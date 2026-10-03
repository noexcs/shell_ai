# Scenario 1 — natural language typed at the prompt.
#
# Replaces the accept-line widget: instead of handing the line to zsh's parser we
# can look at it first. Deliberately conservative (PRODUCTION_DESIGN §15): only a
# line that contains non-ASCII *and* whose first word resolves to nothing is
# treated as natural language. Everything else goes to `.accept-line` untouched,
# which also keeps `帮我(找出` out of the PS2 continuation trap.

_ai_shell_should_intercept() {
  [[ -n ${AI_SHELL_DISABLE-} ]] && return 1

  # Shell syntax can never be natural language — let zsh deal with it.
  case ${BUFFER[1]} in
    ''|'#'|'|'|'&'|';'|'('|')'|'<'|'>') return 1 ;;
  esac

  [[ $BUFFER == *[^[:ascii:]]* ]] || return 1

  local first=$(_ai_shell_first_word "$BUFFER")
  [[ -n $first ]] || return 1
  whence -w "$first" >/dev/null 2>&1 && return 1

  return 0
}

_ai_shell_accept_line() {
  if ! _ai_shell_should_intercept; then
    # Compose: if another plugin owned accept-line, defer to it.
    if [[ -v widgets[_ai_shell_outer_accept] ]]; then
      zle _ai_shell_outer_accept
    else
      zle .accept-line
    fi
    return 0
  fi

  # Do NOT print the panel here. ZLE's line accounting is stale while a widget
  # runs, so its redraw after the widget erases the tail of whatever we wrote
  # (measured at 85 cols: ESC[A×3 + ESC[J wiped `→ cmd`, the footer and the blank
  # line). Hand the query to precmd, which runs with ZLE inactive — the same
  # context the command-not-found and non-zero-exit paths print from.
  typeset -g AI_SHELL_QUERY=$BUFFER
  BUFFER=""
  CURSOR=0
  zle .accept-line
}

# Keep whatever already owned the widget (`.accept-line` still reaches the
# builtin, but a plugin's own wrapper would otherwise disappear).
if [[ -v widgets[accept-line] && ${widgets[accept-line]} != builtin ]]; then
  zle -A accept-line _ai_shell_outer_accept
fi
zle -N accept-line _ai_shell_accept_line
