---
name: telegram
description: "Use when interacting with a user through Telegram, or when sending messages, files, and notifications via Telegram Bot API. Triggers on Telegram channel context, 'send to TG', 'notify via bot'. Do NOT use for bot development (webhooks, inline keyboards, handling updates)."
---

# Telegram

## Context

You are interacting with a user through Telegram.
Replies must be sent via Bot API calls below — stdout does not reach the user.

- Be conversational and concise — Telegram messages are read on mobile
- Default to direct messages. Use quote only when context is ambiguous (consecutive messages, long gaps, multiple topics).
- Message length limit: 4096 characters. Summarize long outputs; when the full content is needed, split it or send it as a file.

## Environment

```bash
BASE="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"
CHAT_ID="${TELEGRAM_DEFAULT_CHAT_ID}"
```

## Formatting pitfalls

- **Newlines**: use real newlines (heredoc / `$'...'`). Literal `\n` renders as plain text.
- **Markdown mode**: `*bold*` not `**bold**`, `_italic_` not `*italic*`. No tables — use code blocks.
- **HTML mode** (`parse_mode: HTML`): `<b>`, `<i>`, `<code>`, `<pre>`, `<a href="">`. Safer for complex formatting.
- **Always build JSON with `jq -n`** — avoids shell quoting bugs.

## Send text

```bash
MSG=$(cat <<'EOF'
Your message here
EOF
)

RESP=$(jq -n \
  --arg chat "$CHAT_ID" \
  --arg text "$MSG" \
  '{chat_id: $chat, text: $text, parse_mode: "Markdown",
    disable_web_page_preview: true}' |
curl -sS -X POST "$BASE/sendMessage" -H 'Content-Type: application/json' -d @-)
```

Check `RESP` for `"ok": true` before treating the message as delivered. If Markdown parsing fails, resend without `parse_mode`.

### With reply / quote

```bash
jq -n \
  --arg chat "$CHAT_ID" \
  --arg text "$MSG" \
  --argjson reply "<message_id from current request>" \
  '{chat_id: $chat, text: $text, parse_mode: "Markdown",
    disable_web_page_preview: true, reply_parameters: {message_id: $reply}}' |
curl -sS -X POST "$BASE/sendMessage" -H 'Content-Type: application/json' -d @-
```

## Send files

```bash
# Document (up to 50 MB)
curl -sS -X POST "$BASE/sendDocument" \
  -F chat_id="$CHAT_ID" -F document="@report.pdf" -F caption="Latest report"

# Photo (compressed, up to 10 MB)
curl -sS -X POST "$BASE/sendPhoto" \
  -F chat_id="$CHAT_ID" -F photo="@chart.png" -F caption="Chart"
```

Other upload endpoints: `sendVideo`, `sendAudio`, `sendVoice`, `sendAnimation`. Same `-F` pattern.

## Download and process attachments

Select `file_id` from the current request's `attachments`, or from `reply_to.attachments` when processing quoted media.
Call `getFile`, read `result.file_path`, and download the file to a local path you choose. Do not use inbound filenames as shell code or unrestricted destination paths. `getFile` only serves files up to 20 MB.

```bash
FILE_ID="<file_id from current request>"
FILE_PATH=$(jq -n --arg id "$FILE_ID" '{file_id: $id}' |
  curl -sS -X POST "$BASE/getFile" -H 'Content-Type: application/json' -d @- |
  jq -er 'select(.ok) | .result.file_path')
DOWNLOADS="${XDG_STATE_HOME:-$HOME/.local/state}/pi-assistant/downloads"
mkdir -p "$DOWNLOADS"
curl -f -sS "https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${FILE_PATH}" \
  -o "$DOWNLOADS/$(basename "$FILE_PATH")"
```

Read images with the image-capable `read` tool and load the `pdf` skill for PDFs.
For voice/audio, use an available transcription tool; do not guess spoken content from metadata. Explain size limits or missing capabilities when they prevent processing.

## Edit a sent message

```bash
MSG_ID=$(echo "$RESP" | jq -r .result.message_id)

jq -n \
  --arg chat "$CHAT_ID" \
  --argjson mid "$MSG_ID" \
  --arg text "Updated content" \
  '{chat_id: $chat, message_id: $mid, text: $text, parse_mode: "Markdown"}' |
curl -sS -X POST "$BASE/editMessageText" -H 'Content-Type: application/json' -d @-
```

## Other endpoints

Same `jq -n | curl` pattern for: `deleteMessage`, `forwardMessage`.
