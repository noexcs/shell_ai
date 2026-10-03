# Context assembly + runtime invocation. This is the only place the shell talks
# to the Node runtime.

# First whitespace-delimited word of a command line, leading blanks stripped.
# Shared by the natural-language check and the exit-code ignore list.
_ai_shell_first_word() {
  local trimmed=${1##[[:space:]]#}
  print -r -- "${trimmed%%[[:space:]]*}"
}

# $1=trigger $2=ms $3=exit code $4=command — only written when AI_SHELL_LOG is on
# (the e2e suite asserts "normal commands leave no trace" through this file).
_ai_shell_log() {
  [[ -n $AI_SHELL_LOG ]] || return 0
  print -r -- "trigger=$1 ms=$2 rc=$3 cmd=$4" >> "$AI_SHELL_LOG_FILE"
}

# Emits the NUL-separated context on stdout, field order fixed by
# runtime/context.ts. Values are printed verbatim, so newlines/quotes/control
# characters need no escaping.
# $1=trigger $2=buffer $3=last command $4=exit code
_ai_shell_context() {
  local -a recent=()
  # zsh returns an EMPTY slice for ${arr[-20,-1]} when the array is shorter than
  # 20 — clamp by hand, otherwise short histories silently vanish.
  local -a keys=(${(on)${(k)history}})
  (( ${#keys} > 20 )) && keys=("${keys[-20,-1]}")
  local key
  for key in "${keys[@]}"; do
    recent+=("${history[$key]}")
  done

  # A fresh shell's $history is empty (zsh does not preload the history file), so
  # a failure on the first few commands would otherwise be judged with no context.
  if (( ${#recent} < 20 )) && [[ -r ${HISTFILE-} ]]; then
    local -a past=()
    local line
    for line in "${(@f)$(command tail -n 20 -- "$HISTFILE" 2>/dev/null)}"; do
      [[ $line == ': '*';'* ]] && line=${line#*;}   # tolerate extended history format
      [[ -n $line ]] && past+=("$line")
    done
    recent=("${past[@]}" "${recent[@]}")
    (( ${#recent} > 20 )) && recent=("${recent[-20,-1]}")
  fi

  local envdump=$(env)

  print -rn -- "1"$'\0'
  print -rn -- "zsh"$'\0'
  print -rn -- "$PWD"$'\0'
  # Strip the "  # rationale" the runtime appends to suggestions: fed back as
  # context it made the model explain its own comment instead of the failure.
  print -rn -- "${2%%  \# *}"$'\0'
  print -rn -- "${3%%  \# *}"$'\0'
  print -rn -- "$4"$'\0'
  print -rn -- "$1"$'\0'
  print -rn -- "${(F)recent}"$'\0'
  print -rn -- "$envdump"$'\0'
  print -rn -- "$AI_SHELL_SESSION_DIR/pending"$'\0'
  print -rn -- "$AI_SHELL_PLATFORM"$'\0'
}

# Runs the runtime, which streams the panel to the terminal and writes the
# suggestion (when there is one) to $AI_SHELL_SESSION_DIR/pending. Always
# returns 0: a broken AI call must never change the shell's behaviour.
# $1=trigger $2=buffer $3=last command $4=exit code
_ai_shell_ask() {
  local trigger=$1 start=$EPOCHREALTIME
  local out=$AI_SHELL_SESSION_DIR/pending
  # zsh does not word-split unquoted expansions, so `${VAR:+--model $VAR}`
  # would arrive as one mangled argv element. Build a real argv array instead.
  local -a extra=()
  [[ -n ${AI_SHELL_MODEL-} ]] && extra+=(--model "$AI_SHELL_MODEL")
  [[ -n ${AI_SHELL_TIMEOUT_MS-} ]] && extra+=(--timeout "$AI_SHELL_TIMEOUT_MS")
  # Trailing `# explanation` is only inert when the shell treats it as a comment;
  # with interactive_comments off those words become arguments to the command.
  [[ -o interactive_comments ]] && extra+=(--comment)
  rm -f -- "$out"

  _ai_shell_context "$@" | "${AI_SHELL_CMD[@]}" ask "${extra[@]}"
  local rc=$?

  local elapsed=$(( (EPOCHREALTIME - start) * 1000 ))
  _ai_shell_log "$trigger" "${elapsed%.*}" "$rc" "$2"
  return 0
}

_ai_shell_cleanup() {
  zmodload zsh/system 2>/dev/null
  [[ ${sysparams[pid]} == $$ ]] || return 0   # subshell: leave the parent's dir alone
  rm -rf -- "$AI_SHELL_SESSION_DIR"
}
