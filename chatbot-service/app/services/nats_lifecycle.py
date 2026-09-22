"""Optional NATS connection for platform events (chat works without the broker)."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

import nats

if TYPE_CHECKING:
    from nats.aio.client import Client as NatsClient
    from nats.js import JetStreamContext

logger = logging.getLogger(__name__)


async def connect_nats_optional(
    url: str,
) -> tuple[NatsClient | None, JetStreamContext | None]:
    """Connect to NATS; return (None, None) on failure so the API can still start."""
    try:
        # Reconnect forever — the default 60 attempts gives up after ~2 min of
        # broker outage and the outbox drain loop would stall until restart.
        nc = await nats.connect(url, max_reconnect_attempts=-1)
        return nc, nc.jetstream()
    except Exception:
        logger.warning(
            "NATS unavailable at %s; chat API will run — events go to event_outbox "
            "until JetStream is up and the outbox drain loop publishes them",
            url,
            exc_info=True,
        )
        return None, None
