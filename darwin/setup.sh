#!/usr/bin/env bash
set -euxo pipefail # -e=-o errexit, -u=-o nounset

: ${XDG_CACHE_HOME:=~/.cache}
: ${XDG_CONFIG_HOME:=~/.config}
: ${XDG_DATA_HOME:=~/.local/share}
: ${XDG_STATE_HOME:=~/.local/state}
export XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME

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

# Check for Homebrew, install if we don't have it
command -v brew >/dev/null || \
    curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | /bin/bash
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

# Codesign MoneyWiz 3 application if installed
[ -d "/Applications/MoneyWiz 3.app" ] && codesign --force --deep --sign - "/Applications/MoneyWiz 3.app"

# Install Rime configuration
git clone --recurse-submodules https://github.com/tshu-w/rime-conf ~/Library/Rime
(cd ~/Library/Rime/plum && bash rime-install ../plum-package.conf)

# Install info files
# https://github.com/d12frosted/homebrew-emacs-plus/issues/437
(cd $HOMEBREW_PREFIX/share/info/emacs && for file in * ; do install-info "$file" dir; done)

command -v yabai >/dev/null && yabai --start-service
command -v skhd >/dev/null && skhd --start-service
ln -sf $HOMEBREW_PREFIX/opt/emacs-head@30/Emacs.app /Applications
mkdir -p $XDG_DATA_HOME
ln -sf $HOMEBREW_PREFIX/Caskroom/miniconda/base/ $XDG_DATA_HOME/conda

command -v wechattweak-cli && sudo wechattweak-cli install

# Init mu
mu init -m $XDG_STATE_HOME/mail
for dir in "fastmail" "iscas"; do
    mkdir -p $XDG_STATE_HOME/mail/$dir
done

# Add login item
for app in "AlDente" "Dash" "Dropbox" "Easydict" "Emacs" "Focus" "iTerm" "Ice" "LaunchBar" "LookAway" "Surge"; do
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
[ -d $UNISON_DIR ] && UNISON=$XDG_CONFIG_HOME/unison unison -batch -force $UNISON_DIR

# Apply macoS system settings
. "macOS.sh"
