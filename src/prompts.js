// Topic prompts: extra guidance for particular kinds of requests (digital
// security, legal questions, history...). Each prompts/*.md file has a short
// front matter block and a body:
//
//   ---
//   name: legal
//   description: questions about laws, rights, legal processes, contracts
//   ---
//   Guidance added to the system prompt when a message is about this topic.
//
// Before each reply, a quick model call picks the topic that fits the message
// (or none), and that file's body is added to the system prompt.

import { promises as fs } from "node:fs";
import path from "node:path";
import { LogService } from "matrix-bot-sdk";

const NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Parses one prompt file. Returns null (with a warning) if it is malformed. */
export function parsePromptFile(text, file = "prompt") {
    const m = text.replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) {
        LogService.warn("melong", `Skipping ${file}: no front matter (--- name / description ---)`);
        return null;
    }
    const meta = {};
    for (const line of m[1].split(/\r?\n/)) {
        const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
        if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^(["'])(.*)\1$/, "$2");
    }
    const body = m[2].trim();
    const name = (meta.name || "").toLowerCase();
    if (!NAME.test(name) || name === "none" || !meta.description || !body) {
        LogService.warn("melong", `Skipping ${file}: needs a name (lowercase, dashes), a description and a body`);
        return null;
    }
    return { name, description: meta.description.replace(/\s+/g, " "), body };
}

/** Loads every *.md in `dir` except README.md. A missing dir means no topics. */
export async function loadPrompts(dir) {
    let files;
    try {
        files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md").sort();
    } catch (err) {
        if (err?.code === "ENOENT") return [];
        throw err;
    }
    const prompts = [];
    for (const f of files) {
        const p = parsePromptFile(await fs.readFile(path.join(dir, f), "utf8"), f);
        if (!p) continue;
        if (prompts.some((q) => q.name === p.name)) {
            LogService.warn("melong", `Skipping ${f}: duplicate topic name "${p.name}"`);
            continue;
        }
        prompts.push(p);
    }
    return prompts;
}

const CLASSIFY_INSTRUCTIONS =
    "You route chat messages to topic guidance. Read the conversation and pick the one topic that best fits " +
    "what the user is asking for in their latest message. Pick a topic only when the request is mainly about it; " +
    'small talk and unrelated requests are "none". The message may be in any language. ' +
    "Reply with only the topic name, nothing else.\n\nTopics:\n";

export class PromptLibrary {
    /**
     * @param {Array<{name:string, description:string, body:string}>} prompts
     * @param {{client: any, model: string, timeoutMs?: number}} opts
     */
    constructor(prompts, { client, model, timeoutMs = 20000 }) {
        this.prompts = prompts;
        this.byName = new Map(prompts.map((p) => [p.name, p]));
        this.client = client;
        this.model = model;
        this.timeoutMs = timeoutMs;
        this.system =
            CLASSIFY_INSTRUCTIONS + [...prompts.map((p) => `- ${p.name}: ${p.description}`), "- none: anything else"].join("\n");
    }

    get names() {
        return this.prompts.map((p) => p.name);
    }

    /**
     * Picks the topic prompt for a message, or null. Never throws.
     * @param {string} message the latest user message (text and transcripts)
     * @param {string} [context] a short summary of the recent conversation
     */
    async classify(message, context = "", { signal } = {}) {
        if (!this.prompts.length || !message.trim()) return null;
        const started = Date.now();
        try {
            const content =
                (context ? `Earlier in the conversation:\n${context}\n\n` : "") + `Latest message:\n${message.slice(0, 2000)}`;
            const res = await this.client.chat.completions.create(
                {
                    model: this.model,
                    messages: [
                        { role: "system", content: this.system },
                        { role: "user", content },
                    ],
                    // Room for a thinking model's reasoning before the one-word answer.
                    max_tokens: 2000,
                },
                { timeout: this.timeoutMs, signal },
            );
            const answer = (res?.choices?.[0]?.message?.content ?? "").toString().trim().toLowerCase();
            const name = answer.replace(/[^a-z0-9-]/g, "");
            const topic = this.byName.get(name) || null;
            LogService.info("melong", `Topic: ${topic ? topic.name : "none"} (${Date.now() - started} ms)`);
            return topic;
        } catch (err) {
            LogService.warn("melong", `Topic classification failed, using the default prompt: ${err?.message || err}`);
            return null;
        }
    }
}
