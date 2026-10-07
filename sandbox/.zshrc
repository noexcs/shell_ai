# Sandbox zshrc for unstuck. Used only via ZDOTDIR, so the user's real
# ~/.zshrc is never touched.
#
#   scripts/sandbox.sh          -> interactive sandbox shell
#   python3 test/e2e.py         -> drives this sandbox over a pty

typeset -g UNSTUCK_SANDBOX_ROOT=${${(%):-%x}:A:h:h}

# Stable prompt token: the e2e harness synchronizes on it, and whatever follows
# it on the line is the current ZLE buffer.
PS1='UNSTUCK> '

export UNSTUCK_LOG=1
export UNSTUCK_LOG_FILE="${UNSTUCK_LOG_FILE:-$UNSTUCK_SANDBOX_ROOT/.unstuck-e2e/log}"
[[ -d ${UNSTUCK_LOG_FILE:h} ]] || mkdir -p -- "${UNSTUCK_LOG_FILE:h}"

# Keep test runs from leaving a history file behind; in-memory $history still works.
HISTFILE=/dev/null
setopt HIST_IGNORE_ALL_DUPS

# Suggested commands carry their rationale as a trailing `# …` comment; that is
# only inert when zsh treats `#` as a comment. Off by default in zsh, on in bash.
setopt interactive_comments

source "$UNSTUCK_SANDBOX_ROOT/plugin/zsh/unstuck.zsh"
