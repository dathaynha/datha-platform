from __future__ import annotations

from app.core.config import DEFAULT_CHAT_MODEL_ID, Settings
from app.schemas.chat_models import ChatModelOption
from app.services import chat_models as cm


def test_is_chat_generative_model_filters_embedding() -> None:
    assert not cm._is_chat_generative_model(
        {
            "name": "models/gemini-embedding-001",
            "supportedGenerationMethods": ["embedContent"],
        }
    )
    assert cm._is_chat_generative_model(
        {
            "name": "models/gemini-flash-latest",
            "displayName": "Gemini Flash Latest",
            "supportedGenerationMethods": ["generateContent", "countTokens"],
        }
    )


def test_apply_allowlist_intersects_and_keeps_configured_ids() -> None:
    models = [
        ChatModelOption(id="gemini-flash-latest", display_name="Flash"),
        ChatModelOption(id="gemini-flash-lite-latest", display_name="Lite"),
        ChatModelOption(id="gemini-2.5-flash", display_name="2.5 Flash"),
    ]
    out = cm._apply_allowlist(models, frozenset({"gemini-flash-latest", "custom-x"}))
    ids = {m.id for m in out}
    assert ids == {"gemini-flash-latest", "custom-x"}


def test_list_chat_models_without_api_key_uses_static(monkeypatch) -> None:
    cm._cache_models = None
    cm._cache_expires_at = 0.0
    settings = Settings(_env_file=None, gemini_api_key="")
    models = cm.list_chat_models(settings)
    assert any(m.id == DEFAULT_CHAT_MODEL_ID for m in models)


def test_resolve_default_prefers_configured_when_present() -> None:
    settings = Settings(_env_file=None, chat_default_model="gemini-flash-lite-latest")
    models = [
        ChatModelOption(id="gemini-flash-latest", display_name="Flash"),
        ChatModelOption(id="gemini-flash-lite-latest", display_name="Lite"),
    ]
    assert cm.resolve_default_chat_model(settings, models) == "gemini-flash-lite-latest"
