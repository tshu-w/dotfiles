#!/usr/bin/env bash
set -euxo pipefail # -e=-o errexit, -u=-o nounset

PREFIX=$XDG_DATA_HOME/linuxbrew
if [ ! -d $PREFIX ]; then
    git clone https://github.com/Homebrew/brew $PREFIX/Homebrew
    mkdir $PREFIX/bin
    ln -s $PREFIX/Homebrew/bin/brew $PREFIX/bin
fi
eval $($PREFIX/bin/brew shellenv)

# Install all dependencies from the Brewfile
brew bundle -v --no-lock || true

# Installing Anaconda
if [ ! -d $XDG_DATA_HOME/anaconda3 ]; then
    anaconda_script=`wget -O - https://www.anaconda.com/distribution/ 2>/dev/null | sed -ne 's@.*\(Anaconda3-.*-Linux-x86_64\.sh\)\">64-Bit (x86) Installer.*@\1@p'`
    curl https://repo.anaconda.com/archive/$anaconda_script -o ~/$anaconda_script
    (cd ~ && echo | bash $anaconda_script -b -p $XDG_DATA_HOME/anaconda3)
fi
