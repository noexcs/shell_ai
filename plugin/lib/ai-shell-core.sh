# ai-shell core — shell-agnostic policy, context assembly and the runtime bridge.
#
# Sourced by plugin/<shell>/ai-shell.*.  Nothing in here may use shell-specific
# syntax: it runs under both zsh and bash.  Everything that *is*
# shell-specific — hooks, line-editor access, history, option names — lives in
# the per-shell adapter, which must provide:
#
#   _ai_shell_adapter_init                  register the shell's hooks
#   _ai_shell_adapter_finish                unregister the shell's hooks
#   _ai_shell_adapter_history <n>           print up to n recent commands
#   _ai_shell_adapter_command_exists <word> 0 = the shell can resolve it
#   _ai_shell_adapter_supports_comment      0 = '#' starts a comment here
#   _ai_shell_adapter_pending_ready <cmd>   the shell may deliver a suggestion
#   _ai_shell_adapter_notice <text>         one dim hint line (may be a no-op)
#   _ai_shell_adapter_doctor                print shell-side facts
#
# Contract with the runtime (unchanged across shells): 11 NUL-separated fields
# on stdin, human-readable panel on stdout, suggestion via --command-out.

_ai_shell_setup() {
  : "${AI_SHELL_ROOT:?ai-shell core needs AI_SHELL_ROOT}"
  : "${AI_SHELL_NAME:?ai-shell core needs AI_SHELL_NAME}"

  # `$$` is the *main* shell's pid in both shells, so subshells (the
  # command-not-found handler runs in one) share the parent's session.
  AI_SHELL_SESSION_DIR="${TMPDIR:-/tmp}/ai-shell-${UID:-$(id -u)}-$$"
  export AI_SHELL_SESSION_DIR
  [[ -d $AI_SHELL_SESSION_DIR ]] || mkdir -p -- "$AI_SHELL_SESSION_DIR"
  AI_SHELL_PENDING=$AI_SHELL_SESSION_DIR/pending
  AI_SHELL_CNF_FLAG=$AI_SHELL_SESSION_DIR/cnf-handled

  AI_SHELL_LOG_FILE=${AI_SHELL_LOG_FILE:-$AI_SHELL_SESSION_DIR/log}
  AI_SHELL_MAX_EXIT_AI=${AI_SHELL_MAX_EXIT_AI:-3}
  AI_SHELL_FAIL_STREAK=${AI_SHELL_FAIL_STREAK:-0}
  AI_SHELL_LAST_CMD=""
  AI_SHELL_QUERY=""
  # Commands whose non-zero exit is normal, not a failure to explain.
  AI_SHELL_IGNORE=${AI_SHELL_IGNORE:-"grep egrep fgrep rg ag ack diff cmp test [ [[ false"}

  _ai_shell_resolve_runtime
  _ai_shell_adapter_init
}

# How the runtime is invoked: an explicit binary (AI_SHELL_BIN), one installed on
# PATH, or — for in-repo development — node running the TypeScript directly.
_ai_shell_resolve_runtime() {
  if [[ -n ${AI_SHELL_BIN:-} ]]; then
    AI_SHELL_CMD=("$AI_SHELL_BIN")
  elif command -v ai-shell >/dev/null 2>&1; then
    AI_SHELL_CMD=("$(command -v ai-shell)")
  else
    AI_SHELL_CMD=(node "$AI_SHELL_ROOT/runtime/main.ts")
  fi
}

_ai_shell_reload() {
  unset AI_SHELL_LOADED
  _ai_shell_adapter_finish
  . "$AI_SHELL_ROOT/plugin/$AI_SHELL_NAME/ai-shell.$AI_SHELL_EXT"
}

# --- small utilities used by every shell ------------------------------------

_ai_shell_first_word() {
  local s=$1
  s=${s#"${s%%[![:space:]]*}"}
  printf '%s' "${s%%[[:space:]]*}"
}

# $1 = command name; uses the shell's own resolution via the adapter.
_ai_shell_ignored() {
  case " $AI_SHELL_IGNORE $AI_SHELL_IGNORE_EXTRA " in
    *" $1 "*) return 0 ;;
  esac
  return 1
}

# Monotonic-ish milliseconds; EPOCHREALTIME exists in zsh (zsh/datetime) and
# bash >= 5.  `10#` keeps the fractional digits from being read as octal.
_ai_shell_now_ms() {
  local t=${EPOCHREALTIME:-} frac
  if [[ -n $t ]]; then
    # Fraction precision differs per shell (bash: µs, zsh: ns) — take 3 digits.
    frac="${t#*.}000"
    printf '%s' "$(( ${t%.*} * 1000 + 10#${frac:0:3} ))"
  else
    printf '%s' "$(( ${EPOCHSECONDS:-0} * 1000 ))"
  fi
}

_ai_shell_log() {
  # $1 trigger $2 ms $3 rc $4 command
  [[ -n ${AI_SHELL_LOG:-} ]] || return 0
  printf '%s\n' "trigger=$1 ms=$2 rc=$3 cmd=$4" >> "$AI_SHELL_LOG_FILE"
}

# --- context + runtime -------------------------------------------------------

# Field order is fixed by runtime/context.ts.  The trailing "  # rationale" the
# runtime appends to suggestions is stripped: fed back as context it made the
# model explain its own comment instead of the failure.
_ai_shell_context() {
  # $1=trigger $2=buffer $3=last command $4=exit code
  printf '%s\0' "1"
  printf '%s\0' "$AI_SHELL_NAME"
  printf '%s\0' "$PWD"
  printf '%s\0' "${2%%  \# *}"
  printf '%s\0' "${3%%  \# *}"
  printf '%s\0' "$4"
  printf '%s\0' "$1"
  printf '%s\0' "$(_ai_shell_adapter_history 20)"
  printf '%s\0' "$(env)"
  printf '%s\0' "$AI_SHELL_PENDING"
  printf '%s\0' "$(uname -srm 2>/dev/null)"
}

# Runs the runtime: it streams the panel to the terminal and writes the
# suggestion to the pending file.  Always returns 0 — a broken AI call must
# never change the shell's behaviour.
_ai_shell_ask() {
  # $1=trigger $2=buffer $3=last command $4=exit code
  local trigger=$1 start_ms
  start_ms=$(_ai_shell_now_ms)
  rm -f -- "$AI_SHELL_PENDING"

  local -a extra=()
  [[ -n ${AI_SHELL_MODEL:-} ]] && extra+=(--model "$AI_SHELL_MODEL")
  [[ -n ${AI_SHELL_TIMEOUT_MS:-} ]] && extra+=(--timeout "$AI_SHELL_TIMEOUT_MS")
  if _ai_shell_adapter_supports_comment; then extra+=(--comment); fi

  _ai_shell_context "$@" | "${AI_SHELL_CMD[@]}" ask --command-out "$AI_SHELL_PENDING" "${extra[@]}"
  local rc=$?

  _ai_shell_log "$trigger" "$(( $(_ai_shell_now_ms) - start_ms ))" "$rc" "$3"
  return 0
}

# --- trigger policies --------------------------------------------------------

# Natural language typed at the prompt (zsh/shells with a pre-execution hook).
# Deliberately conservative: only a line that contains non-ASCII *and* whose
# first word resolves to nothing is treated as natural language.  Everything
# else goes to the shell untouched.
_ai_shell_should_intercept_line() {
  local line=$1 first
  [[ -n ${AI_SHELL_DISABLE:-} ]] && return 1
  case ${line:0:1} in
    '' | '#' | '|' | '&' | ';' | '(' | ')' | '<' | '>') return 1 ;;
  esac
  # LC_ALL=C makes [:print:] byte-based, so non-ASCII is detected regardless of
  # the user's locale.
  local saved_lc=${LC_ALL-}
  LC_ALL=C
  case $line in
    *[![:print:][:space:]]*) : ;;
    *) LC_ALL=$saved_lc; return 1 ;;
  esac
  LC_ALL=$saved_lc
  first=$(_ai_shell_first_word "$line")
  [[ -n $first ]] || return 1
  _ai_shell_adapter_command_exists "$first" && return 1
  return 0
}

# Called by the shell's command-not-found hook (runs in a subshell in both zsh
# and bash, so only file-based side effects survive).
_ai_shell_on_not_found() {
  local cmd=$1
  _ai_shell_adapter_not_found_message "$cmd"
  [[ -n ${AI_SHELL_DISABLE:-} ]] && return 127
  : > "$AI_SHELL_CNF_FLAG"
  _ai_shell_ask command_not_found "$AI_SHELL_LAST_CMD" "$cmd" 127
  return 127
}

# Called once per prompt, with the exit status of the command that just ran.
_ai_shell_on_prompt() {
  local ret=$1 last=${2:-} handled=0

  if [[ -n ${AI_SHELL_QUERY:-} ]]; then
    # A natural-language line intercepted before execution (see the adapter).
    local query=$AI_SHELL_QUERY
    AI_SHELL_QUERY=""
    _ai_shell_ask nl "$query" "" ""
    _ai_shell_queue_pending
    return $ret
  fi

  if [[ -e $AI_SHELL_CNF_FLAG ]]; then
    rm -f -- "$AI_SHELL_CNF_FLAG"
    handled=1
  fi

  if (( handled == 0 )) && [[ -z ${AI_SHELL_DISABLE:-} ]]; then
    if (( ret == 0 || ret == 130 )); then
      AI_SHELL_FAIL_STREAK=0
    else
      local first
      first=$(_ai_shell_first_word "$last")
      if [[ -n $first ]] && ! _ai_shell_ignored "$first"; then
        AI_SHELL_FAIL_STREAK=$(( AI_SHELL_FAIL_STREAK + 1 ))
        if (( AI_SHELL_FAIL_STREAK <= AI_SHELL_MAX_EXIT_AI )); then
          _ai_shell_ask non_zero_exit "$last" "$last" "$ret"
        fi
      fi
    fi
  fi

  _ai_shell_queue_pending
  return $ret
}

# Hands a pending suggestion to the shell's delivery mechanism.  zsh pre-fills
# the next buffer by itself (zle-line-init); bash needs an explicit hand-off.
_ai_shell_queue_pending() {
  [[ -s $AI_SHELL_PENDING ]] || return 0
  _ai_shell_adapter_pending_ready "$(cat "$AI_SHELL_PENDING")"
}

# Shell-side facts for `ai-shell doctor`.
_ai_shell_doctor() {
  printf 'shell       : %s\n' "$AI_SHELL_NAME"
  _ai_shell_adapter_doctor
  printf 'runtime     : %s\n' "${AI_SHELL_CMD[*]}"
  printf 'session dir : %s %s\n' "$AI_SHELL_SESSION_DIR" "$([[ -w $AI_SHELL_SESSION_DIR ]] && printf '可写' || printf '不可写')"
}

# User-facing entry points (both shells get the same names).
ai-shell-doctor() { _ai_shell_doctor; }
ai-shell-reload() { _ai_shell_reload; }
