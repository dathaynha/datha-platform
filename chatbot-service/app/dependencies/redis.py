"""Redis dependency — the client opened at app startup."""

from fastapi import HTTPException, Request
from redis.asyncio import Redis


def get_redis_client(request: Request) -> Redis:
    r = getattr(request.app.state, "redis", None)
    if r is None:
        raise HTTPException(status_code=503, detail="Redis is not initialized")
    return r
