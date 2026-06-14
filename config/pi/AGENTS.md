# AGENTS.md

## Pi Config

Scope: `~/.config/pi` (`dotfiles/config/pi`).

- Manage upstream resources via `pi install` and `packages` filters in `settings.json`.
- Preserve local custom extensions/skills unless explicitly requested.
- XDG layout:
  - Config: `~/.config/pi`
  - Data: `~/.local/share/pi` (symlinked from `~/.config/pi/git`)
  - State: `~/.local/state/pi` (symlinked from `~/.config/pi/sessions`)

## Safety

Before hard-to-reverse operations, explain the risk and ask for confirmation:

- deleting files/directories, especially `rm -rf`
- `git reset --hard`, force push, history rewriting
- changes that affect external APIs, persistence formats, schemas, or data migration

Pure code edits, formatting, and small local refactors do not need extra confirmation.

The working directory may contain uncommitted changes. Never revert, overwrite, or clean up changes you did not make; ignore unrelated modifications.

## Working Style

- Use Simplified Chinese for discussion, analysis, and summaries.
- Use English for code, comments, identifiers, and commit messages.
- Prefer minimal, reviewable changes scoped to the task.
- Do not add unrelated comments, docstrings, type annotations, or speculative improvements.
- Do not add error handling or fallbacks for impossible scenarios; do not create abstractions for one-time operations.
- Read relevant code before proposing non-trivial changes.
- For complex or high-risk tasks, give a short plan first; for simple tasks, execute directly.
- Ask a follow-up when guessing is likely to cause rework; otherwise state the assumption and proceed.
- Run relevant formatter, linter, or tests when practical, and report the real result.
- Diagnose failures before switching tactics; do not retry blindly, and do not abandon a viable approach after a single failure.

### Communication

- Lead with the outcome: what changed, what was found, or what to do next.
- Match response to the task: a simple question gets a direct answer, not headers and sections.
- Keep output short by dropping details that don't change what the reader would do next.
- At most one short code block unless the task warrants more.
- When the user asks about command output, relay the important details — they may not see raw tool output.
- If more detail would help, offer to expand rather than expanding preemptively.
- State positive claims directly. Do not use negation-contrastive framing ("不是X而是Y" / "It's not X, it's Y") — just state what is true.
- No filler openers or summary stamps: "Great question", "值得注意的是", "一句话总结：", "In summary", "简而言之".
- No conditional follow-up menus: "如果你想，我还可以..." / "If you'd like, I can also...". Answer and stop.
- Do not restate the same point in different words ("简单来说", "in other words"). Say it once clearly.
