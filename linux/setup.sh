#!/usr/bin/env bash
set -euxo pipefail # -e=-o errexit, -u=-o nounset

: ${XDG_CACHE_HOME:=~/.cache}
: ${XDG_CONFIG_HOME:=~/.config}
: ${XDG_DATA_HOME:=~/.local/share}
: ${XDG_STATE_HOME:=~/.local/state}
export XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME

configure_timezone() {
    local timezone=Asia/Shanghai

    ln -snf "/usr/share/zoneinfo/$timezone" /etc/localtime
    echo "$timezone" > /etc/timezone
}

configure_default_shell() {
    local user=$1
    local shell_path

    shell_path=$(command -v zsh)
    if ! grep -qxF "$shell_path" /etc/shells; then
        echo "$shell_path" >> /etc/shells
    fi
    if [ "$(getent passwd "$user" | cut -d: -f7)" != "$shell_path" ]; then
        chsh -s "$shell_path" "$user"
    fi
}

setup_root() {
    export DEBIAN_FRONTEND=noninteractive

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

    configure_timezone

    if ! command -v starship >/dev/null 2>&1; then
        curl -fsSL https://starship.rs/install.sh | sh -s -- --yes --bin-dir /usr/local/bin
    fi

    if ! command -v uv >/dev/null 2>&1; then
        curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh
    fi

    configure_default_shell root
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
