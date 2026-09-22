---
name: hook-doctor
description: Audit the hooks — registration, wiring, and whether their tests actually test anything. Use for hook doctor, check hooks, audit hooks, are the hooks still right.
---

# hook-doctor

`rule-doctor` audits rules against repo reality. This does the same for hooks,
which need it more: a rule that drifts is read and ignored, while **a hook that
drifts is trusted and wrong**.

## Run the tests first

```bash
.claude/hooks/tests/run.sh
```

12 cases across both hooks; exit 0 means all passed. That is step one, not the
audit.

## Then check the wiring

Four ways a hook is broken while every test passes:

| Check | Command |
|---|---|
| Every registered command exists | compare `settings.json` hook paths against `.claude/hooks/*.sh` |
| Every hook is executable | `ls -l .claude/hooks/*.sh` — mode must be `755`; git preserves this, a copy may not |
| Every hook has cases | each `.sh` appears in `cases.json` |
| Shell is valid | `bash -n .claude/hooks/*.sh` |

A hook registered at a path that does not exist fails **silently** — the tool
call proceeds as if no hook were configured.

## Then the part that matters: are the tests load-bearing?

Passing tests prove nothing until you have watched them fail. For each hook,
neutralise the line that does the work and re-run:

```bash
cp .claude/hooks/<hook>.sh /tmp/h.bak
# change what it computes — do not delete the code, that tests nothing
.claude/hooks/tests/run.sh          # must FAIL, and name the case you predicted
cp /tmp/h.bak .claude/hooks/<hook>.sh
```

**This is the check that finds real problems.** On 2026-09-23 the suite passed
against a deliberately broken `pre-commit-guard.sh` — twice.

- First pass: the two cases labelled REGRESSION never reached the broken line at
  all. Both exit at the command-position gate, so they tested that gate and
  nothing else, while appearing to cover the false positive that caused them.
- Second pass: the new case used the wrong *phrasing*. The regex needs
  `co-authored-by:` followed by a vendor name; the test said "a Co-Authored-By
  line", which matches neither anchored nor unanchored. Green either way.

Only the third attempt — the verbatim string inside a real commit message —
failed for the predicted reason. A test that cannot fail is not a test, and a
test that fails for a different reason is not evidence.

## When a hook is illogical rather than broken

Fix the hook, then add the case that proves it. In that order — write the case
first and you will fit it to the code you already have.

Two failure shapes seen here, both worth checking for:

- **Too broad.** v1 of `pre-commit-guard.sh` matched any Bash command that
  *mentioned* committing and a trailer, so it blocked the commit documenting the
  rule, and then blocked the fix for itself. A guard that cannot tell an
  invocation from a sentence about one gets routed around rather than repaired.
- **Too narrow.** The opposite is quieter and worse: it never fires and everyone
  assumes the rule is held.

## What not to automate

A rule with legitimate exceptions. `docker volume rm` is documented in
`_local/README.md` for re-running `init-db.sh`, so a blanket deny blocks a
procedure this workspace wrote down. Encode the exception or leave it to the
rule — see `suggesting-hooks`.

## Related

- `.claude/skills/suggesting-hooks/SKILL.md` — when to add one
- `.claude/skills/rule-doctor/SKILL.md` — the same idea for docs
- `.claude/hooks/tests/cases.json` — the cases, each with why it exists
