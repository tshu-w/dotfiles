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
if [ ! -d $XDG_DATA_HOME/conda ]; then
    miniconda_script="Miniconda3-latest-Linux-x86_64.sh"
    curl https://repo.anaconda.com/miniconda/$miniconda_script -o ~/$miniconda_script
    (cd ~ && echo | bash $miniconda_script -b -p $XDG_DATA_HOME/conda)
fi
