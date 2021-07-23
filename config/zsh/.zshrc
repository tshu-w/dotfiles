[[ $TERM == "dumb" ]] && unsetopt zle && PS1='$ ' && return

# Enable Powerlevel10k instant prompt. Should stay close to the top of ~/.zshrc.
# Initialization code that may require console input (password prompts, [y/n]
# confirmations, etc.) must go above this block; everything else may go below.
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

setopt auto_cd
setopt multios
setopt prompt_subst
setopt long_list_jobs
setopt interactivecomments

# changing/making/removing directory
setopt auto_pushd
setopt pushd_ignore_dups
setopt pushdminus

## history command configuration
setopt extended_history       # record timestamp of command in HISTFILE
setopt hist_expire_dups_first # delete duplicates first when HISTFILE size exceeds HISTSIZE
setopt hist_ignore_all_dups   # ignore all duplicated commands in history list
setopt hist_ignore_space      # ignore commands that start with space
setopt hist_verify            # show command with history expansion to user before running it
setopt share_history          # share command history data

zshaddhistory() {
  local line=${1%%$'\n'}
  local cmd=${line%% *}
  [[ ${#line} -ge 5
     && ${cmd} != (rm|\\rm|\"rm\")
  ]]
}

zle_highlight=('paste:none')

export HISTFILE="$XDG_DATA_HOME/zsh/history"
[ ! -d "$XDG_DATA_HOME/zsh" ] && mkdir -p "$XDG_DATA_HOME/zsh"
[ "$HISTSIZE" -lt 50000 ] && HISTSIZE=50000
[ "$SAVEHIST" -lt 10000 ] && SAVEHIST=10000

###############################################################################
#                                    ZINIT                                    #
###############################################################################
declare -A ZINIT

ZSH_CACHE_DIR=$XDG_CACHE_HOME/zsh
ZINIT_HOME=$XDG_DATA_HOME/zinit
ZINIT[HOME_DIR]=$ZINIT_HOME
ZINIT[ZCOMPDUMP_PATH]=$ZSH_CACHE_DIR/zcompdump

if [[ ! -f $ZINIT_HOME/bin/zinit.zsh ]]; then
  git clone https://github.com/zdharma/zinit.git $ZINIT_HOME/bin
	zcompile $ZINIT_HOME/bin/zinit.zsh
fi
source $ZINIT_HOME/bin/zinit.zsh

zinit light zsh-users/zsh-completions
zinit light zsh-users/zsh-autosuggestions
zinit light zdharma/fast-syntax-highlighting

zinit light alexrochas/zsh-extract
zinit light sobolevn/wakatime-zsh-plugin

# OMZ
zinit snippet OMZ::lib/clipboard.zsh
zinit snippet OMZ::lib/key-bindings.zsh

# p10k
zinit ice depth=1; zinit light romkatv/powerlevel10k
# To customize prompt, run `p10k configure` or edit $ZDOTDIR/p10k.zsh.
[ ! -f $ZDOTDIR/p10k.zsh ] || source $ZDOTDIR/p10k.zsh

zinit snippet $ZDOTDIR/plugins/completion.zsh
autoload -Uz compinit; compinit -d $ZINIT[ZCOMPDUMP_PATH]; zinit cdreplay -q
zstyle ':completion::complete:*' cache-path $ZSH_CACHE_DIR/zcompcache

zinit light Aloxaf/fzf-tab
zstyle ':fzf-tab:*' default-color $''
# disable sort when completing `git checkout`
zstyle ':completion:*:git-checkout:*' sort false
# set descriptions format to enable group support
zstyle ':completion:*:descriptions' format '[%d]'
# switch group using `,` and `.`
zstyle ':fzf-tab:*' switch-group ',' '.'

# fzf
export FZF_DEFAULT_OPTS='--height 40% --layout=reverse'
[ -f $XDG_CONFIG_HOME/fzf/fzf.zsh ] \
    || $(brew --prefix)/opt/fzf/install --xdg --key-bindings --completion --no-update-rc --no-bash --no-fish >/dev/null
source $XDG_CONFIG_HOME/fzf/fzf.zsh

# gpg
gpg-connect-agent /bye &>/dev/null

###############################################################################
#                                  appearance                                 #
###############################################################################
# https://github.com/ohmyzsh/ohmyzsh/blob/master/lib/theme-and-appearance.zsh
autoload -U colors && colors
export LSCOLORS="Gxfxcxdxbxegedabagacad"

{ls --color -d . &>/dev/null && alias ls='ls --color=tty'} \
    || { [[ -n "$LS_COLORS" ]] && gls -G . &>/dev/null && alias ls='gls --color=tty' } \
    || { ls -G . &>/dev/null && alias ls='ls -G' }

# Take advantage of $LS_COLORS for completion as well.
[[ -n "$LS_COLORS" ]] && zstyle ':completion:*' list-colors "${(s.:.)LS_COLORS}"

# enable diff color if possible.
if command diff --color . . &>/dev/null; then
  alias diff='diff --color'
fi

# tell grep to highlight matches
grep --color a <<< a &>/dev/null && GREP_OPTIONS+=" --color=auto"

# avoid VCS folders
echo | grep --exclude-dir=.cvs '' &>/dev/null && \
    for PATTERN in .cvs .git .hg .svn; do
        GREP_OPTIONS+=" --exclude-dir=$PATTERN"
    done
echo | grep --exclude=.cvs '' &>/dev/null && \
    for PATTERN in .cvs .git .hg .svn; do
        GREP_OPTIONS+=" --exclude=$PATTERN"
    done

unset PATTERN
alias grep="grep $GREP_OPTIONS"
export GREP_COLOR='1;32'

zstyle ':completion:*' list-colors ''
zstyle ':completion:*:*:kill:*:processes' list-colors '=(#b) #([0-9]#) ([0-9a-z-]#)*=01;34=0=01'

###############################################################################
#                                    alias                                    #
###############################################################################
alias _='sudo'
alias ...='cd ../..'
alias ....='cd ../../..'
alias -- -="cd -"
alias 1='cd -'
alias 2='cd -2'
alias 3='cd -3'
alias 4='cd -4'
alias 5='cd -5'
alias 6='cd -6'
alias 7='cd -7'
alias 8='cd -8'
alias 9='cd -9'
alias cp='cp -i'
alias cpwd="pwd|tr -d '\n'|clipcopy"
alias df='df -hT'
alias ipl="ifconfig | grep -Eo 'inet (addr:)?([0-9]*\.){3}[0-9]*' | grep -Eo '([0-9]*\.){3}[0-9]*' | grep -v '127.0.0.1'"
alias la='ls -Ah'
alias ll='ls -lh'
alias lla='ls -lAh'
alias md='mkdir -p'
alias mv='mv -i'
alias paths='echo -e ${PATH//:/\\n}'
alias rm='echo "This is not the command you are looking for."; false'
alias ts='trash'

if [ `uname` = "Darwin" ]; then
    alias cleanupds="find . -type f -name '*.DS_Store' -ls -delete"
    alias cleanupad="find . -type d -name '.AppleD*' -ls -exec /bin/rm -r {} \;"
    alias flushdns="sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder"
    alias resetlaunchpad="defaults write com.apple.dock ResetLaunchPad -bool true"
    alias log='/usr/bin/log'
    alias ofd='open $PWD'
    alias typora='open -a typora'
fi

###############################################################################
#                                  functions                                  #
###############################################################################
# wrap command `ls` into a function
_ls_on_pwd_change() { ls }

# load add-zsh-hook if it's not available yet
(( $+functions[add-zsh-hook] )) || autoload -Uz add-zsh-hook

# hook _ls_on_cwd_change onto `chpwd`
add-zsh-hook chpwd _ls_on_pwd_change

cl () { cd "$@" && ls; }

mk () { mkdir -p "$@" && cd "$_"; }

d () {
  if [[ -n $1 ]]; then
    dirs "$@"
  else
    dirs -v | head -10
  fi
}

# Determine size of a file or total size of a directory
fs () {
  if du -b /dev/null > /dev/null 2>&1; then
    local arg=-sbh
  else
    local arg=-sh
  fi

  if [[ -n "$@" ]]; then
    du $arg -- "$@"
  else
    du $arg .[^.]* *
  fi
}

ip () {
  curl https://ipinfo.io/$1 ; echo
}

http_port=6152
socks_port=6153
proxy () {
  export http_proxy=http://127.0.0.1:$http_port
  export https_proxy=http://127.0.0.1:$http_port
  export all_proxy=socks5://127.0.0.1:$socks_port
  export no_proxy=localhost,127.0.0.0/8,*.local
  echo "Proxy on"
}
noproxy () {
  unset http_proxy
  unset https_proxy
  unset all_proxy
  unset no_proxy
  echo "Proxy off"
}
export http_proxy=http://127.0.0.1:$http_port
export https_proxy=http://127.0.0.1:$http_port
export all_proxy=socks5://127.0.0.1:$socks_port
export no_proxy=localhost,127.0.0.0/8,*.local

# fd - cd to selected directory
fd () {
  local dir
  dir=$(find ${1:-.} -type d 2> /dev/null | fzf +m) && cd $dir
}

# fcd - cd into the directory of the selected file
fcd () {
    local file
    local dir
    file=$(fzf +m -q "$1") && dir=$(dirname "$file") && cd "$dir"
}

# lazy load conda
conda () {
    unfunction conda

    # >>> conda initialize >>>
    # !! Contents within this block are managed by 'conda init' !!
    __conda_setup="$("$ANACONDA_HOME/bin/conda" "shell.zsh" "hook" 2> /dev/null)"
    if [ $? -eq 0 ]; then
        eval "$__conda_setup"
    else
        if [ -f "$ANACONDA_HOME/etc/profile.d/conda.sh" ]; then
            . "$ANACONDA_HOME/etc/profile.d/conda.sh"
        else
            export PATH="$ANACONDA_HOME/bin:$PATH"
        fi
    fi
    unset __conda_setup
    # <<< conda initialize <<<

    conda "$@"
}

transfer () {
    if [ $# -eq 0 ]; then
        echo "No arguments specified.\nUsage:\n transfer <file|directory>\n ... | transfer <file_name>" >&2
        return 1
    fi
    if tty -s; then
        file="$1";
        file_name=$(basename "$file")
        if [ ! -e "$file" ]; then
            echo "$file: No such file or directory" >&2
            return 1
        fi
        if [ -d "$file" ]; then
            file_name="$file_name.zip"
            (cd "$file" && zip -r -q - .) | curl --progress-bar --upload-file "-" "https://transfer.sh/$file_name" | xargs echo
        else
            cat "$file" | curl --progress-bar --upload-file "-" "https://transfer.sh/$file_name" | xargs echo
        fi
    else
        file_name=$1
        curl --progress-bar --upload-file "-" "https://transfer.sh/$file_name" | xargs echo
    fi
}

# macOS related
appID () {
    if [ $# -eq 0 ]; then
        echo "Get Application's bundle identifier"
        echo "Usage:\n\tappID applicationName"
        return
    fi
    osascript -e "id of app \"$1\""
}

pfd () {
  osascript 2>/dev/null <<EOF
    tell application "Finder"
      return POSIX path of (insertion location as alias)
    end tell
EOF
}

pfs () {
  osascript 2>/dev/null <<EOF
    set output to ""
    tell application "Finder" to set the_selection to selection
    set item_count to count the_selection
    repeat with item_index from 1 to count the_selection
      if item_index is less than item_count then set the_delimiter to "\n"
      if item_index is item_count then set the_delimiter to ""
      set output to output & ((item item_index of the_selection as alias)'s POSIX path) & the_delimiter
    end repeat
EOF
}

cdf () {
	cd "$(osascript -e 'tell app "Finder" to POSIX path of (insertion location as alias)')";
}

man-preview () {
  man -t "$@" | open -f -a Preview
}
declare -f compdef &>/dev/null && compdef _man man-preview

quick-look () {
  (( $# > 0 )) && qlmanage -p $* &>/dev/null &
}
