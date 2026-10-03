# zsh adapter: hooks, line-editor access, history.
#
# Everything here is zsh-specific.  The core calls these; see
# plugin/lib/ai-shell-core.sh for the interface.

_ai_shell_adapter_init() {
  autoload -Uz add-zsh-hook add-zle-hook-widget
  add-zsh-hook preexec _ai_shell_zsh_preexec
  add-zsh-hook precmd _ai_shell_zsh_precmd
  add-zsh-hook zshexit _ai_shell_zsh_exit

  # Scenario 2.  zsh runs this in a subshell (measured), so the suggestion can
  # only travel to the parent through the pending file.
  command_not_found_handler() { _ai_shell_on_not_found "$1"; }

  # Compose: keep whatever already owned accept-line (another plugin's wrapper).
  if [[ -v widgets[accept-line] && ${widgets[accept-line]} != builtin ]]; then
    zle -A accept-line _ai_shell_outer_accept
  fi
  zle -N accept-line _ai_shell_zsh_accept_line
  add-zle-hook-widget line-init _ai_shell_zsh_line_init
}

_ai_shell_adapter_finish() {
  # add-zsh-hook / add-zle-hook-widget ignore duplicates, so a reload is safe.
  return 0
}

_ai_shell_adapter_history() {
  local limit=${1:-20}
  local -a keys=(${(on)${(k)history}}) recent=()
  # A short array would make ${arr[-limit,-1]} empty in zsh — clamp explicitly.
  (( ${#keys} > limit )) && keys=("${keys[-${limit},-1]}")
  local key
  for key in "${keys[@]}"; do recent+=("${history[$key]}"); done

  # A fresh shell's $history is empty (zsh does not preload the history file).
  if (( ${#recent} < limit )) && [[ -r ${HISTFILE-} ]]; then
    local line
    local -a past=()
    for line in "${(@f)$(command tail -n "$limit" -- "$HISTFILE" 2>/dev/null)}"; do
      [[ $line == ': '*';'* ]] && line=${line#*;}   # tolerate extended history format
      [[ -n $line ]] && past+=("$line")
    done
    recent=("${past[@]}" "${recent[@]}")
    (( ${#recent} > limit )) && recent=("${recent[-${limit},-1]}")
  fi

  (( ${#recent} )) && printf '%s\n' "${recent[@]}"
  return 0
}

_ai_shell_adapter_not_found_message() { printf 'zsh: command not found: %s\n' "$1" >&2; }

_ai_shell_adapter_command_exists() { whence -w "$1" >/dev/null 2>&1 }

_ai_shell_adapter_supports_comment() { [[ -o interactive_comments ]] }

# zsh pre-fills the next buffer itself (zle-line-init), so nothing to arm here.
_ai_shell_adapter_pending_ready() { return 0 }

_ai_shell_adapter_delivery() { printf 'prefill'; }

_ai_shell_adapter_doctor() {
  if [[ ${widgets[accept-line]-} == user:_ai_shell_zsh_accept_line ]]; then
    printf 'accept-line : ai-shell 已接管\n'
  else
    printf 'accept-line : %s（不是 ai-shell，可能被别的插件覆盖）\n' "${widgets[accept-line]:-builtin}"
  fi
  printf 'line-init   : %s\n' "${widgets[zle-line-init]:-（未注册）}"
  printf 'comments    : %s\n' "${options[interactive_comments]}"
}

# --- hooks -------------------------------------------------------------------

_ai_shell_zsh_preexec() { AI_SHELL_LAST_CMD=$1 }

_ai_shell_zsh_precmd() {
  local ret=$?
  # An empty line keeps $? (measured in both shells), so without this guard a
  # bare Enter after a failure would re-analyse the same command.
  local marker=${HISTCMD:-0}
  if [[ $marker == ${AI_SHELL_LAST_HISTCMD:-} ]]; then
    _ai_shell_on_prompt 0 ""
    return $ret
  fi
  typeset -g AI_SHELL_LAST_HISTCMD=$marker
  _ai_shell_on_prompt "$ret" "$AI_SHELL_LAST_CMD"
  return $ret
}

# Scenario 1 — natural language typed at the prompt.
#
# Do NOT print the panel here: ZLE's line accounting is stale while a widget
# runs, and its redraw after the widget erases the tail of whatever we wrote
# (measured: ESC[A×3 + ESC[J wiped the command line, the footer and the blank
# line).  Hand the query to precmd, which runs with ZLE inactive.
_ai_shell_zsh_accept_line() {
  if ! _ai_shell_should_intercept_line "$BUFFER"; then
    if [[ -v widgets[_ai_shell_outer_accept] ]]; then
      zle _ai_shell_outer_accept
    else
      zle .accept-line
    fi
    return 0
  fi
  typeset -g AI_SHELL_QUERY=$BUFFER
  BUFFER="" CURSOR=0
  zle .accept-line
}

# Delivery: zle-line-init runs inside a widget, so BUFFER can be set here (unlike
# from the command-not-found subshell).  At line-init the buffer is empty, so
# nothing the user typed can be clobbered.
_ai_shell_zsh_line_init() {
  [[ -s $AI_SHELL_PENDING ]] || return 0
  local suggestion
  suggestion=$(cat "$AI_SHELL_PENDING")
  [[ -n $suggestion ]] || return 0
  rm -f -- "$AI_SHELL_PENDING"
  BUFFER=$suggestion CURSOR=${#suggestion}
}

_ai_shell_zsh_exit() {
  zmodload zsh/system 2>/dev/null
  [[ ${sysparams[pid]} == $$ ]] || return 0   # subshell: leave the parent's dir alone
  rm -rf -- "$AI_SHELL_SESSION_DIR"
}
