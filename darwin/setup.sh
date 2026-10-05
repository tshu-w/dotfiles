#!/usr/bin/env bash
set -euxo pipefail # -e=-o errexit, -u=-o nounset

: ${XDG_CACHE_HOME:=~/.cache}
: ${XDG_CONFIG_HOME:=~/.config}
: ${XDG_DATA_HOME:=~/.local/share}
: ${XDG_STATE_HOME:=~/.local/state}
export XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME

# Initialize Pi data directories and links
PI_CONFIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../config/pi" && pwd)"
mkdir -p "$XDG_DATA_HOME"/pi/{git,npm} "$XDG_CACHE_HOME/pi" "$XDG_STATE_HOME"/pi/{sessions,tape}
for dir in git npm; do ln -sfn "$XDG_DATA_HOME/pi/$dir" "$PI_CONFIG_DIR/$dir"; done
ln -sfn "$XDG_CACHE_HOME/pi" "$PI_CONFIG_DIR/cache"
for dir in sessions tape; do ln -sfn "$XDG_STATE_HOME/pi/$dir" "$PI_CONFIG_DIR/$dir"; done
unset PI_CONFIG_DIR

# Ask for the administrator password upfront
sudo -n true 2>/dev/null || sudo -v
# Keep-alive: update existing `sudo` time stamp until `init.sh` has finished
while true; do sudo -n true; sleep 60; kill -0 "$$" || exit; done 2>/dev/null &

# Prevent sleeping during script execution, as long as the machine is on AC power
caffeinate -s -w $$ &

# Install Rosetta
[ `uname -m` = arm64 ] && softwareupdate --install-rosetta --agree-to-license

# HACK: Create a custom sudoers file to allow passwordless sudo for brew
# Introduced in: https://github.com/Homebrew/brew/pull/17694
# Source: https://github.com/Homebrew/brew/issues/17915#issuecomment-2288351932
SUDOERS_FILE=/etc/sudoers.d/custom_homebrew_sudoers
cleanup() { sudo rm -f $SUDOERS_FILE; }
trap cleanup EXIT INT TERM HUP QUIT ABRT ALRM PIPE
cat <<EOF | sudo tee $SUDOERS_FILE > /dev/null
Defaults syslog=authpriv
root ALL=(ALL) ALL
%admin ALL=(ALL) NOPASSWD: ALL
EOF
sudo chmod 0440 $SUDOERS_FILE

case `uname -m` in
arm64)
    eval "$(/opt/homebrew/bin/brew shellenv)" ;;
x86_64)
    eval "$(/usr/local/bin/brew shellenv)" ;;
esac

# Link /opt/homebrew directories to /usr/local
for dir in "bin" "include" "lib" "sbin" "share"; do
    [ -d /usr/local/$dir ] || sudo ln -s /opt/homebrew/$dir /usr/local/$dir
done

# Install all dependencies from the Brewfile
if [[ -n "${GITHUB_ACTION:-}" ]]; then
    export HOMEBREW_BUNDLE_CASK_SKIP=`brew bundle list --cask --quiet | tr '\n' ' '`
    export HOMEBREW_BUNDLE_MAS_SKIP=`/usr/bin/grep "^mas.*id: \d*$" Brewfile | cut -d":" -f2 | tr '\n' ' '`
fi
brew bundle -v || :

if [[ -x /Library/TeX/texbin/tlmgr ]]; then
    sudo /Library/TeX/texbin/tlmgr install latexmk dvisvgm
fi

# Install Rime configuration
[ -d "$HOME/Library/Rime" ] || git clone --recurse-submodules https://github.com/tshu-w/rime-conf "$HOME/Library/Rime"
(cd ~/Library/Rime/plum && bash rime-install ../plum-package.conf)

EMACS_PREFIX="$(brew --prefix emacs-plus@31)"
cp -R "$EMACS_PREFIX/Emacs.app" "$EMACS_PREFIX/Emacs Client.app" /Applications/
mkdir -p $XDG_DATA_HOME

command -v wechattweak-cli && sudo wechattweak-cli install

# Init mu
for dir in "fastmail" "iscas"; do
    mkdir -p $XDG_STATE_HOME/mail/$dir
done
mu init -m $XDG_STATE_HOME/mail

# Add login item
for app in "AlDente" "Bartender 6" "Dropbox" "Easydict" "Emacs" "FlashSpace" "Focus" "Input Source Pro" "iTerm" "LaunchBar" "LookAway" "Loop" "Surge"; do
    osascript <<EOF
    tell application "System Events"
        make new login item at end with properties {} & ¬
        { name:"$app", path:"/Applications/$app.app", hidden:false }
    end tell
EOF
done

# Create Developer Directory
mkdir -p ~/Developer

# Unison restore
UNISON_DIR="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Unison"
mkdir -p "$XDG_CACHE_HOME/unison"
[ -d "$UNISON_DIR" ] && UNISON="$XDG_CONFIG_HOME/unison" unison dotfile -batch -force "$UNISON_DIR"

# Apply macoS system settings
. "macOS.sh"
