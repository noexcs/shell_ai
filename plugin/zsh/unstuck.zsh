# Unstuck — zsh integration entry point (zsh 5.9+).
#
# The policy, context assembly and runtime bridge live in
# plugin/lib/unstuck-core.sh; this directory only implements what is
# zsh-specific (see plugin/zsh/adapter.zsh).

if [[ -n ${UNSTUCK_LOADED-} ]]; then
  return 0
fi
typeset -g UNSTUCK_LOADED=1
typeset -g UNSTUCK_NAME=zsh
typeset -g UNSTUCK_EXT=zsh

# <repo>/plugin/zsh/unstuck.zsh -> <repo>
typeset -g UNSTUCK_ROOT=${${(%):-%x}:A:h:h:h}

# $EPOCHREALTIME feeds the latency column of the log.
zmodload zsh/datetime 2>/dev/null

. "$UNSTUCK_ROOT/plugin/lib/unstuck-core.sh"
. "$UNSTUCK_ROOT/plugin/zsh/adapter.zsh"

_unstuck_setup
