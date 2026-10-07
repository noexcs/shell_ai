# Unstuck — bash integration entry point (bash 5+; macOS needs `brew install bash`).
#
# The policy, context assembly and runtime bridge live in
# plugin/lib/unstuck-core.sh; this directory only implements what is
# bash-specific (see plugin/bash/adapter.bash).

[[ -n ${UNSTUCK_LOADED-} ]] && return 0
UNSTUCK_LOADED=1
UNSTUCK_NAME=bash
UNSTUCK_EXT=bash

# <repo>/plugin/bash/unstuck.bash -> <repo>
UNSTUCK_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)

. "$UNSTUCK_ROOT/plugin/lib/unstuck-core.sh"
. "$UNSTUCK_ROOT/plugin/bash/adapter.bash"

_unstuck_setup
