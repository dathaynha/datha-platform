"""Manual orphan backfill + outbox sweep. Default dry-run; pass --execute to publish.

  python -m app.reconcile_orphans           # dry-run (safe default)
  python -m app.reconcile_orphans --execute # drain outbox + publish orphan cleanup events

Prod: ADO scheduled job (~daily) with the same --execute command.
Does not require the API (uvicorn) to be running.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from app.core.config import get_settings
from app.db.session import AsyncSessionLocal
from app.services.nats_lifecycle import connect_nats_optional
from app.services.orphan_reconcile import run_reconcile

logger = logging.getLogger(__name__)


async def _main(*, execute: bool) -> int:
    settings = get_settings()
    nc, js = await connect_nats_optional(settings.nats_url)

    try:
        async with AsyncSessionLocal() as session:
            stats = await run_reconcile(session, js, settings, execute=execute)
    finally:
        if nc is not None:
            await nc.drain()

    if stats.errors and execute:
        return 1
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Drain event_outbox and backfill orphan file cleanup (default: dry-run).",
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Publish to NATS (default is dry-run only).",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stdout,
    )

    if not args.execute:
        logger.info("dry-run mode (pass --execute to publish)")

    exit_code = asyncio.run(_main(execute=args.execute))
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
