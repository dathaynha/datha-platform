# Context boundaries

_Paths and artifacts the agent must not read or use as context unless the user explicitly asks_

Keep agent context on **source, tests, migrations, README, and `.env.example`** — not generated trees, dependencies, or local secrets.

This rule is the workspace's only ignore mechanism — there is no tool-level ignore file, so `.claude/` stays self-contained and shareable.

## Never read or edit (unless user explicitly points to a path)

| Area | Examples |
|------|----------|
| **`_local/` legacy/reference material** | Old project folders and notes (`Ideas/`, `JD/`, `docs/`, prompt notes, CV) — read-only reference at most, never modify. Clarified by dathq 2026-08-04: the no-touch intent is "don't change legacy projects", NOT the whole folder |
| **Backend secrets** | See **`always-apply/env-file-safety.md`** — never `.env` / `.env.*` in service dirs; use `.env.example` |
| **Git internals** | `**/.git/` |

### `_local/legacy/` — extracted source material (added 2026-09-22)

`_local/legacy/` holds documents **extracted from dathq's own finished or abandoned
projects**, kept as design input for platform work. It is `_local/`, so the standing rule
applies unchanged: **do not read anything in it until dathq names the file.** When he does,
it is read-only — the extract is the record of a project whose source may no longer exist,
so an edit cannot be undone from anywhere.

One folder per source project. What is in it now:

| Path | From | Status |
|---|---|---|
| `packtech/` | `packtech`, dathq's own recruitment app | `AI-INTERVIEW-PRACTICE-SPEC.md` **fully folded in** 2026-09-21 as `interview-prep` — superseded, kept for provenance. Plus the **Figma file** and `fig-tools/` (see below) |

**The packtech Figma file is design input for later, and it reads offline.**
`Recruitment PackTech 1.3.fig` (10 MB) is the source design for the app the
interview spec came from; dathq kept it to learn Figma with Claude against a
file he already knows. `fig-tools/` is four small scripts that decode it with
**no Figma access and no API token** — a `.fig` is a zip holding a kiwi-format
`canvas.fig`, and `fig-tools/README.md` has the whole procedure. Prefer that to
asking for a Figma connector: there is nothing to authenticate against, and the
tree dump gives type, size, auto-layout, padding, fills, radius and font size
directly.

Verified end to end on 2026-09-22: **20,363 nodes decoded with every byte
consumed**, and a dump of the `Candidate Portal` section printed real frames with
sizes, `stackMode`, padding and hex fills. Needs the `zstd` CLI; the Python
`zstandard` package is *not* installed and is not required.

Two traps. **Block lengths are per file**, so an offset copied from another
file decodes garbage — the README's example used to hardcode `29033`/`29053`
and failed on this one both ways. Fixed 2026-09-22 to read the uint32 prefixes,
and the corrected block was then executed verbatim out of the README. And
**instance overrides live in `symbolData` / `derivedSymbolData`**, which the
decoder skips — a component master can show different colours than the instance
on the frame, so sample the exported PNG to settle those.

⚠️ **Check whose a thing is before reusing it.** An extract may carry assets that are not
dathq's to ship — commissioned models, audio, transcripts. Techniques carry over freely;
assets do not. Prefer a freely-licensed substitute for anything only needed to learn against.

⚠️ **A project folder with its own `.git` is not backed up by the root repo.** Git adds an
embedded repository as a **gitlink** — a pointer with no file contents — so `git add _local/`
would appear to work and back up nothing. Either keep such a project out of the backup
deliberately, or `rm -rf` its `.git` first and accept it as plain files. **This is the failure
mode that already cost `packtech`'s source.**

The working rule for anything landing here: **fold it into `.claude/docs/` in this
workspace's own format, then treat the original as provenance rather than as a live
document.** A spec that exists in two places drifts, and the copy under `_local/` is the one
nothing links to. Audit coverage section by section *before* calling the fold complete —
doing that on 2026-09-21 caught two load-bearing sections (evidence verification, prompt
caching) that a first read had missed.

**`_local/` working files are fair game:** `docker-compose.yml` (infra), `README.md` (docker/colima docs), `docker-backup/` (volume tarballs), `init-db.sh`, `sql/` — the agent may read and edit these for infra tasks without a per-file ask.

**`_local/` holds no credentials** — verified 2026-09-18 by scanning the whole folder for token, key and private-key shapes; nothing matched. The rule used to claim it stored PATs and that was simply out of date. What it does hold is two **local-dev** secrets, both in `docker-compose.yml`: `POSTGRES_PASSWORD` and coturn's `--static-auth-secret`. Both bind to localhost, so they are backup-safe — but gitleaks flags them, and a finding lives in the commit, so they carry `# gitleaks:allow`. The consequence for this rule: `_local/` is excluded from the agent's reach because it is **personal**, not because it is secret, so "is this confidential?" is the wrong question to ask about it — "did dathq name this file?" is the right one.

## Do not search, grep, or bulk-read by default

Treat as out of scope unless the user asks or debugging clearly requires one specific file:

- **Dependencies:** `node_modules/`, `vendor/`, `.venv/`, `.pnpm/`
- **Build & test output:** `dist/`, `bin/`, `out-tsc/`, `coverage/`, `htmlcov/`, `.angular/`, `.pytest_cache/`, `.nyc_output/`, `.turbo/`, `test-results/`, `junit.xml`
- **Compiled artifacts:** `__pycache__/`, `*.pyc`, `*.test`, `*.out`, `.coverage*`
- **Logs & IDE clutter:** `*.log`, `.DS_Store`, `.idea/`, `.history/`

## When exceptions are OK

- User names a path (e.g. “check this log”, “what’s in vendor for X”).
- Fixing a build/test failure and the error points at a specific generated or cache file.
- Lock files (`pnpm-lock.yaml`, etc.) when dependency versions matter — reading them on purpose is fine; bulk-scanning them is not.

## Prefer instead

- Service `src/`, `cmd/`, `internal/`, migrations, tests
- `.claude/docs/` for platform conventions
- Frontend `environment.*.ts` for non-secret config (see env-file-safety)
