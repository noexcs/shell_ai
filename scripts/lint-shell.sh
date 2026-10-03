#!/bin/sh
# Syntax-check every shell file with the shell that will actually source it.
#
# Each file is checked SEPARATELY on purpose: `bash -n a b` treats b as an
# argument, so a broken second file would pass unnoticed.
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

fail=0
check() {
  file=$1
  shell=$2
  if command -v "$shell" >/dev/null 2>&1; then
    if "$shell" -n "$file" 2>/tmp/ai-shell-lint.err; then
      printf 'ok   %-42s (%s)\n' "$file" "$shell"
    else
      printf 'FAIL %-42s (%s)\n' "$file" "$shell"
      sed 's/^/     /' /tmp/ai-shell-lint.err
      fail=1
    fi
  else
    printf 'skip %-42s (%s 不存在)\n' "$file" "$shell"
  fi
}

for file in plugin/lib/*.sh; do
  check "$file" bash
  check "$file" zsh
done
for file in plugin/bash/*.bash; do check "$file" bash; done
for file in plugin/zsh/*.zsh; do check "$file" zsh; done
check sandbox/.bashrc bash
check sandbox/.zshrc zsh

exit $fail
