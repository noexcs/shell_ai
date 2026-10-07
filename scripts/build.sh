#!/bin/sh
# Build a single self-contained executable — no Node, no npm, no node_modules at
# runtime. Cross-build with: scripts/build.sh bun-linux-x64
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
target=${1:-}
cd "$root"

# The zsh plugin is embedded so one file installs both halves.
node scripts/gen-plugin.ts

mkdir -p dist
if [ -n "$target" ]; then
  bun build --compile --target="$target" --outfile "dist/unstuck-$target" runtime/main.ts
  ls -lh "dist/unstuck-$target"
else
  bun build --compile --outfile dist/unstuck runtime/main.ts
  ls -lh dist/unstuck
fi
