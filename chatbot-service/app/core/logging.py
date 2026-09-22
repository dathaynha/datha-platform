"""Structured JSON logging + optional OTLP push (platform-observability).

JSON to stdout always (structlog rendering stdlib records); when
OTEL_EXPORTER_OTLP_ENDPOINT is set, records are also pushed via OTLP to the
observability stack. correlation_id rides a contextvar so every log line in a
request/job context carries the id that spans gateway -> service -> worker.
"""

from __future__ import annotations

import logging
import os
import sys
from contextvars import ContextVar

import structlog

correlation_id_var: ContextVar[str] = ContextVar("correlation_id", default="")


class _ContextFilter(logging.Filter):
    """Stamp service name + correlation_id onto every record (both handlers see it)."""

    def __init__(self, service: str) -> None:
        super().__init__()
        self._service = service

    def filter(self, record: logging.LogRecord) -> bool:
        record.service = self._service
        cid = correlation_id_var.get()
        if cid:
            record.correlation_id = cid
        return True


def configure_logging(service_name: str) -> None:
    pre_chain = [
        structlog.stdlib.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", key="timestamp"),
        structlog.stdlib.ExtraAdder(),
    ]
    formatter = structlog.stdlib.ProcessorFormatter(
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            structlog.processors.EventRenamer("msg"),
            structlog.processors.JSONRenderer(),
        ],
        foreign_pre_chain=pre_chain,
    )

    stdout_handler = logging.StreamHandler(sys.stdout)
    stdout_handler.setFormatter(formatter)
    stdout_handler.addFilter(_ContextFilter(service_name))

    root = logging.getLogger()
    root.handlers = [stdout_handler]
    root.setLevel(logging.INFO)

    # uvicorn installs its own plain-text handlers before the app imports —
    # strip them so everything funnels through the JSON root handler.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        uvicorn_logger = logging.getLogger(name)
        uvicorn_logger.handlers = []
        uvicorn_logger.propagate = True
    # our middleware logs requests with correlation_id; uvicorn access lines are noise
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)

    if not os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT"):
        return

    from opentelemetry._logs import set_logger_provider
    from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
    from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
    from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
    from opentelemetry.sdk.resources import Resource

    provider = LoggerProvider(resource=Resource.create({"service.name": service_name}))
    provider.add_log_record_processor(BatchLogRecordProcessor(OTLPLogExporter()))
    set_logger_provider(provider)

    otel_handler = LoggingHandler(level=logging.INFO, logger_provider=provider)
    otel_handler.addFilter(_ContextFilter(service_name))
    root.addHandler(otel_handler)
