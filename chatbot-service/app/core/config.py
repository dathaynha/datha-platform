"""Environment-backed settings (no secrets logged)."""

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# Pinned model ids (2026-08-27): the `-latest` aliases 503d under load and `gemini-2.5-*`
# is retired for new keys. Explicit pins mean a bump is a reviewed change, and the
# worker retry absorbs transient capacity errors. Verified ids live in
# `.claude/docs/services/chatbot-service-architecture.md`.
DEFAULT_CHAT_MODEL_ID = "gemini-3.6-flash"
DEFAULT_TITLE_MODEL_ID = "gemini-3.5-flash-lite"


def _to_asyncpg_url(database_url: str) -> str:
    """Normalize postgresql://… to postgresql+asyncpg://… for SQLAlchemy async."""
    u = database_url.strip()
    if "+asyncpg" in u:
        return u
    if u.startswith("postgresql+psycopg://"):
        return u.replace("postgresql+psycopg://", "postgresql+asyncpg://", 1)
    if u.startswith("postgresql://"):
        return u.replace("postgresql://", "postgresql+asyncpg://", 1)
    return u


def _to_psycopg_url(database_url: str) -> str:
    """Sync driver URL for the worker process."""
    u = database_url.strip()
    if "+psycopg" in u or "+psycopg2" in u:
        return u
    if "+asyncpg" in u:
        return u.replace("+asyncpg", "+psycopg", 1)
    if u.startswith("postgresql://"):
        return u.replace("postgresql://", "postgresql+psycopg://", 1)
    return u


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str = "postgresql://postgres:password@localhost:5432/chatbot_service"
    redis_url: str = "redis://localhost:6379/0"
    gemini_api_key: str = ""
    gemini_title_model: str = Field(
        default=DEFAULT_TITLE_MODEL_ID,
        description=(
            "Gemini model id for sidebar thread titles (generateContent). "
            "Use a lite model to spare flash RPD quota on chat."
        ),
    )
    chat_default_model: str = Field(
        default=DEFAULT_CHAT_MODEL_ID,
        description="Default model id when the client omits model or sends an unknown id.",
    )
    chat_model_allowlist: str = Field(
        default="",
        description=(
            "Optional comma-separated model ids for POST /messages and GET /models. "
            "Empty = all generateContent models returned by Google models.list (filtered)."
        ),
    )

    generation_retry_attempts: int = Field(
        default=3,
        ge=1,
        le=5,
        description=(
            "Total Gemini attempts per job (1 = no retry). In-process only — these are "
            "not NATS redeliveries, and only apply before the first streamed chunk."
        ),
    )
    generation_retry_base_delay_seconds: float = Field(
        default=1.0,
        gt=0,
        description="First backoff step; doubles per attempt with full jitter.",
    )
    generation_retry_max_delay_seconds: float = Field(
        default=8.0,
        gt=0,
        description=(
            "Cap for one backoff wait, `Retry-After` included. Keeps the worst case "
            "under the frontend first-event watchdog."
        ),
    )

    job_meta_ttl_seconds: int = 86_400
    queue_key: str = "chatbot:jobs"
    file_service_url: str = Field(
        default="http://localhost:3001",
        description="Internal base URL for file-service. Used by the worker to fetch SAS download URLs.",
    )
    nats_url: str = Field(
        default="nats://localhost:4222",
        description="NATS JetStream for platform business events (e.g. conversation deleted).",
    )
    event_outbox_poll_seconds: float = Field(
        default=5.0,
        description="API background loop interval for draining event_outbox to JetStream.",
    )
    event_outbox_batch_size: int = Field(
        default=25,
        ge=1,
        le=500,
        description="Max outbox rows published per drain batch.",
    )
    event_outbox_max_backoff_seconds: int = Field(
        default=3600,
        ge=1,
        description="Cap for exponential backoff between failed outbox publish attempts.",
    )

    @property
    def async_database_url(self) -> str:
        return _to_asyncpg_url(self.database_url)

    @property
    def sync_database_url(self) -> str:
        return _to_psycopg_url(self.database_url)

    def chat_model_allowlist_set(self) -> frozenset[str] | None:
        raw = (self.chat_model_allowlist or "").strip()
        if not raw:
            return None
        parts = {p.strip() for p in raw.split(",") if p.strip()}
        return frozenset(parts) if parts else None


@lru_cache
def get_settings() -> Settings:
    return Settings()


def redis_stream_key(job_id: str) -> str:
    """Redis Stream key for SSE chunks. Uses a distinct prefix from the old
    Pub/Sub channel ('chatbot:stream:') to avoid key-type conflicts in Redis."""
    return f"chatbot:events:{job_id}"


JOB_META_KEY_PREFIX = "chatbot:job:"


def redis_job_meta_key(job_id: str) -> str:
    return f"{JOB_META_KEY_PREFIX}{job_id}"


def redis_conv_active_job_key(conversation_id: str) -> str:
    """Latest job enqueued for a conversation — lets a revisit re-attach to a live stream."""
    return f"chatbot:conv_active_job:{conversation_id}"
