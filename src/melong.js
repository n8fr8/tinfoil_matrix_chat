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
import { toMp3 } from "./media.js";
import { isMostlyTibetan } from "./speech.js";
import { LogService } from "matrix-bot-sdk";

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

// Added when the Tibetan speech sidecar is enabled, depending on SPEECH_STT.
const TIBETAN_REPLY_RULE =
    ` When writing a spoken reply in Tibetan, write numbers as words and use only Tibetan script.`;
const TIBETAN_SPEECH_INSTRUCTIONS = {
    tibetan:
        `\n\nVoice messages and audio are transcribed by a Tibetan speech model. Its ` +
        `transcripts are in Tibetan script, with no punctuation and some spelling ` +
        `errors: read them charitably, as spoken Tibetan. Reply to a voice message ` +
        `in Tibetan unless the user asks for another language.` + TIBETAN_REPLY_RULE,
    both:
        `\n\nVoice messages may come with two transcripts: one from a general ` +
        `multilingual speech model and one from a Tibetan-only speech model. The ` +
        `Tibetan model always outputs Tibetan script, even for other languages, and ` +
        `has no punctuation and some spelling errors. The general model often turns ` +
        `Tibetan speech into romanized or invented words; if the Tibetan transcript ` +
        `is plausible Tibetan, prefer it.` + TIBETAN_REPLY_RULE,
    general: "",
};
const STT_MODES = Object.keys(TIBETAN_SPEECH_INSTRUCTIONS);

const TRANSCRIBABLE = new Set(["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave"]);

export class ChatClient {
    constructor({
        model = "gemma4-31b",
        transcriptionModel = "voxtral-small-24b",
        ttsModel = "voxtral-tts",
        ttsVoice = "neutral_female",
        maxNewTokens = 2048,
        systemPrompt,
        historyTurns = 10,
        timeoutMs = 120000,
        client,
        speech = null, // SpeechSidecar for Tibetan TTS/STT (optional)
        speechStt = "tibetan", // see TIBETAN_SPEECH_INSTRUCTIONS
    } = {}) {
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

    // Speech-to-text. Converts to MP3 first unless it already is MP3/WAV.
    async transcribe({ data, mimetype, filename, kind }) {
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
                { model: this.transcriptionModel, file: new File([audio], name, { type }) },
                { timeout: this.timeoutMs },
            );
            return (result?.text ?? "").trim();
        } catch (err) {
            throw new Error(`Tinfoil transcription failed: ${describeError(err)}`);
        }
    }

    // Transcript block(s) for an audio/video attachment, from the Tibetan
    // sidecar, the general model, or both in parallel (SPEECH_STT).
    async transcribeForModel(a) {
        const header = `[Transcript of ${a.kind} "${a.filename}"`;
        const show = (t) => t || "(no speech detected)";
        if (this.speechStt === "general") return `${header}]:\n${show(await this.transcribe(a))}`;
        if (this.speechStt === "tibetan") {
            try {
                return `${header}, Tibetan speech model]:\n${show(await this.speech.stt(a.data))}`;
            } catch (err) {
                throw new Error(`Tibetan transcription failed: ${err?.message || err}`);
            }
        }
        const [general, tibetan] = await Promise.allSettled([this.transcribe(a), this.speech.stt(a.data)]);
        if (general.status === "rejected" && tibetan.status === "rejected") throw general.reason;
        if (tibetan.status === "rejected") LogService.warn("melong", `Tibetan transcription failed: ${tibetan.reason?.message}`);
        if (general.status === "rejected") LogService.warn("melong", `General transcription failed: ${general.reason?.message}`);
        const result = (r) => (r.status === "fulfilled" ? show(r.value) : "(unavailable)");
        return (
            `${header}, general multilingual model]:\n${result(general)}\n` +
            `${header}, Tibetan speech model]:\n${result(tibetan)}`
        );
    }

    // Text-to-speech. Returns the audio bytes (WAV). Tibetan text goes to the
    // speech sidecar when it's enabled; everything else to Tinfoil.
    async speak(text) {
        if (this.speech && isMostlyTibetan(text)) {
            try {
                return await this.speech.tts(text);
            } catch (err) {
                throw new Error(`Tibetan text-to-speech failed: ${err?.message || err}`);
            }
        }
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
     * @returns {Promise<{text: string, voice: boolean}>} voice=true when the user asked for a spoken reply
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
            } else {
                parts.push({ type: "file", file: { filename: a.filename, file_data: dataUrl(a) } });
                notes.push(`[Shared a file: ${a.filename}]`);
            }
        }

        const prompt = text || defaultPrompt(attachments);
        const userMsg = parts.length
            ? { role: "user", content: [{ type: "text", text: prompt }, ...parts] }
            : { role: "user", content: prompt };

        let completion;
        const started = Date.now();
        try {
            completion = await this.client.chat.completions.create(
                {
                    model: this.model,
                    messages: [{ role: "system", content: this.systemPrompt + VOICE_INSTRUCTIONS + TIBETAN_SPEECH_INSTRUCTIONS[this.speechStt] }, ...history, userMsg],
                    max_tokens: this.maxNewTokens,
                },
                { timeout: this.timeoutMs, signal: opts.signal },
            );
        } catch (err) {
            throw new Error(`Tinfoil request failed after ${Math.round((Date.now() - started) / 1000)}s: ${describeError(err)}`);
        }

        let out = (completion?.choices?.[0]?.message?.content ?? "").toString().trim();
        const voice = out.startsWith(VOICE_TAG);
        if (voice) out = out.slice(VOICE_TAG.length).trim();
        if (!out) throw new Error("Tinfoil returned an empty response: " + JSON.stringify(completion).slice(0, 300));

        // Remember this exchange (text-only), trimmed to the last N turns.
        const remembered = { role: "user", content: [...notes, prompt].join("\n\n") };
        const updated = [...history, remembered, { role: "assistant", content: out }];
        this.histories.set(conversationId, updated.slice(-this.historyTurns * 2));
        return { text: out, voice };
    }
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
