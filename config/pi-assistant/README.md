# Pi Assistant

Milo, a personal assistant powered by Pi.

Node.js Telegram bridge for Pi, built on the [pi-agents](https://github.com/tshu-w/pi-agents) personal agent:
each chat has its own, `pd main --name telegram:<chat_id>`, so Agents keep working between messages
and their results reach Telegram.
The bridge handles polling, authorization, queues, typing and editable tool progress.
The agent replies, sends files and processes attachments through the Bot API
(`skills/telegram`). Milo works in the home directory.

## Setup

Requires Node.js 22.19+, and `pi` and `pd` on PATH. Copy `pi-assistant.env.example` to
`pi-assistant.env` (mode `0600`). Link this directory to `~/.config/pi-assistant` and the
machine-specific plist into `~/Library/LaunchAgents/`. Stop other pollers for the same bot before startup.

- Check credentials: `node startup.mjs --check`
- Enable login startup: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.pi-assistant.bot.plist`
- Restart: `launchctl kickstart -k gui/$(id -u)/dev.pi-assistant.bot`

## Commands and recovery

- `/new`: start a new session for the next messages.
- `/stop`: terminate current work and cancel queued messages, retaining the session.
- `/ping`, `/status`, `/help`, `/logs`: service information.
- `/restart`: restart the bridge.

Open a chat's agent with `pd attach <id>` (`/status` shows the id) or `pd agents`. Let the bridge start it:
one started first from a terminal runs without `--approve` and Milo's prompt, skill and extensions.
State and logs live under `~/.local/state/pi-assistant/`.
After restart, unstarted messages resume; interrupted work is reported for you to resend.
Runs are non-interactive, so extensions cannot prompt; the `questionnaire` tool is disabled.

When a run still fails after Pi's retries, `extensions/model-fallback.ts` continues it
with the next scoped model (`enabledModels` or `--models`), then restores the model in use before the failure.

## Tests

`node --test`
