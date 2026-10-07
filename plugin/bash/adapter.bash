# bash adapter: hooks, readline access, history.
#
# bash has no pre-execution hook, so this adapter deliberately does *not*
# intercept Enter:
#   * natural language is simply executed and lands in the
#     command-not-found path (the shell prints one "command not found" line);
#   * bind -x on Enter would consume that keystroke, and bash cannot pass it
#     through in the same keypress without eval (which breaks interactive
#     programs) — measured.
# Delivery of a suggestion therefore uses a one-shot Enter handler, armed only
# while a suggestion is pending: the Enter that would have been a no-op on an
# empty line accepts the suggestion instead.

_unstuck_adapter_init() {
  command_not_found_handle() { UNSTUCK_LAST_CMD="$*"; _unstuck_on_not_found "$1"; }

  # Ours must run first: every other PROMPT_COMMAND entry would clobber $?.
  local entry=_unstuck_bash_prompt
  if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == "declare -a"* ]]; then
    local -a rebuilt=("$entry")
    local existing
    for existing in "${PROMPT_COMMAND[@]}"; do
      [[ $existing == "$entry" ]] || rebuilt+=("$existing")
    done
    PROMPT_COMMAND=("${rebuilt[@]}")
  else
    case ";${PROMPT_COMMAND-};" in
      *";$entry;"*) : ;;
      *) PROMPT_COMMAND="$entry${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
    esac
  fi

  trap _unstuck_bash_exit EXIT
}

_unstuck_adapter_finish() { return 0; }

# bash's `history` prints "  <n>  <command>"; strip the number (and any
# HISTTIMEFORMAT prefix) without forking.
_unstuck_bash_strip_number() {
  local text=$1
  text=${text#"${text%%[![:space:]]*}"}      # leading blanks
  [[ $text == \[*\]* ]] && text=${text#*]}   # HISTTIMEFORMAT prefix, if any
  text=${text#"${text%%[![:space:]]*}"}
  text=${text#"${text%%[!0-9]*}"}            # the entry number
  text=${text#"${text%%[![:space:]]*}"}      # blanks after it
  printf '%s' "$text"
}

_unstuck_adapter_history() {
  local limit=${1:-20} line
  local -a lines=()
  while IFS= read -r line; do
    line=$(_unstuck_bash_strip_number "$line")
    [[ -n $line ]] && lines+=("$line")
  done < <(history "$limit" 2>/dev/null)
  (( ${#lines[@]} )) && printf '%s\n' "${lines[@]}"
  return 0
}

_unstuck_bash_last_command() {
  local line
  line=$(history 1 2>/dev/null) || return 0
  _unstuck_bash_strip_number "$line"
}

_unstuck_adapter_not_found_message() { printf 'bash: %s: command not found\n' "$1" >&2; }

_unstuck_adapter_command_exists() { command -v -- "$1" >/dev/null 2>&1; }

# bash enables this by default, so suggestions can carry their rationale inline.
_unstuck_adapter_supports_comment() { shopt -q interactive_comments; }

_unstuck_adapter_delivery() { printf 'enter'; }

# Arm the one-shot Enter handler.  `bind` only affects the current shell, so this
# must run in the prompt hook (never inside the command-not-found subshell).  The
# "press Enter" instruction is printed by the runtime inside the panel.
_unstuck_adapter_pending_ready() {
  [[ $- == *i* ]] || return 0
  bind -x '"\C-m": _unstuck_bash_accept' 2>/dev/null || return 0
}

_unstuck_bash_accept() {
  # The user started typing instead of accepting — never clobber their line.
  if [[ -n ${READLINE_LINE-} ]]; then
    bind '"\C-m": accept-line'
    return 0
  fi
  local suggestion
  suggestion=$(cat "$UNSTUCK_PENDING" 2>/dev/null)
  READLINE_LINE=$suggestion
  READLINE_POINT=${#suggestion}
  rm -f -- "$UNSTUCK_PENDING"
  bind '"\C-m": accept-line'
}

_unstuck_bash_prompt() {
  local ret=$? marker=${HISTCMD:-0}
  # An empty line keeps $? (measured), so without this guard a bare Enter after a
  # failure would re-analyse the same command on every keystroke-less prompt.
  if [[ $marker == "${UNSTUCK_LAST_HISTCMD:-}" ]]; then
    _unstuck_on_prompt 0 ""
    return $ret
  fi
  UNSTUCK_LAST_HISTCMD=$marker
  _unstuck_on_prompt "$ret" "$(_unstuck_bash_last_command)"
  return $ret
}

_unstuck_adapter_doctor() {
  if declare -F command_not_found_handle >/dev/null 2>&1; then
    printf 'not-found   : unstuck 已接管\n'
  else
    printf 'not-found   : 未接管\n'
  fi
  case "${PROMPT_COMMAND-}" in
    *_unstuck_bash_prompt*) printf 'prompt hook : 已挂载\n' ;;
    *) printf 'prompt hook : 未挂载\n' ;;
  esac
  printf 'comments    : %s\n' "$(shopt -q interactive_comments && printf on || printf off)"
}

_unstuck_bash_exit() {
  # Subshells inherit the EXIT trap; only the main shell may clean up.
  [[ ${BASHPID:-$$} == $$ ]] || return 0
  rm -rf -- "$UNSTUCK_SESSION_DIR"
}
