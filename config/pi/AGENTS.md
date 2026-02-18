# AGENTS.md

Scope: `~/.config/pi` (`dotfiles/config/pi`).

- Manage upstream resources via `pi install` and `packages` filters in `settings.json`.
- Do not overwrite local custom extensions/skills unless explicitly requested.
- XDG layout:
  - Config: `~/.config/pi`
  - Data: `~/.local/share/pi` (symlinked from `~/.config/pi/git`)
  - State: `~/.local/state/pi` (symlinked from `~/.config/pi/sessions`)
