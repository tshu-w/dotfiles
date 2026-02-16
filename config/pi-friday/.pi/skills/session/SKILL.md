---
name: session
description: Manage Friday session symlink (current) for model-driven rotation.
---

# Session (Friday)

Use this skill when you need to **inspect**, **rotate**, or **set** the current session for a Telegram chat.

## Session layout

```
$FRIDAY_DATA_HOME/sessions/{chat_id}/
  current -> YYYYMMDD-HHMM_<shortid>.jsonl
  YYYYMMDD-HHMM_<shortid>.jsonl
```

- `current` is a **symlink** to the active pi JSONL session file.
- Session files are **pi JSONL** sessions (pi will create them on first use).
- A dangling `current` symlink is OK; pi will create the JSONL on first use.

## Rules

- Do **not** delete old sessions unless the user explicitly asks.
- To rotate, update the `current` symlink only.

## Where is the chat id?

Use `TELEGRAM_DEFAULT_CHAT_ID` (exported by Friday) as `{chat_id}`.

## Read current session

```bash
BASE="${FRIDAY_DATA_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/friday}/sessions/${TELEGRAM_DEFAULT_CHAT_ID}"
readlink "$BASE/current"
```

## Rotate to a new session

```bash
BASE="${FRIDAY_DATA_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/friday}/sessions/${TELEGRAM_DEFAULT_CHAT_ID}"
STAMP="$(date +%Y%m%d-%H%M)"
RAND="$(openssl rand -hex 3)"
TARGET="$BASE/${STAMP}_${RAND}.jsonl"
ln -sf "$TARGET" "$BASE/current"
```

Notes:
- Use an **absolute** path for the symlink target to avoid ambiguity.
- Do **not** pre-create the session file; pi will create it when invoked with `--session`.

## Set current to an existing session

```bash
BASE="${FRIDAY_DATA_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/friday}/sessions/${TELEGRAM_DEFAULT_CHAT_ID}"
ln -sf "/abs/path/to/existing.jsonl" "$BASE/current"
```
