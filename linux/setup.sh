#!/usr/bin/env bash
set -euxo pipefail # -e=-o errexit, -u=-o nounset

: ${XDG_CACHE_HOME:=~/.cache}
: ${XDG_CONFIG_HOME:=~/.config}
: ${XDG_DATA_HOME:=~/.local/share}
: ${XDG_STATE_HOME:=~/.local/state}
export XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME

setup_root() {
    export DEBIAN_FRONTEND=noninteractive
    export TZ=Asia/Shanghai

    apt-get update
    apt-get install -y --no-install-recommends \
        cron \
        curl \
        direnv \
        emacs \
        gh \
        git \
        git-lfs \
        gnupg \
        nodejs \
        npm \
        python-is-python3 \
        python3 \
        python3-pip \
        ripgrep \
        rsync \
        screen \
        stow \
        trash-cli \
        vim \
        zoxide \
        zsh

    ln -snf /usr/share/zoneinfo/$TZ /etc/localtime
    echo $TZ > /etc/timezone

    if ! command -v starship >/dev/null 2>&1; then
        curl -fsSL https://starship.rs/install.sh | sh -s -- --yes --bin-dir /usr/local/bin
    fi

    if ! command -v uv >/dev/null 2>&1; then
        curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh
    fi

    zsh_path=$(command -v zsh)
    if ! grep -qxF "$zsh_path" /etc/shells; then
        echo "$zsh_path" >> /etc/shells
    fi
    if [ "$(getent passwd root | cut -d: -f7)" != "$zsh_path" ]; then
        chsh -s "$zsh_path" root
    fi
}

setup_homebrew() {
    local prefix

    if sudo -n true 2>/dev/null; then
        prefix=/home/linuxbrew/.linuxbrew
        [ -d "$prefix" ] || \
            curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | /bin/bash
    else
        prefix=$XDG_DATA_HOME/linuxbrew
        if [ ! -d "$prefix" ]; then
            git clone https://github.com/Homebrew/brew "$prefix/Homebrew"
            mkdir "$prefix/bin"
            ln -s "$prefix/Homebrew/bin/brew" "$prefix/bin"
        fi
    fi

    eval "$("$prefix/bin/brew" shellenv)"
    brew bundle -v || :
}

if [ "$EUID" -eq 0 ]; then
    setup_root
else
    setup_homebrew
fi
