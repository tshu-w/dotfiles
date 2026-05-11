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

## Working Style

- Use Simplified Chinese for discussion, analysis, and summaries.
- Use English for code, comments, identifiers, and commit messages.
- Prefer minimal, reviewable changes scoped to the task.
- Do not add unrelated comments, docstrings, type annotations, or speculative improvements.
- Read relevant code before proposing non-trivial changes.
- For complex or high-risk tasks, give a short plan first; for simple tasks, execute directly.
- Ask a follow-up when guessing is likely to cause rework; otherwise state the assumption and proceed.
- Run relevant formatter, linter, or tests when practical, and report the real result.
- Keep responses direct: state what changed, how it was verified, and any remaining risk.
