# Scenario 3 — a command that ran and failed.
#
# precmd runs between the command's output and the next prompt, so a panel
# printed here lands exactly where the design wants it. Failures that were
# already handled (command-not-found, an intercepted natural-language line,
# Ctrl+C) are skipped, as are commands whose non-zero exit is normal.

_ai_shell_preexec() {
  typeset -g AI_SHELL_LAST_CMD=$1
}

_ai_shell_precmd() {
  local ret=$?

  # A natural-language line intercepted by the accept-line widget: answer it here,
  # where ZLE is not active and the panel survives intact.
  if [[ -n ${AI_SHELL_QUERY-} ]]; then
    local query=$AI_SHELL_QUERY
    AI_SHELL_QUERY=""
    _ai_shell_ask nl "$query" "" ""
    return $ret
  fi

  if [[ -e $AI_SHELL_SESSION_DIR/cnf-handled ]]; then
    rm -f -- "$AI_SHELL_SESSION_DIR/cnf-handled"
    return $ret
  fi
  [[ -n ${AI_SHELL_DISABLE-} ]] && return $ret

  if (( ret == 0 || ret == 130 )); then
    AI_SHELL_FAIL_STREAK=0
    return $ret
  fi

  local cmd=${AI_SHELL_LAST_CMD:-}
  [[ -n $cmd ]] || return $ret

  local first=$(_ai_shell_first_word "$cmd")
  # Read the extra list at check time so an interactive `export` takes effect too.
  local -a extra=(${=AI_SHELL_IGNORE_EXTRA-})
  (( ${AI_SHELL_IGNORE[(I)$first]} + ${extra[(I)$first]} )) && return $ret

  (( AI_SHELL_FAIL_STREAK++ ))
  (( AI_SHELL_FAIL_STREAK > AI_SHELL_MAX_EXIT_AI )) && return $ret

  _ai_shell_ask non_zero_exit "$cmd" "$cmd" "$ret"
  return $ret
}
