# Pi Assistant

Milo, a personal assistant powered by Pi.

Node.js Telegram bridge for Pi: one persistent RPC process and session per chat.
The bridge handles polling, authorization, queues, typing and editable tool progress.
The agent replies, sends files and processes attachments through the Bot API
(`.pi/skills/telegram`); stdout is not forwarded.

## Setup

Requires Node.js 22.19+ and `pi` on PATH. Copy `pi-assistant.env.example` to `pi-assistant.env`
(mode `0600`). Link this directory to `~/.config/pi-assistant` and the machine-specific
plist into `~/Library/LaunchAgents/`. Stop other pollers for the same bot before startup.

- Check credentials: `node startup.mjs --check`
- Enable login startup: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.pi-assistant.bot.plist`
- Restart: `launchctl kickstart -k gui/$(id -u)/dev.pi-assistant.bot`

## Commands and recovery

- `/new`: new session after current work; no automatic idle reset.
- `/stop`: abort current work and cancel queued messages, retaining the session.
- `/ping`, `/status`, `/help`, `/logs`: service information.
- `/restart`: restart the bridge.

State, sessions and logs live under `~/.local/state/pi-assistant/`. After restart,
unstarted messages resume; interrupted work is reported but never automatically replayed.
RPC dialogs are cancelled automatically, and the `questionnaire` tool is disabled.

When a run still fails after Pi's retries, `.pi/extensions/model-fallback.ts` continues it
with the next model in global `enabledModels`, then restores the default model.

## Tests

`node --test` (YAML round-trip checks use macOS system Ruby).
