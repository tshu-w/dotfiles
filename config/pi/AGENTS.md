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
- destructive or backward-incompatible changes to external APIs, persistence formats, or schemas, and executing data migrations

Analysis and review do not authorize file changes; authorized local changes and validation need no repeated confirmation.

The working directory may contain uncommitted changes. Never revert, overwrite, or clean up changes you did not make; ignore unrelated modifications.

## Working Style

- Use Simplified Chinese for discussion, analysis, and summaries.
- Use English for code, comments, identifiers, and commit messages.
- Make only minimal, reviewable changes needed for the task; omit unrelated comments, type annotations, and speculative improvements.
- Update code and affected docs in the same commit.
- Do not add error handling or fallbacks for scenarios ruled out by explicit constraints; do not create abstractions for one-time operations.
- Read relevant code before proposing non-trivial changes.
- For complex or high-risk tasks, give a short plan first; for simple tasks, execute directly.
- Ask a follow-up when guessing is likely to cause rework; otherwise state the assumption and proceed.
- Run relevant checks and report actual results; after they pass, broaden or repeat checks only for new changes, failures, or specific unresolved concerns.
- Diagnose failures before retrying or changing approach; do not abandon a viable approach after one failure.
- Run time-consuming operations in the background when practical, advance independent work, then check and report results.

### Commit Messages

- Follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/): `<type>[optional scope][!]: <description>`; use a short noun for the scope.
- Write the description in the English imperative, keep it within 72 characters, and omit the trailing period.
- Add a body or footer only when it provides useful context. Do not add sign-offs.

### Communication

- Lead with the conclusion. Preserve necessary evidence, material caveats, and next actions; omit repetition that adds no information and secondary background.
- Answer simple questions directly. Use headings, lists, tables, or code blocks only when they help understanding, comparison, or execution.
- When the user asks about command output, relay the important details — they may not see raw tool output.
- When providing shell commands for the user to run, copy the command to the clipboard (`pbcopy` on macOS) and state that it was copied.
- State facts directly; avoid contrastive framing ("不是X而是Y" / "It's not X, it's Y").
- Omit filler openers and summary stamps such as "Great question", "值得注意的是", and "一句话总结：".
- Answer and stop; do not append offers such as "如果你想，我还可以..." / "If you'd like, I can also...".
- In multi-turn tasks, proactively summarize the goal, current progress, and next steps so the user can follow along without rereading earlier messages.
