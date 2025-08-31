#!/usr/bin/env bash
set -euxo pipefail # -e=-o errexit, -u=-o nounset

: ${XDG_CACHE_HOME:=~/.cache}
: ${XDG_CONFIG_HOME:=~/.config}
: ${XDG_DATA_HOME:=~/.local/share}
: ${XDG_STATE_HOME:=~/.local/state}
export XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME

if sudo -n true 2>/dev/null; then
    PREFIX=/home/linuxbrew/.linuxbrew
    [ -d $PREFIX ] || \
        curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | /bin/bash
else
    PREFIX=$XDG_DATA_HOME/linuxbrew
    if [ ! -d $PREFIX ]; then
        git clone https://github.com/Homebrew/brew $PREFIX/Homebrew
        mkdir $PREFIX/bin
        ln -s $PREFIX/Homebrew/bin/brew $PREFIX/bin
    fi
fi
eval $($PREFIX/bin/brew shellenv)

# Install all dependencies from the Brewfile
brew bundle -v || :
