#!/usr/bin/env bash
# PostToolUse guard: a scripted edit bypasses the formatter, and no test suite
# can see it — vitest and karma do not care about formatting, while MegaLinter
# fails the PR for it. That gap has cost this workspace two PRs (2026-09-14,
# 2026-09-15), both found by a manual audit rather than by anything green.
#
# Checks only what `.mega-linter.yml` actually gates: TYPESCRIPT_PRETTIER and
# JSON_PRETTIER. `.scss` and `.html` are deliberately not linted there, so they
# are not checked here either.
#
# Exits 2 on a violation, which is what puts the message in front of Claude.
set -uo pipefail

file=$(cat | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("tool_input",{}).get("file_path",""))
except Exception: print("")' 2>/dev/null)

[ -n "$file" ] && [ -f "$file" ] || exit 0
case "$file" in
  *.ts|*.json|*.mjs|*.cjs) ;;
  *) exit 0 ;;
esac

# Walk up to the repo that owns the file and has prettier installed.
dir=$(cd "$(dirname "$file")" && pwd)
while [ "$dir" != "/" ] && [ ! -x "$dir/node_modules/.bin/prettier" ]; do
  dir=$(dirname "$dir")
done
[ -x "$dir/node_modules/.bin/prettier" ] || exit 0

if ! (cd "$dir" && ./node_modules/.bin/prettier --check "$file" >/dev/null 2>&1); then
  rel="${file#"$dir"/}"
  echo "prettier: ${rel} is not formatted, and MegaLinter fails the PR on this." >&2
  echo "Fix: (cd $(basename "$dir") && pnpm exec prettier --write \"${rel}\")" >&2
  exit 2
fi
exit 0
