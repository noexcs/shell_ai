# AI Shell — zsh integration entry point (zsh 5.9+).
#
# The policy, context assembly and runtime bridge live in
# plugin/lib/ai-shell-core.sh; this directory only implements what is
# zsh-specific (see plugin/zsh/adapter.zsh).

if [[ -n ${AI_SHELL_LOADED-} ]]; then
  return 0
fi
typeset -g AI_SHELL_LOADED=1
typeset -g AI_SHELL_NAME=zsh
typeset -g AI_SHELL_EXT=zsh

# <repo>/plugin/zsh/ai-shell.zsh -> <repo>
typeset -g AI_SHELL_ROOT=${${(%):-%x}:A:h:h:h}

# $EPOCHREALTIME feeds the latency column of the log.
zmodload zsh/datetime 2>/dev/null

. "$AI_SHELL_ROOT/plugin/lib/ai-shell-core.sh"
. "$AI_SHELL_ROOT/plugin/zsh/adapter.zsh"

_ai_shell_setup
