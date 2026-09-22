"""Provider error normalization for worker/API responses."""

from __future__ import annotations

import json

from app.services.generation_errors import (
    NormalizedGenerationError,
    normalize_gemini_http_error,
    normalize_simple,
    provider_retry_delay,
)


def test_normalize_simple_strips_and_uses_defaults() -> None:
    err = normalize_simple("timeout", "  Request timed out  ", detail=None)
    assert err == NormalizedGenerationError(
        code="timeout",
        summary="Request timed out",
        detail="Request timed out",
    )


def test_normalize_simple_empty_summary_falls_back() -> None:
    err = normalize_simple("x", "   ", detail="detail text")
    assert err.summary == "Something went wrong."
    assert err.detail == "detail text"


def test_normalize_gemini_page_limit_by_regex() -> None:
    body = json.dumps(
        {
            "error": {
                "status": "INVALID_ARGUMENT",
                "message": "File exceeds the supported page limit of 1000",
            }
        }
    )
    err = normalize_gemini_http_error(400, body)
    assert err.code == "provider_page_limit"
    assert "too many pages" in err.summary


def test_normalize_gemini_page_limit_by_keywords() -> None:
    body = json.dumps(
        {
            "error": {
                "status": "INVALID_ARGUMENT",
                "message": "Document page limit exceeded for upload",
            }
        }
    )
    err = normalize_gemini_http_error(400, body)
    assert err.code == "provider_page_limit"


def test_normalize_gemini_invalid_argument_other() -> None:
    body = json.dumps(
        {
            "error": {
                "status": "INVALID_ARGUMENT",
                "message": "Unsupported MIME type",
            }
        }
    )
    err = normalize_gemini_http_error(400, body)
    assert err.code == "provider_invalid_argument"
    assert err.summary == "Unsupported MIME type"


def test_normalize_gemini_short_message_uses_provider_error() -> None:
    body = json.dumps(
        {"error": {"message": "Rate limited", "status": "RESOURCE_EXHAUSTED"}}
    )
    err = normalize_gemini_http_error(429, body)
    assert err.code == "provider_error"
    assert err.summary == "Rate limited"


def test_normalize_gemini_invalid_json_falls_back_to_http_code() -> None:
    err = normalize_gemini_http_error(502, "upstream exploded")
    assert err.code == "provider_http_502"
    assert "AI service could not complete" in err.summary
    assert err.detail == "upstream exploded"


def test_normalize_gemini_truncates_huge_body() -> None:
    err = normalize_gemini_http_error(500, "z" * 3000)
    assert len(err.detail) == 2000
    assert err.detail.endswith("…")


def test_normalize_gemini_long_message_falls_back_to_http_code() -> None:
    long_msg = "x" * 700
    body = json.dumps({"error": {"message": long_msg, "status": "INTERNAL"}})
    err = normalize_gemini_http_error(500, body)
    assert err.code == "provider_http_500"
    assert len(err.detail) <= 2000


def test_retryable_statuses_are_flagged() -> None:
    body = json.dumps({"error": {"status": "UNAVAILABLE", "message": "overloaded"}})
    for status in (429, 500, 502, 503, 504):
        assert normalize_gemini_http_error(status, body).retryable is True, status


def test_client_errors_are_not_retryable() -> None:
    body = json.dumps({"error": {"status": "INVALID_ARGUMENT", "message": "bad model"}})
    for status in (400, 401, 403, 404, 413, 422):
        assert normalize_gemini_http_error(status, body).retryable is False, status


def test_retryable_survives_the_long_message_fallback() -> None:
    err = normalize_gemini_http_error(
        503, json.dumps({"error": {"message": "x" * 700}})
    )
    assert err.code == "provider_http_503"
    assert err.retryable is True


def test_normalize_simple_defaults_to_not_retryable() -> None:
    assert normalize_simple("worker_exception", "boom").retryable is False
    assert (
        normalize_simple("worker_exception", "boom", retryable=True).retryable is True
    )


def test_retry_delay_from_header_seconds() -> None:
    assert provider_retry_delay("30", "") == 30.0
    assert provider_retry_delay(" 1.5s ", "") == 1.5


def test_retry_delay_from_retry_info_body() -> None:
    body = json.dumps(
        {
            "error": {
                "status": "RESOURCE_EXHAUSTED",
                "message": "quota",
                "details": [
                    {"@type": "type.googleapis.com/google.rpc.QuotaFailure"},
                    {
                        "@type": "type.googleapis.com/google.rpc.RetryInfo",
                        "retryDelay": "24s",
                    },
                ],
            }
        }
    )
    assert provider_retry_delay(None, body) == 24.0


def test_retry_delay_absent_or_unparseable() -> None:
    assert provider_retry_delay(None, "") is None
    assert provider_retry_delay("Wed, 21 Oct 2026 07:28:00 GMT", "") is None
    assert (
        provider_retry_delay(None, json.dumps({"error": {"details": "nope"}})) is None
    )
