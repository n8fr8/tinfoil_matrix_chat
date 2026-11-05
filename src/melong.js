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
    } = {}) {
        this.model = model;
        this.transcriptionModel = transcriptionModel;
        this.ttsModel = ttsModel;
        this.ttsVoice = ttsVoice;
        this.maxNewTokens = maxNewTokens;
        this.systemPrompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;
        // Number of past user/assistant exchanges to remember per conversation.
        this.historyTurns = historyTurns;
        this.timeoutMs = timeoutMs;
        this.client = client || new TinfoilAI();
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
            throw new Error(`Tinfoil transcription failed: ${err?.message || err}`);
        }
    }

    // Text-to-speech. Returns the audio bytes (WAV).
    async speak(text) {
        try {
            const res = await this.client.audio.speech.create(
                { model: this.ttsModel, voice: this.ttsVoice, input: text },
                { timeout: this.timeoutMs },
            );
            return Buffer.from(await res.arrayBuffer());
        } catch (err) {
            throw new Error(`Tinfoil text-to-speech failed: ${err?.message || err}`);
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
                const transcript = await this.transcribe(a);
                const t = `[Transcript of ${a.kind} "${a.filename}"]:\n${transcript || "(no speech detected)"}`;
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
        try {
            completion = await this.client.chat.completions.create(
                {
                    model: this.model,
                    messages: [{ role: "system", content: this.systemPrompt + VOICE_INSTRUCTIONS }, ...history, userMsg],
                    max_tokens: this.maxNewTokens,
                },
                { timeout: this.timeoutMs, signal: opts.signal },
            );
        } catch (err) {
            throw new Error(`Tinfoil request failed: ${err?.message || err}`);
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
