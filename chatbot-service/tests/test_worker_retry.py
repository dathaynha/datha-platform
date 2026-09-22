"""Worker-side bounded retry against Gemini (in-process attempts, not NATS redeliveries)."""

from __future__ import annotations

import json
import uuid
from types import SimpleNamespace

import httpx
import pytest

from app import worker as wk
from app.models.message import Message
from app.services.generation_errors import normalize_simple


class FakeRedis:
    """Records stream frames and job-meta writes."""

    def __init__(self) -> None:
        self.frames: list[dict] = []
        self.hashes: dict[str, dict[str, str]] = {}

    def xadd(self, key: str, fields: dict, **_kw: object) -> None:
        self.frames.append(json.loads(fields["data"]))

    def expire(self, *_a: object, **_kw: object) -> None:
        return None

    def hset(self, key: str, field: str, value: str) -> None:
        self.hashes.setdefault(key, {})[field] = value

    def frame_types(self) -> list[str]:
        return [f.get("type") for f in self.frames]


class _Scalars:
    def __init__(self, rows: list[Message]) -> None:
        self._rows = rows

    def all(self) -> list[Message]:
        return self._rows


class _Result:
    def __init__(self, rows: list[Message]) -> None:
        self._rows = rows

    def scalars(self) -> _Scalars:
        return _Scalars(self._rows)


class FakeSession:
    def __init__(self, rows: list[Message]) -> None:
        self._rows = rows
        self.added: list[Message] = []

    def __enter__(self) -> "FakeSession":
        return self

    def __exit__(self, *_exc: object) -> bool:
        return False

    def execute(self, _stmt: object) -> _Result:
        return _Result(self._rows)

    def add(self, row: Message) -> None:
        if getattr(row, "id", None) is None:
            row.id = uuid.uuid4()
        self.added.append(row)

    def commit(self) -> None:
        return None

    def get(self, _model: object, _pk: object) -> None:
        return None


@pytest.fixture
def settings() -> SimpleNamespace:
    return SimpleNamespace(
        gemini_api_key="test-key",
        gemini_title_model="gemini-3.5-flash-lite",
        file_service_url="http://localhost:3001",
        job_meta_ttl_seconds=60,
        generation_retry_attempts=3,
        generation_retry_base_delay_seconds=1.0,
        generation_retry_max_delay_seconds=8.0,
    )


@pytest.fixture
def job_payload() -> dict:
    user_message_id = uuid.uuid4()
    return {
        "job_id": str(uuid.uuid4()),
        "conversation_id": str(uuid.uuid4()),
        "user_message_id": str(user_message_id),
        "model": "gemini-3.6-flash",
        # empty owner_id skips file fetching and the message.sent outbox write
        "owner_id": "",
    }


def _session_factory(job_payload: dict):
    user_msg = Message(
        id=uuid.UUID(job_payload["user_message_id"]),
        conversation_id=uuid.UUID(job_payload["conversation_id"]),
        role="user",
        content="hello",
    )
    return lambda: FakeSession([user_msg])


def _run(job_payload: dict, settings: SimpleNamespace, r: FakeRedis) -> None:
    wk.process_one_job(
        json.dumps(job_payload),
        settings=settings,
        r=r,
        SessionLocal=_session_factory(job_payload),
    )


def _retryable_failure(retry_after: float | None = None) -> wk._AttemptFailure:
    return wk._AttemptFailure(
        normalized=normalize_simple("provider_http_503", "overloaded", retryable=True),
        legacy_detail="Gemini HTTP 503",
        retry_after=retry_after,
    )


@pytest.fixture
def sleeps(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    recorded: list[float] = []
    monkeypatch.setattr(wk.time, "sleep", lambda s: recorded.append(s))
    return recorded


def _script_attempts(
    monkeypatch: pytest.MonkeyPatch, outcomes: list[object]
) -> list[int]:
    """Replace the Gemini call with a scripted sequence. Returns a mutable call log."""
    calls: list[int] = []

    def fake_attempt(*, full_text: list[str], **_kw: object):
        calls.append(len(calls) + 1)
        outcome = outcomes[len(calls) - 1]
        if callable(outcome):
            return outcome(full_text)
        return outcome

    monkeypatch.setattr(wk, "_attempt_generation", fake_attempt)
    return calls


def test_retries_then_succeeds(
    monkeypatch: pytest.MonkeyPatch,
    settings: SimpleNamespace,
    job_payload: dict,
    sleeps: list[float],
) -> None:
    def succeed(full_text: list[str]) -> None:
        full_text.append("hi")
        return None

    calls = _script_attempts(monkeypatch, [_retryable_failure(), succeed])
    r = FakeRedis()

    _run(job_payload, settings, r)

    assert len(calls) == 2
    assert len(sleeps) == 1
    types = r.frame_types()
    assert "error" not in types
    assert types.count("retrying") == 1
    assert types[-1] == "done"
    retrying = next(f for f in r.frames if f["type"] == "retrying")
    assert retrying == {"type": "retrying", "attempt": 2, "max_attempts": 3}


def test_exhausts_attempts_and_emits_one_failure(
    monkeypatch: pytest.MonkeyPatch,
    settings: SimpleNamespace,
    job_payload: dict,
    sleeps: list[float],
) -> None:
    calls = _script_attempts(monkeypatch, [_retryable_failure() for _ in range(3)])
    r = FakeRedis()

    _run(job_payload, settings, r)

    assert len(calls) == 3
    assert len(sleeps) == 2
    types = r.frame_types()
    assert types.count("retrying") == 2
    assert types.count("error") == 1
    assert types[-1] == "error"


def test_non_retryable_error_is_not_retried(
    monkeypatch: pytest.MonkeyPatch,
    settings: SimpleNamespace,
    job_payload: dict,
    sleeps: list[float],
) -> None:
    failure = wk._AttemptFailure(
        normalized=normalize_simple("provider_invalid_argument", "bad model id"),
        legacy_detail="Gemini HTTP 400",
    )
    calls = _script_attempts(monkeypatch, [failure])
    r = FakeRedis()

    _run(job_payload, settings, r)

    assert len(calls) == 1
    assert sleeps == []
    assert r.frame_types().count("retrying") == 0
    assert r.frame_types()[-1] == "error"


def test_mid_stream_break_does_not_retry(
    monkeypatch: pytest.MonkeyPatch,
    settings: SimpleNamespace,
    job_payload: dict,
    sleeps: list[float],
) -> None:
    """Deltas are already in the stream; a retry would duplicate them on replay."""

    def break_mid_stream(full_text: list[str]) -> wk._AttemptFailure:
        full_text.append("partial ")
        return _retryable_failure()

    calls = _script_attempts(monkeypatch, [break_mid_stream, break_mid_stream])
    r = FakeRedis()

    _run(job_payload, settings, r)

    assert len(calls) == 1
    assert sleeps == []
    assert r.frame_types().count("retrying") == 0
    assert r.frame_types()[-1] == "error"


def test_retry_after_is_honoured(
    monkeypatch: pytest.MonkeyPatch,
    settings: SimpleNamespace,
    job_payload: dict,
    sleeps: list[float],
) -> None:
    _script_attempts(
        monkeypatch, [_retryable_failure(retry_after=2.5), lambda ft: None]
    )
    r = FakeRedis()

    _run(job_payload, settings, r)

    assert sleeps == [2.5]


def test_retry_after_is_capped(
    monkeypatch: pytest.MonkeyPatch,
    settings: SimpleNamespace,
    job_payload: dict,
    sleeps: list[float],
) -> None:
    _script_attempts(
        monkeypatch, [_retryable_failure(retry_after=600), lambda ft: None]
    )
    r = FakeRedis()

    _run(job_payload, settings, r)

    assert sleeps == [settings.generation_retry_max_delay_seconds]


def test_backoff_grows_and_stays_jittered(settings: SimpleNamespace) -> None:
    for attempt, window in ((1, 1.0), (2, 2.0), (3, 4.0)):
        waits = [wk._retry_wait_seconds(attempt, None, settings) for _ in range(50)]
        assert all(window / 2 <= w <= window for w in waits)
    assert wk._retry_wait_seconds(10, None, settings) <= 8.0


def test_retry_disabled_when_attempts_is_one(
    monkeypatch: pytest.MonkeyPatch,
    settings: SimpleNamespace,
    job_payload: dict,
    sleeps: list[float],
) -> None:
    settings.generation_retry_attempts = 1
    calls = _script_attempts(monkeypatch, [_retryable_failure()])
    r = FakeRedis()

    _run(job_payload, settings, r)

    assert len(calls) == 1
    assert sleeps == []
    assert r.frame_types()[-1] == "error"


def test_transport_errors_are_retryable_others_are_not() -> None:
    assert wk._retryable_transport_error(httpx.ConnectError("boom")) is True
    assert wk._retryable_transport_error(httpx.ReadTimeout("slow")) is True
    assert wk._retryable_transport_error(ValueError("bug")) is False


def _mock_client(monkeypatch: pytest.MonkeyPatch, handler) -> None:
    transport = httpx.MockTransport(handler)
    real_client = httpx.Client

    def factory(*_a: object, **kw: object) -> httpx.Client:
        return real_client(transport=transport, timeout=kw.get("timeout"))

    monkeypatch.setattr(wk.httpx, "Client", factory)


def test_attempt_classifies_a_real_503_with_retry_after(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    body = json.dumps({"error": {"status": "UNAVAILABLE", "message": "high demand"}})
    _mock_client(
        monkeypatch,
        lambda _req: httpx.Response(503, content=body, headers={"Retry-After": "3"}),
    )
    r = FakeRedis()

    failure = wk._attempt_generation(
        url="https://example.invalid/stream",
        api_key="k",
        contents=[{"role": "user", "parts": [{"text": "hi"}]}],
        r=r,
        stream_key="s",
        ttl=60,
        full_text=[],
    )

    assert failure is not None
    assert failure.normalized.retryable is True
    assert failure.retry_after == 3.0
    assert r.frames == []


def test_attempt_publishes_chunks_on_success(monkeypatch: pytest.MonkeyPatch) -> None:
    sse = (
        'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n'
        'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n'
    )
    _mock_client(monkeypatch, lambda _req: httpx.Response(200, content=sse))
    r = FakeRedis()
    full_text: list[str] = []

    failure = wk._attempt_generation(
        url="https://example.invalid/stream",
        api_key="k",
        contents=[{"role": "user", "parts": [{"text": "hi"}]}],
        r=r,
        stream_key="s",
        ttl=60,
        full_text=full_text,
    )

    assert failure is None
    assert "".join(full_text) == "Hello"
    assert [f["text"] for f in r.frames] == ["Hel", "lo"]
