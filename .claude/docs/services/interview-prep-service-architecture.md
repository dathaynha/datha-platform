# `interview-prep-service` architecture and workflow

_API + worker contracts, the AI capability contract, and processing workflow for
`interview-prep` (port 3007)._

Generic Python/FastAPI standards live in `lang/lang-python-fastapi.md`; the product and its
data model live in `products/interview-prep-architecture.md`. This doc captures what is
specific to the service. Supersedes `services/profile-match-service-architecture.md`
(deleted 2026-09-21).

## Process split

One repo, two processes — the `chatbot-service` shape, which already runs exactly this way:

- **`app.main`** — FastAPI: command/query HTTP, the auth boundary, SSE for the interview
  turn, read-model access. Never runs a heavy model call inline.
- **`app.worker`** — consumes JetStream, runs CV parse, script generation, assessment,
  comparison and (from step 9) indexing.

**`app/ai/` owns every prompt and every model call.** Nothing outside it talks to Gemini.
That directory is the seam the whole service is tested through: step 1 of the build order is
a fixture-returning implementation of it, and it stays useful as a test double afterwards.

## HTTP surface

All routes behind the gateway at `/api/interview-prep/*`, scoped by the `owner_id` in the
**gateway-minted access token** — never `getIdentityClaims().sub`, which is the IdP's subject
and matches nothing here.

### Commands

- `POST /v1/job-descriptions` — raw pasted text; extracts structure inline (cheap, fast)
- `POST /v1/resumes` — registers a CV already uploaded through `file-service`; enqueues parse
- `POST /v1/matches` — resume × JD; one model call
- `POST /v1/scripts` — generate a draft script from a JD (+ the CV)
- `PATCH /v1/scripts/{id}` — the edit, which is a first-class product step
- `POST /v1/attempts` — start a run of a script
- `POST /v1/attempts/{id}/turns` — submit an answer; **response is SSE**
- `POST /v1/attempts/{id}/finish` — enqueue assessment
- `POST /v1/resumes/{id}/reparse`, `POST /v1/matches/{id}/recompute` — retries

### Queries — side-effect free

- `GET /v1/job-descriptions`, `/v1/resumes`, `/v1/scripts`, `/v1/matches/{id}`
- `GET /v1/attempts/{id}` — includes phase and phase progress, which is what makes
  resumption a read
- `GET /v1/attempts/{id}/result`
- `GET /v1/scripts/{id}/progress` — per-criterion series across attempts
- `GET /v1/jobs/{id}` — stage, state, retryable, last error

## Event model (NATS JetStream)

Versioned subjects under the platform envelope. **Topology belongs to `platform-nats`** —
this service connects and publishes, and never calls `streams.add` or `consumers.add` on
startup. Durable names stay in sync with `src/nats/streams.ts` there.

- `interview.resume.uploaded.v1`
- `interview.resume.parsed.v1` / `.failed.v1`
- `interview.script.generated.v1` / `.failed.v1`
- `interview.attempt.started.v1`
- `interview.attempt.finished.v1`
- `interview.assessment.completed.v1` / `.failed.v1`
- `interview.document.indexed.v1` — step 9 only

Every event carries `event_id`, `event_type`, `occurred_at`, `correlation_id`,
`causation_id`, `owner_id`, the relevant entity ids, and `schema_version`.

Publishing these buys an ops UI over the whole pipeline in `event-store` for free, which is
most of the reason the stage transitions are events rather than just column writes.

## Worker stages

1. Fetch the CV from `file-service` and pass it to the model **as a document** (below).
2. Parse to JSON Resume; persist the full structure.
3. Detect and store document language.
4. Script generation, assessment and comparison as their own stages.
5. *(step 9)* chunk, embed, index into OpenSearch.

On failure: persist the failing stage and reason in Postgres, emit the `.failed.v1` event,
let JetStream's DLQ policy take poison messages, and allow replay after a fix. Every stage is
idempotent or checkpointed — at-least-once delivery means a stage runs twice sooner or later.

## AI capability contract

Seven capabilities. The contract is provider-neutral; the mechanics below are Gemini's.

The response shapes here were reconstructed by reading the client code of **`packtech`**,
dathq's own legacy recruitment app (see `platform/platform-backlog.md`) — the field names in
the match output carried real traffic there. Its source has since been deleted, so these
docs are the surviving record of those shapes. Treat them as a
proven starting shape rather than a requirement: we own both sides. Where a detail is
load-bearing it says so; where the original got it wrong (`<UNKNOWN>` strings, collapsed
`highlights[]`) it says that too.

| # | Capability | Input | Output |
|---|---|---|---|
| 1 | Parse a CV | the file | JSON Resume: `basics`, `work[]`, `education[]`, `skills[]`, `projects[]` |
| 2 | Extract JD structure | raw pasted text | title, seniority, required + nice-to-have skills, responsibilities, experience minimum |
| 3 | Generate a script | JD structure **+ the CV** | phases, criteria with weights, seed questions |
| 4 | Match CV to JD | parsed resume + JD structure | see below |
| 5 | Interview turn | script, phase, criteria, CV, **current phase's** history, latest answer | next question + coverage signal + follow-up decision — **streamed** |
| 6 | Assess an attempt | criteria, full transcript, CV | per-criterion grading + overall + `focus_next` |
| 7 | Compare attempts | two or more results against one script | what improved, regressed, stayed stuck |

**Phase advancement (capability 5).** Advance when coverage passes its threshold *or* the
phase's question budget is spent, whichever comes first. **Cap consecutive follow-ups on one
topic at two or three** — the goal is practice across the whole interview, not being ground
down on the weakest answer. Send only the current phase's history each turn.

Capability 3 takes the CV deliberately: an interview that probes the gap between your
experience and the JD is far better practice than one built from the JD alone.

Capability 7 is worth a model call rather than a numeric diff in code — it can read the
transcripts and say *"your system design answers now state trade-offs explicitly, but you
still describe what you built without saying why you chose it"*, which a delta cannot.

### Match output (capability 4)

```
fit_score            int
fit_label            string
summary              { one_line, top_matches[], top_gaps[] }
skill_analysis       [{ skill,
                        match_status,          // Yes | No | Partial
                        proficiency_estimate,  // Junior | Mid | Senior | Expert
                        evidence[],            // quotes from the CV
                        notes }]
talking_points       []                        // how to frame the gaps
scoring_breakdown    { weights, subscores }
```

`evidence[]` and `scoring_breakdown` are the two fields that earn their place: the first
tells you which parts of your CV are doing work and which experience you wrote up so weakly
the model could not find it — directly actionable rewriting feedback. The second tells you
whether a low score is a skills problem or an experience-framing problem.

Return **`null`** for unavailable fields. The reference system returned the literal string
`<UNKNOWN>`; do not copy that.

### Assessment output (capability 6)

```
criteria_grading [{ title, score, justification,
                    what_was_missing,       // specific
                    stronger_answer }]      // exemplar using the user's own background
overall          { score, summary }
focus_next       []                         // 2-3 items for the next attempt
```

## Gemini mechanics

Provider decided 2026-09-21: **Gemini, on the free tier.** The capability contract above is
provider-neutral, so this section is the only thing a provider swap would touch.

`chatbot-service` already calls the REST API directly over `httpx` with no vendor SDK, and
that is the pattern to copy — `app/services/gemini_stream.py` there is the working
reference.

- Base `https://generativelanguage.googleapis.com/v1beta`
- `:generateContent` for one-shot, `:streamGenerateContent?alt=sse` for the interview turn
- **REST JSON is snake_case**: `inline_data.mime_type`, not `inlineData.mimeType`. This has
  bitten in `chatbot-service` already and the comment there says so.
- Embeddings (step 9 only): `:embedContent` / `:batchEmbedContents`, one model family
  throughout or the vectors are not comparable.

**Verify current model ids, free-tier rate limits and whether thinking config is available
on the chosen models before writing the first call.** These move fast — `chatbot-service`
currently defaults to `gemini-3.6-flash` with `gemini-3.5-flash-lite` for titles, and those
defaults were themselves a bump. Do not trust a model id recalled from anywhere but the live
`models.list` response.

### Structured outputs, everywhere — the one genuinely new piece

Every capability output above is a schema. Constrain the model to it with
`generationConfig.responseMimeType: "application/json"` plus `responseSchema`, rather than
asking for JSON in the prompt and parsing what comes back. This removes the single largest
source of breakage in an application like this: a model that wraps its JSON in prose or drops
a field once every few hundred calls.

**`chatbot-service` does not use `responseSchema` anywhere** — it streams prose, so it never
needed it. This service is the first on the platform to need constrained output, so there is
no local precedent to copy and the schema handling is worth its own test.

### Send the CV as a document, not extracted text

Pass the PDF as an `inline_data` part rather than running it through a text extractor first.
Layout survives — two-column CVs, sidebars and tables are exactly what naive extraction
scrambles, and CV layouts are creative. `app/services/file_client.py` in `chatbot-service`
already builds these blobs from a `file-service` blob; the same helper shape applies.

### Evidence you can trust

Capability 4 asks the model to quote the CV back as `evidence[]`. Those quotes are the most
useful thing in the output and also the easiest thing for a model to invent.

**Take structured outputs, then substring-check every evidence string against the CV text
after parsing, and flag any that does not appear.** Schema safety plus a hallucination
detector, for the cost of one string scan. A flagged quote is shown as unverified rather
than dropped — it is usually a paraphrase, and knowing *that* is itself feedback about how
findable the experience is.

Provenance: on the Claude API the alternative is `citations`, which returns exact character
offsets into the document but is **mutually exclusive with structured output** (sending both
400s). The substring check is the portable answer and does not depend on which provider is
in use — keep it whatever happens to the provider decision.

### Prompt caching is the main cost lever

Caching matches on a **prefix**, so stable content goes first and per-request content after
it. **One changed byte in the prefix invalidates everything after it** — a timestamp, a
reordered JSON key, a regenerated uuid.

Where it pays here is overwhelmingly the interview turn: the script, the criteria and the CV
are identical across every turn of an attempt, and identical again across **every attempt
against that script**. Retakes are the whole product, so the same prefix is sent five, ten,
twenty times. Build the turn request with that prefix stable from day one — it is far harder
to retrofit than to do correctly first.

**Verify it from the response's cache/usage metadata rather than assuming.** Zero cache
reads across repeated turns means a silent invalidator, and a timestamp in the system prompt
is the usual culprit. On the free tier the payoff is quota and rate-limit headroom rather
than money, which matters more mid-attempt, not less.

⚠️ Gemini's caching (explicit `cachedContents` with a TTL, and implicit caching on some
models) is **not** the same mechanism as Claude's `cache_control` breakpoints, and free-tier
eligibility is its own question. Verify both against the live API before building the
request shape around either.

### Model choice per capability

Free tier, so the lever is which *tier* of model rather than price. Default to the strongest
model the free tier allows for the two that carry the product, and step down where the work
is mechanical:

| Capability | Tier | Why |
|---|---|---|
| Assess attempt, generate script | strongest available | The feedback **is** the product, and a weak script wastes every attempt run against it |
| Interview turn, compare attempts | strong, latency-aware | Latency is felt mid-conversation |
| Parse CV, extract JD, match | fast/cheap | Extraction and structured comparison |

## Failure behaviour

| When this fails | Do this |
|---|---|
| CV parse | Fail the upload, **keep the file**, allow retry |
| JD extraction | Show the raw paste and let it be corrected by hand |
| Script generation | Retry; offer a blank script to fill in manually |
| **Interview turn** | **Keep the attempt alive.** Error on that turn only, allow retry |
| Assessment | Retry — the transcript is already saved, nothing is lost |

The interview turn is the one that matters. Losing a fifteen-minute attempt because one turn
failed is the worst outcome the product can produce.

**Resumption is a read.** `InterviewAttempt` stores current phase and phase progress
precisely so a reconnect restores state instead of reconstructing it.

## Cost control

Free tier means the exposure is **rate limits and quota exhaustion mid-attempt**, not an
invoice — but the instrumentation is the same either way and is worth having before the first
paid call ever happens.

- **Log token counts per call, grouped by capability.** Without it you cannot tell whether
  interviews or script generation is the expensive part.
- Surface per-attempt token use in the UI.
- Handle 429 as a first-class state, not an error bubble: the attempt stays alive and the
  turn is retryable, per the table above.
- Keep history **partitioned by phase** and send only the current phase each turn. Bounds
  cost and keeps the model focused. The final assessment is the one call that reads
  everything.

## Prompt and scoring discipline

**Prompts live in code and are versioned; scoring configuration lives in config.** Every
attempt records `model_id`, `prompt_version` and `script_version` — three small columns
without which the progress tracking is untrustworthy, because you cannot tell a real
improvement from a prompt edit.

Keep a handful of saved transcripts as a lightweight eval: re-run them when a prompt changes
and diff the outputs.

## Data rules

1. Postgres is source of truth for lifecycle and job state; Redis and OpenSearch are derived.
2. Idempotency keys or stage checkpoints on every long-running worker step.
3. Outbox/inbox (or equivalent) for reliable event publication.
4. Keep PII access minimal; redact raw CV text in logs.
5. Every entity scoped by `owner_id`.

## Out of scope until asked

- **Voice.** Decided 2026-09-21 — see the product doc.
- **Translation pipeline.** Translating CV/JD chunks to a canonical language before indexing
  would improve BM25 keyword matching across language pairs, with Gemini as the provider and
  a `(source_lang, hash(text)) → translated_text` cache. Cross-language recall through the
  multilingual embedding space is sufficient. **Do not design or scaffold it.**
- **Anything in steps 9-10** until steps 1-8 are being used in anger.
