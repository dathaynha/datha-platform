---
name: branch-cleanup
description: >-
  Delete local git branches across all platform repos, keeping only main.
  Use when the user says clean up branches, cleanup local branches, back to
  main everywhere, delete old branches, or similar. Safe workflow: survey
  first, flag unmerged/unpushed work, then delete.
---

# branch-cleanup

Clean local branches in every repo of the `datha_platform/` workspace (or only the repos the user names), keeping `main`.

The workspace root is NOT a git repo — iterate the top-level service folders that contain `.git` (see `.claude/docs/always-apply/workspace-layout.md`).

## Steps

1. **Survey** — for each repo: current branch, all local branches, dirty files:

   ```bash
   for d in */; do [ -d "$d/.git" ] || continue; echo "== $d =="; \
     git -C "$d" branch --show-current; git -C "$d" branch; \
     git -C "$d" status --short | head -3; done
   ```

   - Repo not on `main` → check it out first (`git -C <repo> checkout main`). If the working tree is dirty, STOP for that repo and report — never stash/discard without the user's word.

2. **Safety check** — for each non-main branch:
   - Unmerged commits: `git -C <repo> branch --no-merged main`
   - On origin? `git -C <repo> branch -r | grep <branch>`
   - Classify: **merged** (safe), **unmerged but pushed** (recoverable from origin — deletable, report it), **unmerged and NOT pushed** (work would be lost — STOP and ask before deleting).

3. **Delete** — everything except `main` (and anything the user said to keep):

   ```bash
   git -C "$d" branch | grep -v '^\*' | tr -d ' ' | while read -r b; do git -C "$d" branch -D "$b"; done
   ```

   Use `-D`; safety was already established in step 2. Never delete `main`.

4. **Report** — per repo: branches deleted, branches kept, anything skipped and why. Remind that deleted-but-pushed branches are recoverable via `git checkout <branch>` (origin still has them).

## Hard rules

- **Local branches only** — never touch `origin/*` (no `git push --delete`), never prune remotes unless explicitly asked.
- Unmerged + unpushed = user decision, always.
- Dirty working tree = skip that repo and report.
