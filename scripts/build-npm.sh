#!/bin/sh
# Build the npm artifact: a single bundled JS file (~450KB) that runs on any
# Node >= 20 — no TypeScript, no node_modules, no 60MB binary.
#
# Node cannot strip types for files under node_modules
# (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so the published CLI must be
# compiled; bun bundles the AI SDK in at build time and the deps stay dev-only.
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

node scripts/gen-plugin.ts

mkdir -p bin
bun build --target=node --minify --outfile bin/ai-shell.js runtime/main.ts
chmod +x bin/ai-shell.js
ls -lh bin/ai-shell.js
