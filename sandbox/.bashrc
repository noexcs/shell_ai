# Sandbox bashrc for ai-shell. Used only via `bash --rcfile`, so the user's real
# ~/.bashrc is never touched.
#
#   scripts/sandbox-bash.sh      -> interactive sandbox shell
#   python3 test/e2e.py --shell bash

_ai_shell_sandbox_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

PS1='SHELLAI> '

# Keep test runs from leaving a history file behind.
HISTFILE=/dev/null

export AI_SHELL_LOG=1
export AI_SHELL_LOG_FILE="${AI_SHELL_LOG_FILE:-$_ai_shell_sandbox_root/.ai-shell-e2e/log}"
[[ -d ${AI_SHELL_LOG_FILE%/*} ]] || mkdir -p -- "${AI_SHELL_LOG_FILE%/*}"

. "$_ai_shell_sandbox_root/plugin/bash/ai-shell.bash"
