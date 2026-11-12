// Makes PDF documents from Markdown, for when someone asks for a document,
// a printable version or a PDF. Rendering is done by WeasyPrint (HTML -> PDF),
// which shapes complex scripts properly (Tibetan stacks, Devanagari conjuncts,
// CJK) with the Noto fonts installed in the image. See the Dockerfile.

import { spawn } from "node:child_process";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { LogService } from "matrix-bot-sdk";

const WEASYPRINT = process.env.WEASYPRINT || "weasyprint";
const MAX_MARKDOWN_CHARS = 200_000;
const TIMEOUT_MS = 90_000;

// Only plain document structure: no images, styles, scripts or embeds, so
// WeasyPrint never fetches anything (files or URLs) while rendering.
const ALLOWED_TAGS = [
    "h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "hr", "blockquote",
    "ul", "ol", "li", "dl", "dt", "dd", "strong", "b", "em", "i", "u", "s", "del", "sup", "sub",
    "code", "pre", "a", "table", "thead", "tbody", "tr", "th", "td", "span", "div",
];

const CSS = `
@page {
  size: A4;
  margin: 2.2cm 2cm;
  @bottom-center { content: counter(page) " / " counter(pages); font-size: 9pt; color: #777; }
}
html { font-family: "Noto Serif", "Noto Serif Tibetan", "Noto Serif Devanagari", "Noto Serif CJK SC", "Noto Sans CJK SC", serif;
       font-size: 11pt; line-height: 1.5; color: #111; }
html:lang(bo) { font-size: 13pt; line-height: 1.85; }
h1, h2, h3, h4 { font-family: "Noto Sans", "Noto Serif Tibetan", "Noto Sans Devanagari", "Noto Sans CJK SC", sans-serif;
                 line-height: 1.3; page-break-after: avoid; }
h1 { font-size: 20pt; margin: 0 0 0.2em; }
h2 { font-size: 15pt; margin-top: 1.4em; border-bottom: 1px solid #ccc; padding-bottom: 0.15em; }
h3 { font-size: 12.5pt; margin-top: 1.2em; }
.meta { color: #666; font-size: 9pt; margin-bottom: 1.6em; }
a { color: #1a4f8b; text-decoration: none; }
blockquote { margin: 1em 0; padding: 0.2em 1em; border-left: 3px solid #bbb; color: #444; }
code { font-family: "Noto Sans Mono", monospace; font-size: 9.5pt; background: #f3f3f3; padding: 0 0.2em; }
pre { background: #f3f3f3; padding: 0.7em; white-space: pre-wrap; page-break-inside: avoid; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; margin: 1em 0; width: 100%; page-break-inside: auto; }
th, td { border: 1px solid #aaa; padding: 0.3em 0.6em; text-align: left; vertical-align: top; }
th { background: #eee; }
tr { page-break-inside: avoid; }
li { margin: 0.2em 0; }
`;

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Mostly-Tibetan text gets a larger size and line height; Tibetan stacks are tall.
function documentLanguage(text) {
    const letters = text.match(/\p{L}/gu) || [];
    const tibetan = text.match(/[ཀ-ྼ]/g) || [];
    return letters.length && tibetan.length / letters.length > 0.5 ? "bo" : "";
}

/** A safe file name from a title: keeps letters in any script, ends in .pdf. */
export function pdfFilename(title) {
    const base = String(title || "document")
        .normalize("NFKC")
        .replace(/[^\p{L}\p{M}\p{N}\u0F0B]+/gu, "-") // keeps the Tibetan tsheg
        .replace(/^[-\u0F0B]+|[-\u0F0B]+$/g, "")
        .slice(0, 60);
    return `${base || "document"}.pdf`;
}

/** Builds the HTML for a document (exported for tests). */
export function documentHtml(title, markdown, { date = new Date() } = {}) {
    const body = sanitizeHtml(marked.parse(String(markdown || ""), { gfm: true, breaks: false }), {
        allowedTags: ALLOWED_TAGS,
        allowedAttributes: { a: ["href"], th: ["colspan", "rowspan"], td: ["colspan", "rowspan"] },
        allowedSchemes: ["http", "https", "mailto"],
    });
    // The document title is always the one top heading: drop a first heading
    // that repeats it, and turn any other top-level headings into sections.
    const plain = (h) => h.replace(/<[^>]+>/g, "").replace(/[\s\u0F0B\u0F0D:—–-]+/g, "").toLowerCase();
    const first = body.match(/^\s*<h1>([\s\S]*?)<\/h1>/);
    let content = first && plain(first[1]) === plain(escapeHtml(title)) ? body.slice(first[0].length) : body;
    content = content.replace(/<(\/?)h1>/g, "<$1h2>");
    const lang = documentLanguage(`${title} ${markdown}`);
    return `<!doctype html><html${lang ? ` lang="${lang}"` : ""}><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${CSS}</style></head><body><h1>${escapeHtml(
        title,
    )}</h1><div class="meta">${date.toISOString().slice(0, 10)}</div>${content}</body></html>`;
}

/** Renders Markdown to a PDF Buffer. */
export async function renderPdf(title, markdown) {
    if (String(markdown || "").length > MAX_MARKDOWN_CHARS) throw new Error(`document too long (max ${MAX_MARKDOWN_CHARS} characters)`);
    const html = documentHtml(title, markdown);
    return new Promise((resolve, reject) => {
        // "-" in, "-" out; base URL set to a non-existent file so nothing relative resolves.
        const proc = spawn(WEASYPRINT, ["--base-url", "file:///nonexistent/", "-", "-"], { stdio: ["pipe", "pipe", "pipe"] });
        const out = [];
        let err = "";
        const timer = setTimeout(() => proc.kill("SIGKILL"), TIMEOUT_MS);
        proc.stdout.on("data", (d) => out.push(d));
        proc.stderr.on("data", (d) => (err += d).length > 4000 && (err = err.slice(-4000)));
        proc.on("error", (e) => {
            clearTimeout(timer);
            reject(new Error(`couldn't run WeasyPrint (${WEASYPRINT}): ${e.message}`));
        });
        proc.on("close", (code) => {
            clearTimeout(timer);
            const pdf = Buffer.concat(out);
            if (code === 0 && pdf.subarray(0, 4).toString() === "%PDF") resolve(pdf);
            else reject(new Error(`PDF rendering failed (exit ${code}): ${err.trim().split("\n").slice(-2).join(" ")}`));
        });
        proc.stdin.end(html);
    });
}

/** Whether WeasyPrint is installed; checked once at startup. */
export async function pdfAvailable() {
    try {
        await new Promise((resolve, reject) => {
            const p = spawn(WEASYPRINT, ["--version"], { stdio: "ignore" });
            p.on("error", reject);
            p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
        });
        return true;
    } catch (err) {
        LogService.info("melong", `PDF documents off: WeasyPrint not found (${err.message})`);
        return false;
    }
}

export const PDF_TOOL = {
    type: "function",
    function: {
        name: "create_pdf",
        description:
            "Create a PDF document and attach it to your reply. Use when someone asks for a document, a printable version, a PDF, a handout or a report.",
        parameters: {
            type: "object",
            properties: {
                title: { type: "string", description: "Document title (also used for the file name)" },
                content: {
                    type: "string",
                    description: "The full document in Markdown: headings, paragraphs, lists, tables. No images. Don't repeat the title as the first heading.",
                },
            },
            required: ["title", "content"],
        },
    },
};

export const PDF_INSTRUCTIONS =
    "\n\nYou can make PDF documents with the create_pdf tool. Use it when someone asks for a document, a printable or downloadable version, " +
    "a PDF, a handout, a worksheet or a report. Put the complete document in the content, in Markdown with clear headings, lists and tables, " +
    "written in the language the user is using. To turn an earlier answer into a PDF, use that answer's content (you may tidy the formatting). " +
    "The file is attached right after your message, so your chat reply should only say in a sentence or two what the document contains; " +
    "don't paste the document into the chat.";
