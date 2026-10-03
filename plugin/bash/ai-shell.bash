# AI Shell — bash integration entry point (bash 5+; macOS needs `brew install bash`).
#
# The policy, context assembly and runtime bridge live in
# plugin/lib/ai-shell-core.sh; this directory only implements what is
# bash-specific (see plugin/bash/adapter.bash).

[[ -n ${AI_SHELL_LOADED-} ]] && return 0
AI_SHELL_LOADED=1
AI_SHELL_NAME=bash
AI_SHELL_EXT=bash

# <repo>/plugin/bash/ai-shell.bash -> <repo>
AI_SHELL_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)

. "$AI_SHELL_ROOT/plugin/lib/ai-shell-core.sh"
. "$AI_SHELL_ROOT/plugin/bash/adapter.bash"

_ai_shell_setup
