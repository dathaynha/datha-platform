"""Config helpers — DB URL normalization and Redis key builders."""

from __future__ import annotations

import pytest

from app.core.config import (
    DEFAULT_CHAT_MODEL_ID,
    DEFAULT_TITLE_MODEL_ID,
    Settings,
    _to_asyncpg_url,
    _to_psycopg_url,
    get_settings,
    redis_job_meta_key,
    redis_stream_key,
)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("postgresql://u:p@localhost/db", "postgresql+asyncpg://u:p@localhost/db"),
        (
            "postgresql+psycopg://u:p@localhost/db",
            "postgresql+asyncpg://u:p@localhost/db",
        ),
        (
            "postgresql+asyncpg://u:p@localhost/db",
            "postgresql+asyncpg://u:p@localhost/db",
        ),
        ("mysql://localhost/db", "mysql://localhost/db"),
    ],
)
def test_to_asyncpg_url(raw: str, expected: str) -> None:
    assert _to_asyncpg_url(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("postgresql://u:p@localhost/db", "postgresql+psycopg://u:p@localhost/db"),
        (
            "postgresql+asyncpg://u:p@localhost/db",
            "postgresql+psycopg://u:p@localhost/db",
        ),
        (
            "postgresql+psycopg://u:p@localhost/db",
            "postgresql+psycopg://u:p@localhost/db",
        ),
    ],
)
def test_to_psycopg_url(raw: str, expected: str) -> None:
    assert _to_psycopg_url(raw) == expected


def test_to_psycopg_url_non_postgres_unchanged() -> None:
    assert _to_psycopg_url("mysql://localhost/db") == "mysql://localhost/db"


def test_settings_database_url_properties() -> None:
    settings = Settings(database_url="postgresql://u:p@localhost/chatbot_service")
    assert settings.async_database_url.startswith("postgresql+asyncpg://")
    assert settings.sync_database_url.startswith("postgresql+psycopg://")


def test_redis_key_helpers() -> None:
    assert redis_stream_key("job-1") == "chatbot:events:job-1"
    assert redis_job_meta_key("job-1") == "chatbot:job:job-1"


def test_model_defaults_are_explicit_pins() -> None:
    settings = Settings(_env_file=None)
    assert settings.gemini_title_model == DEFAULT_TITLE_MODEL_ID
    assert settings.chat_default_model == DEFAULT_CHAT_MODEL_ID
    # A `-latest` alias is what 503d under load on 2026-08-27; pins are bumped
    # deliberately, and the worker retry covers transient capacity errors.
    assert "latest" not in settings.gemini_title_model
    assert "latest" not in settings.chat_default_model


def test_get_settings_cached(monkeypatch: pytest.MonkeyPatch) -> None:
    get_settings.cache_clear()
    monkeypatch.setenv("GEMINI_TITLE_MODEL", "custom-model")
    try:
        assert get_settings().gemini_title_model == "custom-model"
        assert get_settings().gemini_title_model == "custom-model"
    finally:
        get_settings.cache_clear()
