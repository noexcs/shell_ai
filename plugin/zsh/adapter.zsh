# zsh adapter: hooks, line-editor access, history.
#
# Everything here is zsh-specific.  The core calls these; see
# plugin/lib/unstuck-core.sh for the interface.

_unstuck_adapter_init() {
  autoload -Uz add-zsh-hook add-zle-hook-widget
  add-zsh-hook preexec _unstuck_zsh_preexec
  add-zsh-hook precmd _unstuck_zsh_precmd
  add-zsh-hook zshexit _unstuck_zsh_exit

  # Scenario 2.  zsh runs this in a subshell (measured), so the suggestion can
  # only travel to the parent through the pending file.
  command_not_found_handler() { _unstuck_on_not_found "$1"; }

  # Compose: keep whatever already owned accept-line (another plugin's wrapper).
  if [[ -v widgets[accept-line] && ${widgets[accept-line]} != builtin ]]; then
    zle -A accept-line _unstuck_outer_accept
  fi
  zle -N accept-line _unstuck_zsh_accept_line
  add-zle-hook-widget line-init _unstuck_zsh_line_init
}

_unstuck_adapter_finish() {
  # add-zsh-hook / add-zle-hook-widget ignore duplicates, so a reload is safe.
  return 0
}

_unstuck_adapter_history() {
  local limit=${1:-20}
  local -a keys=(${(on)${(k)history}}) recent=()
  # A short array would make ${arr[-limit,-1]} empty in zsh — clamp explicitly.
  (( ${#keys} > limit )) && keys=("${keys[-${limit},-1]}")
  local key
  for key in "${keys[@]}"; do
    [[ ${history[$key]} == '#'* ]] && continue   # questions, not commands
    recent+=("${history[$key]}")
  done

  # A fresh shell's $history is empty (zsh does not preload the history file).
  if (( ${#recent} < limit )) && [[ -r ${HISTFILE-} ]]; then
    local line
    local -a past=()
    for line in "${(@f)$(command tail -n "$limit" -- "$HISTFILE" 2>/dev/null)}"; do
      [[ $line == ': '*';'* ]] && line=${line#*;}   # tolerate extended history format
      [[ $line == '#'* ]] && continue                # questions, not commands
      [[ -n $line ]] && past+=("$line")
    done
    recent=("${past[@]}" "${recent[@]}")
    (( ${#recent} > limit )) && recent=("${recent[-${limit},-1]}")
  fi

  (( ${#recent} )) && printf '%s\n' "${recent[@]}"
  return 0
}

_unstuck_adapter_not_found_message() { printf 'zsh: command not found: %s\n' "$1" >&2; }

_unstuck_adapter_command_exists() { whence -w "$1" >/dev/null 2>&1 }

_unstuck_adapter_supports_comment() { [[ -o interactive_comments ]] }

# zsh pre-fills the next buffer itself (zle-line-init), so nothing to arm here.
_unstuck_adapter_pending_ready() { return 0 }

_unstuck_adapter_delivery() { printf 'prefill'; }

_unstuck_adapter_doctor() {
  if [[ ${widgets[accept-line]-} == user:_unstuck_zsh_accept_line ]]; then
    printf 'accept-line : unstuck 已接管\n'
  else
    printf 'accept-line : %s（不是 unstuck，可能被别的插件覆盖）\n' "${widgets[accept-line]:-builtin}"
  fi
  printf 'line-init   : %s\n' "${widgets[zle-line-init]:-（未注册）}"
  printf 'comments    : %s\n' "${options[interactive_comments]}"
}

# --- hooks -------------------------------------------------------------------

_unstuck_zsh_preexec() { UNSTUCK_LAST_CMD=$1 }

_unstuck_zsh_precmd() {
  local ret=$?
  # An empty line keeps $? (measured in both shells), so without this guard a
  # bare Enter after a failure would re-analyse the same command.
  local marker=${HISTCMD:-0}
  if [[ $marker == ${UNSTUCK_LAST_HISTCMD:-} ]]; then
    _unstuck_on_prompt 0 ""
    return $ret
  fi
  typeset -g UNSTUCK_LAST_HISTCMD=$marker
  _unstuck_on_prompt "$ret" "$UNSTUCK_LAST_CMD"
  return $ret
}

# Scenario 1 — natural language typed at the prompt.
#
# Do NOT print the panel here: ZLE's line accounting is stale while a widget
# runs, and its redraw after the widget erases the tail of whatever we wrote
# (measured: ESC[A×3 + ESC[J wiped the command line, the footer and the blank
# line).  Hand the query to precmd, which runs with ZLE inactive.
_unstuck_zsh_accept_line() {
  if ! _unstuck_should_intercept_line "$BUFFER"; then
    if [[ -v widgets[_unstuck_outer_accept] ]]; then
      zle _unstuck_outer_accept
    else
      zle .accept-line
    fi
    return 0
  fi
  # The explicit `? …` / `# …` trigger already carries the question without its
  # marker; the heuristic path asks with the line as typed.
  local query=${UNSTUCK_QUESTION_BODY:-$BUFFER}
  typeset -g UNSTUCK_QUERY=$query

  # Keep the question on screen instead of erasing it: re-submit it as a comment
  # so zsh echoes the line, records it in history, and executes nothing.  Only a
  # single-line buffer can be commented out — a `#` would leave the rest of it
  # runnable — and without interactive_comments a `#` line is a command, so both
  # of those fall back to clearing the buffer.
  if _unstuck_adapter_supports_comment && [[ $query != *$'\n'* ]]; then
    BUFFER="# $query"
    CURSOR=${#BUFFER}
  else
    BUFFER="" CURSOR=0
  fi
  zle .accept-line
}

# Delivery: zle-line-init runs inside a widget, so BUFFER can be set here (unlike
# from the command-not-found subshell).  At line-init the buffer is empty, so
# nothing the user typed can be clobbered.
_unstuck_zsh_line_init() {
  [[ -s $UNSTUCK_PENDING ]] || return 0
  local suggestion
  suggestion=$(cat "$UNSTUCK_PENDING")
  [[ -n $suggestion ]] || return 0
  rm -f -- "$UNSTUCK_PENDING"
  BUFFER=$suggestion CURSOR=${#suggestion}
}

_unstuck_zsh_exit() {
  zmodload zsh/system 2>/dev/null
  [[ ${sysparams[pid]} == $$ ]] || return 0   # subshell: leave the parent's dir alone
  rm -rf -- "$UNSTUCK_SESSION_DIR"
}
