// General-purpose chat client backed by Tinfoil private inference.
//
// Tinfoil runs open-source models inside secure hardware enclaves. The SDK is a
// drop-in replacement for the OpenAI client and verifies enclave attestation
// and code provenance on every connection. It reads TINFOIL_API_KEY from the
// environment, so the key is never passed in code.
//
// Recent messages are kept in memory per conversation (e.g. per Matrix room)
// so the bot can follow along. History is lost when the bot restarts.
//
// Attachments:
//   image -> sent to the (vision-capable) chat model as an image_url part
//   audio -> transcribed by the speech-to-text model; transcript sent as text
//   video -> audio track transcribed (frames are not analysed)
//   file  -> sent as a "file" part; Tinfoil converts PDF/DOCX/PPTX/XLSX/CSV/text
//            server-side inside the enclave

import { TinfoilAI } from "tinfoil";
import { pcm16kToWav, toMp3, toPcm16kMono } from "./media.js";
import { splitByScript } from "./speech.js";
import { LogService } from "matrix-bot-sdk";
import { WIKI_TOOLS, runWikiTool, wikiInstructions } from "./wiki.js";
import { PDF_INSTRUCTIONS, PDF_TOOL, pdfFilename, renderPdf } from "./pdf.js";
import { INSPECT_INSTRUCTIONS, INSPECT_TOOL, bundleImages, isZip, runInspectTool } from "./forensics.js";

// Builds the Tinfoil SDK client. By default the SDK asks Tinfoil's attestation
// service for a router and gets a random one (e.g. router-0.tinfoil.sh or
// inference.tinfoil.sh). Inside a Tinfoil Container, egress is limited to an
// allowlist, so we pin the router: TINFOIL_ENCLAVE_URL (default
// https://inference.tinfoil.sh). It is still attested and verified against
// Tinfoil's official router code. TINFOIL_TRANSPORT=tls switches the transport
// from EHBP (default) to TLS pinning.
export function createTinfoilClient(overrides = {}) {
    const options = {
        enclaveURL: process.env.TINFOIL_ENCLAVE_URL || "https://inference.tinfoil.sh",
        configRepo: process.env.TINFOIL_CONFIG_REPO || "tinfoilsh/confidential-model-router",
        ...(process.env.TINFOIL_TRANSPORT ? { transport: process.env.TINFOIL_TRANSPORT } : {}),
        ...overrides,
    };
    return new TinfoilAI(options);
}

export const DEFAULT_SYSTEM_PROMPT =
    "You are a friendly, knowledgeable assistant chatting in a Matrix room. " +
    "Help with any topic people bring up. Keep replies clear and conversational, " +
    "and reply in the language the user writes in. Users may share images, " +
    "documents, and audio (which you receive as a transcript).";

// Appended to the system prompt so the model can flag when a voice reply was
// requested. The bot strips the tag and sends the reply as a voice message.
export const VOICE_TAG = "[VOICE]";
const VOICE_INSTRUCTIONS =
    `\n\nYou can reply with a voice message. Only when the user asks you to speak, ` +
    `answer out loud, read something aloud, or reply with voice/audio/a voice message, ` +
    `start your reply with the exact tag ${VOICE_TAG} and write the rest as natural ` +
    `spoken text: no Markdown, lists, tables, code, emoji, or URLs, and keep it ` +
    `reasonably short. Never use the tag otherwise.`;

// Added when the user's message was itself a voice message / audio: the reply
// is always spoken (and also sent as text).
const SPOKEN_INPUT_INSTRUCTIONS =
    `\n\nThe user's latest message is a voice message, so your reply will be ` +
    `sent as a voice message too, in the language the user spoke unless they ask ` +
    `otherwise. Write it as natural spoken text: no Markdown, lists, tables, code, ` +
    `emoji, or URLs, and keep it reasonably short.`;

// Added when the Tibetan speech sidecar is enabled, depending on SPEECH_STT.
const TIBETAN_REPLY_RULE =
    ` When writing a spoken reply in Tibetan, write numbers as words and use only Tibetan script.`;
const TIBETAN_TRANSCRIPT_NOTE =
    `Its transcripts are in Tibetan script, with no punctuation and some ` +
    `spelling errors: read them charitably, as spoken Tibetan.`;
const TIBETAN_SPEECH_INSTRUCTIONS = {
    auto:
        `\n\nVoice messages and audio are transcribed automatically: Tibetan ` +
        `speech by a Tibetan speech model, other languages by a general model. ` +
        `Each transcript says which. ` + TIBETAN_TRANSCRIPT_NOTE + TIBETAN_REPLY_RULE,
    tibetan:
        `\n\nVoice messages and audio are transcribed by a Tibetan speech model. ` +
        TIBETAN_TRANSCRIPT_NOTE + ` Reply to a voice message in Tibetan unless the ` +
        `user asks for another language.` + TIBETAN_REPLY_RULE,
    general: "",
};
const STT_MODES = Object.keys(TIBETAN_SPEECH_INSTRUCTIONS);

// Room wikis (src/wiki.js): tool rounds per reply, size of a shared file
// kept as a raw source, and the extra instructions for !memory commands.
const MAX_TOOL_ROUNDS = 20;
const MAX_RAW_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const WIKI_TASKS = {
    add:
        "\n\nThe user used the !memory add command: add the material in their message (and any message or file they replied to) to the wiki now, " +
        "following the ingest steps in the schema, then confirm in one short sentence that you'll remember it.",
    lint:
        "\n\nThe user used the !memory check command: do a lint pass over the whole wiki as the schema describes. " +
        "Read the pages you need and fix what you safely can. Then reply briefly in plain words: that you've tidied up the room's memory, " +
        "and any questions only a person can answer. Don't mention pages or files.",
};

// Tinfoil web search (https://docs.tinfoil.sh/guides/web-search). The model
// decides when to search; searches run in Tinfoil's enclave via Exa. The two
// filters mask personal data in queries and drop prompt-injection attempts
// from results. Sources come back as inline Markdown links.
const WEB_SEARCH_FIELDS = { web_search_options: {}, pii_check_options: {}, prompt_injection_check_options: {} };

const TRANSCRIBABLE = new Set(["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave"]);

export class ChatClient {
    constructor({
        model = "deepseek-v4-1-flash",
        transcriptionModel = "voxtral-small-24b",
        ttsModel = "voxtral-tts",
        ttsVoice = "neutral_female",
        maxNewTokens = 16000,
        systemPrompt,
        historyTurns = 10,
        timeoutMs = 300000,
        client,
        speech = null, // SpeechSidecar for Tibetan TTS/STT (optional)
        speechStt = "auto", // see TIBETAN_SPEECH_INSTRUCTIONS
        detectModel = "whisper-large-v3-turbo", // decides Tibetan vs other ("auto")
        detectThreshold = -0.45,
        webSearch = true,
        prompts = null, // PromptLibrary of topic guidance (optional)
        wikiSchema = "", // default SCHEMA.md, for rooms without a wiki yet
        wikiMaxBytes = 20 * 1024 * 1024,
        pdf = false, // offer the create_pdf tool (needs WeasyPrint)
        forensics = null, // installed media forensics tools ({c2patool, exiftool, proofmode}); offers inspect_media
    } = {}) {
        this.prompts = prompts;
        this.wikiSchema = wikiSchema;
        this.wikiMaxBytes = wikiMaxBytes;
        this.pdf = pdf;
        this.forensics = forensics;
        this.webSearch = webSearch;
        this.detectModel = detectModel;
        this.detectThreshold = detectThreshold;
        this.speech = speech;
        if (!STT_MODES.includes(speechStt)) throw new Error(`SPEECH_STT must be one of ${STT_MODES.join(", ")}`);
        this.speechStt = speech ? speechStt : "general";
        this.model = model;
        this.transcriptionModel = transcriptionModel;
        this.ttsModel = ttsModel;
        this.ttsVoice = ttsVoice;
        this.maxNewTokens = maxNewTokens;
        this.systemPrompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;
        // Number of past user/assistant exchanges to remember per conversation.
        this.historyTurns = historyTurns;
        this.timeoutMs = timeoutMs;
        this.client = client || createTinfoilClient();
        this.histories = new Map();
    }

    reset(conversationId) {
        this.histories.delete(conversationId);
    }

    // Speech-to-text with Tinfoil. Converts to MP3 first unless it already is
    // MP3/WAV. Returns the text, or with `verbose` the full result (language,
    // per-segment confidence).
    async transcribe({ data, mimetype, filename, kind }, { model = this.transcriptionModel, verbose = false } = {}) {
        let audio = data;
        let name = filename;
        let type = mimetype;
        if (kind === "video" || !TRANSCRIBABLE.has(mimetype)) {
            audio = await toMp3(data);
            name = filename.replace(/\.[^.]*$/, "") + ".mp3";
            type = "audio/mpeg";
        }
        try {
            const result = await this.client.audio.transcriptions.create(
                { model, file: new File([audio], name, { type }), ...(verbose ? { response_format: "verbose_json" } : {}) },
                { timeout: this.timeoutMs },
            );
            return verbose ? result : (result?.text ?? "").trim();
        } catch (err) {
            throw new Error(`Tinfoil transcription failed: ${describeError(err)}`);
        }
    }

    // Transcript block for an audio/video attachment (SPEECH_STT):
    //   general  Tinfoil's transcription model only
    //   tibetan  the Tibetan sidecar only
    //   auto     Whisper and the sidecar in parallel. Whisper can't transcribe
    //            Tibetan, and on Tibetan speech it returns nothing or
    //            low-confidence gibberish; when it's confident, the speech
    //            isn't Tibetan and its transcript is used. Otherwise the
    //            Tibetan one is. (Calibrated on real speech: Tibetan scored
    //            <= -0.58 or empty; en/fr/hi/zh/ne >= -0.33.)
    async transcribeForModel(a) {
        const header = `[Transcript of ${a.kind} "${a.filename}"`;
        const show = (t) => t || "(no speech detected)";
        const tibetan = async () => {
            try {
                return await this.speech.stt(a.data);
            } catch (err) {
                throw new Error(`Tibetan transcription failed: ${err?.message || err}`);
            }
        };
        if (this.speechStt === "general") return `${header}]:\n${show(await this.transcribe(a))}`;
        if (this.speechStt === "tibetan") return `${header}, Tibetan speech model]:\n${show(await tibetan())}`;

        const [whisper, bod] = await Promise.allSettled([this.transcribe(a, { model: this.detectModel, verbose: true }), tibetan()]);
        const w = whisper.status === "fulfilled" ? whisperSummary(whisper.value) : null;
        const general = w && w.text && w.score >= this.detectThreshold;
        LogService.info("melong", `Speech detection: ${w ? `language=${w.language} score=${w.score.toFixed(2)}` : "whisper failed"} -> ${general ? "general" : "Tibetan"}`);
        if (general) return `${header}, general model, language: ${w.language || "unknown"}]:\n${w.text}`;
        if (bod.status === "fulfilled") return `${header}, Tibetan speech model]:\n${show(bod.value)}`;
        if (w?.text) {
            LogService.warn("melong", bod.reason?.message);
            return `${header}, general model (low confidence), language: ${w.language || "unknown"}]:\n${w.text}`;
        }
        throw bod.reason;
    }

    // Text-to-speech. Returns the audio bytes (WAV). With the speech sidecar,
    // Tibetan stretches are spoken by it and everything else by Tinfoil; mixed
    // replies (e.g. Tibetan plus an English gloss) are stitched together.
    async speak(text) {
        text = forSpeech(text);
        const runs = this.speech ? splitByScript(text) : [];
        if (!runs.some((r) => r.tibetan)) return this.speakGeneral(text);
        if (runs.length === 1) return this.speakTibetan(runs[0].text);
        const clips = await Promise.all(runs.map((r) => (r.tibetan ? this.speakTibetan(r.text) : this.speakGeneral(r.text))));
        const pcm = await Promise.all(clips.map(toPcm16kMono));
        const gap = Buffer.alloc(16000 * 2 * 0.3); // 0.3 s of silence between runs
        return pcm16kToWav(Buffer.concat(pcm.flatMap((p, i) => (i ? [gap, p] : [p]))));
    }

    async speakTibetan(text) {
        try {
            return await this.speech.tts(text);
        } catch (err) {
            throw new Error(`Tibetan text-to-speech failed: ${err?.message || err}`);
        }
    }

    async speakGeneral(text) {
        try {
            const res = await this.client.audio.speech.create(
                { model: this.ttsModel, voice: this.ttsVoice, input: text },
                { timeout: this.timeoutMs },
            );
            return Buffer.from(await res.arrayBuffer());
        } catch (err) {
            throw new Error(`Tinfoil text-to-speech failed: ${describeError(err)}`);
        }
    }

    /**
     * Send a user message (optionally with attachments) and return the reply.
     * @param {string} conversationId key for remembered history (e.g. room ID)
     * @param {string} text the user's message (may be empty if attachments are given)
     * @param {Array<{kind:string,data:Buffer,mimetype:string,filename:string}>} [attachments]
     * @param {{signal?: AbortSignal}} [opts]
     * @returns {Promise<{text: string, voice: boolean}>} voice=true when the reply should be spoken:
     *   the user sent audio, or asked for a spoken reply
     */
    async chat(conversationId, text, attachments = [], opts = {}) {
        const history = this.histories.get(conversationId) || [];

        // `parts` go to the model now; `notes` are the text-only version kept in
        // history, so large files aren't re-sent with every later message.
        const parts = [];
        const notes = [];
        for (const a of attachments) {
            if (a.kind === "image") {
                parts.push({ type: "image_url", image_url: { url: dataUrl(a) } });
                notes.push(`[Shared an image: ${a.filename}]`);
            } else if (a.kind === "audio" || a.kind === "video") {
                const t = await this.transcribeForModel(a);
                parts.push({ type: "text", text: t });
                notes.push(t);
            } else if (isZip(a)) {
                // The model can't read archives; inspect_media can (e.g. ProofMode proof bundles).
                // A few photos from inside are shown, downscaled, so it can see what they depict.
                const previews = await bundleImages(a).catch((err) => (LogService.warn("melong", `Bundle previews failed: ${err.message}`), []));
                const shown = previews.length ? ` Downscaled copies of ${previews.length} of its photos/video frames follow: ${previews.map((p) => p.filename).join(", ")}.` : "";
                parts.push({ type: "text", text: `[Attached archive: ${a.filename}, ${a.data.length} bytes. The inspect_media tool can check it.${shown}]` });
                for (const p of previews) {
                    parts.push({ type: "text", text: `[From ${a.filename}: ${p.filename}]` });
                    parts.push({ type: "image_url", image_url: { url: dataUrl(p) } });
                }
                notes.push(`[Shared a file: ${a.filename}]`);
            } else {
                parts.push({ type: "file", file: { filename: a.filename, file_data: dataUrl(a) } });
                notes.push(`[Shared a file: ${a.filename}]`);
            }
        }

        const prompt = text || defaultPrompt(attachments);
        const spokenInput = attachments.some((a) => a.kind === "audio");
        // Topic guidance (prompts/*.md) for this kind of request, if any. Topic
        // text goes before the voice/Tibetan rules so those have the last word.
        const topic = await this.prompts?.classify([...notes, text].filter(Boolean).join("\n\n") || prompt, recentContext(history), opts);
        const inspect = Boolean(this.forensics && attachments.length);
        const system =
            this.systemPrompt +
            (topic ? `\n\nGuidance for this kind of request (${topic.name}):\n${topic.body}` : "") +
            (opts.wiki ? wikiInstructions(opts.wiki, this.wikiSchema) + (WIKI_TASKS[opts.wikiTask] || "") : "") +
            (this.pdf ? PDF_INSTRUCTIONS : "") +
            (inspect ? INSPECT_INSTRUCTIONS : "") +
            (spokenInput ? SPOKEN_INPUT_INSTRUCTIONS : VOICE_INSTRUCTIONS) +
            TIBETAN_SPEECH_INSTRUCTIONS[this.speechStt];
        const userMsg = parts.length
            ? { role: "user", content: [{ type: "text", text: prompt }, ...parts] }
            : { role: "user", content: prompt };

        // With a wiki, the model may call wiki tools for a few rounds before answering.
        const messages = [{ role: "system", content: system }, ...history, userMsg];
        const toolList = [...(opts.wiki ? WIKI_TOOLS : []), ...(this.pdf ? [PDF_TOOL] : []), ...(inspect ? [INSPECT_TOOL] : [])];
        const tools = toolList.length ? { tools: toolList } : {};
        const files = []; // documents made with create_pdf, attached after the reply
        const started = Date.now();
        let completion;
        for (let round = 1; ; round++) {
            try {
                completion = await this.client.chat.completions.create(
                    {
                        model: this.model,
                        messages,
                        max_tokens: this.maxNewTokens,
                        ...(this.webSearch ? WEB_SEARCH_FIELDS : {}),
                        ...tools,
                    },
                    { timeout: this.timeoutMs, signal: opts.signal },
                );
            } catch (err) {
                throw new Error(`Tinfoil request failed after ${Math.round((Date.now() - started) / 1000)}s: ${describeError(err)}`);
            }
            const message = completion?.choices?.[0]?.message;
            const calls = message?.tool_calls || [];
            if (!toolList.length || !calls.length) break;
            if (round > MAX_TOOL_ROUNDS) throw new Error(`the model was still using tools after ${MAX_TOOL_ROUNDS} rounds; try a smaller request`);
            messages.push(message);
            for (const call of calls) {
                let args = {};
                try {
                    args = JSON.parse(call.function?.arguments || "{}");
                } catch {}
                const result =
                    call.function?.name === "create_pdf"
                        ? await this.makePdf(args, files)
                        : call.function?.name === "inspect_media" && inspect
                          ? await runInspectTool(attachments, args, this.forensics)
                          : opts.wiki
                          ? await runWikiTool(opts.wiki, call.function?.name, args, { maxBytes: this.wikiMaxBytes })
                          : `Unknown tool ${call.function?.name}.`;
                LogService.debug("melong", `Tool ${call.function?.name}(${args.path || args.query || args.title || ""}) -> ${result.slice(0, 80)}`);
                messages.push({ role: "tool", tool_call_id: call.id, content: result });
            }
        }

        let out = (completion?.choices?.[0]?.message?.content ?? "").toString().trim();
        const tagged = out.startsWith(VOICE_TAG);
        if (tagged) out = out.slice(VOICE_TAG.length).trim();
        const voice = spokenInput || tagged;
        if (!out && completion?.choices?.[0]?.finish_reason === "length") {
            throw new Error(`the model used its whole ${this.maxNewTokens}-token budget thinking and wrote no answer; try a simpler or shorter request (or raise CHAT_MAX_NEW_TOKENS)`);
        }
        if (!out) throw new Error("Tinfoil returned an empty response: " + JSON.stringify(completion).slice(0, 300));

        // Wiki changed: keep the shared files as sources and log the change.
        if (opts.wiki?.changed.size) {
            for (const a of attachments) {
                if (a.data.length <= MAX_RAW_ATTACHMENT_BYTES && opts.wiki.bytes + a.data.length <= this.wikiMaxBytes) {
                    const ext = (a.filename.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] || "bin").toLowerCase();
                    await opts.wiki.saveSource(a.filename.replace(/\.[^.]*$/, ""), a.data, ext);
                }
            }
            opts.wiki.appendLog(opts.wikiTask === "lint" ? "lint" : "update", text || prompt, [...opts.wiki.changed]);
        }

        // Remember this exchange (text-only), trimmed to the last N turns.
        const remembered = { role: "user", content: [...notes, prompt].join("\n\n") };
        const updated = [...history, remembered, { role: "assistant", content: out }];
        this.histories.set(conversationId, updated.slice(-this.historyTurns * 2));
        return { text: out, voice, files };
    }

    // create_pdf tool: renders the document and queues it to be attached.
    async makePdf(args, files) {
        const title = String(args.title || "Document").trim().slice(0, 200);
        if (files.length >= 3) return "Already made 3 documents for this reply; not making more.";
        try {
            const started = Date.now();
            const data = await renderPdf(title, String(args.content || ""));
            let filename = pdfFilename(title);
            if (files.some((f) => f.filename === filename)) filename = filename.replace(/\.pdf$/, `-${files.length + 1}.pdf`);
            files.push({ filename, data, mimetype: "application/pdf" });
            LogService.info("melong", `Made PDF "${filename}" (${data.length} bytes) in ${Date.now() - started} ms`);
            return `Created ${filename}. It will be attached right after your message; just say briefly what it contains.`;
        } catch (err) {
            LogService.error("melong", "PDF failed:", err?.message || err);
            return `The PDF couldn't be made (${err?.message || err}). Tell the user, and offer the content as text instead.`;
        }
    }
}

// Text to read aloud: drops Markdown links (web search citations) and bare URLs.
export function forSpeech(text) {
    return text
        .replace(/\[[^\]]*\]\([^)\s]*\)/g, "")
        .replace(/https?:\/\/\S+/g, "")
        .replace(/[ \t]+([.,;:!?།])/g, "$1")
        .replace(/[,;:]+(?=[.!?།])/g, "")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/[ \t]+\n/g, "\n")
        .trim();
}

// The last exchange, shortened, so follow-ups ("what about in Nepal?") keep their topic.
function recentContext(history) {
    return history
        .slice(-2)
        .map((m) => {
            const t = typeof m.content === "string" ? m.content : "";
            return `${m.role}: ${t.length > 400 ? t.slice(0, 400) + "..." : t}`;
        })
        .join("\n");
}

// Error message plus the underlying network cause, if any.
function describeError(err) {
    const msg = err?.message || String(err);
    const cause = err?.cause?.code || err?.cause?.message;
    return cause && !msg.includes(cause) ? `${msg} (${cause})` : msg;
}

function dataUrl({ data, mimetype }) {
    return `data:${mimetype};base64,${data.toString("base64")}`;
}

// Used when someone sends media with no accompanying text.
function defaultPrompt(attachments) {
    const kinds = new Set(attachments.map((a) => a.kind));
    if (kinds.size === 1) {
        if (kinds.has("image")) return attachments.length > 1 ? "Describe what is in these images." : "Describe what is in this image.";
        if (kinds.has("audio")) return "Respond to this voice message.";
        if (kinds.has("video")) return "Summarise what is said in this video.";
        if (kinds.has("file")) return "Summarise this document.";
    }
    return "Describe and summarise what I've shared.";
}

// Text, language and duration-weighted mean log-probability (0 = certain)
// from a verbose_json transcription.
function whisperSummary(result) {
    const segments = result?.segments || [];
    const weight = (seg) => Math.max(seg.end - seg.start, 0.01);
    const total = segments.reduce((sum, seg) => sum + weight(seg), 0);
    const score = total ? segments.reduce((sum, seg) => sum + seg.avg_logprob * weight(seg), 0) / total : -Infinity;
    return { text: (result?.text ?? "").trim(), language: result?.language, score };
}
