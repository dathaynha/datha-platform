# chatbot-service

FastAPI service: **Google OAuth token proxy** at `POST /api/v1/auth/google/token` (adds `client_secret` server-side and forwards to Google), **`GET /health`**, an **async chat pipeline** (`POST /api/v1/messages`, `GET /api/v1/stream/{job_id}` SSE, **`python -m app.worker`** — worker streams Gemini via `GEMINI_API_KEY`), and **chat history**: **`GET /api/v1/conversations`** (paginated summaries; **`title`** is set by the **worker** after the first assistant reply via a one-off Gemini title call, unless already non-empty) and **`PATCH /api/v1/conversations/{id}`** (rename; empty clears to “Untitled” in the UI). **`GET /api/v1/conversations/{id}/messages`** returns chronological `user` / `assistant` rows. Configure optional **`GEMINI_TITLE_MODEL`** (default `gemini-flash-lite-latest` for sidebar titles). **Schema** is applied with **Alembic** (`alembic upgrade head`), not on API startup.

Default listen port: **8050** (avoid **5060/5061** locally if you test in Chromium — those ports are blocked as `ERR_UNSAFE_PORT` for `http://`).

**Python:** **3.11.x** locally and in **`Dockerfile`** (`python:3.11-slim`). Pin in **`.python-version`** (e.g. `3.11.9`). Do **not** use a 3.9 venv — Alembic/SQLAlchemy will fail on `str | None` annotations.

## CI — bot review (pull requests)

PRs targeting `main` use **`azure-pipelines/bot-review.yml`**:

1. **Unit tests** — `pytest` from `requirements-dev.txt` (required).
2. **MegaLinter** — Python flavor; config in `.mega-linter.yml` (continues on error).
3. **PR-Agent** — Gemini review via `pragent/pr-agent` (continues on error).

**Azure DevOps setup (once per repo):** pipeline path `/azure-pipelines/bot-review.yml`, PR trigger only, variable group with **`GEMINI_KEY`** and **`ADO_PAT`**. OAuth for PR comments is enabled in YAML via `env: SYSTEM_ACCESSTOKEN: $(System.AccessToken)` on the relevant steps (not the Classic Agent-job checkbox). `.pr_agent.toml` on `main` must match pipeline model env for PR-Agent defaults.

---

## Python 3.11 — pick one way to create `.venv`

All options end the same: activate `.venv`, confirm **`python -V`** → `3.11.x`, then continue at [§1](#1-first-time-on-a-machine).

| Option | Best for |
|--------|----------|
| **[A pyenv](#option-a-pyenv-recommended)** | Several Python versions across projects |
| **[B Homebrew](#option-b-homebrew-python311)** | One system install via `brew` |
| **[C pyenv direct path](#option-c-pyenv-without-shell-shims)** | pyenv installed but `python` not on `PATH` yet |

### Option A — pyenv (recommended)

Install pyenv, then enable it in **bash** (`~/.bash_profile` on macOS Terminal):

```bash
export PYENV_ROOT="$HOME/.pyenv"
[[ -d $PYENV_ROOT/bin ]] && export PATH="$PYENV_ROOT/bin:$PATH"
eval "$(pyenv init - bash)"
```

Reload: `source ~/.bash_profile`. In this repo:

```bash
cd chatbot-service
pyenv install 3.11.9          # once per machine
pyenv local 3.11.9            # uses .python-version
python -V
python -m venv .venv
```

### Option B — Homebrew `python@3.11`

```bash
brew install python@3.11
# Apple Silicon:
/opt/homebrew/bin/python3.11 -m venv .venv
# Intel Mac:
# /usr/local/bin/python3.11 -m venv .venv
```

If `python3.11` is on your `PATH` after `brew link python@3.11`:

```bash
python3.11 -m venv .venv
```

### Option C — pyenv without shell shims

Use this when `pyenv install` worked but `python: command not found` (pyenv not in `PATH` yet):

```bash
~/.pyenv/versions/3.11.9/bin/python -m venv .venv
source .venv/bin/activate
python -V                     # 3.11.9 — venv is enough for daily work
```

You can add [Option A](#option-a-pyenv-recommended) shell init later for other directories.

**After any option:**

```bash
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

---

## 1. First time on a machine

From this folder (`chatbot-service/`), create **`.venv`** with [Python 3.11](#python-311--pick-one-way-to-create-venv) above, then:

```bash
source .venv/bin/activate
cp .env.example .env               # then edit .env with real values
```

`.env`: set **`GEMINI_API_KEY`** (create an API key at [Google AI Studio](https://aistudio.google.com/); do not commit it). In each line use **`KEY=value`** with **no space after `=`**; otherwise bash treats the value as a separate command when you `source .env`. CORS is handled exclusively by api-gateway — no CORS config is needed here.

Apply DB migrations (Postgres must be reachable; same `DATABASE_URL` as in `.env`). Includes **`event_outbox`** for NATS publish retry when JetStream is temporarily down:


- **Empty database** (first deploy, or new local DB): create tables and record the revision.

```bash
source .venv/bin/activate && set -a && source .env && set +a && alembic upgrade head
```

- **Database already has `conversations` / `messages`** (e.g. you used the API before Alembic, when startup ran `create_all`): do **not** run `upgrade` first — Alembic will error with `DuplicateTable` / `relation "conversations" already exists`. Instead, mark the baseline **once** (no DDL, data unchanged):

```bash
source .venv/bin/activate && set -a && source .env && set +a && alembic stamp 67594ea08441
```

After that, future schema changes use `alembic upgrade head` as usual. Check revision: `alembic current`.

**When you change SQLAlchemy models** (ongoing): generate a revision, **review** the new file under `alembic/versions/` (autogenerate is not perfect), then apply.

```bash
source .venv/bin/activate && set -a && source .env && set +a && alembic revision --autogenerate -m "short_description"
```

```bash
source .venv/bin/activate && set -a && source .env && set +a && alembic upgrade head
```

Hand-written migrations: `alembic revision -m "short_description"` (no `--autogenerate`), then edit `upgrade()` / `downgrade()` in the new file before `upgrade head`.

Verify (one command from `chatbot-service/`; Windows: activate `.venv` and load `.env` your usual way, then run uvicorn):

```bash
source .venv/bin/activate && set -a && source .env && set +a && uvicorn app.main:app --host 0.0.0.0 --port 8050 --reload
```

```bash
curl -s http://127.0.0.1:8050/health
```

Expect `{"status":"ok"}`.

**Async chat (second terminal):** with Postgres and Redis running locally (however you start them in your dev setup), start the worker from `chatbot-service/`:

```bash
source .venv/bin/activate && set -a && source .env && set +a && python -m app.worker
```

Then `POST /api/v1/messages` with JSON `{"text":"…","conversation_id":null,"model":"gemini-flash-latest"}` and open `GET /api/v1/stream/{job_id}` with `Accept: text/event-stream` (or `curl -N`). SSE `data:` lines are JSON: `chunk`, `done` (includes `full_text`), or `error`.

---

## Orphan reconcile (optional, manual)

Backfill orphan file cleanup when `conversation.deleted` never reached NATS. **Not** a third always-on process — run when you need it (~daily in prod via ADO later).

```bash
source .venv/bin/activate && set -a && source .env && set +a && python -m app.reconcile_orphans           # dry-run
source .venv/bin/activate && set -a && source .env && set +a && python -m app.reconcile_orphans --execute  # publish
```

Default is **dry-run** (logs only). **`--execute`** drains pending **`event_outbox`** and publishes orphan cleanup events. Does **not** require uvicorn. Spec: **`.claude/docs/platform/chatbot-file-events.md`** (*Orphan reconcile*).

---

## 2. Normal startup

**One command** from `chatbot-service/`:

```bash
source .venv/bin/activate && set -a && source .env && set +a && uvicorn app.main:app --host 0.0.0.0 --port 8050 --reload
```

From a parent folder (optional — e.g. if `chatbot-service/` sits under `datha_platform/` on your machine), prepend `cd chatbot-service &&`:

```bash
cd chatbot-service && source .venv/bin/activate && set -a && source .env && set +a && uvicorn app.main:app --host 0.0.0.0 --port 8050 --reload
```

If clients get **CORS** errors, update **`CORS_ORIGINS`** in api-gateway (the sole CORS owner). If the socket is refused, nothing is listening on **8050** (wrong host/port or process not started).

---

## 3. When you change `.env`

Restart **uvicorn** (Ctrl+C, then the same commands as in §2). Environment variables are read at process start.

---

## 4. When you update `requirements.txt`

```bash
source .venv/bin/activate
pip install -r requirements.txt
```

Then restart uvicorn (§2).

---

## 5. When you recreate the venv

```bash
rm -rf .venv
```

Recreate with any [Python 3.11](#python-311--pick-one-way-to-create-venv) option, then `pip install -r requirements.txt`. Keep `.env` (gitignored). Then §2.

### Upgrade an old 3.9 (or other) venv to 3.11

Same as §5: remove `.venv`, recreate with 3.11, reinstall deps, then:

```bash
set -a && source .env && set +a && alembic upgrade head
```

Restart **uvicorn** and **`python -m app.worker`** after switching.

---

## Quick reference

| Goal | Command |
|------|--------|
| Python 3.11 / new `.venv` | See [Python 3.11](#python-311--pick-one-way-to-create-venv) (pyenv, Homebrew, or direct path) |
| DB migrations (apply) | `source .venv/bin/activate && set -a && source .env && set +a && alembic upgrade head` |
| New migration after model change | See §1: `alembic revision --autogenerate -m "…"` then `alembic upgrade head` (same env prefix as other rows) |
| Dev server (one shot, from `chatbot-service/`) | `source .venv/bin/activate && set -a && source .env && set +a && uvicorn app.main:app --host 0.0.0.0 --port 8050 --reload` |
| Activate venv only | `source .venv/bin/activate` |
| Orphan reconcile (dry-run) | `source .venv/bin/activate && set -a && source .env && set +a && python -m app.reconcile_orphans` |
| Orphan reconcile (publish) | same + ` --execute` |

Windows: use `.venv\Scripts\activate` and export variables from `.env` in your usual way.

**Gemini:** set **`GEMINI_API_KEY`** in `.env` for the **worker** (and title generation). The browser never calls Google directly; use **`GET /api/v1/models`** (picker), **`POST /api/v1/messages`** + SSE. Optional **`CHAT_MODEL_ALLOWLIST`** (comma-separated ids) and **`CHAT_DEFAULT_MODEL`** in `.env`.
