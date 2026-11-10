# Pi Assistant

Milo, a personal assistant on Telegram powered by Pi.
Each chat gets its own [pi-agents](https://github.com/tshu-w/pi-agents) main Agent, `telegram:<chat_id>`,
so work continues between messages and Agent results reach the chat.
Milo replies, sends files and reads attachments through the telegram skill, and works in the home directory.

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
- `/restart`: restart the service.

Open a chat's agent with `pd attach <id>` (`/status` shows the id) or `pd agents`.
Message Milo in the chat before attaching: an agent first started from a terminal lacks Milo's prompt,
skill, extensions and `--approve`.
State and logs live under `~/.local/state/pi-assistant/`.
After restart, unstarted messages resume; interrupted work is reported for you to resend.
Extension dialogs are unavailable.

When a run still fails after Pi's retries, Milo continues it
with the next scoped model (`enabledModels` or `--models`), then restores the model in use before the failure.

## Tests

`node --test`
