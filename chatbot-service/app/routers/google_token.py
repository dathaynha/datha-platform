"""Proxies Google OAuth token POSTs and injects client_secret (server-side only)."""

import os
from urllib.parse import parse_qsl

import httpx
from fastapi import APIRouter, HTTPException, Request, Response

GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "").strip()
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "").strip()

router = APIRouter()


@router.post("/auth/google/token")
async def google_token_proxy(request: Request) -> Response:
    if not GOOGLE_CLIENT_SECRET:
        raise HTTPException(
            status_code=503,
            detail="GOOGLE_CLIENT_SECRET is not configured on chatbot-service",
        )

    raw = await request.body()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as e:
        raise HTTPException(status_code=400, detail="invalid body encoding") from e

    data = dict(parse_qsl(text, keep_blank_values=True))
    if not data.get("grant_type"):
        raise HTTPException(status_code=400, detail="missing grant_type")

    cid = data.get("client_id")
    if GOOGLE_CLIENT_ID and cid and cid != GOOGLE_CLIENT_ID:
        raise HTTPException(
            status_code=400, detail="client_id does not match server configuration"
        )

    data["client_secret"] = GOOGLE_CLIENT_SECRET

    async with httpx.AsyncClient(timeout=30.0) as client:
        upstream = await client.post(
            GOOGLE_TOKEN_URL,
            data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )

    ct = upstream.headers.get("content-type", "application/json")
    return Response(
        content=upstream.content, status_code=upstream.status_code, media_type=ct
    )
