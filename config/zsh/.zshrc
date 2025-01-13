[[ $TERM == "dumb" ]] && unsetopt zle && PS1='$ ' && return

### Zsh
setopt auto_cd auto_pushd pushd_ignore_dups pushdminus \
       interactive_comments long_list_jobs multios \
       glob_star_short numeric_glob_sort

bindkey -e                # force emacs mode regardless of $EDITOR
bindkey -s '\el' 'ls\n'   # [Esc-l] - run command: ls
bindkey ' ' magic-space   # [Space] - don't do history expansion
bindkey "^[m" copy-prev-shell-word
bindkey '^[q' push-line-or-edit
bindkey '^[k' describe-key-briefly # Alt-H: run-help

# Edit the current command line in $EDITOR
autoload -U edit-command-line
zle -N edit-command-line
bindkey '\C-x\C-e' edit-command-line

### Znap
ZNAP_HOME=$XDG_DATA_HOME/znap/zsh-snap
if [[ ! -f $ZNAP_HOME/znap.zsh ]]; then
    git clone --depth 1 -- https://github.com/marlonrichert/zsh-snap.git $ZNAP_HOME
fi
source $ZNAP_HOME/znap.zsh
zstyle ':znap:*:*' git-maintenance off
unset ZNAP_HOME

### Plugins
# starship
(( $+commands[starship] )) && { znap eval starship 'starship init zsh --print-full-init' ; znap prompt }

export ZSH_AUTOSUGGEST_STRATEGY=(history completion)
znap source zsh-users/zsh-completions
znap source zsh-users/zsh-autosuggestions
znap source zsh-users/zsh-syntax-highlighting

# dir_colors
(( $+commands[dircolors] )) && znap eval dircolors 'dircolors -b $ZDOTDIR/dir_colors'

znap source marlonrichert/zsh-autocomplete
zstyle ':completion:*' file-sort date
zstyle ':completion:*' list-colors ${(s.:.)LS_COLORS}
zstyle ':completion:*:paths' path-completion yes
zstyle ':completion:*:processes' command 'ps x'
zstyle ':autocomplete:*' min-input 1
zstyle ':autocomplete:*complete*:*' insert-unambiguous yes
zstyle ':completion:*:*' matcher-list 'm:{[:lower:]-}={[:upper:]_}' '+r:|[.]=**'
zstyle ':completion:*' completer _complete _complete:-fuzzy _correct _approximate _ignored
bindkey -M menuselect "^[m" accept-and-hold
bindkey -M menuselect "^I"  menu-complete
bindkey -M menuselect "$terminfo[kcbt]" reverse-menu-complete

znap source le0me55i/zsh-extract
znap source marlonrichert/zsh-edit
znap source conda-incubator/conda-zsh-completion

# direnv
(( $+commands[direnv] )) && znap eval direnv 'direnv hook zsh'

# iterm2 shell integration
if [ "${LC_TERMINAL-}" = "iTerm2" ]; then
    export PATH=$PATH:$HOME/.local/bin/iterm2
    znap eval iterm2 'curl -fsSL https://iterm2.com/shell_integration/zsh'
fi

# orbstack command-line tools and integration
[ -d ~/.orbstack ] && znap eval orbstack 'cat ~/.orbstack/shell/init.zsh'

# zoxide
(( $+commands[zoxide] )) && znap eval zoxide 'zoxide init --cmd j zsh'

### History
[ -d $XDG_STATE_HOME/zsh ] || mkdir -p $XDG_STATE_HOME/zsh
HISTFILE=$XDG_STATE_HOME/zsh/history
SAVEHIST=$(( 100 * 1000 ))
HISTSIZE=$(( 1.2 * SAVEHIST ))

setopt extended_history share_history \
       hist_expire_dups_first hist_ignore_all_dups \
       hist_ignore_space hist_verify

zshaddhistory() {
    local line=${1%%$'\n'}
    local cmd=${line%% *}
    [[ ${#line} -ge 5
         && ${cmd} != (rm|\\rm|\"rm\")
     ]]
}

### Misc
hash -d d="$HOME/dotfiles"
hash -d icloud="$HOME/Library/Mobile Documents/com~apple~CloudDocs"
hash -d surge="$HOME/Library/Mobile Documents/iCloud~com~nssurge~inc/Documents"
hash -d rime="$HOME/Library/Rime"

### Alias
for index ({1..9}) alias "$index"="cd -${index}"; unset index
alias _='sudo'
alias ...='cd ../..'
alias ....='cd ../../..'
alias cp='cp -i'
alias d='dirs -v | head -10'
alias df='df -h'
alias du='du -h'
if (( $+commands[wget] )); then
  alias get='wget --continue --progress=bar --timestamping'
elif (( $+commands[curl] )); then
  alias get='curl --continue-at - --location --progress-bar --remote-name --remote-time'
fi
alias grep='grep --color=auto'
alias iplocal="ifconfig | grep -Eo 'inet (addr:)?([0-9]*\.){3}[0-9]*' | grep -Eo '([0-9]*\.){3}[0-9]*' | grep -v '127.0.0.1'"
alias ls='ls --l --color=auto --group-directories-first'
alias la='ls -Ah'
alias ll='ls -lh'
alias lla='ls -lAh'
alias mv='mv -i'
alias paths='echo -e ${PATH//:/\\n}'
alias pip='python -m pip'
alias pdb='python -m pdb -c "c" -c "q"'
alias rm='echo "This is not the command you are looking for."; false'
alias rcp='rsync --archive --compress --verbose --human-readable --partial --progress'
alias rmv='rcp --remove-source-files'
alias rupd='rcp --update'
alias rsyn='rcp --update --delete'
alias scr='screen'
alias scrl='screen -ls'
alias scrn='screen -U -S'
alias scrr='screen -a -A -U -D -RR'
alias ssh='ssh -t -o PermitLocalCommand=yes'
alias topc='top -o %CPU'
alias topm='top -o %MEM'
alias ts='trash'
alias cleanupds="find . \( -type f -name '*.DS_Store' -o -type d -name '__MACOSX' \) -ls -exec /bin/rm -r {} \;"

alias magit='ec --eval "(magit-status)"'

if [ $VENDOR = "apple" ]; then
    alias cleanupad="find . -type d -name '.AppleD*' -ls -exec /bin/rm -r {} \;"
    alias flushdns="sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder"
    alias resetlaunchpad="defaults write com.apple.dock ResetLaunchPad -bool true"
    alias log='/usr/bin/log'
    alias ofd='open $PWD'
    alias topc='top -o cpu'
    alias topm='top -o vsize'
fi

### Functions
md () { mkdir -p "$@" && cd "$_"; }

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

cip () {
    curl "ipinfo.io/$1${IPINFO_TOKEN:+?token=$IPINFO_TOKEN}"; echo
}

http_port=6152; socks_port=6153
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
proxy_forward () {
    ssh -fnNT -R :${http_port}:localhost:${http_port} -R :${socks_port}:localhost:${socks_port} $@
}

# lazy load conda
conda () {
    unfunction conda

    # >>> conda initialize >>>
    # !! Contents within this block are managed by 'conda init' !!
    __conda_setup="$("$CONDA_HOME/bin/conda" "shell.zsh" "hook" 2> /dev/null)"
    if [ $? -eq 0 ]; then
        eval "$__conda_setup"
    else
        if [ -f "$CONDA_HOME/etc/profile.d/conda.sh" ]; then
            . "$CONDA_HOME/etc/profile.d/conda.sh"
        else
            export PATH="$CONDA_HOME/bin:$PATH"
        fi
    fi
    unset __conda_setup
    # <<< conda initialize <<<

    conda "$@"
}

colortest () {
    printf "          "
    for b in 0 1 2 3 4 5 6 7; do printf "  4${b}m "; done
    echo
    for f in "" 30 31 32 33 34 35 36 37; do
        for s in "" "1;"; do
            printf "%4sm" "${s}${f}"
            printf " \033[%sm%s\033[0m" "$s$f" "gYw "
            for b in 0 1 2 3 4 5 6 7; do
                printf " \033[4%s;%sm%s\033[0m" "$b" "$s$f" " gYw "
            done
            echo
        done
    done
}

cuda () {
    local devs=$1
    shift
    CUDA_VISIBLE_DEVICES="$devs" "$@"
}

onelink() {
    echo -n "$1"|base64|sed "s/=$//;s/\//\_/g;s/\+/\-/g;s/^/https:\/\/api\.onedrive\.com\/v1\.0\/shares\/u\!/;s/$/\/root\/content/";
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

# https://www.stefaanlippens.net/pretty-csv.html
pretty-csv () {
    # column -t -s, -n "$@" | less -F -S -X -K
    perl -pe 's/((?<=,)|(?<=^)),/ ,/g;' "$@" | column -t -s, | less  -F -S -X -K
}

if [ $VENDOR = "apple" ]; then
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

    quick-look () {
        (( $# > 0 )) && qlmanage -p $* &>/dev/null &
    }
fi

ghcs() {
	FUNCNAME="$funcstack[1]"
	TARGET="shell"
	local GH_DEBUG="$GH_DEBUG"
	local GH_HOST="$GH_HOST"

	read -r -d '' __USAGE <<-EOF
	Wrapper around \`gh copilot suggest\` to suggest a command based on a natural language description of the desired output effort.
	Supports executing suggested commands if applicable.

	USAGE
	  $FUNCNAME [flags] <prompt>

	FLAGS
	  -d, --debug           Enable debugging
	  -h, --help            Display help usage
	      --hostname        The GitHub host to use for authentication
	  -t, --target target   Target for suggestion; must be shell, gh, git
	                        default: "$TARGET"

	EXAMPLES

	- Guided experience
	  $ $FUNCNAME

	- Git use cases
	  $ $FUNCNAME -t git "Undo the most recent local commits"
	  $ $FUNCNAME -t git "Clean up local branches"
	  $ $FUNCNAME -t git "Setup LFS for images"

	- Working with the GitHub CLI in the terminal
	  $ $FUNCNAME -t gh "Create pull request"
	  $ $FUNCNAME -t gh "List pull requests waiting for my review"
	  $ $FUNCNAME -t gh "Summarize work I have done in issues and pull requests for promotion"

	- General use cases
	  $ $FUNCNAME "Kill processes holding onto deleted files"
	  $ $FUNCNAME "Test whether there are SSL/TLS issues with github.com"
	  $ $FUNCNAME "Convert SVG to PNG and resize"
	  $ $FUNCNAME "Convert MOV to animated PNG"
	EOF

	local OPT OPTARG OPTIND
	while getopts "dht:-:" OPT; do
		if [ "$OPT" = "-" ]; then     # long option: reformulate OPT and OPTARG
			OPT="${OPTARG%%=*}"       # extract long option name
			OPTARG="${OPTARG#"$OPT"}" # extract long option argument (may be empty)
			OPTARG="${OPTARG#=}"      # if long option argument, remove assigning `=`
		fi

		case "$OPT" in
			debug | d)
				GH_DEBUG=api
				;;

			help | h)
				echo "$__USAGE"
				return 0
				;;

			hostname)
				GH_HOST="$OPTARG"
				;;

			target | t)
				TARGET="$OPTARG"
				;;
		esac
	done

	# shift so that $@, $1, etc. refer to the non-option arguments
	shift "$((OPTIND-1))"

	TMPFILE="$(mktemp -t gh-copilotXXXXXX)"
	trap 'rm -f "$TMPFILE"' EXIT
	if GH_DEBUG="$GH_DEBUG" GH_HOST="$GH_HOST" gh copilot suggest -t "$TARGET" "$@" --shell-out "$TMPFILE"; then
		if [ -s "$TMPFILE" ]; then
			FIXED_CMD="$(cat $TMPFILE)"
			print -s "$FIXED_CMD"
			echo
			eval "$FIXED_CMD"
		fi
	else
		return 1
	fi
}

ghce() {
	FUNCNAME="$funcstack[1]"
	local GH_DEBUG="$GH_DEBUG"
	local GH_HOST="$GH_HOST"

	read -r -d '' __USAGE <<-EOF
	Wrapper around \`gh copilot explain\` to explain a given input command in natural language.

	USAGE
	  $FUNCNAME [flags] <command>

	FLAGS
	  -d, --debug      Enable debugging
	  -h, --help       Display help usage
	      --hostname   The GitHub host to use for authentication

	EXAMPLES

	# View disk usage, sorted by size
	$ $FUNCNAME 'du -sh | sort -h'

	# View git repository history as text graphical representation
	$ $FUNCNAME 'git log --oneline --graph --decorate --all'

	# Remove binary objects larger than 50 megabytes from git history
	$ $FUNCNAME 'bfg --strip-blobs-bigger-than 50M'
	EOF

	local OPT OPTARG OPTIND
	while getopts "dh-:" OPT; do
		if [ "$OPT" = "-" ]; then     # long option: reformulate OPT and OPTARG
			OPT="${OPTARG%%=*}"       # extract long option name
			OPTARG="${OPTARG#"$OPT"}" # extract long option argument (may be empty)
			OPTARG="${OPTARG#=}"      # if long option argument, remove assigning `=`
		fi

		case "$OPT" in
			debug | d)
				GH_DEBUG=api
				;;

			help | h)
				echo "$__USAGE"
				return 0
				;;

			hostname)
				GH_HOST="$OPTARG"
				;;
		esac
	done

	# shift so that $@, $1, etc. refer to the non-option arguments
	shift "$((OPTIND-1))"

	GH_DEBUG="$GH_DEBUG" GH_HOST="$GH_HOST" gh copilot explain "$@"
}


### Completions
compdef _gnu_generic emacs emacsclient
compdef _man man-preview
compdef _mkdir md
compdef _run run
compdef _sweep sweep

znap function _pip_completion pip       'eval "$( pip completion --zsh )"'
compctl -K    _pip_completion pip
