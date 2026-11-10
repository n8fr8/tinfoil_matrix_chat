# Topic prompts

Each `.md` file here (except this README) adds guidance for one kind of request. Before every reply, the bot asks a model which topic fits the user's message, using each file's `description`. If one fits, that file's body is added to the system prompt. Otherwise the reply uses the default prompt only.

## File format

```markdown
---
name: history
description: explaining historical events, people, periods, or the history of a place or culture
---
Guidance for the model, written as instructions to it...
```

- **`name`:** lowercase letters, digits and dashes; unique. `none` is reserved.
- **`description`:** one line. This is all the classifier sees, so describe what kind of request belongs here, not how to answer it.
- **Body:** the instructions added to the system prompt. Write for both text and voice replies. Voice replies have their own formatting rules (no lists or links), which take priority.

## Adding or changing a topic

1. Add or edit a file here.
2. Test locally with `npm start` and a message that should match. The log shows `Topic: <name> (N ms)` for every message.
3. Release as usual; the folder is copied into the container image.

Settings: `PROMPTS_DIR` (default `./prompts`; empty turns topics off) and `PROMPT_CLASSIFIER_MODEL` (default: `TINFOIL_MODEL`).
