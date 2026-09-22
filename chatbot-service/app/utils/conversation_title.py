"""Conversation titles: legacy first-line helper and sanitization for model output."""


def sidebar_title_from_user_text(text: str, max_len: int = 72) -> str:
    first_line = text.split("\n", 1)[0].strip()
    if not first_line:
        return "New chat"
    if len(first_line) <= max_len:
        return first_line
    return first_line[: max_len - 1].rstrip() + "\u2026"


def sanitize_generated_title(text: str, max_len: int = 200) -> str:
    """Normalize a model-produced title for DB / sidebar (single line, bounded)."""
    t = (text or "").strip()
    if not t:
        return ""
    if t.startswith("```"):
        t = t[3:].lstrip()
        if t.lower().startswith("json"):
            t = t[4:].lstrip()
        if "\n" in t:
            t = t.split("\n", 1)[1]
        if "```" in t:
            t = t.split("```", 1)[0]
        t = t.strip()
    t = t.split("\n", 1)[0].strip()
    t = t.strip(" \"'`")
    t = " ".join(t.split())
    if not t:
        return ""
    if len(t) <= max_len:
        return t
    return t[: max_len - 1].rstrip() + "\u2026"
