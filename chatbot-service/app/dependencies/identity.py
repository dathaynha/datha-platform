"""Identity dependencies — read the user identity injected by the api-gateway."""

from fastapi import Header, HTTPException


async def get_owner_id(x_owner_id: str = Header(default="")) -> str:
    """Return the owner_id set by the api-gateway via the X-Owner-ID header.

    The gateway strips any client-supplied X-Owner-ID before forwarding, so this
    value is always trustworthy on authenticated routes. An empty value means the
    request bypassed the gateway (dev tooling, health checks, etc.) — reject it.
    """
    if not x_owner_id:
        raise HTTPException(status_code=401, detail="missing identity header")
    return x_owner_id
