# Git commit conventions

_Commit message conventions — Conventional Commits, no AI attribution trailers_

Applies to every commit and PR in every repo of this workspace, whichever AI assistant writes it.

## Format

- **Conventional Commits**: `type: subject` (`feat` / `fix` / `ci` / `style` / `test` / `docs` / `refactor` / `chore`).
- Subject ≤ 50 chars, imperative mood.
- Body only when the "why" isn't obvious from the diff — short, why-focused.

## No AI attribution — hard rule

Never add AI attribution to commits or PRs:

- No `Co-Authored-By: Claude …` / `Co-Authored-By: Cursor …` or any AI co-author trailer.
- No "Generated with Claude Code / Cursor / AI" lines in commit bodies or PR descriptions.
- No robot emoji signatures.

The user authors the history; assistant involvement is not recorded in git metadata.
