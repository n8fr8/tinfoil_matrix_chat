// Offline unit tests for the pure parts: message splitting, cross-signing
// signatures, room memory (wiki) storage and tools, and topic prompt files.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { splitMessage, weightedLength } from "../src/split.js";
import { canonicalJson, crossSigningUploadBody, generateCrossSigningKeys, parseCrossSigningKey } from "../src/cross-signing.js";
import { Wiki, WikiStore, cleanPath, runWikiTool } from "../src/wiki.js";
import { loadPrompts, parsePromptFile } from "../src/prompts.js";
import { forSpeech } from "../src/melong.js";

const squash = (s) => s.replace(/\s+/g, "");

test("splitMessage: paragraphs and sentences, nothing lost, all pieces fit", () => {
    const text = Array.from({ length: 6 }, (_, i) => `Paragraph ${i}. ` + "Some sentence here. ".repeat(10)).join("\n\n");
    const parts = splitMessage(text, 500);
    assert.ok(parts.length > 1 && parts.every((p) => p.length <= 500));
    assert.equal(squash(parts.join("")), squash(text));
});

test("splitMessage: Tibetan splits at the shad; code blocks are re-fenced", () => {
    const tib = "བོད་ཀྱི་ལོ་རྒྱུས་ནི་ཧ་ཅང་རིང་པོ་ཡིན། ".repeat(40);
    assert.ok(splitMessage(tib, 300).slice(0, -1).every((p) => p.endsWith("།")));
    const code = "```js\n" + Array.from({ length: 40 }, (_, i) => `const x${i} = ${i};`).join("\n") + "\n```";
    assert.ok(splitMessage(code, 300).every((p) => p.startsWith("```js") && p.endsWith("```")));
});

test("weightedLength counts CJK as 3 (voxtral-tts limit)", () => {
    assert.equal(weightedLength("ab中"), 5);
    assert.ok(splitMessage("这是一个句子。".repeat(400), 2000, weightedLength).every((p) => weightedLength(p) <= 2000));
});

test("forSpeech drops citation links and URLs", () => {
    assert.equal(forSpeech("News [Phayul](https://x.y/a), [B](https://d.e). See https://foo.bar now"), "News. See now");
});

test("cross-signing: canonical JSON, key round trip, valid signature", () => {
    assert.equal(canonicalJson({ b: "2", a: [1, { z: null, y: true }] }), '{"a":[1,{"y":true,"z":null}],"b":"2"}');
    const { secret, keys } = generateCrossSigningKeys();
    assert.equal(parseCrossSigningKey(secret).master.publicKey, keys.master.publicKey);
    const { signatures, ...ssk } = crossSigningUploadBody("@u:x", keys).self_signing_key;
    const pub = crypto.createPublicKey({
        key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(keys.master.publicKey, "base64")]),
        format: "der",
        type: "spki",
    });
    assert.ok(crypto.verify(null, Buffer.from(canonicalJson(ssk)), pub, Buffer.from(signatures["@u:x"][keys.master.keyId], "base64")));
    assert.throws(() => parseCrossSigningKey("garbage"));
});

function fakeMatrix() {
    const media = new Map();
    const accountData = new Map();
    return {
        media,
        async uploadContent(buf) {
            const id = `mxc://test/${media.size}`;
            media.set(id, Buffer.from(buf));
            return id;
        },
        async downloadContent(mxc) {
            return { data: media.get(mxc) };
        },
        async getRoomAccountData(type, room) {
            if (!accountData.has(type + room)) throw Object.assign(new Error("not found"), { body: { errcode: "M_NOT_FOUND" } });
            return accountData.get(type + room);
        },
        async setRoomAccountData(type, room, content) {
            accountData.set(type + room, content);
        },
    };
}

test("room memory: tools, encrypted save, reload, export, wrong key", async () => {
    const matrix = fakeMatrix();
    const key = crypto.randomBytes(32).toString("base64");
    const store = new WikiStore(matrix, key);
    await store.withRoom("!r", async (wiki) => {
        assert.match(await runWikiTool(wiki, "wiki_write", { path: "people/tenzin.md", content: "# Tenzin\n\nBrings momos." }), /Created/);
        assert.match(await runWikiTool(wiki, "wiki_save_source", { title: "Picnic", content: "Tenzin brings momos" }), /Saved raw\//);
        assert.match(await runWikiTool(wiki, "wiki_write", { path: "log.md", content: "x" }), /automatically/);
        assert.match(await runWikiTool(wiki, "wiki_write", { path: "../etc/passwd.md", content: "x" }), /Error/);
        assert.match(await runWikiTool(wiki, "wiki_search", { query: "momos" }), /people\/tenzin\.md/);
        wiki.appendLog("update", "remember this", wiki.changed);
        await store.save("!r", wiki);
    });
    assert.ok(![...matrix.media.values()].some((b) => b.includes("momos")), "homeserver only sees ciphertext");

    const reloaded = await new WikiStore(matrix, key).load("!r");
    assert.ok(reloaded.files.has("SCHEMA.md") && reloaded.files.has("index.md") && reloaded.files.has("people/tenzin.md"));
    assert.match(reloaded.text("log.md"), /update \| remember this/);
    assert.equal(Wiki.fromZip(reloaded.toZip()).files.size, reloaded.files.size);

    await assert.rejects(new WikiStore(matrix, crypto.randomBytes(32).toString("base64")).load("!r"), (err) => err.wikiLoad === true);
    assert.throws(() => cleanPath("a/../b"));
});

test("topic prompts: every file in prompts/ parses", async () => {
    const prompts = await loadPrompts(new URL("../prompts", import.meta.url).pathname);
    assert.ok(prompts.length >= 4);
    for (const p of prompts) assert.ok(p.name && p.description && p.body.length > 200, p.name);
    assert.equal(parsePromptFile("no front matter", "x.md"), null);
});
