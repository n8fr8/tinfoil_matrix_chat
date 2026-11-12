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

test("PDF documents: title handling, sanitizing, file names", async () => {
    const { documentHtml, pdfFilename, pdfAvailable, renderPdf } = await import("../src/pdf.js");
    const body = (h) => h.slice(h.indexOf("<body>"));
    assert.match(body(documentHtml("Phone Security", "# Phone Security\n\ntext\n\n# Part two")), /^<body><h1>Phone Security<\/h1>.*<p>text<\/p>\s*<h2>Part two<\/h2>/s);
    assert.match(body(documentHtml("ལོ་གསར།", "# ངོ་སྤྲོད།\n\nཚིག")), /<h1>ལོ་གསར།<\/h1>.*<h2>ངོ་སྤྲོད།<\/h2>/s);
    assert.match(documentHtml("ལོ་གསར།", "བོད་ཀྱི་ལོ་རྒྱུས།"), /<html lang="bo">/);
    const unsafe = body(documentHtml("x", '<img src="file:///etc/passwd"><script>1</script>[a](javascript:alert(1))<style>p{}</style><link href="http://x">'));
    assert.doesNotMatch(unsafe, /img|script|javascript|<style|<link/);
    assert.equal(pdfFilename("ལོ་གསར་གྱི་སྲོལ་རྒྱུན།"), "ལོ་གསར་གྱི་སྲོལ་རྒྱུན.pdf");
    assert.equal(pdfFilename("Phone Security: Basics!"), "Phone-Security-Basics.pdf");
    // Rendering itself needs WeasyPrint (installed in the Docker image).
    if (await pdfAvailable()) assert.equal((await renderPdf("t", "བོད་ཡིག")).subarray(0, 4).toString(), "%PDF");
});

test("media forensics: inspect_media reports hash, Content Credentials and zip contents", async () => {
    const { forensicsTools, inspectAttachment, isZip, runInspectTool } = await import("../src/forensics.js");
    const { readFile } = await import("node:fs/promises");
    const { zipSync } = await import("fflate");
    assert.match(await runInspectTool([], {}, {}), /No file is attached/);
    const jpg = { filename: "c2pa-sample.jpg", mimetype: "image/jpeg", data: await readFile(new URL("fixtures/c2pa-sample.jpg", import.meta.url)) };
    assert.match(await runInspectTool([jpg], { filename: "other.png" }, {}), /No attached file matches/);
    const zip = { filename: "bundle.zip", mimetype: "application/octet-stream", data: Buffer.from(zipSync({ "c2pa-sample.jpg": new Uint8Array(jpg.data), "x.proof.json": new TextEncoder().encode("{}") })) };
    assert.ok(isZip(zip) && !isZip(jpg));
    // The rest needs c2patool and exiftool (installed in the Docker image).
    const tools = await forensicsTools();
    if (!tools) return;
    const r = await inspectAttachment(jpg, tools);
    assert.equal(r.sha256, crypto.createHash("sha256").update(jpg.data).digest("hex"));
    assert.equal(r.content_credentials.present, true);
    assert.equal(r.content_credentials.validation_state, "Valid", "signed by c2patool's sample certificate, which isn't on a trust list");
    assert.ok(r.content_credentials.failures.some((f) => f.startsWith("signingCredential.untrusted")));
    assert.equal(r.metadata["File:FileType"], "JPEG");
    const plain = await inspectAttachment({ filename: "p.png", mimetype: "image/png", data: Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cfc0f01f00050001ff89993d1d0000000049454e44ae426082", "hex") }, tools);
    assert.equal(plain.content_credentials.present, false);
    const z = await inspectAttachment(zip, tools);
    assert.ok(z.contents.some((c) => c.startsWith("c2pa-sample.jpg")));
    assert.equal(z.media["c2pa-sample.jpg"].content_credentials.validation_state, "Valid", "one media file: full report");
    // Nested zip with two photos and a sidecar: both bundles checked, brief per-media reports, sidecar shown.
    const inner = zipSync({ "a.jpg": new Uint8Array(jpg.data), "b.jpg": new Uint8Array(jpg.data), "x.ipfs-cids.json": new TextEncoder().encode('{"cid":"bafy"}') });
    const outer = { filename: "pack.zip", mimetype: "application/zip", data: Buffer.from(zipSync({ "inner.zip": inner, "c.jpg": new Uint8Array(jpg.data) })) };
    const n = await inspectAttachment(outer, tools);
    assert.deepEqual(n.nested_zips, ["inner.zip"]);
    assert.deepEqual(Object.keys(n.media).sort(), ["c.jpg", "inner.zip/a.jpg", "inner.zip/b.jpg"]);
    assert.equal(n.media["inner.zip/a.jpg"].content_credentials.validation_state, "Valid");
    assert.ok(n.media["inner.zip/a.jpg"].content_credentials.signer, "brief C2PA keeps the signer");
    assert.equal(n.other_files["inner.zip/x.ipfs-cids.json"], '{"cid":"bafy"}');
    if (tools.proofmode) assert.deepEqual(Object.keys(n.proofmode_check), ["pack.zip", "inner.zip"]);
    // Previews: downscaled JPEGs of photos inside (needs ffmpeg).
    const { bundleImages } = await import("../src/forensics.js");
    const previews = await bundleImages(outer, 2).catch(() => null);
    if (previews?.length) assert.ok(previews.length === 2 && previews.every((p) => p.mimetype === "image/jpeg" && p.data.subarray(0, 2).toString("hex") === "ffd8"));
    assert.match(await runInspectTool([jpg], {}, tools), /^Inspection report[\s\S]*"validation_state":"Valid"/);
});

test("media forensics: proofmode check report is trimmed to what matters", async () => {
    const { proofcheckSummary } = await import("../src/forensics.js");
    const raw = {
        metadata: { fileCount: 1 },
        keys: [{ key: Array(3000).fill(45) }],
        files: [
            {
                name: "a.jpg",
                hash: "ab".repeat(32),
                mimeType: "image/jpeg",
                data: Array(100000).fill(1),
                json: { device: { model: "Pixel 9" } },
                integrity: {
                    pgp: { media: { verified: true, key_id: "8b9b", key: Array(3000).fill(1), details: "" }, json: { verified: true, key_id: "8b9b" } },
                    c2pa: { manifest_info: { big: "x".repeat(5000) } },
                    opentimestamps: { verified: true, digest_type: "SHA256", timestamp: "x\n result attested by Pending: update URI https://a.example\n result attested by Pending: update URI https://a.example\n" },
                },
            },
        ],
        errors: [],
        integrity: { pgp: { media: 1, proof: 1 }, c2pa: 1, opentimestamps: 1 },
        consistency: {
            verified: false,
            summary: { totalFiles: 2, totalFlags: 3 },
            fileDiscrepancies: [
                { fileName: "a.jpg", flags: [{ severity: "warning", kind: "missingData", message: "network.ipv4 is missing" }] },
                { fileName: "b.jpg", flags: [{ severity: "warning", kind: "missingData", message: "network.ipv4 is missing" }, { severity: "error", kind: "mismatch", message: "EXIF Model differs" }] },
            ],
        },
        synchrony: { verified: true },
    };
    const s = proofcheckSummary(raw);
    assert.ok(JSON.stringify(s).length < 2000);
    assert.equal(s.files[0].sha256, "ab".repeat(32));
    assert.deepEqual(s.files[0].pgp_signature.media, { verified: true, key_id: "8b9b", details: "" });
    assert.deepEqual(s.files[0].opentimestamps.attestations, ["Pending: update URI https://a.example"]);
    assert.equal(s.consistency.verified, false);
    assert.deepEqual(s.consistency.flags, { "warning (missingData): network.ipv4 is missing": "all 2 files", "error (mismatch): EXIF Model differs": "b.jpg" });
});

test("media forensics: proofmode's huge JSON is streamed with byte arrays dropped", async () => {
    const { JsonByteArrayFilter } = await import("../src/forensics.js");
    const doc = {
        keys: [{ key: Array.from({ length: 3000 }, (_, i) => i % 256) }],
        files: [{ name: "a [1, 2] \"q\".jpg", data: Array(5000).fill(7), coords: [-71.125, 42.3286], empty: [], nested: [[1, 2], ["x"]] }],
        ok: true,
    };
    const text = "Status: Starting ProofCheck\nStatus: Checking integrity\n" + JSON.stringify(doc, null, 2) + "\nOutput written\n";
    const f = new JsonByteArrayFilter();
    const bytes = Buffer.from(text);
    for (let i = 0; i < bytes.length; i += 7) f.write(bytes.subarray(i, i + 7)); // odd chunk size: arrays split across chunks
    const out = JSON.parse(f.result());
    assert.equal(out.keys[0].key, "[3000 numbers omitted]");
    assert.equal(out.files[0].data, "[5000 numbers omitted]");
    assert.deepEqual(out.files[0].coords, [-71.125, 42.3286]);
    assert.deepEqual(out.files[0].empty, []);
    assert.deepEqual(out.files[0].nested, [[1, 2], ["x"]]);
    assert.equal(out.files[0].name, 'a [1, 2] "q".jpg');
    assert.equal(out.ok, true);
});
