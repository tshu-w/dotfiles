#!/usr/bin/env bash
set -euxo pipefail # -e=-o errexit, -u=-o nounset

# Ask for the administrator password upfront
sudo -n true 2>/dev/null || sudo -v
# Keep-alive: update existing `sudo` time stamp until `init.sh` has finished
while true; do sudo -n true; sleep 60; kill -0 "$$" || exit; done 2>/dev/null &

# Prevent sleeping during script execution, as long as the machine is on AC power
caffeinate -s -w $$ &

# Check for Homebrew, install if we don't have it
command -v brew >/dev/null || \
    curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | /bin/bash

# Install all dependencies from the Brewfile
brew bundle -v --no-lock || true

brew services start yabai
brew services start skhd
ln -sf /usr/local/opt/emacs-head@29/Emacs.app /Applications

for dir in "fastmail" "iscas"; do
    mkdir -p $XDG_DATA_HOME/mail/$dir
done

sudo rm -rf /Applications/Anaconda-Navigator.app

for app in "Bartender 4" "Dash" "Dropbox" "Emacs" "iTerm" "Karabiner-Elements" "Launchbar" "Surge"; do
    osascript <<EOF
    tell application "System Events"
        make new login item at end with properties {} & ¬
        { name:"$app", path:"/Applications/$app.app", hidden:false }
    end tell
EOF
done

# mackup restore
MACKUP_DIR="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Mackup"
if [[ -f "$MACKUP_DIR/.mackup.cfg" && ! -L "$HOME/.mackup.cfg" ]]; then
    cp -v  "$MACKUP_DIR/.mackup.cfg" $HOME
    cp -rv "$MACKUP_DIR/.mackup" $HOME
    mackup restore -f
else
    echo "mackup.cfg does not exist, please perform the recovery manually later."
fi

# Apply macoS system settings
. "macOS.sh"
