#!/bin/sh
# Interactive bash sandbox (bash 5+; macOS needs `brew install bash`).
set -e
root=$(cd "$(dirname "$0")/.." && pwd)

bash_bin=""
for candidate in bash5 /opt/homebrew/bin/bash /usr/local/bin/bash; do
  if command -v "$candidate" >/dev/null 2>&1; then bash_bin=$candidate; break; fi
done
if [ -z "$bash_bin" ]; then
  echo "需要 bash 4+（macOS 自带 3.2）：brew install bash" >&2
  exit 1
fi

exec env HISTFILE=/dev/null "$bash_bin" --rcfile "$root/sandbox/.bashrc" -i
