#!/bin/zsh
set -euo pipefail

export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
export XDG_STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
export FRIDAY_DATA_HOME="${FRIDAY_DATA_HOME:-$XDG_DATA_HOME/friday}"
export PATH="$HOME/.local/bin:$PATH"

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

agentd_status() {
  if [[ -n "${AGENTD_WORKSPACE:-}" ]]; then
    AGENTD_WORKSPACE="$AGENTD_WORKSPACE" agentd status "$@"
  else
    agentd status "$@"
  fi
}

agentd_service_install() {
  if [[ -n "${AGENTD_WORKSPACE:-}" ]]; then
    AGENTD_WORKSPACE="$AGENTD_WORKSPACE" agentd service install >/dev/null
  else
    agentd service install >/dev/null
  fi
}

ensure_agentd_command() {
  if command -v agentd &>/dev/null; then
    return 0
  fi

  command -v uv &>/dev/null || {
    echo "[friday] missing dependency: agentd (auto-install requires uv)" >&2
    exit 1
  }

  echo "[friday] agentd not found; installing via uv tool install agentd" >&2
  uv tool install agentd >&2
  hash -r
  command -v agentd &>/dev/null || {
    echo "[friday] failed to install agentd" >&2
    exit 1
  }
}

ensure_agentd_daemon() {
  if agentd_status >/dev/null 2>&1; then
    return 0
  fi

  echo "[friday] agentd daemon not ready; installing service metadata" >&2
  agentd_service_install

  if [[ "$OSTYPE" == darwin* ]]; then
    local plist_path="$HOME/Library/LaunchAgents/com.agentd.daemon.plist"
    [[ -f "$plist_path" ]] || {
      echo "[friday] missing agentd launchd plist after service install: $plist_path" >&2
      exit 1
    }

    launchctl unload "$plist_path" >/dev/null 2>&1 || true
    launchctl load "$plist_path"
    launchctl kickstart -k "gui/$(id -u)/com.agentd.daemon"
  else
    systemctl --user daemon-reload
    systemctl --user enable --now agentd
  fi

  local attempts=30
  local i
  for (( i=1; i<=attempts; i++ )); do
    if agentd_status >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "[friday] agentd daemon failed to become ready via service manager" >&2
  exit 1
}

ensure_agentd_command
ensure_agentd_daemon

cd "$FRIDAY_PROJECT_DIR"

STARTUP_MAIN="$FRIDAY_PROJECT_DIR/startup.mjs"
if [[ ! -f "$STARTUP_MAIN" ]]; then
  echo "[friday] missing startup main: $STARTUP_MAIN" >&2
  exit 1
fi

exec node "$STARTUP_MAIN"
