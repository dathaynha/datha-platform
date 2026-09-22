#!/usr/bin/env bash
# Drive every hook with the cases in cases.json and check the exit codes.
#
# These are regression tests, not ceremony. Each case was proved by hand once;
# without this file that proof is lost the moment someone edits a hook. The two
# cases marked REGRESSION are the false positives the first pre-commit-guard
# shipped with — it blocked the very commit that documented it, and then blocked
# the fix for itself.
#
# Run from anywhere:  .claude/hooks/tests/run.sh
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
export CLAUDE_PROJECT_DIR="$root"
cases="$root/.claude/hooks/tests/cases.json"
hooks="$root/.claude/hooks"

pass=0 fail=0 tmpfiles=()
cleanup() { for f in "${tmpfiles[@]:-}"; do [ -n "$f" ] && rm -f "$f"; done; }
trap cleanup EXIT

n=$(python3 -c "import json;print(len(json.load(open('$cases'))))")
for i in $(seq 0 $((n - 1))); do
  read -r hook name expect kind <<<"$(python3 - "$cases" "$i" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))[int(sys.argv[2])]
print(c["hook"], "|".join(c["name"].split()), c["expect"],
      "file" if "file_content" in c else "command")
PY
)"
  name=${name//|/ }

  if [ "$kind" = "command" ]; then
    payload=$(python3 - "$cases" "$i" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))[int(sys.argv[2])]
print(json.dumps({"tool_input": {"command": c["command"]}}))
PY
)
  else
    target=$(python3 - "$cases" "$i" "$root" <<'PY'
import json, os, sys
c = json.load(open(sys.argv[1]))[int(sys.argv[2])]
base = os.path.join(sys.argv[3], c["in_repo"]) if c["in_repo"] else "/tmp"
path = os.path.join(base, c["file_name"])
open(path, "w").write(c["file_content"])
print(path)
PY
)
    tmpfiles+=("$target")
    payload=$(python3 -c 'import json,sys;print(json.dumps({"tool_input":{"file_path":sys.argv[1]}}))' "$target")
  fi

  printf '%s' "$payload" | "$hooks/$hook" >/dev/null 2>&1
  got=$?
  if [ "$got" = "$expect" ]; then
    pass=$((pass + 1))
    printf '  PASS  %-22s %s\n' "$hook" "$name"
  else
    fail=$((fail + 1))
    printf '  FAIL  %-22s %s  (expected %s, got %s)\n' "$hook" "$name" "$expect" "$got"
  fi
done

echo
echo "  $pass passed, $fail failed, of $n"
[ "$fail" -eq 0 ]
