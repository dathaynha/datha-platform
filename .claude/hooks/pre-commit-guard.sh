#!/usr/bin/env bash
# PreToolUse(Bash) guard for git commits. Two checks, both of which were being
# done by hand — which is the whole argument for a hook: a check living in the
# agent's head fails silently the first time it is forgotten.
#
#  1. AI attribution (critical-behaviors #9). A system reminder actively asks
#     for those trailers and CLAUDE.md overrides it, so the pressure to add
#     them is constant and external.
#  2. A real `.env` or an env-backup plaintext directory staged anywhere in the
#     workspace (critical-behaviors #1 and #2). `.env.example` is fine.
#
# Exit 2 blocks the tool call and shows stderr to Claude.
#
# Both patterns below are deliberately narrow, because the first version was
# not: it matched any Bash command that merely *mentioned* committing and a
# trailer, so it blocked the very commit that documented the rule. A command
# invocation is anchored to a command position, and a trailer is anchored to
# the start of a line — prose about either is neither.
set -uo pipefail

cmd=$(cat | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("tool_input",{}).get("command",""))
except Exception: print("")' 2>/dev/null)

[ -n "$cmd" ] || exit 0

# `git commit` invoked as a command, not named inside a string.
printf '%s' "$cmd" | grep -qE '(^|[;&|]|&&)[[:space:]]*(git|/usr/bin/git)[[:space:]]+commit([[:space:]]|$)' || exit 0

fail=0

# A real trailer occupies its own line; a sentence about one does not.
if printf '%s' "$cmd" | grep -qiE '^[[:space:]]*(co-authored-by:[[:space:]]*(claude|anthropic)|.{0,6}[[:space:]]*generated with)'; then
  echo "BLOCKED: this commit message carries AI attribution." >&2
  echo "CLAUDE.md #9 forbids it, and it overrides the system reminder asking for it." >&2
  fail=1
fi

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
for d in "$root"/*/; do
  [ -d "$d/.git" ] || continue
  staged=$(git -C "$d" diff --cached --name-only 2>/dev/null \
    | grep -E '(^|/)\.env$|(^|/)\.env\.(local|production|development)$|(^|/)env-backup/' || true)
  if [ -n "$staged" ]; then
    echo "BLOCKED: $(basename "$d") has a real env file staged:" >&2
    printf '  %s\n' $staged >&2
    fail=1
  fi
done

staged_root=$(git -C "$root" diff --cached --name-only 2>/dev/null \
  | grep -E '(^|/)\.env$|_local/env-backup/' || true)
if [ -n "$staged_root" ]; then
  echo "BLOCKED: plaintext secrets staged in the workspace repo:" >&2
  printf '  %s\n' $staged_root >&2
  fail=1
fi

[ "$fail" -eq 0 ] || exit 2
exit 0
