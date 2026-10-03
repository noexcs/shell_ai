# Pending-suggestion injection.
#
# zle-line-init runs inside a widget, so writing BUFFER here is legal (unlike
# from the command-not-found subshell). At line-init the buffer is always empty,
# so nothing the user typed can be clobbered.

_ai_shell_line_init() {
  local out=$AI_SHELL_SESSION_DIR/pending
  [[ -s $out ]] || return 0

  local suggestion=$(<$out)
  rm -f -- "$out"
  [[ -n $suggestion ]] || return 0

  BUFFER=$suggestion
  CURSOR=${#BUFFER}
}

# add-zle-hook-widget chains with other line-init widgets instead of
# overwriting them (starship, autosuggestions, …).
autoload -Uz add-zle-hook-widget
add-zle-hook-widget line-init _ai_shell_line_init
