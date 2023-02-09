#!/usr/bin/env bash
set -euxo pipefail # -e=-o errexit, -u=-o nounset

# Ask for the administrator password upfront
sudo -n true 2>/dev/null || sudo -v
# Keep-alive: update existing `sudo` time stamp until `init.sh` has finished
while true; do sudo -n true; sleep 60; kill -0 "$$" || exit; done 2>/dev/null &

# Prevent sleeping during script execution, as long as the machine is on AC power
caffeinate -s -w $$ &

# Install Rosetta
[ `uname -m` = arm64 ] && softwareupdate --install-rosetta --agree-to-license

# Check for Homebrew, install if we don't have it
command -v brew >/dev/null || \
    curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | /bin/bash
case `uname -m` in
arm64)
    eval "$(/opt/homebrew/bin/brew shellenv)" ;;
x86_64)
    eval "$(/usr/local/bin/brew shellenv)" ;;
esac
# Link /opt/homebrew/bin to /usr/local/bin
[ -d /usr/local/bin ] || sudo ln -s /opt/homebrew/bin /usr/local/bin

# Install all dependencies from the Brewfile
brew bundle -v --no-lock || true

command -v yabai >/dev/null && brew services start yabai
command -v skhd >/dev/null && brew services start skhd
ln -sf $HOMEBREW_PREFIX/opt/emacs-head@29/Emacs.app /Applications
mkdir -p $XDG_DATA_HOME
ln -sf $HOMEBREW_PREFIX/Caskroom/miniconda/base/ $XDG_DATA_HOME/conda

command -v wechattweak-cli && sudo wechattweak-cli install

# Init mu
mu init -m $XDG_DATA_HOME/mail
for dir in "fastmail" "iscas"; do
    mkdir -p $XDG_DATA_HOME/mail/$dir
done

# Add login item
for app in "Bartender 4" "Bettermouse" "Dropbox" "iTerm" "Launchbar" "Surge", "Emacs"; do
    osascript <<EOF
    tell application "System Events"
        make new login item at end with properties {} & ¬
        { name:"$app", path:"/Applications/$app.app", hidden:false }
    end tell
EOF
done

# Create Developer Directory
mkdir -p ~/Developer

# Mackup restore
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
