SHELL := /bin/bash
DOTFILES_DIR := $(shell dirname $(realpath $(firstword $(MAKEFILE_LIST))))
OS := $(shell uname -s | tr A-Z a-z)

export STOW_DIR = $(DOTFILES_DIR)
export XDG_CONFIG_HOME = $(HOME)/.config
export XDG_CACHE_HOME = $(HOME)/.cache
export XDG_DATA_HOME = $(HOME)/.local/share

ifeq ($(OS),linux)
export PATH := /home/linuxbrew/.linuxbrew/bin/:$(XDG_DATA_HOME)/linuxbrew/bin/:$(PATH)
export NPM_CONFIG_PREFIX := $(HOME)/.local
endif

.PHONY: darwin linux

all: setup link crontab packages $(OS)
	chmod 700 $(XDG_CONFIG_HOME)/gnupg
	chmod 600 $(XDG_CONFIG_HOME)/gnupg/*

	mkdir -p $(XDG_DATA_HOME)/wakatime
	wakatime --config-write api_key 3fd63845-ecde-47ea-bd1a-7042221d1046

darwin:

linux:
	[ -f $(HOME)/.hushlogin ] || touch $(HOME)/.hushlogin

setup:
	cd $(DOTFILES_DIR)/$(OS) && . ./setup.sh

link:
	for f in $$(ls -A $(DOTFILES_DIR)/runcom); do \
		tf=$(HOME)/$${f//"dot-"/"."}; \
		if [[ -e $$tf && ! -L $$tf ]]; then \
			mv -v $$tf{,.bak}; \
		fi \
	done
	mkdir -p $(XDG_CONFIG_HOME) $(HOME)/.local
	stow -v --dotfiles -t $(HOME) runcom
	stow -v -t $(XDG_CONFIG_HOME) config
	stow -v --no-folding -t $(HOME)/.local local

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

crontab:
	crontab $(XDG_CONFIG_HOME)/crontab

packages: python-packages node-packages

python-packages:
	command -v pip3 &>/dev/null && pip3 install flake8 black flake8-black autoflake || true

node-packages:
	npm install -g pyright
