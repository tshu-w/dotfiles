#!/bin/zsh
set -euo pipefail

export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
export FRIDAY_DATA_HOME="${FRIDAY_DATA_HOME:-$XDG_DATA_HOME/friday}"

FRIDAY_PROJECT_DIR="${FRIDAY_PROJECT_DIR:-$XDG_CONFIG_HOME/pi-friday}"

# If the launchd plist isn't installed yet, install a symlink so it can be
# managed via launchctl using the canonical path in this repo/config dir.
ensure_launchagent_plist() {
  local src_plist="$FRIDAY_PROJECT_DIR/dev.friday.bot.plist"
  local dest_dir="$HOME/Library/LaunchAgents"
  local dest_plist="$dest_dir/dev.friday.bot.plist"

  if [[ ! -f "$src_plist" ]]; then
    # Running without launchd support.
    return 0
  fi

  if [[ -e "$dest_plist" ]]; then
    # Already installed.
    return 0
  fi

  mkdir -p "$dest_dir"
  /usr/bin/plutil -lint "$src_plist" >/dev/null
  ln -s "$src_plist" "$dest_plist"

  echo "[friday] installed launchd plist: $dest_plist -> $(readlink "$dest_plist")" >&2
}

ensure_launchagent_plist

# Ensure required commands are available.
command -v node &>/dev/null || { echo "[friday] missing dependency: node" >&2; exit 1; }
command -v pi   &>/dev/null || { echo "[friday] missing dependency: pi" >&2; exit 1; }

# Optional per-daemon env overrides (tokens, defaults)
if [[ -f "$FRIDAY_PROJECT_DIR/friday.env" ]]; then
  source "$FRIDAY_PROJECT_DIR/friday.env"
fi

mkdir -p "$FRIDAY_DATA_HOME/logs" "$FRIDAY_DATA_HOME/runtime"
cd "$FRIDAY_PROJECT_DIR"

STARTUP_MAIN="$FRIDAY_PROJECT_DIR/startup.mjs"
if [[ ! -f "$STARTUP_MAIN" ]]; then
  echo "[friday] missing startup main: $STARTUP_MAIN" >&2
  exit 1
fi

exec node "$STARTUP_MAIN"
