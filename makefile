DOTFILES_DIR := $(shell dirname $(realpath $(firstword $(MAKEFILE_LIST))))
OS := $(shell uname -s | tr A-Z a-z)

export STOW_DIR = $(DOTFILES_DIR)
export XDG_CONFIG_HOME = $(HOME)/.config
export XDG_CACHE_HOME = $(HOME)/.cache
export XDG_DATA_HOME = $(HOME)/.local/share

all: $(OS)
	crontab $(XDG_CONFIG_HOME)/crontab

darwin: setup link reboot

linux: setup link

setup:
	cd $(DOTFILES_DIR)/$(OS) && . ./setup.sh

link:
	for f in $$(ls -A $(DOTFILES_DIR)/runcom); do \
		tf=$(HOME)/$${f//"dot-"/"."}; \
		if [[ -e $$tf && ! -L $$tf ]]; then \
			mv -v $$tf{,.bak}; \
		fi \
	done
	mkdir -p $(XDG_CONFIG_HOME)
	stow -v --dotfiles -t $(HOME) runcom
	stow -v -t $(XDG_CONFIG_HOME) config
	stow -v -t $(HOME)/.local local

unlink:
	stow -v -D -t $(HOME) --dotfiles runcom
	stow -v -D -t $(XDG_CONFIG_HOME) config
	stow -v -D -t $(HOME)/.local local
	for f in $$(ls -A $(DOTFILES_DIR)/runcom); do \
		tf=$(HOME)/$${f//"dot-"/"."}; \
		if [[ -f $$tf{.bak} ]]; then \
			mv -v $tf{.bak,}; \
		fi \
	done

packages: python-packages node-packages

python-packages:
	echo pip install flake8 black flake8-black autoflake

node-packages:
	echo npm install -g pyright

reboot:
	echo sudo /sbin/reboot
