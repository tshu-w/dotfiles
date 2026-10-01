#!/usr/bin/env bash
set -euxo pipefail

command -v brew >/dev/null || \
    curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | /bin/bash
case `uname -m` in
arm64)
    eval "$(/opt/homebrew/bin/brew shellenv)" ;;
x86_64)
    eval "$(/usr/local/bin/brew shellenv)" ;;
esac

brew install stow
