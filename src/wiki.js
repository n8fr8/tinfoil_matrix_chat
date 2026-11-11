// Per-room wikis, after Andrej Karpathy's "LLM Wiki" idea: the model keeps a
// folder of linked Markdown pages for each room, adding to it when people ask
// it to remember something, and reading it to answer questions.
//
// Storage: the container's disk is wiped on restart, so each room's wiki is
// kept in Matrix. The whole wiki is one zip, encrypted with AES-256-GCM under a
// per-room key derived from WIKI_ENCRYPTION_KEY, and uploaded to the
// homeserver's media store. The bot's private per-room account data points at
// the latest upload. The homeserver only ever sees ciphertext. The same zip,
// decrypted, is what `!wiki export` sends.

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { LogService } from "matrix-bot-sdk";

export const ACCOUNT_DATA_TYPE = "org.guardianproject.melong.wiki";
const MAGIC = Buffer.from("MWK1");
const SCHEMA_PATH = new URL("./wiki-schema.md", import.meta.url);
const MAX_PAGE_BYTES = 200 * 1024;

/** Validates and normalizes a wiki path ("people/x.md"); throws on bad input. */
export function cleanPath(input) {
    const p = String(input || "")
        .trim()
        .replace(/\\/g, "/")
        .replace(/^\.?\/+/, "")
        .replace(/\/{2,}/g, "/");
    if (!p || p.length > 200) throw new Error("path must be 1-200 characters");
    if (/[\u0000-\u001f\u007f]/.test(p)) throw new Error("path has control characters");
    if (p.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) throw new Error("path can't contain empty, '.' or '..' parts");
    return p;
}

const slug = (s) =>
    String(s || "")
        .toLowerCase()
        .normalize("NFKC")
        .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "source";

const today = () => new Date().toISOString().slice(0, 10);

/** One room's wiki, held in memory as path -> Buffer. */
export class Wiki {
    constructor(files = new Map()) {
        this.files = files;
        this.changed = new Set();
    }

    get exists() {
        return this.files.size > 0;
    }

    get bytes() {
        let n = 0;
        for (const b of this.files.values()) n += b.length;
        return n;
    }

    text(path) {
        const b = this.files.get(path);
        return b ? b.toString("utf8") : null;
    }

    pages() {
        return [...this.files.keys()].filter((p) => p.endsWith(".md")).sort();
    }

    // Seeds SCHEMA.md, index.md and log.md the first time something is written.
    async ensureSeeded() {
        if (this.exists) return;
        this.files.set("SCHEMA.md", await fs.readFile(SCHEMA_PATH));
        this.files.set("index.md", Buffer.from("# Index\n\nNothing here yet.\n"));
        this.files.set("log.md", Buffer.from("# Log\n"));
        for (const p of ["SCHEMA.md", "index.md", "log.md"]) this.changed.add(p);
    }

    put(path, data) {
        this.files.set(path, Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8"));
        this.changed.add(path);
    }

    delete(path) {
        if (this.files.delete(path)) this.changed.add(path);
    }

    /** Saves an immutable source under raw/, returning its path. */
    async saveSource(name, data, ext = "md") {
        await this.ensureSeeded();
        const base = `raw/${today()}-${slug(name)}`;
        let path = `${base}.${ext}`;
        for (let i = 2; this.files.has(path); i++) path = `${base}-${i}.${ext}`;
        this.put(path, data);
        return path;
    }

    appendLog(op, title, paths) {
        const when = new Date().toISOString().slice(0, 16).replace("T", " ");
        const list = [...paths].filter((p) => p !== "log.md").sort();
        const entry = `\n## [${when}] ${op} | ${title.replace(/\s+/g, " ").slice(0, 80)}\n${list.map((p) => `- ${p}`).join("\n")}\n`;
        this.files.set("log.md", Buffer.concat([this.files.get("log.md") || Buffer.from("# Log\n"), Buffer.from(entry)]));
        this.changed.add("log.md");
    }

    toZip() {
        const entries = {};
        for (const [p, b] of this.files) entries[p] = new Uint8Array(b.buffer, b.byteOffset, b.length);
        return Buffer.from(zipSync(entries, { level: 6, mtime: new Date() }));
    }

    static fromZip(buf) {
        const files = new Map();
        for (const [p, data] of Object.entries(unzipSync(new Uint8Array(buf)))) {
            if (!p.endsWith("/")) files.set(p, Buffer.from(data));
        }
        return new Wiki(files);
    }
}

export class WikiStore {
    /**
     * @param {import("matrix-bot-sdk").MatrixClient} client
     * @param {string} secret WIKI_ENCRYPTION_KEY (base64, at least 32 bytes)
     */
    constructor(client, secret, { maxBytes = 20 * 1024 * 1024 } = {}) {
        const key = Buffer.from(String(secret || "").trim(), "base64");
        if (key.length < 32) throw new Error("WIKI_ENCRYPTION_KEY must be at least 32 bytes, base64 encoded (e.g. `openssl rand -base64 32`)");
        this.client = client;
        this.masterKey = key;
        this.maxBytes = maxBytes;
        this.cache = new Map(); // roomId -> Wiki
        this.locks = new Map(); // roomId -> Promise
    }

    roomKey(roomId) {
        return Buffer.from(crypto.hkdfSync("sha256", this.masterKey, Buffer.from("melong-wiki-v1"), Buffer.from(roomId), 32));
    }

    encrypt(roomId, plain) {
        const iv = crypto.randomBytes(12);
        const c = crypto.createCipheriv("aes-256-gcm", this.roomKey(roomId), iv);
        c.setAAD(Buffer.from(roomId));
        const body = Buffer.concat([c.update(plain), c.final()]);
        return Buffer.concat([MAGIC, iv, body, c.getAuthTag()]);
    }

    decrypt(roomId, blob) {
        if (blob.length < 32 || !blob.subarray(0, 4).equals(MAGIC)) throw new Error("not a wiki snapshot");
        const d = crypto.createDecipheriv("aes-256-gcm", this.roomKey(roomId), blob.subarray(4, 16));
        d.setAAD(Buffer.from(roomId));
        d.setAuthTag(blob.subarray(blob.length - 16));
        return Buffer.concat([d.update(blob.subarray(16, blob.length - 16)), d.final()]);
    }

    /** Runs fn with this room's wiki, one call at a time per room. */
    withRoom(roomId, fn) {
        const prev = this.locks.get(roomId) || Promise.resolve();
        const run = prev.catch(() => {}).then(async () => fn(await this.load(roomId)));
        this.locks.set(roomId, run.catch(() => {}));
        return run;
    }

    async load(roomId) {
        if (this.cache.has(roomId)) return this.cache.get(roomId);
        try {
            return await this.fetch(roomId);
        } catch (err) {
            err.wikiLoad = true; // lets callers carry on without the wiki
            throw err;
        }
    }

    async fetch(roomId) {
        let pointer = null;
        try {
            pointer = await this.client.getRoomAccountData(ACCOUNT_DATA_TYPE, roomId);
        } catch (err) {
            if (err?.body?.errcode !== "M_NOT_FOUND" && err?.statusCode !== 404) throw err;
        }
        let wiki = new Wiki();
        if (pointer?.mxc) {
            const { data } = await this.client.downloadContent(pointer.mxc);
            try {
                wiki = Wiki.fromZip(this.decrypt(roomId, Buffer.from(data)));
            } catch (err) {
                // Don't continue with an empty wiki: the next save would replace the real one.
                throw new Error(`couldn't decrypt this room's wiki (wrong WIKI_ENCRYPTION_KEY?): ${err.message}`);
            }
            LogService.info("melong", `Loaded wiki for ${roomId}: ${wiki.files.size} files, ${wiki.bytes} bytes`);
        }
        this.cache.set(roomId, wiki);
        return wiki;
    }

    /** Uploads the room's wiki if anything changed. */
    async save(roomId, wiki) {
        if (!wiki.changed.size) return false;
        const blob = this.encrypt(roomId, wiki.toZip());
        const mxc = await this.client.uploadContent(blob, "application/octet-stream", "wiki.bin");
        await this.client.setRoomAccountData(ACCOUNT_DATA_TYPE, roomId, {
            mxc,
            updated: new Date().toISOString(),
            bytes: blob.length,
        });
        LogService.info("melong", `Saved wiki for ${roomId}: ${wiki.changed.size} changed, ${wiki.files.size} files, ${blob.length} bytes`);
        wiki.changed.clear();
        return true;
    }

    /** Empties the room's wiki (old uploads stay on the homeserver, unreadable without the key). */
    async clear(roomId) {
        await this.client.setRoomAccountData(ACCOUNT_DATA_TYPE, roomId, { cleared: new Date().toISOString() });
        this.cache.set(roomId, new Wiki());
    }
}

// ---- Tools the model uses to work on the wiki ----

export const WIKI_TOOLS = [
    tool("wiki_list", "List every file in this room's wiki, with sizes.", {}),
    tool("wiki_read", "Read a wiki file.", { path: str("File path, e.g. index.md or people/trisong-detsen.md") }, ["path"]),
    tool(
        "wiki_search",
        "Case-insensitive text search across all wiki pages. Returns matching lines with their paths.",
        { query: str("Words or phrase to find") },
        ["query"],
    ),
    tool(
        "wiki_write",
        "Create or replace a wiki page (Markdown). Only when someone asked you to remember, add, update or fix something in the wiki, or for a !wiki command.",
        { path: str("Page path ending in .md, e.g. topics/samye.md"), content: str("The whole new page content") },
        ["path", "content"],
    ),
    tool("wiki_delete", "Delete a wiki page (e.g. after merging it into another). Same rules as wiki_write.", { path: str("Page path") }, ["path"]),
    tool(
        "wiki_save_source",
        "Save the material being remembered (a message, a transcript, notes from a file) as an immutable source under raw/. Returns its path, to cite in pages.",
        { title: str("Short title"), content: str("The source text, as faithfully as possible") },
        ["title", "content"],
    ),
];

function tool(name, description, properties, required = []) {
    return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}
function str(description) {
    return { type: "string", description };
}

/** Runs one tool call against a wiki. Returns the text for the model. */
export async function runWikiTool(wiki, name, args, { maxBytes = 20 * 1024 * 1024 } = {}) {
    try {
        switch (name) {
            case "wiki_list": {
                if (!wiki.exists) return "This room has no wiki yet. It is created on the first write.";
                return [...wiki.files.entries()]
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([p, b]) => `${p} (${b.length} bytes)`)
                    .join("\n");
            }
            case "wiki_read": {
                const path = cleanPath(args.path);
                const b = wiki.files.get(path);
                if (!b) return `No file ${path}. Use wiki_list to see what exists.`;
                if (!path.endsWith(".md") && !path.endsWith(".txt")) return `${path} is a ${b.length}-byte binary file.`;
                return b.toString("utf8");
            }
            case "wiki_search": {
                const q = String(args.query || "").toLowerCase().trim();
                if (!q) return "Empty query.";
                const hits = [];
                for (const p of wiki.pages()) {
                    wiki.text(p).split("\n").forEach((line, i) => {
                        if (hits.length < 40 && line.toLowerCase().includes(q)) hits.push(`${p}:${i + 1}: ${line.slice(0, 200)}`);
                    });
                }
                return hits.length ? hits.join("\n") : `No matches for "${args.query}".`;
            }
            case "wiki_write": {
                const path = cleanPath(args.path);
                if (!path.endsWith(".md")) return "Pages must end in .md.";
                if (path === "log.md") return "log.md is kept automatically; don't write it.";
                if (path.startsWith("raw/")) return "raw/ holds original sources and can't be edited; use wiki_save_source for new ones.";
                const content = String(args.content ?? "");
                if (Buffer.byteLength(content) > MAX_PAGE_BYTES) return `Page too large (max ${MAX_PAGE_BYTES / 1024} KB); split it into several pages.`;
                if (wiki.bytes + Buffer.byteLength(content) > maxBytes) return "The wiki is full; nothing was written.";
                await wiki.ensureSeeded();
                const existed = wiki.files.has(path);
                wiki.put(path, content);
                return `${existed ? "Updated" : "Created"} ${path}.`;
            }
            case "wiki_delete": {
                const path = cleanPath(args.path);
                if (["SCHEMA.md", "index.md", "log.md"].includes(path) || path.startsWith("raw/")) return `${path} can't be deleted.`;
                if (!wiki.files.has(path)) return `No file ${path}.`;
                wiki.delete(path);
                return `Deleted ${path}. Remember to remove it from index.md and fix links to it.`;
            }
            case "wiki_save_source": {
                const content = String(args.content ?? "");
                if (!content.trim()) return "Nothing to save.";
                if (wiki.bytes + Buffer.byteLength(content) > maxBytes) return "The wiki is full; nothing was saved.";
                const path = await wiki.saveSource(args.title, `# ${String(args.title || "Source").trim()}\n\nSaved ${today()}.\n\n${content}\n`);
                return `Saved ${path}.`;
            }
            default:
                return `Unknown tool ${name}.`;
        }
    } catch (err) {
        return `Error: ${err?.message || err}`;
    }
}

/** System prompt section for a room's wiki. */
export function wikiInstructions(wiki, schemaText) {
    const index = wiki.text("index.md");
    const schema = wiki.text("SCHEMA.md") || schemaText;
    return (
        "\n\nThis room has a wiki that you maintain with the wiki_* tools (see its schema below). " +
        "Read it when it helps answer: check the index, then read the relevant pages, and mention which pages you used. " +
        "Only change it when someone asks you to remember, save, note, add or update something, or uses a !wiki command; " +
        "then follow the schema and say briefly what you changed. " +
        "If someone shares something that seems worth keeping but didn't ask, you may offer once, in one short sentence, to add it to the room's wiki; " +
        "don't offer repeatedly, and don't write anything until they say yes. " +
        "Use the tools quietly: don't describe tool calls, just give the answer.\n\n" +
        `Wiki schema (SCHEMA.md):\n${schema}\n\n` +
        (index ? `Current index.md:\n${index.length > 8000 ? index.slice(0, 8000) + "\n[...truncated; use wiki_read]" : index}` : "This room has no wiki yet; it is created on the first write.")
    );
}

export async function defaultSchema() {
    return fs.readFile(SCHEMA_PATH, "utf8");
}
