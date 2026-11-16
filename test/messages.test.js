// How incoming Matrix messages turn into chat requests and replies, using a fake
// Matrix client and a fake chat (no network). These cases come from how real
// clients behave; see "Client quirks" in CLAUDE.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { UNDECRYPTABLE_NOTICE, handleMessage, handleUndecryptable } from "../src/index.js";

const WAIT = Number(process.env.FILE_NOTE_WAIT_MS) || 6000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const config = { commandPrefix: "", maxAttachmentBytes: 25e6, messageMaxChars: 1500, voiceMaxChars: 600 };

function setup({ chatDelay = 0, reply = null, cfg = config, bot = "@bot:x", room = "!room", members = [] } = {}) {
    const events = {};
    const sent = [];
    const calls = [];
    const log = []; // sent messages and typing changes, in order
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
            log.push("msg");
            return `$sent${sent.length}`;
        },
        async setTyping(_room, on) {
            log.push(on ? "typing" : "stop");
        },
        async getJoinedRoomMembers() {
            return members;
        },
    };
    const chat = {
        wikiStore: null,
        chat(_room, text, attachments, { signal } = {}) {
            const call = { text, files: attachments.map((a) => a.filename), result: "pending" };
            calls.push(call);
            return new Promise((resolve, reject) => {
                const t = setTimeout(() => {
                    call.result = "answered";
                    resolve({ text: reply ?? `reply to "${text}"`, voice: false });
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
    const send = (ev) => handleMessage(client, chat, cfg, bot, room, add(ev));
    return { send, add, sent, calls, log };
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

test("undecryptable message: retried, then one notice per room key", async () => {
    const sent = [];
    let keyArrived = false;
    const client = {
        crypto: {
            async decryptRoomEvent(ev) {
                if (!keyArrived) throw new Error("Can't find the room key");
                return { raw: { ...ev.raw, type: "m.room.message", content: { msgtype: "m.text", body: "hi" } } };
            },
        },
        async sendMessage(_room, content) {
            sent.push(content);
        },
    };
    const enc = (id, session) => ({ event_id: id, sender: "@me:x", type: "m.room.encrypted", content: { algorithm: "m.megolm.v1.aes-sha2", session_id: session, ciphertext: "x" } });
    const handled = [];
    const onDecrypted = (e) => handled.push(e.content.body);

    await handleUndecryptable(client, config, "!room", enc("$1", "S1"), onDecrypted, [1, 1]);
    await handleUndecryptable(client, config, "!room", enc("$2", "S1"), onDecrypted, [1, 1]);
    assert.equal(sent.length, 1, "one notice for the same room key");
    assert.equal(sent[0].body, UNDECRYPTABLE_NOTICE);
    assert.equal(sent[0].msgtype, "m.notice");

    // The key arrives during the retries: answered normally, no notice.
    keyArrived = true;
    await handleUndecryptable(client, config, "!room", enc("$3", "S2"), onDecrypted, [1, 1]);
    assert.deepEqual(handled, ["hi"]);
    assert.equal(sent.length, 1);
});

test("long replies: typing and a pause between messages", async () => {
    const para = "word ".repeat(70).trim();
    const { send, sent, log } = setup({ reply: [para, para, para].join("\n\n"), cfg: { ...config, messageMaxChars: 400, messageDelayMs: 50 } });
    const t0 = Date.now();
    await send(text("$t1", "explain at length"));
    assert.equal(sent.length, 3);
    assert.ok(Date.now() - t0 >= 100, "two pauses of 50 ms");
    // "typing" is switched on again before each later message.
    assert.deepEqual(log.slice(-6), ["msg", "typing", "msg", "typing", "msg", "stop"]);
});

// Several accounts in one instance (MATRIX_ACCOUNTS): "@bot:x" and "@tutor:x".
const ours = () => new Set(["@bot:x", "@tutor:x"]);
const sharedSetup = (room, opts = {}) =>
    setup({ cfg: { ...config, displayName: "Zomkyi", ownUserIds: ours() }, room, members: ["@me:x", "@bot:x", "@tutor:x"], ...opts });

test("several accounts: messages from our other accounts are ignored", async () => {
    const { send, calls } = setup({ cfg: { ...config, ownUserIds: ours() }, room: "!dm1", members: ["@bot:x", "@tutor:x"] });
    await send({ ...text("$t", "hello"), sender: "@tutor:x" });
    assert.equal(calls.length, 0);
});

test("several accounts: in a DM (no other account of ours there) every message is answered", async () => {
    const { send, calls } = setup({ cfg: { ...config, ownUserIds: ours() }, room: "!dm2", members: ["@me:x", "@bot:x"] });
    await send(text("$t", "hello"));
    assert.deepEqual(calls.map((c) => c.text), ["hello"]);
});

test("several accounts: in a shared room only messages addressed to this account are answered", async () => {
    const { send, add, calls } = sharedSetup("!shared1");
    await send(text("$1", "hello everyone"));
    await send(text("$2", "Zomkyi: what is a VPN?"));
    await send(text("$3", "Zomkyi what is Tor?"));
    await send(text("$4", "tutor: hi", { "m.mentions": { user_ids: ["@tutor:x"] } }));
    await send(text("$5", "explain", { "m.mentions": { user_ids: ["@bot:x"] } }));
    add({ event_id: "$mine", sender: "@bot:x", content: { msgtype: "m.text", body: "an earlier answer" } });
    await send(text("$6", "> <@bot:x> an earlier answer\n\ntell me more", { "m.relates_to": { "m.in_reply_to": { event_id: "$mine" } } }));
    assert.deepEqual(
        calls.map((c) => c.text.replace(/^\[Replying[\s\S]*\n\n/, "")),
        ["what is a VPN?", "what is Tor?", "explain", "tell me more"],
    );
});

test("several accounts: in a shared room an unaddressed file or voice note is left alone", async () => {
    const { send, calls } = sharedSetup("!shared2");
    await send(file("$f"));
    await send({ event_id: "$v", content: { msgtype: "m.audio", body: "voice.ogg", url: "mxc://x/v", info: { mimetype: "audio/ogg", size: 10 } } });
    await sleep(WAIT + 300);
    assert.equal(calls.length, 0);
});

test("several accounts: a file, then a note to one account: only that account answers, with the file", async () => {
    const a = sharedSetup("!shared3");
    const b = sharedSetup("!shared3", { bot: "@tutor:x", cfg: { ...config, displayName: "Tutor", ownUserIds: ours() } });
    for (const s of [a, b]) await s.send(file("$f"));
    for (const s of [a, b]) await s.send(text("$n", "Zomkyi: summarize this"));
    await sleep(WAIT + 300);
    assert.deepEqual(a.calls.map((c) => [c.text, c.files]), [["summarize this", ["doc.pdf"]]]);
    assert.equal(b.calls.length, 0);
});
