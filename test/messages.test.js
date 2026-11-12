// How incoming Matrix messages turn into chat requests and replies, using a fake
// Matrix client and a fake chat (no network). These cases come from how real
// clients behave; see "Client quirks" in CLAUDE.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMessage } from "../src/index.js";

const WAIT = Number(process.env.FILE_NOTE_WAIT_MS) || 6000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const config = { commandPrefix: "", maxAttachmentBytes: 25e6, messageMaxChars: 1500, voiceMaxChars: 600 };

function setup({ chatDelay = 0 } = {}) {
    const events = {};
    const sent = [];
    const calls = [];
    const client = {
        crypto: null,
        async getEvent(_room, id) {
            return events[id];
        },
        async downloadContent() {
            return { data: Buffer.from("data") };
        },
        async sendMessage(_room, content) {
            sent.push(content);
            return `$sent${sent.length}`;
        },
        async setTyping() {},
    };
    const chat = {
        wikiStore: null,
        chat(_room, text, attachments, { signal } = {}) {
            const call = { text, files: attachments.map((a) => a.filename), result: "pending" };
            calls.push(call);
            return new Promise((resolve, reject) => {
                const t = setTimeout(() => {
                    call.result = "answered";
                    resolve({ text: `reply to "${text}"`, voice: false });
                }, chatDelay);
                signal?.addEventListener("abort", () => {
                    clearTimeout(t);
                    call.result = "cancelled";
                    reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
                });
            });
        },
    };
    const add = (ev) => (events[ev.event_id] = { sender: "@me:x", origin_server_ts: Date.now(), ...ev });
    const send = (ev) => handleMessage(client, chat, config, "@bot:x", "!room", add(ev));
    return { send, sent, calls };
}

const text = (id, body, extra = {}) => ({ event_id: id, content: { msgtype: "m.text", body, ...extra } });
const file = (id, extra = {}) => ({
    event_id: id,
    content: { msgtype: "m.file", body: "doc.pdf", filename: "doc.pdf", url: "mxc://x/f", info: { mimetype: "application/pdf", size: 10 }, ...extra },
});
const inThread = (root) => ({ "m.relates_to": { rel_type: "m.thread", event_id: root } });

test("file, then a note as a thread reply on it: answered once, together", async () => {
    const { send, sent, calls } = setup();
    await send(file("$f"));
    await sleep(50);
    await send(text("$n", "remember this document", inThread("$f")));
    await sleep(WAIT + 300);
    assert.deepEqual(calls.map((c) => [c.text, c.files]), [["remember this document", ["doc.pdf"]]]);
    assert.deepEqual(sent[0]["m.relates_to"], { "m.in_reply_to": { event_id: "$f" } }, "reply in main timeline, quoting the thread root");
});

test("file, then a plain note: answered together", async () => {
    const { send, calls } = setup();
    await send(file("$f"));
    await send(text("$n", "summarize this"));
    await sleep(WAIT + 300);
    assert.deepEqual(calls.map((c) => [c.text, c.files]), [["summarize this", ["doc.pdf"]]]);
});

test("file with no note: answered alone after the wait", async () => {
    const { send, calls } = setup();
    await send(file("$f"));
    await sleep(WAIT + 300);
    assert.deepEqual(calls.map((c) => [c.text, c.files]), [["", ["doc.pdf"]]]);
});

test("text, then the file as a thread reply while answering: answer restarts with the file", async () => {
    const { send, sent, calls } = setup({ chatDelay: 800 });
    send(text("$t", "how many onions are there?"));
    await sleep(100);
    send({ ...file("$i"), content: { ...file("$i").content, msgtype: "m.image", body: "onions.jpg", filename: "onions.jpg", ...inThread("$t") } });
    await sleep(1500);
    assert.deepEqual(calls.map((c) => [c.result, c.files]), [["cancelled", []], ["answered", ["onions.jpg"]]]);
    assert.equal(sent.length, 1, "only the combined answer is sent");
});

test("text answered before the file arrives: the file is answered with that text", async () => {
    const { send, calls } = setup({ chatDelay: 10 });
    await send(text("$t", "how many onions are there?"));
    await send({ ...file("$i"), content: { ...file("$i").content, ...inThread("$t") } });
    await sleep(100);
    assert.deepEqual(calls.map((c) => [c.text, c.files]), [["how many onions are there?", []], ["how many onions are there?", ["doc.pdf"]]]);
});

test("voice note under a placeholder text: answered at once, in the main timeline", async () => {
    const { send, sent, calls } = setup();
    await send(text("$p", "Sent 1 media items."));
    await send({
        event_id: "$v",
        content: {
            msgtype: "m.audio",
            body: "Voice message.ogg",
            filename: "Voice message.ogg",
            url: "mxc://x/a",
            info: { mimetype: "audio/ogg", size: 10 },
            "org.matrix.msc3245.voice": {},
            ...inThread("$p"),
        },
    });
    await sleep(100);
    assert.deepEqual(calls.map((c) => [c.text, c.files]), [["", ["Voice message.ogg"]]], "placeholder is not the prompt; no wait");
    assert.deepEqual(sent[0]["m.relates_to"], { "m.in_reply_to": { event_id: "$p" } });
});

test("a reply to a text message brings in the quoted text", async () => {
    const { send, calls } = setup();
    await send(text("$q", "Our picnic is on February 18"));
    calls.length = 0;
    await send(text("$r", "> <@me:x> Our picnic is on February 18\n\nremember this", { "m.relates_to": { "m.in_reply_to": { event_id: "$q" } } }));
    await sleep(50);
    assert.match(calls[0].text, /Replying to this message from @me:x[\s\S]*Our picnic is on February 18[\s\S]*remember this$/);
});
