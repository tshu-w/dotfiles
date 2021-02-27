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
setopt hist_ignore_dups       # ignore duplicated commands history list
setopt hist_ignore_space      # ignore commands that start with space
setopt hist_verify            # show command with history expansion to user before running it
setopt share_history          # share command history data

export HISTFILE="$XDG_DATA_HOME/zsh/history"
[ ! -d "$XDG_DATA_HOME/zsh" ] && mkdir -p "$XDG_DATA_HOME/zsh"
[ "$HISTSIZE" -lt 50000 ] && HISTSIZE=50000
[ "$SAVEHIST" -lt 10000 ] && SAVEHIST=10000

###############################################################################
#                                   ZZINIT                                    #
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

zinit light zsh-users/zsh-autosuggestions
zinit light zsh-users/zsh-completions
zinit light zdharma/fast-syntax-highlighting

zinit light alexrochas/zsh-extract
zinit light sobolevn/wakatime-zsh-plugin
# zinit light sukkaw/zsh-osx-autoproxy

# OMZ
zinit snippet OMZ::lib/clipboard.zsh
zinit snippet OMZ::lib/key-bindings.zsh

# p10k
zinit ice depth=1; zinit light romkatv/powerlevel10k
# To customize prompt, run `p10k configure` or edit $ZDOTDIR/p10k.zsh.
[[ ! -f $ZDOTDIR/p10k.zsh ]] || source $ZDOTDIR/p10k.zsh

autoload -Uz compinit; compinit -D $ZINIT[ZCOMPDUMP_PATH] && zinit cdreplay -q
zstyle ':completion::complete:*' cache-path $ZSH_CACHE_DIR/zcompcache

# emacs completion
declare -f compdef &>/dev/null && compdef _gnu_generic emacs emacsclient

# fzf
export FZF_DEFAULT_OPTS='--height 40% --layout=reverse'
if  command -v brew &> /dev/null ; then
    [ -f $XDG_CONFIG_HOME/fzf/fzf.zsh ] \
        || $(brew --prefix)/opt/fzf/install --xdg --key-bindings --completion --no-update-rc --no-bash --no-fish
    source $XDG_CONFIG_HOME/fzf/fzf.zsh
else
    source $JUNEST_HOME/usr/share/fzf/key-bindings.zsh
    source $JUNEST_HOME/usr/share/fzf/completion.zsh
fi

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
alias cpwd="pwd|tr -d '\n'|clipcopy"
alias ip="curl https://ipinfo.io/$1 ; echo"
alias ipl="ifconfig | grep -Eo 'inet (addr:)?([0-9]*\.){3}[0-9]*' | grep -Eo '([0-9]*\.){3}[0-9]*' | grep -v '127.0.0.1'"
alias la='ls -Ah'
alias ll='ls -lh'
alias lla='ls -lAh'
alias magit='ec -e "(magit-status \"$PWD\")"'
alias md='mkdir -p'
alias paths='echo -e ${PATH//:/\\n}'
alias sshr='ssh -fnNT -R :2048:localhost:22'
alias asshr='autossh -M 0 -f -nNT -R :2048:localhost:22'
alias rm='echo "This is not the command you are looking for."; false'
alias ts='trash'

alias pbtext="pbpaste | textutil -convert txt -stdin -stdout -encoding 30 | pbcopy"
alias pbspaces="pbpaste | expand | pbcopy"

if [[ `uname` == "Darwin" ]]; then
    alias cleanupds="find . -type f -name '*.DS_Store' -ls -delete"
    alias cleanupad="find . -type d -name '.AppleD*' -ls -exec /bin/rm -r {} \;"
    alias flushdns='dscacheutil -flushcache && killall -HUP mDNSResponder'
    alias log='/usr/bin/log'
    alias ofd='open $PWD'
    alias subl='open -a "Sublime text"'
    alias typora='open -a typora'
else
    alias j="junest"
    alias jf="junest -f"
fi

###############################################################################
#                                  functions                                  #
###############################################################################

# Preferred editor for local and remote sessions
# if [[ -n $SSH_CONNECTION ]]; then
#     ec () { ssh mac "emacsclient --no-wait /ssh:hostname:$(readlink -f $1)"; }
# fi

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

http_port=6152
socks_port=6153
proxy () {
  export http_proxy="http://127.0.0.1:$http_port"
  export https_proxy="http://127.0.0.1:$http_port"
  export all_proxy="socks5://127.0.0.1:$socks_port"
  echo "Proxy on"
}
noproxy () {
  unset http_proxy
  unset https_proxy
  unset all_proxy
  echo "Proxy off"
}
remote_proxy () {
    ssh -fnNT -R :"$http_port":localhost:"$http_port" $1
    ssh -fnNT -R :"$socks_port":localhost:"$socks_port" $1
}

# cdd - cd into the directory of the selected file
cdd () {
    local file
    local dir
    file=$(fzf +m -q "$1") && dir=$(dirname "$file") && cd "$dir"
}

# fkill - kill processes - list only the ones you can kill. Modified the earlier script.
fkill () {
    local pid
    if [ "$UID" != "0" ]; then
        pid=$(ps -f -u $UID | sed 1d | fzf -m | awk '{print $2}')
    else
        pid=$(ps -ef | sed 1d | fzf -m | awk '{print $2}')
    fi

    if [ "x$pid" != "x" ]
    then
        echo $pid | xargs kill -${1:-9}
    fi
}

# lazy load conda
conda () {
    unfunction conda

    # >>> conda initialize >>>
    # !! Contents within this block are managed by 'conda init' !!
    __conda_setup="$('/usr/local/anaconda3/bin/conda' 'shell.zsh' 'hook' 2> /dev/null)"
    if [ $? -eq 0 ]; then
        eval "$__conda_setup"
    else
        if [ -f "/usr/local/anaconda3/etc/profile.d/conda.sh" ]; then
            . "/usr/local/anaconda3/etc/profile.d/conda.sh"
        else
            export PATH="/usr/local/anaconda3/bin:$PATH"
        fi
    fi
    unset __conda_setup
    # <<< conda initialize <<<

    conda "$@"
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
