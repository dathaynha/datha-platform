---
name: suggesting-hooks
description: Propose a hook when a rule is being enforced by hand, repeatedly. Not user-invocable — it fires on the agent noticing its own repetition.
---

# suggesting-hooks

A rule that lives only in `.claude/` is **advisory**: it works until the agent
forgets, and it fails silently when it does. A hook is **deterministic** — a
shell command that runs every time, that cannot be skipped and cannot be
rationalised away.

This skill exists because the gap went unnoticed for months. `suggesting-skills`
covers workflows; nothing covered enforcement. Cursor's equivalents
(`suggesting-cursor-rules`, `suggesting-cursor-hooks`) were dropped on
2026-08-17 and never replaced — `workspace-map.md` claimed they were kept in
`.claude/_retired/`, and that directory has never existed.

## The trigger

Suggest a hook the **third** time you do the same check by hand in a session,
or the first time you notice a rule you have been enforcing from memory.

The tell is a sentence like *"verified no attribution"*, *"checked nothing
secret is staged"*, *"confirmed the port is down"*. If you are reporting a check
rather than a result, the check belongs in a hook.

Worked example, and the one that produced this skill: on 2026-09-22 the
attribution rule was hand-grepped after **eight** commits in one session. Every
one passed. That is not evidence the rule is safe — it is eight coin flips that
happened to land right, on a rule a system reminder actively pushes against.

## What makes a good candidate

| Good | Bad |
|---|---|
| Deterministic — a string, a path, a port | Needs judgement about intent |
| Cheap — milliseconds, one file | Full suite, full lint, network |
| Failure is expensive or silent | Cosmetic, or loud when it breaks |
| No legitimate exception | Situational (see below) |

**Situational rules are the trap.** `docker volume rm` is documented in
`_local/README.md` for re-running `init-db.sh`, so a blanket deny would block a
procedure this workspace wrote down. Where a rule has legitimate exceptions,
either encode the exception or leave it to the rule — do not ship a guard that
people learn to route around.

## How to propose

1. Name the rule, and where it lives in `.claude/`.
2. Say how many times it has been enforced by hand, with the evidence.
3. Give the hook event and matcher — `PreToolUse(Bash)`, `PostToolUse(Edit|Write)`.
4. State what it cannot cover. A `Read(**/.env)` deny does not stop `cat` in
   Bash; say so rather than implying the mechanism is complete.
5. **Wait for go.** A hook changes what the agent is permitted to do, so it is
   his call, like any outward-facing change.

## Never ship one untested

A hook that does not fire is worse than no hook, because it is believed. Before
registering one, drive it directly with crafted JSON on stdin and prove **four**
cases at minimum:

- the violation → blocks, with a message that says how to fix it
- the clean case → silent, exit 0
- an adjacent-but-legal case → silent (`.env.example`, an unlinted `.scss`)
- malformed or empty input → does not crash

Red-proof the same way a regression test is red-proofed: if you cannot make it
fail on demand, you have not tested it.

## Keep them fast, and few

Three to five hooks is a working setup. Every hook runs on the hot path, so
heavy checks — full suites, full lint, anything on the network — belong in
`prepare-push` or in CI, never on a per-edit hook.

## Related

- `.claude/skills/suggesting-skills/SKILL.md` — the workflow counterpart
- `.claude/rules/critical-behaviors.md` — the rules most worth enforcing
- `.claude/hooks/` — what is already wired
