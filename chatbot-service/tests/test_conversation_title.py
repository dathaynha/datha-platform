"""Conversation title helpers — sidebar text and model output sanitization."""

from __future__ import annotations

from app.utils.conversation_title import (
    sanitize_generated_title,
    sidebar_title_from_user_text,
)


def test_sidebar_title_empty_or_whitespace_returns_new_chat() -> None:
    assert sidebar_title_from_user_text("") == "New chat"
    assert sidebar_title_from_user_text("  \n\n") == "New chat"


def test_sidebar_title_first_line_only() -> None:
    assert sidebar_title_from_user_text("Hello\nworld") == "Hello"


def test_sidebar_title_truncates_with_ellipsis() -> None:
    text = "a" * 80
    result = sidebar_title_from_user_text(text, max_len=10)
    assert result.endswith("\u2026")
    assert len(result) == 10


def test_sanitize_generated_title_empty() -> None:
    assert sanitize_generated_title("") == ""
    assert sanitize_generated_title("   ") == ""


def test_sanitize_generated_title_strips_quotes_and_collapses_whitespace() -> None:
    assert sanitize_generated_title('  "My   Title"  ') == "My Title"


def test_sanitize_generated_title_unwraps_markdown_fence() -> None:
    # Fence handler skips the first inner line (e.g. language tag), title on the next line.
    raw = "```\n_\nProject kickoff notes\n```"
    assert sanitize_generated_title(raw) == "Project kickoff notes"


def test_sanitize_generated_title_unwraps_json_fence() -> None:
    raw = "```json\n_\nBudget review Q2\n```"
    assert sanitize_generated_title(raw) == "Budget review Q2"


def test_sanitize_generated_title_first_line_only() -> None:
    assert sanitize_generated_title("Line one\nLine two") == "Line one"


def test_sanitize_generated_title_truncates() -> None:
    assert sanitize_generated_title("x" * 250, max_len=20).endswith("\u2026")
