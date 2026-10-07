# Sandbox bashrc for unstuck. Used only via `bash --rcfile`, so the user's real
# ~/.bashrc is never touched.
#
#   scripts/sandbox-bash.sh      -> interactive sandbox shell
#   python3 test/e2e.py --shell bash

_unstuck_sandbox_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

PS1='UNSTUCK> '

# Keep test runs from leaving a history file behind.
HISTFILE=/dev/null

export UNSTUCK_LOG=1
export UNSTUCK_LOG_FILE="${UNSTUCK_LOG_FILE:-$_unstuck_sandbox_root/.unstuck-e2e/log}"
[[ -d ${UNSTUCK_LOG_FILE%/*} ]] || mkdir -p -- "${UNSTUCK_LOG_FILE%/*}"

. "$_unstuck_sandbox_root/plugin/bash/unstuck.bash"
