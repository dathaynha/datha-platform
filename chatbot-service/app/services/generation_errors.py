"""Normalize provider/worker failures into stable codes + user-facing summaries."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

_DETAIL_CAP = 2000

# Provider statuses worth a second attempt: rate limit, capacity, transient 5xx.
# 4xx other than 429 (bad model id, revoked key, oversized request) never self-heal.
RETRYABLE_STATUS_CODES = frozenset({429, 500, 502, 503, 504})


@dataclass(frozen=True)
class NormalizedGenerationError:
    code: str
    summary: str
    detail: str
    retryable: bool = False


def _truncate(s: str, cap: int = _DETAIL_CAP) -> str:
    if len(s) <= cap:
        return s
    return s[: cap - 1] + "…"


_PAGE_LIMIT_RE = re.compile(
    r"exceeds\s+the\s+supported\s+page\s+limit\s+of\s+\d+",
    re.IGNORECASE,
)


def normalize_gemini_http_error(
    status_code: int, body: str
) -> NormalizedGenerationError:
    """Parse Gemini REST error JSON when possible; fall back to generic copy."""
    detail_raw = _truncate(body.strip())
    retryable = status_code in RETRYABLE_STATUS_CODES
    msg: str | None = None
    status_token: str | None = None
    try:
        data = json.loads(body)
        err = data.get("error") if isinstance(data, dict) else None
        if isinstance(err, dict):
            raw_msg = err.get("message")
            if isinstance(raw_msg, str):
                msg = raw_msg.strip()
            raw_st = err.get("status")
            if isinstance(raw_st, str):
                status_token = raw_st.strip().upper()
    except (json.JSONDecodeError, TypeError):
        pass

    detail = _truncate(msg or detail_raw)

    if status_token == "INVALID_ARGUMENT" and msg:
        if _PAGE_LIMIT_RE.search(msg) or (
            "page" in msg.lower() and "limit" in msg.lower()
        ):
            return NormalizedGenerationError(
                code="provider_page_limit",
                summary=(
                    "This document has too many pages for the model "
                    "(about 1,000 pages max). Try a shorter PDF or split the file."
                ),
                detail=detail,
            )
        return NormalizedGenerationError(
            code="provider_invalid_argument",
            summary=_truncate(msg, 500),
            detail=detail,
        )

    if msg and len(msg) <= 600:
        return NormalizedGenerationError(
            code="provider_error",
            summary=_truncate(msg, 500),
            detail=detail,
            retryable=retryable,
        )

    return NormalizedGenerationError(
        code=f"provider_http_{status_code}",
        summary=(
            "The AI service could not complete this request. "
            "Try again or adjust your message or attachments."
        ),
        detail=detail,
        retryable=retryable,
    )


def normalize_simple(
    code: str,
    summary: str,
    detail: str | None = None,
    *,
    retryable: bool = False,
) -> NormalizedGenerationError:
    return NormalizedGenerationError(
        code=code,
        summary=summary.strip() or "Something went wrong.",
        detail=_truncate((detail or summary).strip()),
        retryable=retryable,
    )


_DURATION_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*s?\s*$", re.IGNORECASE)


def _duration_seconds(raw: object) -> float | None:
    if not isinstance(raw, str):
        return None
    m = _DURATION_RE.match(raw)
    if not m:
        return None
    try:
        value = float(m.group(1))
    except ValueError:
        return None
    return value if value >= 0 else None


def provider_retry_delay(header: str | None, body: str) -> float | None:
    """Seconds the provider asked us to wait, or None when it did not say.

    Two sources: the `Retry-After` header (seconds form — Google does not send
    HTTP dates here) and `google.rpc.RetryInfo.retryDelay` ("24s") in the error
    details of a 429 body.
    """
    from_header = _duration_seconds(header)
    if from_header is not None:
        return from_header

    try:
        data = json.loads(body)
    except (json.JSONDecodeError, TypeError):
        return None
    err = data.get("error") if isinstance(data, dict) else None
    details = err.get("details") if isinstance(err, dict) else None
    if not isinstance(details, list):
        return None
    for item in details:
        if not isinstance(item, dict):
            continue
        if "RetryInfo" not in str(item.get("@type", "")):
            continue
        delay = _duration_seconds(item.get("retryDelay"))
        if delay is not None:
            return delay
    return None
