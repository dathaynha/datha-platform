from __future__ import annotations

from pydantic import BaseModel, Field


class ChatModelOption(BaseModel):
    id: str = Field(
        description="Model id passed to POST /messages (e.g. gemini-3.6-flash)."
    )
    display_name: str = Field(description="Human-readable label for the UI.")


class ChatModelsResponse(BaseModel):
    models: list[ChatModelOption]
    default_model: str
