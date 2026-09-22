# `interview-prep-frontend` architecture and product rules

_Screens, streaming and UI behaviour for `interview-prep` (Angular 21, Module Federation
remote, port 4004)._

Generic Angular conventions live in `lang/lang-angular.md`; the product lives in
`products/interview-prep-architecture.md`. Supersedes
`services/profile-match-frontend-architecture.md` (deleted 2026-09-21).

## Responsibilities

- Paste a JD and see what was extracted from it
- Upload a CV and see the parsed structure
- Show a match as **gaps and talking points first**, the number second
- **Edit the generated interview script** — the central screen, not a settings page
- Run a text interview with streamed questions, resumable
- Show per-criterion feedback with exemplar answers
- Show progress across attempts against one script

No parsing, matching or scoring in the browser.

## Route surface

```
/interview-prep                       landing
/job-descriptions                     list + paste new
/job-descriptions/:id                 extracted structure, scripts built from it
/resumes                              CV list + upload
/matches/:id                          fit, gaps, evidence, talking points
/scripts/:id                          THE EDIT SCREEN
/scripts/:id/progress                 per-criterion trend across attempts
/attempts/:id                         the live interview
/attempts/:id/result                  assessment
/attempts/compare?a=&b=               side-by-side
```

Follow `platform-frontend-structure`: feature folders with `*.routes.ts`, list and detail
split as above.

## The screens that decide whether this is any good

### The script editor

Land on the generated script **in an editable form**. Phases reorder, criteria and weights
change, seed questions get rewritten, a phase can be dropped. The generated draft is a
starting point, and the interview gets better when the user tells it to dig into the thing
they are actually worried about. An `edited` flag is part of the model because a hand-tuned
script is a different thing to measure against than a generated one.

### The match

Lead with **gaps and talking points**. The fit number is a header, not the page. Each skill
row shows `evidence[]` — the quotes from the CV behind the judgment — because an empty
evidence list is itself the finding: that experience is written up too weakly to be found.

### The interview

```
ask ──► answer ──► adapt ──► follow up or advance ──► … ──► assess
```

- **Stream the question over SSE.** A question that appears word by word feels like a
  conversation; one that appears after eight seconds of nothing feels broken.
- Show phase, phase progress and which criteria are still uncovered.
- **A failed turn never ends the attempt** — error on that turn, offer retry, keep
  everything else.
- **Resumable from the URL.** `/attempts/:id` reconstructs from the server's phase and
  history; a dead browser at minute twelve loses nothing.

Text mode only. Voice is out of scope — see the product doc.

### Assessment

Per criterion: the score, why, **what was missing** specifically, and a **stronger answer
built from the user's own CV**. That last one is the highest-value thing the product renders
and the easiest to under-build — give it room, not a tooltip.

Then 2-3 focus items for the next attempt, and what is already good enough to stop worrying
about.

### Progress

Per-criterion sparkline beats one overall number. Show what moved since the last attempt,
and call out **persistent gaps** — criteria low across three or more attempts — plainly,
because those are the only ones worth working on.

Side-by-side answers to the same seed question in attempt 1 versus attempt 4 is the most
motivating output available; treat it as a feature, not a debug view.

**Where `model_id`, `prompt_version` or `script_version` differ across the attempts being
compared, label the comparison instead of drawing a trend line.** A trend across a prompt
change is a lie the UI would be telling on the service's behalf.

## Async UX

Every long action returns an id and a status. The UI:

- navigates to the status/result screen immediately,
- renders stage-based progress (`queued`, `processing`, `completed`, `failed`) with the
  stage named, never a bare spinner,
- polls queries, or reads the SSE stream where one exists,
- never fakes completion optimistically,
- handles partial readiness — a CV parsed while its match is still pending is normal.

## Platform rules this remote inherits

1. **A remote must work without the shell.** Anything the shell mounts on this remote's
   behalf needs a counterpart mount in the standalone tree at :4004.
2. **A host never loads a remote's global stylesheet.** Any value the layout depends on
   belongs in a Sass constant or the component's own styles — never only in
   `styles/base.scss`, where it computes to the empty string at :4000.
3. **Responsive rules that are about room use `@container`**, on a named container declared
   in a *component* stylesheet so it travels with the federated JavaScript. Name it
   `ip-page`, on the layout region rather than the page host. `@media` stays for what it
   genuinely describes — `max-height`, `pointer: coarse`. A viewport breakpoint cannot see
   the shell's 224px sidebar.
4. This remote carries its **own** copy of `AuthenticationService`, `auth.interceptor.ts`
   and `http-context.tokens.ts` — there is no shared auth library. A fix to any of them
   belongs in all five frontends.
5. Copy keys from day one (status labels, errors, result headings), en + de, and **compare
   the two catalogues as key sets** rather than by reading them.
6. Pin exact versions — Angular 21.2.x, MF 21.2.2 — and `@datha/platform-ui` exactly.
   Mismatch breaks MF DI with NG0919.
7. `MF_INTERVIEW_PREP_PUBLIC_PATH` must be set whenever the remote is reached from another
   device; a `localhost:4004` default bakes itself into every lazy chunk and works only on
   the dev machine.

## Registration in the shell

Adding this remote makes the shell's bottom bar six items, which truncates labels silently.
**The bottom-nav cap is a prerequisite** — see `platform/platform-backlog.md`.

Registration itself: `environment.apps` gets a row (`icon`, `route: "/interview-prep"`,
`remoteName: "interview-prep"`), `environment.remotes` gets the entry URL, and the tile name
and description derive from `APPS.INTERVIEW_PREP` i18n keys.

⚠️ A remote's translation block **merges into the host baseline leaf by leaf** as of
v0.6.1 — do not redeclare a `PROFILE` block or anything else the shell owns.
