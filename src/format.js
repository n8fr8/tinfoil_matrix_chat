// Converts the model's Markdown replies into the HTML subset Matrix clients
// render (see the Matrix spec, "m.room.message msgtypes" -> m.text).

import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

const MATRIX_ALLOWED_TAGS = [
    "del", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "p", "a", "ul", "ol",
    "sup", "sub", "li", "b", "i", "u", "strong", "em", "s", "code", "hr", "br",
    "div", "table", "thead", "tbody", "tr", "th", "td", "caption", "pre", "span",
    "details", "summary",
];

export function markdownToMatrixHtml(markdown) {
    const html = marked.parse(markdown, { gfm: true, breaks: false, async: false });
    return sanitizeHtml(html, {
        allowedTags: MATRIX_ALLOWED_TAGS,
        allowedAttributes: {
            a: ["href"],
            ol: ["start"],
            // Keeps "language-js" etc. so clients can syntax-highlight code blocks.
            code: ["class"],
        },
        allowedClasses: { code: [/^language-/] },
        allowedSchemes: ["http", "https", "mailto", "matrix"],
    }).trim();
}
