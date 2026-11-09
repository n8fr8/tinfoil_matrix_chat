// Downloading and preparing Matrix attachments (images, audio, video, files)
// so they can be sent to Tinfoil.

import { spawn } from "node:child_process";
import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import { LogService } from "matrix-bot-sdk";

export const MEDIA_MSGTYPES = ["m.image", "m.audio", "m.video", "m.file"];

// matrix-bot-sdk 0.7 downloads from the legacy unauthenticated media endpoint,
// which most current homeservers have switched off. Try the authenticated
// endpoint (Matrix 1.11) first and fall back to the legacy one.
export function useAuthenticatedMedia(client) {
    const legacy = client.downloadContent.bind(client);
    client.downloadContent = async (mxcUrl, allowRemote = true) => {
        const match = /^mxc:\/\/([^/]+)\/([^/?#]+)/i.exec(mxcUrl || "");
        if (!match) throw new Error(`Invalid mxc URL: ${mxcUrl}`);
        const [, server, mediaId] = match;
        const path = `/_matrix/client/v1/media/download/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}`;
        try {
            const res = await client.doRequest("GET", path, { allow_remote: allowRemote }, null, null, true, null, true);
            return { data: res.body, contentType: res.headers["content-type"] };
        } catch (err) {
            const status = err?.statusCode ?? err?.body?.statusCode;
            if (status !== 404 && status !== 400 && status !== 405) throw err;
            LogService.debug("melong", `Authenticated media unavailable (${status}); using legacy endpoint`);
            return legacy(mxcUrl, allowRemote);
        }
    };
}

// Maps a Matrix msgtype + mimetype to how we handle it.
export function attachmentKind(content) {
    const mimetype = content?.info?.mimetype || "";
    if (content.msgtype === "m.image" || mimetype.startsWith("image/")) return "image";
    if (content.msgtype === "m.audio" || mimetype.startsWith("audio/")) return "audio";
    if (content.msgtype === "m.video" || mimetype.startsWith("video/")) return "video";
    return "file";
}

// Matrix media captions: when `filename` is set and differs from `body`, the
// body is a caption. Otherwise the body is just the file name.
// Clients that don't set `filename` put either the file name or a caption in
// `body`; treat it as a caption unless it looks like a file name.
export function attachmentCaption(content) {
    const body = (content.body || "").trim();
    if (!body) return "";
    if (content.filename) return body !== content.filename ? body : "";
    return /\.[a-z0-9]{2,5}$/i.test(body) ? "" : body;
}

export function attachmentFilename(content) {
    return content.filename || content.body || "attachment";
}

// Downloads (and decrypts, for encrypted rooms) an attachment.
export async function downloadAttachment(client, content) {
    let data;
    if (content.file?.url) {
        const encrypted = (await client.downloadContent(content.file.url)).data;
        data = decryptAttachment(Buffer.from(encrypted), content.file);
    } else if (content.url) {
        data = (await client.downloadContent(content.url)).data;
    } else {
        throw new Error("Attachment has no URL");
    }
    return {
        kind: attachmentKind(content),
        data: Buffer.from(data),
        mimetype: content.info?.mimetype || "application/octet-stream",
        filename: attachmentFilename(content),
    };
}

// Decrypts an encrypted Matrix attachment (AES-256-CTR + SHA-256 check, per
// the spec). We do this ourselves rather than via the SDK's Rust crypto because
// that rejects base64 with "=" padding ("Invalid padding at line 1 column N"),
// which some clients send. Node's base64 decoder accepts padded/unpadded and
// standard/URL-safe alphabets.
export function decryptAttachment(ciphertext, file) {
    if (file.key?.alg && file.key.alg !== "A256CTR") throw new Error(`Unsupported attachment algorithm: ${file.key.alg}`);
    const key = Buffer.from(file.key?.k || "", "base64");
    const iv = Buffer.from(file.iv || "", "base64");
    const expected = Buffer.from(file.hashes?.sha256 || "", "base64");
    if (key.length !== 32 || iv.length !== 16 || expected.length !== 32) {
        throw new Error("Encrypted attachment has an invalid key, IV, or hash");
    }
    const actual = createHash("sha256").update(ciphertext).digest();
    if (!timingSafeEqual(actual, expected)) throw new Error("Encrypted attachment failed its integrity check");
    const decipher = createDecipheriv("aes-256-ctr", key, iv);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// Runs ffmpeg with `input` on stdin and returns stdout.
function ffmpeg(args, input) {
    return new Promise((resolve, reject) => {
        const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", ...args, "pipe:1"]);
        const out = [];
        const errs = [];
        ff.stdout.on("data", (c) => out.push(c));
        ff.stderr.on("data", (c) => errs.push(c));
        ff.on("error", (err) =>
            reject(new Error(err.code === "ENOENT" ? "ffmpeg is not installed (needed to convert audio/video)" : err.message)),
        );
        ff.on("close", (code) => {
            if (code === 0 && out.length) resolve(Buffer.concat(out));
            else reject(new Error(`ffmpeg failed (${code}): ${Buffer.concat(errs).toString().trim().slice(0, 300)}`));
        });
        ff.stdin.on("error", () => {}); // ffmpeg may close stdin early on bad input
        ff.stdin.end(input);
    });
}

// Converts audio (or a video's audio track) to MP3, since the transcription
// model only accepts MP3/WAV. Matrix voice messages are Ogg/Opus.
export function toMp3(data) {
    return ffmpeg(["-vn", "-ac", "1", "-ar", "16000", "-f", "mp3"], data);
}

// 16 kHz mono 16-bit WAV, the input format of the Tibetan speech sidecar.
// ffmpeg writes raw samples (a WAV written to a pipe has no valid length
// field), and we add the 44-byte header ourselves.
export async function toWav16kMono(data) {
    const pcm = await ffmpeg(["-vn", "-ac", "1", "-ar", "16000", "-f", "s16le"], data);
    const h = Buffer.alloc(44);
    h.write("RIFF", 0);
    h.writeUInt32LE(36 + pcm.length, 4);
    h.write("WAVEfmt ", 8);
    h.writeUInt32LE(16, 16); // fmt chunk size
    h.writeUInt16LE(1, 20); // PCM
    h.writeUInt16LE(1, 22); // mono
    h.writeUInt32LE(16000, 24); // sample rate
    h.writeUInt32LE(16000 * 2, 28); // byte rate
    h.writeUInt16LE(2, 32); // block align
    h.writeUInt16LE(16, 34); // bits per sample
    h.write("data", 36);
    h.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([h, pcm]);
}

// Turns synthesized speech into a Matrix voice message: Ogg/Opus audio plus
// the duration and waveform that clients use to draw the voice-message player.
export async function toVoiceMessage(audio) {
    const SAMPLE_RATE = 8000;
    const [ogg, pcm] = await Promise.all([
        ffmpeg(["-vn", "-ac", "1", "-c:a", "libopus", "-b:a", "32k", "-f", "ogg"], audio),
        ffmpeg(["-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le"], audio),
    ]);
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
    const durationMs = Math.round((samples.length / SAMPLE_RATE) * 1000);

    // 100 bars of peak amplitude, scaled 0-1024 (MSC3246).
    const BARS = 100;
    const per = Math.max(1, Math.floor(samples.length / BARS));
    const peaks = [];
    for (let b = 0; b < BARS && b * per < samples.length; b++) {
        let peak = 0;
        for (let i = b * per; i < Math.min((b + 1) * per, samples.length); i++) peak = Math.max(peak, Math.abs(samples[i]));
        peaks.push(peak);
    }
    const max = Math.max(1, ...peaks);
    const waveform = peaks.map((p) => Math.round((p / max) * 1024));

    return { data: ogg, mimetype: "audio/ogg", durationMs, waveform };
}

// Uploads a file to the homeserver, encrypting it first in encrypted rooms.
// Returns the content fields to merge into the message ({url} or {file}).
export async function uploadForRoom(client, roomId, data, mimetype, filename) {
    if (client.crypto && (await client.crypto.isRoomEncrypted(roomId))) {
        const { buffer, file } = await client.crypto.encryptMedia(data);
        const url = await client.uploadContent(buffer, "application/octet-stream", filename);
        return { file: { ...file, url } };
    }
    return { url: await client.uploadContent(data, mimetype, filename) };
}
