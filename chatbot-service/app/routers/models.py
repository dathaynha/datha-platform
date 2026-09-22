"""GET /models — chat-capable Gemini models for the UI picker."""

from __future__ import annotations

from fastapi import APIRouter

from app.core.config import get_settings
from app.schemas.chat_models import ChatModelsResponse
from app.services.chat_models import list_chat_models, resolve_default_chat_model

router = APIRouter(tags=["models"])


@router.get("/models", response_model=ChatModelsResponse)
async def list_models() -> ChatModelsResponse:
    settings = get_settings()
    models = list_chat_models(settings)
    default_model = resolve_default_chat_model(settings, models)
    return ChatModelsResponse(models=models, default_model=default_model)
