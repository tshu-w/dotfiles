---
name: telegram-send
description: Send a Telegram message via Bot API. Use when the user asks to reply or notify through Telegram.
---

# Telegram Send

Send messages and files to Telegram via Bot API (curl).

## Setup

```bash
BASE="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"
CHAT_ID="${TELEGRAM_DEFAULT_CHAT_ID}"
```

Both env vars must be set. `TELEGRAM_REPLY_TO_MESSAGE_ID` is optional (for quoting).

## ⚠ Formatting rules

- **Newlines**: use real newlines (heredoc / multiline string). Literal `\n` renders as plain text.
- **Markdown mode** (`parse_mode: Markdown`): `*bold*` (not `**`), `_italic_` (not `*`). No tables — use code blocks instead.
- **HTML mode** (`parse_mode: HTML`): `<b>`, `<i>`, `<code>`, `<pre>`, `<a href="">`. Safer for complex formatting.
- Use `jq -n` to build JSON payloads — avoids shell quoting bugs.

## Send text message

```bash
MSG='Your message here'

jq -n \
  --arg chat "$CHAT_ID" \
  --arg text "$MSG" \
  '{chat_id: $chat, text: $text, parse_mode: "Markdown", disable_web_page_preview: true}' |
curl -sS -X POST "$BASE/sendMessage" -H 'Content-Type: application/json' -d @-
```

### With reply / quote

```bash
jq -n \
  --arg chat "$CHAT_ID" \
  --arg text "$MSG" \
  --argjson reply "${TELEGRAM_REPLY_TO_MESSAGE_ID:-null}" \
  '{chat_id: $chat, text: $text, parse_mode: "Markdown",
    disable_web_page_preview: true, reply_to_message_id: $reply}' |
curl -sS -X POST "$BASE/sendMessage" -H 'Content-Type: application/json' -d @-
```

### Long / multiline message

```bash
MSG=$(cat <<'EOF'
*Report*

Line 1
Line 2
`code block`
EOF
)

jq -n --arg chat "$CHAT_ID" --arg text "$MSG" \
  '{chat_id: $chat, text: $text, parse_mode: "Markdown"}' |
curl -sS -X POST "$BASE/sendMessage" -H 'Content-Type: application/json' -d @-
```

## Send files

All file uploads use multipart form (`-F`).

```bash
# Document (any file)
curl -sS -X POST "$BASE/sendDocument" \
  -F chat_id="$CHAT_ID" -F document="@report.pdf" -F caption="Latest report"

# Photo
curl -sS -X POST "$BASE/sendPhoto" \
  -F chat_id="$CHAT_ID" -F photo="@screenshot.png" -F caption="Result"

# Video
curl -sS -X POST "$BASE/sendVideo" \
  -F chat_id="$CHAT_ID" -F video="@demo.mp4" -F caption="Preview"

# Audio
curl -sS -X POST "$BASE/sendAudio" \
  -F chat_id="$CHAT_ID" -F audio="@note.mp3"
```

## Less common operations

### Edit message
```bash
jq -n --arg chat "$CHAT_ID" --argjson mid 12345 --arg text "updated" \
  '{chat_id: $chat, message_id: $mid, text: $text}' |
curl -sS -X POST "$BASE/editMessageText" -H 'Content-Type: application/json' -d @-
```

### Delete message
```bash
jq -n --arg chat "$CHAT_ID" --argjson mid 12345 \
  '{chat_id: $chat, message_id: $mid}' |
curl -sS -X POST "$BASE/deleteMessage" -H 'Content-Type: application/json' -d @-
```

### Forward / copy message
```bash
# Forward (shows original sender)
jq -n --arg chat "$CHAT_ID" --arg from "$CHAT_ID" --argjson mid 12345 \
  '{chat_id: $chat, from_chat_id: $from, message_id: $mid}' |
curl -sS -X POST "$BASE/forwardMessage" -H 'Content-Type: application/json' -d @-

# Copy (hides original sender)
# Same payload, use $BASE/copyMessage
```

### Send media group (album)
```bash
curl -sS -X POST "$BASE/sendMediaGroup" \
  -F chat_id="$CHAT_ID" \
  -F media='[{"type":"photo","media":"attach://a"},{"type":"photo","media":"attach://b"}]' \
  -F a=@1.jpg -F b=@2.jpg
```

### Typing indicator
```bash
curl -sS -X POST "$BASE/sendChatAction" \
  -H 'Content-Type: application/json' \
  -d "{\"chat_id\":\"$CHAT_ID\",\"action\":\"typing\"}"
```

### Inline keyboard
```bash
jq -n --arg chat "$CHAT_ID" --arg text "Choose one" \
  '{chat_id: $chat, text: $text,
    reply_markup: {inline_keyboard: [[
      {text: "A", callback_data: "a"},
      {text: "B", callback_data: "b"}
    ]]}}' |
curl -sS -X POST "$BASE/sendMessage" -H 'Content-Type: application/json' -d @-
```
