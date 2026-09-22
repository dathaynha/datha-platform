"""One-off `generateContent` call to label a thread after the first assistant reply."""

from __future__ import annotations

import logging

import httpx

from app.services.gemini_stream import generate_content_url, text_from_generate_response
from app.utils.conversation_title import sanitize_generated_title

logger = logging.getLogger(__name__)

_USER_PREVIEW = 3_500
_ASSIST_PREVIEW = 3_500


def _title_prompt(user_text: str, assistant_text: str) -> str:
    u = (user_text or "").strip()[:_USER_PREVIEW]
    a = (assistant_text or "").strip()[:_ASSIST_PREVIEW]
    return (
        "You name chat threads for a sidebar list.\n"
        "Output exactly ONE short title: 3–8 words, Title Case optional, "
        "no quotes, no trailing punctuation, no emojis unless essential.\n"
        "Do not include the words 'chat' or 'conversation' unless needed.\n\n"
        f"User message:\n---\n{u}\n---\n\n"
        f"Assistant reply:\n---\n{a}\n---\n\n"
        "Title:"
    )


def generate_sidebar_title_sync(
    *,
    api_key: str,
    model: str,
    user_text: str,
    assistant_text: str,
    timeout: float = 30.0,
) -> str | None:
    if not (api_key or "").strip():
        return None
    url = generate_content_url(model)
    # Single-turn generateContent (no role field).
    body = {
        "contents": [
            {"parts": [{"text": _title_prompt(user_text, assistant_text)}]},
        ],
        "generationConfig": {
            "temperature": 0.4,
            "maxOutputTokens": 96,
        },
    }
    try:
        with httpx.Client(timeout=timeout) as client:
            resp = client.post(
                url,
                headers={
                    "Content-Type": "application/json",
                    "X-goog-api-key": api_key.strip(),
                },
                json=body,
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning("title generate request failed: %s", exc)
        return None

    if resp.status_code != 200:
        logger.warning(
            "title generate HTTP %s: %s",
            resp.status_code,
            resp.text[:500],
        )
        return None

    try:
        obj = resp.json()
    except Exception as exc:  # noqa: BLE001
        logger.warning("title generate bad JSON: %s", exc)
        return None

    raw = text_from_generate_response(obj)
    cleaned = sanitize_generated_title(raw)
    return cleaned or None


def try_sidebar_title_with_fallback_models(
    *,
    api_key: str,
    primary_model: str,
    fallback_model: str,
    user_text: str,
    assistant_text: str,
) -> str | None:
    """Try `primary_model`, then `fallback_model` if different, for a non-empty title."""
    key = (api_key or "").strip()
    if not key:
        return None
    pm = (primary_model or "").strip() or "gemini-flash-lite-latest"
    fb = (fallback_model or "").strip()
    t = generate_sidebar_title_sync(
        api_key=key,
        model=pm,
        user_text=user_text,
        assistant_text=assistant_text,
    )
    if t:
        return t
    if fb and fb != pm:
        return generate_sidebar_title_sync(
            api_key=key,
            model=fb,
            user_text=user_text,
            assistant_text=assistant_text,
        )
    return None
