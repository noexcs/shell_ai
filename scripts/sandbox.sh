#!/bin/sh
# Interactive sandbox: a zsh whose rc file is sandbox/.zshrc, so ai-shell can be
# exercised without touching ~/.zshrc.
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
exec env ZDOTDIR="$root/sandbox" zsh -i
