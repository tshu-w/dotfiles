#!/usr/bin/env bash
set -euxo pipefail # -e=-o errexit, -u=-o nounset

mkdir -p $XDG_DATA_HOME
[ ! -d $XDG_DATA_HOME/junest ] && git clone git://github.com/fsquillace/junest $XDG_DATA_HOME/junest
[ ! -d $JUNEST_HOME ] && junest setup

pacman -Syu --noconfirm
junest yay -S --needed --noconfirm $(< Packages)

# Installing Anaconda
if [ ! -d $XDG_DATA_HOME/anaconda3 ]; then
    anaconda_script=Anaconda3-2020.11-Linux-x86_64.sh
    curl https://repo.anaconda.com/archive/$anaconda_script -o ~/$anaconda_script
    (cd ~ && echo | bash $anaconda_script -b -p $XDG_DATA_HOME/anaconda3)
fi
