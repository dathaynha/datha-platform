"""Parse Gemini `streamGenerateContent` SSE (REST) and extract cumulative text."""

from __future__ import annotations

import json
from typing import Iterator, Union

GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta"


def stream_generate_url(model: str) -> str:
    return f"{GEMINI_BASE}/models/{model}:streamGenerateContent?alt=sse"


def generate_content_url(model: str) -> str:
    return f"{GEMINI_BASE}/models/{model}:generateContent"


def text_from_generate_response(obj: dict) -> str:
    parts = (obj.get("candidates") or [{}])[0].get("content", {}).get("parts", [])
    return "".join(p.get("text") or "" for p in parts if isinstance(p, dict))


def iter_sse_json_lines(
    raw_stream: Iterator[Union[str, bytes]],
) -> Iterator[dict]:
    """Yield JSON objects from `data: …` lines in a Gemini SSE stream."""
    for line in raw_stream:
        if not line:
            continue
        if isinstance(line, bytes):
            s = line.decode("utf-8", errors="replace").strip()
        else:
            s = line.strip()
        if not s or s.startswith(":"):
            continue
        if not s.startswith("data:"):
            continue
        payload = s[5:].strip()
        if payload == "[DONE]":
            break
        try:
            yield json.loads(payload)
        except json.JSONDecodeError:
            continue


def delta_from_chunks(chunks: Iterator[dict]) -> Iterator[tuple[str, str]]:
    """
    For each chunk, yield (delta_text, cumulative_text).
    Gemini often returns growing text in `candidates[0].content.parts[0].text`.
    """
    prev = ""
    for obj in chunks:
        cur = text_from_generate_response(obj)
        if len(cur) <= len(prev) and cur == prev[: len(cur)]:
            continue
        if cur.startswith(prev):
            delta = cur[len(prev) :]
            prev = cur
            if delta:
                yield delta, cur
        else:
            # Rare: reset or alternate shape — emit full chunk delta vs prev prefix
            delta = cur
            prev = cur
            if delta:
                yield delta, cur
