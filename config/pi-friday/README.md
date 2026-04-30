# Friday

Multi-channel local assistant powered by [pi](https://github.com/anthropics/pi) (Telegram now).

Channel ingress → `env.telegram.message` event → chat-bound durable root task in agentd → pi uses tools (read/bash/edit/write) → reply via Telegram skill.

## How it works

- `startup.sh` — entrypoint, loads env, runs `startup.mjs`
- `startup.mjs` — Telegram polling loop, durable root task routing, progress reporting
- `AGENTS.md` — operating rules for the AI
- `.pi/` — project-level pi settings and skills

## Event model

Friday no longer converts Telegram updates into a prompt blob.
Instead, each inbound update is normalized to:

- `type = "env.telegram.message"`
- `payload = { text, chat, message, reply_to, ... }`

Example payload shape:

```json
{
  "text": "hello",
  "chat": {"id": "123456", "type": "private"},
  "message": {
    "id": 42,
    "date": 1730000000,
    "text": "hello",
    "from": {"id": 1, "display_name": "Alice"}
  },
  "reply_to": {
    "id": 41,
    "text": "previous message"
  }
}
```

Each Telegram chat is bound to one current durable root task id.
New inbound messages use `agentd emit`; a new root task is only created when the chat has no binding yet or Friday intentionally starts a new session.
The runtime persists that binding in `chat_root_tasks.json` and will also read legacy `chat_workers.json` during migration.

Every `spawn` / `emit` call sends the full env bundle required by the agent runtime:

- `PATH`
- `PI_CODING_AGENT_DIR`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_DEFAULT_CHAT_ID`
- `TELEGRAM_REPLY_TO_MESSAGE_ID` (when replying to a specific inbound message)

This is intentional: `agentd` env overlays are daemon-memory only, so Friday must rehydrate them on every ingress call to remain restart-safe.

## Run

```bash
cp friday.env.example friday.env   # fill in TELEGRAM_BOT_TOKEN, FRIDAY_USER_IDS
./startup.sh
```

## Smoke test

```bash
./smoke-test.sh
```

This script:

- starts an isolated `agentd` daemon in a temporary workspace
- spawns a chat-bound root task with an initial `env.telegram.message`
- emits a second message to the same root task
- restarts the isolated daemon
- emits a third message after restart
- asserts `task.session.saved` / `task.session.loaded` markers from `agentd logs`

It uses the real `TELEGRAM_BOT_TOKEN` and `TELEGRAM_DEFAULT_CHAT_ID`, so it will send **3 actual Telegram replies** to your configured chat.

Useful knobs:

- `SMOKE_TIMEOUT=240` — overall wait timeout per step
- `SMOKE_PROGRESS=0` — default; use plain `agentd wait`
- `SMOKE_PROGRESS=1` — stream `agentd wait --progress` for debugging, but this currently depends on live event output cadence

Or via launchd (auto-installed on first run):

```bash
launchctl load ~/Library/LaunchAgents/dev.friday.bot.plist
```

## File structure

```text
pi-friday/
├── startup.sh              # shell entrypoint (env, deps check, auto-install plist)
├── startup.mjs             # main process
├── dev.friday.bot.plist    # launchd daemon config
├── friday.env              # secrets (gitignored)
├── friday.env.example
├── AGENTS.md               # AI operating rules
├── TODO.md
└── .pi/
    ├── settings.json       # default provider/model for Friday
    └── skills/
```

Runtime data:
- Friday runtime/logs: `~/.local/share/friday/`
- Telegram offsets + root-task map: `~/.local/share/friday/runtime/`
- Telegram sessions: `~/.local/state/pi/sessions/friday/telegram/`

## Commands

`/ping` `/status` `/new` `/stop` `/logs` `/restart` `/help`
