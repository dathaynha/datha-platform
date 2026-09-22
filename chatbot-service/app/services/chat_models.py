"""List chat-capable Gemini models (Google models.list + optional allowlist)."""

from __future__ import annotations

import logging
import re
import time
from typing import Any

import httpx

from app.core.config import DEFAULT_CHAT_MODEL_ID, DEFAULT_TITLE_MODEL_ID, Settings
from app.schemas.chat_models import ChatModelOption
from app.services.gemini_stream import GEMINI_BASE

logger = logging.getLogger(__name__)

_MODELS_LIST_URL = f"{GEMINI_BASE}/models"
_CACHE_TTL_SECONDS = 300.0

# Used when GEMINI_API_KEY is missing or models.list fails.
_STATIC_CHAT_MODELS: tuple[ChatModelOption, ...] = (
    ChatModelOption(id=DEFAULT_CHAT_MODEL_ID, display_name="Gemini 3.6 Flash"),
    ChatModelOption(id=DEFAULT_TITLE_MODEL_ID, display_name="Gemini 3.5 Flash Lite"),
)

_EXCLUDED_ID_RE = re.compile(
    r"(embed|imagen|tts|veo|lyria|aqa|robotics|computer-use|native-audio|/live|gemma)",
    re.IGNORECASE,
)

_cache_models: list[ChatModelOption] | None = None
_cache_expires_at: float = 0.0


def _strip_models_prefix(name: str) -> str:
    raw = (name or "").strip()
    if raw.startswith("models/"):
        return raw[len("models/") :]
    return raw


def _is_chat_generative_model(entry: dict[str, Any]) -> bool:
    model_id = _strip_models_prefix(str(entry.get("name") or ""))
    if not model_id:
        return False
    methods = entry.get("supportedGenerationMethods") or []
    if "generateContent" not in methods:
        return False
    return _EXCLUDED_ID_RE.search(model_id) is None


def _apply_allowlist(
    models: list[ChatModelOption],
    allowlist: frozenset[str] | None,
) -> list[ChatModelOption]:
    if allowlist is None:
        return models
    allowed = [m for m in models if m.id in allowlist]
    for model_id in sorted(allowlist):
        if not any(m.id == model_id for m in allowed):
            allowed.append(ChatModelOption(id=model_id, display_name=model_id))
    return allowed


def _fetch_models_from_google(api_key: str) -> list[ChatModelOption]:
    headers = {"X-goog-api-key": api_key}
    out: list[ChatModelOption] = []
    page_token: str | None = None

    with httpx.Client(timeout=30.0) as client:
        while True:
            params: dict[str, str | int] = {"pageSize": 100}
            if page_token:
                params["pageToken"] = page_token
            resp = client.get(_MODELS_LIST_URL, headers=headers, params=params)
            resp.raise_for_status()
            payload = resp.json()
            for entry in payload.get("models") or []:
                if not isinstance(entry, dict) or not _is_chat_generative_model(entry):
                    continue
                model_id = _strip_models_prefix(str(entry.get("name") or ""))
                display = (entry.get("displayName") or model_id).strip() or model_id
                out.append(ChatModelOption(id=model_id, display_name=display))
            page_token = payload.get("nextPageToken")
            if not page_token:
                break

    out.sort(key=lambda m: m.id)
    return out


def list_chat_models(settings: Settings) -> list[ChatModelOption]:
    """Return chat models for the picker; cached briefly per process."""
    global _cache_models, _cache_expires_at

    allowlist = settings.chat_model_allowlist_set()
    now = time.monotonic()
    if _cache_models is not None and now < _cache_expires_at:
        return _apply_allowlist(list(_cache_models), allowlist)

    api_key = (settings.gemini_api_key or "").strip()
    if not api_key:
        base = list(_STATIC_CHAT_MODELS)
        return _apply_allowlist(base, allowlist)

    try:
        fetched = _fetch_models_from_google(api_key)
        if not fetched:
            base = list(_STATIC_CHAT_MODELS)
        else:
            base = fetched
            _cache_models = list(base)
            _cache_expires_at = now + _CACHE_TTL_SECONDS
    except Exception as exc:  # noqa: BLE001
        logger.warning("models.list failed, using static chat models: %s", exc)
        base = list(_STATIC_CHAT_MODELS)

    return _apply_allowlist(base, allowlist)


def resolve_default_chat_model(
    settings: Settings, models: list[ChatModelOption]
) -> str:
    preferred = (settings.chat_default_model or DEFAULT_CHAT_MODEL_ID).strip()
    ids = {m.id for m in models}
    if preferred in ids:
        return preferred
    if models:
        return models[0].id
    return preferred


MODEL_ID_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9._-]{0,127}$")


def resolve_requested_model(settings: Settings, requested: str) -> str:
    """Resolve a client-supplied model id; empty falls back to the server default.

    Raises ValueError with a client-safe message when the id is malformed or is not
    in the allowlist, so callers can map it to a 400.
    """
    available = list_chat_models(settings)
    model = (requested or "").strip() or resolve_default_chat_model(settings, available)
    if not MODEL_ID_RE.fullmatch(model):
        raise ValueError("invalid model id")
    if model not in {m.id for m in available}:
        raise ValueError("model not allowed")
    return model
