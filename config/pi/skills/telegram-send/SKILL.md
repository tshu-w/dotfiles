---
name: telegram-send
description: Send a Telegram message via Bot API. Use when the user asks to reply or notify through Telegram.
---

# Telegram Send

Send content to Telegram.

## Preconditions
- `TELEGRAM_BOT_TOKEN` must be set.
- Prefer `TELEGRAM_DEFAULT_CHAT_ID` for inbound conversations.
- Use real newline characters in message text (e.g., heredoc/multiline variable), not literal `\\n`; otherwise Telegram renders `\n` as plain text.
- Telegram Markdown (Legacy) differs from standard: use `*text*` for bold (not `**`), `_text_` for italic (not `*`), and it does not support tables (use fenced code blocks instead).

## Option A: `telegram-send` binary (preferred when available)

Install:
```bash
uv tool install telegram-send
```

### Send text
```bash
telegram-send "hello"
```

### Send from stdin
```bash
cat <<'MSG' | telegram-send --stdin --disable-web-page-preview
YOUR_MESSAGE
MSG
```

### Silent send
```bash
telegram-send --silent "background done"
```

### Markdown / HTML
```bash
telegram-send --format markdown "*bold* _italic_"
telegram-send --format html "<b>bold</b>"
```

### Send files/media
```bash
telegram-send --file report.pdf
telegram-send --image screenshot.png --caption "result"
telegram-send --video demo.mp4 --caption "preview"
telegram-send --audio note.mp3
telegram-send --sticker sticker.webp
```

### Get/delete message IDs
```bash
telegram-send --showids "track this"
telegram-send --delete 12345
```

### Use explicit config (ephemeral)
```bash
CONF="$(mktemp)"
cat >"$CONF" <<EOF
[telegram]
token = ${TELEGRAM_BOT_TOKEN}
chat_id = ${TELEGRAM_DEFAULT_CHAT_ID}
# optional:
# reply_to_message_id = ${TELEGRAM_REPLY_TO_MESSAGE_ID}
EOF

cat <<'MSG' | telegram-send --config "$CONF" --stdin --format markdown --disable-web-page-preview
YOUR_MESSAGE
MSG
rm -f "$CONF"
```

## Option B: Bot API via curl (fallback)

### Direct send
```bash
MSG="YOUR_MESSAGE"
curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -H 'Content-Type: application/json' \
  -d "{\"chat_id\":\"${TELEGRAM_DEFAULT_CHAT_ID}\",\"text\":\"${MSG}\",\"parse_mode\":\"Markdown\",\"disable_web_page_preview\":true}"
```

### Reply / quote
```bash
MSG="YOUR_MESSAGE"
REPLY_TO="${TELEGRAM_REPLY_TO_MESSAGE_ID:-null}"
curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -H 'Content-Type: application/json' \
  -d "{\"chat_id\":\"${TELEGRAM_DEFAULT_CHAT_ID}\",\"text\":\"${MSG}\",\"parse_mode\":\"Markdown\",\"disable_web_page_preview\":true,\"reply_to_message_id\":${REPLY_TO}}"
```

## Common Bot API snippets (useful in practice)

Set shared vars:
```bash
BASE="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"
CHAT_ID="${TELEGRAM_DEFAULT_CHAT_ID}"
```

### 1) Send photo
```bash
curl -sS -X POST "$BASE/sendPhoto" \
  -F chat_id="$CHAT_ID" \
  -F photo="@/path/to/image.png" \
  -F caption="build result"
```

### 2) Send document
```bash
curl -sS -X POST "$BASE/sendDocument" \
  -F chat_id="$CHAT_ID" \
  -F document="@/path/to/report.pdf" \
  -F caption="latest report"
```

### 3) Send media group (album)
```bash
curl -sS -X POST "$BASE/sendMediaGroup" \
  -F chat_id="$CHAT_ID" \
  -F media='[{"type":"photo","media":"attach://img1"},{"type":"photo","media":"attach://img2"}]' \
  -F img1=@/path/to/1.jpg \
  -F img2=@/path/to/2.jpg
```

### 4) Edit text message
```bash
curl -sS -X POST "$BASE/editMessageText" \
  -H 'Content-Type: application/json' \
  -d '{"chat_id":"'"$CHAT_ID"'","message_id":12345,"text":"updated text"}'
```

### 5) Delete message
```bash
curl -sS -X POST "$BASE/deleteMessage" \
  -H 'Content-Type: application/json' \
  -d '{"chat_id":"'"$CHAT_ID"'","message_id":12345}'
```

### 6) Send inline keyboard
```bash
curl -sS -X POST "$BASE/sendMessage" \
  -H 'Content-Type: application/json' \
  -d '{
    "chat_id":"'"$CHAT_ID"'",
    "text":"Choose one",
    "reply_markup":{"inline_keyboard":[[{"text":"A","callback_data":"pick_a"},{"text":"B","callback_data":"pick_b"}]]}
  }'
```

### 7) Answer callback query
```bash
curl -sS -X POST "$BASE/answerCallbackQuery" \
  -H 'Content-Type: application/json' \
  -d '{"callback_query_id":"<callback_query_id>","text":"Done"}'
```

### 8) Send chat action (typing/uploading)
```bash
curl -sS -X POST "$BASE/sendChatAction" \
  -H 'Content-Type: application/json' \
  -d '{"chat_id":"'"$CHAT_ID"'","action":"typing"}'
```

### 9) Copy / forward message
```bash
# copy (keeps sender hidden)
curl -sS -X POST "$BASE/copyMessage" \
  -H 'Content-Type: application/json' \
  -d '{"chat_id":"'"$CHAT_ID"'","from_chat_id":"'"$CHAT_ID"'","message_id":12345}'

# forward
curl -sS -X POST "$BASE/forwardMessage" \
  -H 'Content-Type: application/json' \
  -d '{"chat_id":"'"$CHAT_ID"'","from_chat_id":"'"$CHAT_ID"'","message_id":12345}'
```
