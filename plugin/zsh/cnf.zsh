# Scenario 2 — `command not found`.
#
# zsh runs this handler in a subshell (measured), so anything assigned here dies
# with it: no BUFFER writes, no `print -z`. The panel is streamed from the
# subshell (it inherits the tty) and the suggestion is handed to the parent
# through the pending file, which zle-line-init injects.

command_not_found_handler() {
  # Keep zsh's own message: users expect to see what failed.
  print -u2 -- "zsh: command not found: $1"

  [[ -o interactive ]] || return 127
  [[ -n ${AI_SHELL_DISABLE-} ]] && return 127

  # Tell the next precmd that this failure has already been handled (S3).
  : >| "$AI_SHELL_SESSION_DIR/cnf-handled"

  # preexec ran in the parent, so the full original line is inherited here.
  _ai_shell_ask command_not_found "${AI_SHELL_LAST_CMD:-${(j: :)@}}" "$1" 127

  return 127
}
