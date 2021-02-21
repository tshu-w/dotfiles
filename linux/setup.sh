#!/usr/bin/env bash
set -euxo pipefail # -e=-o errexit, -u=-o nounset

PREFIX=$HOME/.linuxbrew
if [ ! -d $PREFIX ]; then
    git clone https://github.com/Homebrew/brew $PREFIX/Homebrew
    mkdir $PREFIX/bin
    ln -s $PREFIX/Homebrew/bin/brew $PREFIX/bin
fi
eval $($PREFIX/bin/brew shellenv)

# Install all dependencies from the Brewfile
brew bundle -v --no-lock || true

# Installing Anaconda
if [ ! -d ~/.anaconda3 ]; then
    anaconda_script=Anaconda3-2020.11-Linux-x86_64.sh
    curl https://repo.anaconda.com/archive/$anaconda_script -o ~/$anaconda_script
    (cd ~ && echo | bash $anaconda_script -b -p $HOME/.anaconda3)
fi
