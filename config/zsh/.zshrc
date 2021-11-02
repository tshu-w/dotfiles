[[ $TERM == "dumb" ]] && unsetopt zle && PS1='$ ' && return
[ ! -d $XDG_DATA_HOME/zsh ] && mkdir -p $XDG_DATA_HOME/zsh

# Enable Powerlevel10k instant prompt. Should stay close to the top of ~/.zshrc.
# Initialization code that may require console input (password prompts, [y/n]
# confirmations, etc.) must go above this block; everything else may go below.
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

###############################################################################
#                                     Znap                                    #
###############################################################################
ZNAP_HOME=$XDG_DATA_HOME/zsh/zsh-snap

if [[ ! -f $ZNAP_HOME/znap.zsh ]]; then
    git clone --depth 1 -- https://github.com/marlonrichert/zsh-snap.git $ZNAP_HOME
fi
source $ZNAP_HOME/znap.zsh

znap source romkatv/powerlevel10k
[ ! -f $ZDOTDIR/p10k.zsh ] || source $ZDOTDIR/p10k.zsh

znap source zsh-users/zsh-completions
znap source zsh-users/zsh-autosuggestions
znap source zsh-users/zsh-syntax-highlighting

znap source marlonrichert/zsh-autocomplete
zstyle ':completion:*' matcher-list 'm:{a-z}={A-Za-z}' 'r:|=*' 'l:|=* r:|=*'
zstyle ':completion:*:paths' path-completion yes
zstyle ':autocomplete:*' min-input 1
zstyle ':autocomplete:*' insert-unambiguous yes
zstyle ':autocomplete:*' fzf-completion yes
bindkey "?" list-expand
bindkey -M menuselect "^[m" accept-and-hold

znap source esc/conda-zsh-completion
znap source le0me55i/zsh-extract
znap source marlonrichert/zsh-edit
znap source ohmyzsh/ohmyzsh lib/clipboard.zsh
znap source sobolevn/wakatime-zsh-plugin
export ZSH_WAKATIME_BIN=/usr/local/bin/wakatime-cli

compdef _gnu_generic emacs emacsclient

# dir_colors
(( $+commands[dircolors] )) && znap eval dircolors 'dircolors -b $ZDOTDIR/dir_colors'

# direnv
(( $+commands[direnv] )) && znap eval direnv 'direnv hook zsh'

# fzf
export FZF_DEFAULT_OPTS='--height 40% --layout=reverse'
[ -f $XDG_CONFIG_HOME/fzf/fzf.zsh ] \
    || $(brew --prefix)/opt/fzf/install --xdg --no-key-bindings --completion --no-update-rc --no-bash --no-fish >/dev/null
source $XDG_CONFIG_HOME/fzf/fzf.zsh

# gpg
gpg-connect-agent /bye &>/dev/null

# zoxide
(( $+commands[zoxide] )) && znap eval zoxide 'zoxide init --cmd j zsh'

# iterm2_shell_integration
[ ! -e $ZDOTDIR/iterm2_shell_integration.zsh ] || source $ZDOTDIR/iterm2_shell_integration.zsh

###############################################################################
#                                     Misc                                    #
###############################################################################
export HISTFILE=$XDG_DATA_HOME/zsh/history
HISTSIZE=60000
SAVEHIST=50000

setopt extended_history
setopt hist_expire_dups_first hist_ignore_all_dups
setopt hist_ignore_space hist_verify share_history

zshaddhistory() {
  local line=${1%%$'\n'}
  local cmd=${line%% *}
  [[ ${#line} -ge 5
     && ${cmd} != (rm|\\rm|\"rm\")
  ]]
}

setopt auto_cd auto_pushd pushd_ignore_dups pushdminus
setopt interactivecomments long_list_jobs multios prompt_subst

bindkey '\ew' kill-region                             # [Esc-w] - Kill from the cursor to the mark
bindkey -s '\el' 'ls\n'                               # [Esc-l] - run command: ls
bindkey ' ' magic-space                               # [Space] - don't do history expansion

# Edit the current command line in $EDITOR
autoload -U edit-command-line
zle -N edit-command-line
bindkey '\C-x\C-e' edit-command-line

# file rename magick
bindkey "^[m" copy-prev-shell-word

###############################################################################
#                                    alias                                    #
###############################################################################
{ls --color -d . &>/dev/null && alias ls='ls --l --color'} \
    || { gls -G . &>/dev/null && alias ls='gls --l --color' } \
    || { ls -G . &>/dev/null && alias ls='ls -G' }

grep --color a <<< a &>/dev/null && alias grep="grep --color=auto"

alias _='sudo'
alias ...='cd ../..'
alias ....='cd ../../..'
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
