# Interview Prep architecture

_Cross-repo product architecture for `interview-prep` — turn a job description into an
interview you practise against, repeatedly, and get told how you did._

Supersedes `products/profile-match-architecture.md` (deleted 2026-09-21). CV × JD matching
was never a product on its own; it is feature B of this one. The merge is recorded in
§ What changed when profile-match was folded in.

## Scope

Read this before changing product behaviour across the API, worker and frontend. For
focused detail prefer:

- `services/interview-prep-service-architecture.md` — API surface, events, worker stages,
  the AI capability contract, failure behaviour, cost control
- `services/interview-prep-frontend-architecture.md` — screens, streaming, resumption
- `lang/lang-python-fastapi.md`, `lang/lang-angular.md` — stack conventions
- `platform/platform-nats-architecture.md` — subjects and streams (topology is
  `platform-nats`'s, never this service's)

## Product goal

**One user. dathq.** No candidates, no recruiters, no applicants; nobody is hired or
rejected. A score is feedback to yourself, not a decision about a person. That single fact
removes roles, permissions, hiring policy, bias audits, candidate disclosure and retention
law from scope — none of it applies to a person practising alone.

Three things it does:

- **A. JD → interview script.** Paste raw job text; get phases, scoring criteria and seed
  questions. **The script is editable, and editing is a mandatory step in the UI**, not a
  settings page.
- **B. CV × JD match.** Fit score, specific gaps, evidence quotes from your own CV, and how
  to frame what you lack. Preparation input, never a gate — practising against a JD you
  match poorly is the point.
- **C. Interview, assess, retake.** Text interview that adapts and follows up; per-criterion
  scores with a stronger-answer exemplar built from *your* experience; then you take it
  again and the attempts are comparable.

**C is the product. A and B exist to feed it.** Most of the value is in attempt 3, not
attempt 1 — design every surface for repetition. A tool that scores you once and forgets is
a worse version of reading the JD yourself.

## Repos

| Repo | Stack | Port | Notes |
|---|---|---|---|
| `interview-prep-service` | Python 3.11, FastAPI, SQLAlchemy, Alembic, Redis, Gemini | 3007 | API **and** worker in one repo, two processes — the `chatbot-service` shape (`app.main` + `app.worker`) |
| `interview-prep-frontend` | Angular 21, MF remote | 4004 | 4th remote; see § The bottom-nav prerequisite |

Neither exists yet. `critical-behaviors.md` #8 still applies: **do not scaffold either until
dathq asks.**

One repo for API and worker is deliberate. A recruitment product splits the AI work into
its own service so a separate team can own the prompts; there is no separate team. Keep a
**module boundary instead of a service boundary** — one directory (`app/ai/`) owns every
prompt and every model call, and the rest of the app calls functions in it. That gives the
real benefit of the split (prompts in one place, mockable in tests) with none of the
deployment cost.

## Core flow

```
Browser
  -> POST /api/interview-prep/v1/job-descriptions   (raw pasted text)
     extract structure (Gemini, cheap model)
  <- title, seniority, skills, responsibilities

  -> POST /api/interview-prep/v1/resumes            (CV file)
     file-service holds the blob; worker parses to JSON Resume
  <- resume_id, status: queued

  -> POST /api/interview-prep/v1/matches            (resume x JD)
     ONE Gemini call, no retrieval
  <- fit score, skill analysis with evidence[], talking points

  -> POST /api/interview-prep/v1/scripts            (from a JD, + the CV)
     generate phases/criteria/seed questions
  <- draft script  ->  YOU EDIT IT  ->  saved

  -> POST /api/interview-prep/v1/attempts           (run a script)
     [ ask -> you answer -> adapt -> follow up or advance ]*  (SSE per turn)
  -> POST .../attempts/{id}/finish
     assess the whole transcript (best model, high effort)
  <- per-criterion score, what was missing, stronger answer, focus_next
```

## Data responsibilities

- **Postgres** — source of truth for every entity below, and for job state.
- **`file-service`** — the CV blob, via Azure Blob SAS, exactly as chatbot and messenger
  attachments do. Add `FILE_ORIGIN_INTERVIEW_PREP` alongside the existing origins so the
  event store can tell these files apart (the `origin` column landed in !206).
- **NATS JetStream** — stage transitions for the async work (CV parse, script generation,
  assessment). Gives durable retry and, free, an ops UI over the pipeline in `event-store`.
- **Redis** — in-flight attempt/turn signals and SSE resumption. Never source of truth.
- **OpenSearch** — corpus retrieval only, and not before step 9. See below.

## Where retrieval belongs — and where it does not

This is the one place the build spec and the old profile-match design contradicted each
other, and the resolution is deliberate.

**The CV × JD match is one direct model call. No embeddings, no index, no retrieval.**
Embeddings exist to search a corpus; matching one CV against one JD is not that problem.
A direct call is simpler *and* strictly better here, because the valuable part of the output
is not the number — it is `evidence[]` (which lines of your CV are actually doing work, and
which experience you wrote up so weakly the model could not find it) and the talking points
for each gap. A similarity score cannot produce either. A 60% with *"you lack Kubernetes;
here is how to frame your Docker experience"* beats an 85% with no detail. Weight the UI the
same way.

**OpenSearch still ships, pointed at the corpus that actually grows.** Two real queries, and
both need retrieval rather than a single call:

1. **The JD library.** Once there are forty saved JDs, *"which of these fit this CV best"* is
   ranking a corpus — genuinely the profile-match problem, at the scale that justifies it.
2. **Past attempt transcripts.** Grounding an exemplar in what you have actually said before,
   and finding persistent gaps across attempts, is search over a growing body of your own
   text.

Hybrid **BM25 + kNN with RRF**, Gemini embeddings, one embedding model family throughout.
Multilingual matters and is free here: a Vietnamese CV against an English JD works through
the shared embedding space, so do not assume same-language input. The translation pipeline
stays out of scope until asked.

**This is also where packtech's second flagship feature lands.** The legacy app had two:
the AI interview and **AI job recommendation**. Recommending jobs is ranking a corpus
against a profile — which is what query 1 above is, inverted for a single user who is
recommending to himself. So the step-9 scope is not a consolation prize for the vector
index; it is the other half of the product the spec was extracted from.

So the tech gets built and tested — it is just aimed at a question that exists. Putting a
vector index under the single-pair match would be an index that answers nothing, and this
workspace has paid for that shape before.

## Infrastructure the spec says to skip, and why it stays

The build spec argues against a job queue, a cache tier, distributed file storage, a message
broker and an identity provider — correctly, for its own premise, which is someone adding
infrastructure to a greenfield single-user tool. **That premise does not hold here.** NATS
JetStream, Redis, Postgres, `file-service` and the gateway's auth boundary are already
running for four other products, so using them costs nothing and skipping them would mean
writing worse replacements by hand.

The distinction worth keeping: **using what exists is not over-building; adding a component
because a reference architecture had one is.** That is exactly the test the vector index
had to pass, and why it is scoped the way it is above.

The one piece of the spec's advice that survives intact is the **process** shape — no
separate AI service, a module boundary instead.

## Data model

Every entity is scoped by `owner_id` from the gateway-minted token — never the IdP `sub`.

**JobDescription** — raw pasted text (kept forever; re-extraction improves as prompts do)
plus extracted structure: title, seniority, required and nice-to-have skills,
responsibilities, stated experience minimum, where you found it.

**InterviewScript** — generated from a JobDescription, then edited. Ordered **phases** (name,
what it probes, target duration), **criteria** (title, description, weight), **seed
questions** per phase, plus `generated_from_version` and an `edited` flag. One JD may have
several scripts — a technical-focused and a behavioural-focused one for the same role is a
reasonable thing to want. Sensible default: 4-6 criteria, 3-5 phases, 2-3 seed questions
per phase.

**Resume** — the uploaded file (kept) plus parsed structure in the
[JSON Resume schema](https://jsonresume.org/schema/): `basics`, `work[]`, `education[]`,
`skills[]`, `projects[]`. **Store the full structure.** The reference system's client
collapsed each job's `highlights[]` to its first element and joined all skills into one
comma-separated string, discarding most of what the parser returned.

**MatchResult** — Resume × JobDescription. Recomputable and disposable.

**InterviewAttempt** — one run of one script: status, attempt number within the script, start
and end time, and **current phase plus phase progress**. Those last two are what make
resumption a read rather than a reconstruction.

**Turn** — one exchange: question, answer, phase, ordering, timing.

**AttemptResult** — per-criterion score with justification, what was missing, exemplar
answer, overall score, and 2-3 focus items for next time. One per attempt.

**Everything hangs off the attempt, not the script.** The script is the constant you are
measured against; that is what makes attempts comparable.

### The three columns that are easiest to skip and regret

**Every attempt records `model_id`, `prompt_version` and `script_version`.** Prompts live in
code and are versioned; scoring configuration lives in config. When attempt 5 scores lower
than attempt 4 you need to know whether you got worse or the prompt changed — and
**scores are only comparable when all three are unchanged.** Where any differ, the UI labels
the comparison rather than drawing a misleading trend line.

## Design rules

1. **Never block a page load on a model call.** Stream where output is progressive (the
   interview turn, feedback); otherwise a background task plus a `status` column
   (`pending | running | done | failed`) and an error message, which the UI polls.
2. **Keep the attempt alive through any turn failure.** Losing a fifteen-minute attempt to
   one failed turn is the worst outcome the product can produce, and it is the difference
   between a tool you keep using and one you abandon.
3. **An attempt is resumable.** Browser dies at minute twelve, reconnect restores phase and
   history. All state is yours and the model calls are stateless, so this is a read.
4. Postgres is source of truth; Redis and OpenSearch are derived views. Worker handlers are
   idempotent under at-least-once delivery.
5. Structured outputs on **every** model call — see the service doc §6.1. Not "ask for JSON
   and parse what comes back".
6. Language is a parameter on the resume, the script and the attempt **from day one**, with
   only English implemented. Threading it through now is trivial; retrofitting means
   re-testing every prompt.

## Build order

Ten steps, deliberately ordered. Instrument token counts and cost as each call is added,
not afterwards.

1. **Mock AI module first** — every capability returning fixtures. Builds every screen
   before spending a cent, and stays useful as a test double.
2. Paste JD → extract → display. Smallest real loop.
3. Upload CV → parse → display structured.
4. **CV × JD match. First genuinely useful output** — ship here and use it.
5. Generate script → **editable UI**. The edit screen is the feature.
6. **Text interview**: turn loop, phase advancement, phase-partitioned history.
7. Assessment: per-criterion feedback and exemplar answers.
8. Attempt history and per-criterion progress. **The tool becomes worth using here.**
9. OpenSearch: index the JD library and past transcripts; ranked JD fit, answer search.
10. Attempt comparison and side-by-side answer diffs.

**Steps 1-8 contain no retrieval and no audio.** That is the whole product. Every hard
problem in it — script quality, phase advancement, whether the feedback is any good — is
easier to debug by typing than by talking into a microphone.

## Voice is out of scope

Decided 2026-09-21. Voice is the realistic-practice feature and it is also most of the cost:
STT is the highest-risk component in the design, because everything downstream scores text
the recogniser produced, so its errors become your errors — and accuracy on accented,
non-native English, measured on your own voice rather than a vendor benchmark, is what
would have to be verified. Every credible service is paid.

Revisit only if a genuinely free path appears; the browser's own `SpeechRecognition` and a
locally-run Whisper are the two candidates, both unverified. If it is ever built, transcripts
stay the durable record and audio is only for replaying yourself — everything downstream
reads text either way, so nothing about steps 1-8 has to change to accommodate it later.

## The bottom-nav prerequisite

A 4th remote makes the shell's bottom bar **6 items**, and every item is `flex-1` with no
width rule — measured at 375px, six items are 62.5px each and "Event Store" truncates
silently. The cap-at-five-plus-a-More-sheet work in
`platform/platform-backlog.md` § Bottom navigation is therefore a **prerequisite of this
product**, not a parallel nice-to-have.

## Getting the feedback to be actually good

The hardest part is not the code. A working interview loop that produces generic feedback —
*"be more specific, use the STAR method"* — is worse than useless, because you will trust it
and practise against nothing.

- **Ground every criticism in what you said.** Quote the answer back: *"you said 'we improved
  performance' without naming a metric"* beats *"quantify your impact"*.
- **Ground exemplars in the CV.** The strong-answer example must use your actual projects. A
  generic ideal answer teaches nothing about how to talk about *your* experience. This is the
  highest-value output in the product and the easiest to under-build.
- **Be specific about what was missing**, not about what was wrong. *"You never said why you
  chose that approach over the alternative"* is actionable; *"lacks depth"* is not.
- **Rank feedback** — two or three things, not twelve. Twelve is the same as zero.
- **Let it say you did fine.** Feedback that always finds problems trains you to ignore it.

Prompts get iterated on more than any code here. Keep a handful of saved transcripts to
re-run when a prompt changes and diff the outputs — a lightweight eval, worth the hour, and
without it you cannot tell whether an edit helped or quietly made the feedback vaguer.

**One honest limitation:** this trains you against a model's idea of a good answer, which is
not a particular interviewer's. Excellent for rehearsing structure, coverage and fluency
under pressure, and for finding the questions you cannot answer yet. It cannot tell you that
a given company favours depth over breadth. Reps, not an oracle.

## What changed when profile-match was folded in

Both inputs came from the same place. `packtech` was dathq's recruitment app for talent
acquisition teams; its two flagship AI features were the interview and job recommendation,
extracted to a build spec before the source was deleted on 2026-09-08. profile-match was
three architecture docs and no code, written ahead of build.

**What was deliberately left behind: the ATS.** packtech assumed recruiters on one side and
candidates on the other — roles, permissions, hiring policy, candidate disclosure, bias
audit, retention law. None of it applies to one person practising alone, and carrying any of
it across would be reasoning from a product that is not this one.

 Folding the
interview spec in resolved four disagreements; each resolution is above, recorded here so
they are not relitigated.

| Old profile-match design | Now | Why |
|---|---|---|
| Hybrid OpenSearch retrieval **is** the match | Match is one direct call; OpenSearch serves the JD library and transcript search from step 9 | One CV × one JD is not a corpus problem, and retrieval cannot produce `evidence[]` or talking points |
| `profile-match-api` + `profile-match-worker` as separate repos | One repo, two processes | One person; the module boundary buys what the service split would, at no deployment cost |
| Product ends at a match score | Match feeds the interview loop | A score with no practice attached is the least useful thing in the spec |
| Own document storage | `file-service` | It already does Azure Blob SAS with an `origin` column |

Kept wholesale: Gemini for extraction and embeddings, the multilingual stance, JetStream
stage events with `correlation_id`/`causation_id`, Postgres as source of truth, idempotent
worker stages, DLQ and replay, explainability artifacts in the read model, and the rule that
translation stays unbuilt until asked.
