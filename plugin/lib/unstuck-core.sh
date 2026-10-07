# unstuck core — shell-agnostic policy, context assembly and the runtime bridge.
#
# Sourced by plugin/<shell>/unstuck.*.  Nothing in here may use shell-specific
# syntax: it runs under both zsh and bash.  Everything that *is*
# shell-specific — hooks, line-editor access, history, option names — lives in
# the per-shell adapter, which must provide:
#
#   _unstuck_adapter_init                  register the shell's hooks
#   _unstuck_adapter_finish                unregister the shell's hooks
#   _unstuck_adapter_history <n>           print up to n recent commands
#   _unstuck_adapter_command_exists <word> 0 = the shell can resolve it
#   _unstuck_adapter_supports_comment      0 = '#' starts a comment here
#   _unstuck_adapter_pending_ready <cmd>   the shell may deliver a suggestion
#   _unstuck_adapter_delivery             "prefill" or "enter" (how it is delivered)
#   _unstuck_adapter_doctor                print shell-side facts
#
# Contract with the runtime (unchanged across shells): 11 NUL-separated fields
# on stdin, human-readable panel on stdout, suggestion via --command-out.

_unstuck_setup() {
  : "${UNSTUCK_ROOT:?unstuck core needs UNSTUCK_ROOT}"
  : "${UNSTUCK_NAME:?unstuck core needs UNSTUCK_NAME}"

  # `$$` is the *main* shell's pid in both shells, so subshells (the
  # command-not-found handler runs in one) share the parent's session.
  UNSTUCK_SESSION_DIR="${TMPDIR:-/tmp}/unstuck-${UID:-$(id -u)}-$$"
  export UNSTUCK_SESSION_DIR
  [[ -d $UNSTUCK_SESSION_DIR ]] || mkdir -p -- "$UNSTUCK_SESSION_DIR"
  UNSTUCK_PENDING=$UNSTUCK_SESSION_DIR/pending
  UNSTUCK_CNF_TRIGGER=$UNSTUCK_SESSION_DIR/cnf-trigger
  UNSTUCK_CNF_QUERY=$UNSTUCK_SESSION_DIR/cnf-query

  UNSTUCK_LOG_FILE=${UNSTUCK_LOG_FILE:-$UNSTUCK_SESSION_DIR/log}
  UNSTUCK_MAX_EXIT_AI=${UNSTUCK_MAX_EXIT_AI:-3}
  UNSTUCK_FAIL_STREAK=${UNSTUCK_FAIL_STREAK:-0}
  UNSTUCK_LAST_CMD=""
  UNSTUCK_QUERY=""
  # Commands whose non-zero exit is normal, not a failure to explain.
  UNSTUCK_IGNORE=${UNSTUCK_IGNORE:-"grep egrep fgrep rg ag ack diff cmp test [ [[ false"}

  _unstuck_resolve_runtime
  _unstuck_adapter_init
}

# How the runtime is invoked: an explicit binary (UNSTUCK_BIN), one installed on
# PATH, or — for in-repo development — node running the TypeScript directly.
_unstuck_resolve_runtime() {
  if [[ -n ${UNSTUCK_BIN:-} ]]; then
    UNSTUCK_CMD=("$UNSTUCK_BIN")
  elif command -v unstuck >/dev/null 2>&1; then
    UNSTUCK_CMD=("$(command -v unstuck)")
  else
    UNSTUCK_CMD=(node "$UNSTUCK_ROOT/runtime/main.ts")
  fi
}

_unstuck_reload() {
  unset UNSTUCK_LOADED
  _unstuck_adapter_finish
  . "$UNSTUCK_ROOT/plugin/$UNSTUCK_NAME/unstuck.$UNSTUCK_EXT"
}

# --- small utilities used by every shell ------------------------------------

_unstuck_first_word() {
  local s=$1
  s=${s#"${s%%[![:space:]]*}"}
  printf '%s' "${s%%[[:space:]]*}"
}

# $1 = command name; uses the shell's own resolution via the adapter.
_unstuck_ignored() {
  case " $UNSTUCK_IGNORE $UNSTUCK_IGNORE_EXTRA " in
    *" $1 "*) return 0 ;;
  esac
  return 1
}

# Monotonic-ish milliseconds; EPOCHREALTIME exists in zsh (zsh/datetime) and
# bash >= 5.  `10#` keeps the fractional digits from being read as octal.
_unstuck_now_ms() {
  local t=${EPOCHREALTIME:-} frac
  if [[ -n $t ]]; then
    # Fraction precision differs per shell (bash: µs, zsh: ns) — take 3 digits.
    frac="${t#*.}000"
    printf '%s' "$(( ${t%.*} * 1000 + 10#${frac:0:3} ))"
  else
    printf '%s' "$(( ${EPOCHSECONDS:-0} * 1000 ))"
  fi
}

_unstuck_log() {
  # $1 trigger $2 ms $3 rc $4 command
  [[ -n ${UNSTUCK_LOG:-} ]] || return 0
  printf '%s\n' "trigger=$1 ms=$2 rc=$3 cmd=$4" >> "$UNSTUCK_LOG_FILE"
}

# --- context + runtime -------------------------------------------------------

# Field order is fixed by runtime/context.ts.  The trailing "  # rationale" the
# runtime appends to suggestions is stripped: fed back as context it made the
# model explain its own comment instead of the failure.
_unstuck_context() {
  # $1=trigger $2=buffer $3=last command $4=exit code
  printf '%s\0' "1"
  printf '%s\0' "$UNSTUCK_NAME"
  printf '%s\0' "$PWD"
  printf '%s\0' "${2%%  \# *}"
  printf '%s\0' "${3%%  \# *}"
  printf '%s\0' "$4"
  printf '%s\0' "$1"
  printf '%s\0' "$(_unstuck_adapter_history 20)"
  printf '%s\0' "$(env)"
  printf '%s\0' "$UNSTUCK_PENDING"
  printf '%s\0' "$(uname -srm 2>/dev/null)"
}

# Runs the runtime: it streams the panel to the terminal and writes the
# suggestion to the pending file.  Always returns 0 — a broken AI call must
# never change the shell's behaviour.
_unstuck_ask() {
  # $1=trigger $2=buffer $3=last command $4=exit code
  local trigger=$1 start_ms
  start_ms=$(_unstuck_now_ms)
  rm -f -- "$UNSTUCK_PENDING"

  local extra=()
  [[ -n ${UNSTUCK_MODEL:-} ]] && extra+=(--model "$UNSTUCK_MODEL")
  [[ -n ${UNSTUCK_TIMEOUT_MS:-} ]] && extra+=(--timeout "$UNSTUCK_TIMEOUT_MS")
  if _unstuck_adapter_supports_comment; then extra+=(--comment); fi
  extra+=(--delivery "$(_unstuck_adapter_delivery)")

  _unstuck_context "$@" | "${UNSTUCK_CMD[@]}" ask --command-out "$UNSTUCK_PENDING" "${extra[@]}"
  local rc=$?

  _unstuck_log "$trigger" "$(( $(_unstuck_now_ms) - start_ms ))" "$rc" "$3"
  return 0
}

# --- trigger policies --------------------------------------------------------

# Non-ASCII and nothing the shell can resolve ⇒ the user typed a question, not a
# command.  Shared by the pre-execution hook (zsh) and the command-not-found
# handler (bash) so both shells frame the input the same way.
_unstuck_looks_like_natural_language() {
  local line=$1 first saved_lc=${LC_ALL-}
  case ${line:0:1} in
    '' | '#' | '|' | '&' | ';' | '(' | ')' | '<' | '>') return 1 ;;
  esac
  # LC_ALL=C makes [:print:] byte-based, so non-ASCII is detected regardless of
  # the user's locale.
  LC_ALL=C
  case $line in
    *[![:print:][:space:]]*) : ;;
    *) LC_ALL=$saved_lc; return 1 ;;
  esac
  LC_ALL=$saved_lc
  first=$(_unstuck_first_word "$line")
  [[ -n $first ]] || return 1
  case $first in
    */*) return 1 ;;   # a path: let the shell report it, it is not a question
  esac
  _unstuck_adapter_command_exists "$first" && return 1
  return 0
}

# The explicit trigger: a leading run of `?`/`#` markers followed by text.
# `? 为什么失败` / `# why did this fail` are questions, never commands.
# A bare marker (or only blanks after it) is not a question — `#` stays a
# comment and `?` stays a glob — so it is left to the shell.
# Sets UNSTUCK_QUESTION_BODY (the question with the marker stripped) and never
# forks: this runs on every Enter.
_unstuck_explicit_question() {
  local line=$1 rest
  UNSTUCK_QUESTION_BODY=""
  case $line in
    '?'* | '#'*) ;;
    *) return 1 ;;
  esac
  rest=${line#"${line%%[!?#]*}"}          # drop the marker run
  rest=${rest#"${rest%%[![:space:]]*}"}   # drop the blanks after it
  [[ -n $rest ]] || return 1
  UNSTUCK_QUESTION_BODY=$rest
  return 0
}

# Natural language typed at the prompt (shells with a pre-execution hook).
# Deliberately conservative: everything that is not clearly a question goes to
# the shell untouched.
_unstuck_should_intercept_line() {
  [[ -n ${UNSTUCK_DISABLE:-} ]] && return 1
  _unstuck_explicit_question "$1" && return 0
  _unstuck_looks_like_natural_language "$1"
}

# Called by the shell's command-not-found hook (runs in a subshell in both zsh
# and bash, so only file-based side effects survive).
_unstuck_on_not_found() {
  local cmd=$1 line=${UNSTUCK_LAST_CMD:-$1}

  if [[ -n ${UNSTUCK_DISABLE:-} ]]; then
    _unstuck_adapter_not_found_message "$cmd"
    return 127
  fi

  if _unstuck_should_intercept_line "$line"; then
    # A question, not a mistyped command: skip the shell's own error line and
    # defer it to the prompt hook, so the parent shell owns delivery.
    printf '%s' "nl" > "$UNSTUCK_CNF_TRIGGER"
    printf '%s' "${UNSTUCK_QUESTION_BODY:-$line}" > "$UNSTUCK_CNF_QUERY"
    return 127
  fi

  _unstuck_adapter_not_found_message "$cmd"
  # iZSH writes command_end only after this handler returns. Deferring the AI
  # call to precmd makes the completed stdout/stderr available to the runtime.
  printf '%s' "command_not_found" > "$UNSTUCK_CNF_TRIGGER"
  printf '%s' "$line" > "$UNSTUCK_CNF_QUERY"
  return 127
}

# Called once per prompt, with the exit status of the command that just ran.
_unstuck_on_prompt() {
  local ret=$1 last=${2:-}

  if [[ -n ${UNSTUCK_QUERY:-} ]]; then
    # A natural-language line intercepted before execution (see the adapter).
    local query=$UNSTUCK_QUERY
    UNSTUCK_QUERY=""
    _unstuck_ask nl "$query" "" ""
    _unstuck_queue_pending
    return $ret
  fi

  if [[ -s $UNSTUCK_CNF_TRIGGER ]]; then
    local trigger query
    trigger=$(cat "$UNSTUCK_CNF_TRIGGER" 2>/dev/null)
    query=$(cat "$UNSTUCK_CNF_QUERY" 2>/dev/null)
    rm -f -- "$UNSTUCK_CNF_TRIGGER" "$UNSTUCK_CNF_QUERY"
    case $trigger in
      nl) _unstuck_ask nl "$query" "" 127 ;;
      command_not_found) _unstuck_ask command_not_found "$query" "$query" 127 ;;
    esac
    _unstuck_queue_pending
    return $ret
  fi

  if [[ -z ${UNSTUCK_DISABLE:-} ]]; then
    if (( ret == 0 || ret == 130 )); then
      UNSTUCK_FAIL_STREAK=0
    else
      local first
      first=$(_unstuck_first_word "$last")
      if [[ -n $first ]] && ! _unstuck_ignored "$first"; then
        UNSTUCK_FAIL_STREAK=$(( UNSTUCK_FAIL_STREAK + 1 ))
        if (( UNSTUCK_FAIL_STREAK <= UNSTUCK_MAX_EXIT_AI )); then
          _unstuck_ask non_zero_exit "$last" "$last" "$ret"
        fi
      fi
    fi
  fi

  _unstuck_queue_pending
  return $ret
}

# Hands a pending suggestion to the shell's delivery mechanism.  zsh pre-fills
# the next buffer by itself (zle-line-init); bash needs an explicit hand-off.
_unstuck_queue_pending() {
  [[ -s $UNSTUCK_PENDING ]] || return 0
  _unstuck_adapter_pending_ready "$(cat "$UNSTUCK_PENDING")"
}

# Shell-side facts for `unstuck doctor`.
_unstuck_doctor() {
  printf 'shell       : %s\n' "$UNSTUCK_NAME"
  _unstuck_adapter_doctor
  printf 'runtime     : %s\n' "${UNSTUCK_CMD[*]}"
  printf 'session dir : %s %s\n' "$UNSTUCK_SESSION_DIR" "$([[ -w $UNSTUCK_SESSION_DIR ]] && printf '可写' || printf '不可写')"
}

# User-facing entry points (both shells get the same names).
unstuck-doctor() { _unstuck_doctor; }
unstuck-reload() { _unstuck_reload; }
