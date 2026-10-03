# AI Shell — zsh integration entry point (zsh 5.9+).
#
# Sourced from ~/.zshrc (`ai-shell install`). The plugin only ever *suggests*:
# the model's command is pasted into ZLE's BUFFER and still needs the user's
# Enter, so nothing here executes anything the model produced.
#
# Hot path rule: a normal command must not fork, network, or shell out. All
# classification below is builtin-only string work.

if [[ -n ${AI_SHELL_LOADED-} ]]; then
  return 0
fi
typeset -g AI_SHELL_LOADED=1

# <repo>/plugin/zsh/ai-shell.zsh -> <repo>
typeset -g AI_SHELL_ROOT=${${(%):-%x}:A:h:h:h}

# How the runtime is invoked: an explicit binary (AI_SHELL_BIN), one installed on
# PATH, or — for in-repo development — Node running the TypeScript directly.
typeset -ga AI_SHELL_CMD
if [[ -n ${AI_SHELL_BIN-} ]]; then
  AI_SHELL_CMD=("$AI_SHELL_BIN")
elif (( $+commands[ai-shell] )); then
  AI_SHELL_CMD=("${commands[ai-shell]}")
else
  AI_SHELL_CMD=(node "$AI_SHELL_ROOT/runtime/main.ts")
fi

typeset -g AI_SHELL_SESSION_DIR="${TMPDIR:-/tmp}/ai-shell-${UID}-$$"
export AI_SHELL_SESSION_DIR
[[ -d $AI_SHELL_SESSION_DIR ]] || mkdir -p -- "$AI_SHELL_SESSION_DIR"

# Config (all optional).
typeset -g AI_SHELL_MODEL=${AI_SHELL_MODEL-}
typeset -g AI_SHELL_TIMEOUT_MS=${AI_SHELL_TIMEOUT_MS-}
typeset -g AI_SHELL_LOG=${AI_SHELL_LOG-}
typeset -g AI_SHELL_LOG_FILE=${AI_SHELL_LOG_FILE-$AI_SHELL_SESSION_DIR/log}
typeset -g AI_SHELL_MAX_EXIT_AI=${AI_SHELL_MAX_EXIT_AI-3}
typeset -g AI_SHELL_PLATFORM=$(uname -srm 2>/dev/null)

# $EPOCHREALTIME feeds the latency column of the log; without this module it is
# empty and every measurement silently recorded 0.
zmodload zsh/datetime 2>/dev/null
typeset -g AI_SHELL_LAST_CMD=""
typeset -g AI_SHELL_QUERY=""
typeset -gi AI_SHELL_FAIL_STREAK=0

# Commands whose non-zero exit is normal, not a failure to explain.
typeset -ga AI_SHELL_IGNORE=(grep egrep fgrep rg ag ack diff cmp test '[' '[[' false)

for _ai_shell_module in context accept-line cnf lifecycle inject; do
  source "$AI_SHELL_ROOT/plugin/zsh/${_ai_shell_module}.zsh"
done
unset _ai_shell_module

autoload -Uz add-zsh-hook
add-zsh-hook preexec _ai_shell_preexec
add-zsh-hook precmd _ai_shell_precmd
add-zsh-hook zshexit _ai_shell_cleanup

# Shell-side facts for `ai-shell doctor` (the CLI runs this inside an
# interactive zsh, where ZLE state and the plugin's own widgets are visible).
ai-shell-doctor() {
  local -a lines
  lines+=("zsh         : $ZSH_VERSION")
  if [[ ${widgets[accept-line]-} == user:_ai_shell_accept_line ]]; then
    lines+=("accept-line : ai-shell 已接管")
  else
    lines+=("accept-line : ${widgets[accept-line]:-builtin}（不是 ai-shell，可能被别的插件覆盖）")
  fi
  lines+=("line-init   : ${widgets[zle-line-init]:-（未注册）}")
  lines+=("runtime     : ${AI_SHELL_CMD[*]}")
  lines+=("session dir : $AI_SHELL_SESSION_DIR $([[ -w $AI_SHELL_SESSION_DIR ]] && print -n 可写 || print -n 不可写)")
  lines+=("comments    : ${options[interactive_comments]}")
  print -rl -- "${lines[@]}"
}

# Pick up plugin updates without opening a new terminal (the load guard above
# would otherwise keep the version this shell started with).
ai-shell-reload() {
  unset AI_SHELL_LOADED
  source "$AI_SHELL_ROOT/plugin/zsh/ai-shell.zsh"
}
