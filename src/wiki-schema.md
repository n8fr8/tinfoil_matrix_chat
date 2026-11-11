# Wiki schema

This wiki belongs to one Matrix room. The assistant writes and maintains it; people in the room add to it by asking the assistant to remember things. It follows Andrej Karpathy's "LLM Wiki" idea: knowledge is compiled into linked pages once and kept current, instead of being rediscovered from chat history every time.

## Layout

- `SCHEMA.md`: this file. The rules for maintaining the wiki. Change it only when someone in the room asks for different conventions.
- `index.md`: a catalog of every page, grouped by category, one line each: `- [Title](path.md): one-line summary`. Update it whenever a page is added, renamed or removed.
- `log.md`: a chronological record of changes. The bot appends to it automatically; never edit it.
- `raw/`: original sources (remembered messages, shared files). They are never changed after they are saved.
- Pages, in folders by kind:
  - `people/`: people and groups
  - `places/`
  - `topics/`: concepts, ideas, subjects
  - `events/`
  - `sources/`: a summary page for each saved source, with key points and links to the pages it informed
  - `notes/`: anything that fits nowhere else (decisions, lists, how-tos, answers worth keeping)

## Pages

- File names: lowercase words joined by dashes, ending in `.md`, e.g. `people/trisong-detsen.md`. Names in other scripts may be used when there is no common Latin spelling.
- Start with `# Title`, then a one or two sentence summary, then the details.
- Link related pages with relative Markdown links, e.g. `[Samye](../places/samye.md)`, so the wiki works in any Markdown viewer.
- End with `## Sources`, listing the `raw/` files or other pages the facts came from.
- Write in the language the room uses. For Tibetan names and terms, give the Tibetan script with a common English spelling.
- Keep facts separate from opinions, and say who holds an opinion.
- When new information contradicts a page, don't silently overwrite it: keep both, mark it with `> **Conflict:**`, and say which source says what.

## Operations

- **Remember / ingest:** when someone asks to remember something, save the material with `wiki_save_source`, write or update a summary page in `sources/`, then update every page the material touches (often several), creating pages for new people, places or topics. Update `index.md`. Tell the person briefly what changed.
- **Query:** when answering a question, check `index.md` and read the relevant pages first. Cite pages by path. If an answer is worth keeping and the person agrees, file it as a page in `notes/`.
- **Lint:** look for contradictions, outdated claims, pages with no links pointing to them, topics mentioned without their own page, missing links between pages, and index entries that don't match the pages. Fix what you can and report the rest.
