---
name: telegram
description: "Use when interacting with a user through Telegram, or when sending messages, files, and notifications via Telegram Bot API. Triggers on Telegram channel context, 'send to TG', 'notify via bot'. Do NOT use for bot development (webhooks, inline keyboards, handling updates)."
---

# Telegram

## Context

You are interacting with a user through Telegram.
Replies must be sent via Bot API calls below — stdout does not reach the user.

- Be conversational and concise — Telegram messages are read on mobile
- For long outputs, summarize and offer to provide details
- Default to direct messages. Use quote only when context is ambiguous (consecutive messages, long gaps, multiple topics).
- Message length limit: 4096 characters. Split or send as file for longer content.

## Environment

```bash
BASE="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"
CHAT_ID="${TELEGRAM_DEFAULT_CHAT_ID}"
```

Both must be set. Check before sending — if either is missing, tell the user which variable is unset.

`TELEGRAM_REPLY_TO_MESSAGE_ID` is optional (for quoting).

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

jq -n \
  --arg chat "$CHAT_ID" \
  --arg text "$MSG" \
  '{chat_id: $chat, text: $text, parse_mode: "Markdown",
    disable_web_page_preview: true}' |
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

Same `jq -n | curl` pattern for: `deleteMessage`, `sendChatAction` (`"typing"`), `forwardMessage`, `sendMediaGroup`.
