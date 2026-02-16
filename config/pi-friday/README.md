# Friday

Multi-channel local assistant powered by [pi](https://github.com/anthropics/pi) (Telegram now).

Channel ingress → spawn pi per message → pi uses tools (read/bash/edit/write) → reply via channel-specific skill.

## How it works

- `startup.sh` — entrypoint, loads env, runs `startup.mjs`
- `startup.mjs` — Telegram polling loop, session management, provider fallback, progress reporting
- `AGENTS.md` — operating rules for the AI
- `.pi/` — project-level pi settings and skills

## Run

```bash
cp friday.env.example friday.env   # fill in TELEGRAM_BOT_TOKEN, FRIDAY_USER_IDS
./startup.sh
```

Or via launchd (auto-installed on first run):

```bash
launchctl load ~/Library/LaunchAgents/dev.friday.bot.plist
```

## File structure

```
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
        └── session/        # session symlink management
```

Runtime data lives in `~/.local/share/friday/` (sessions, logs, offset).

## Commands

`/ping` `/status` `/new` `/stop` `/logs` `/restart` `/help`
