"""Synchronous HTTP client for the internal file-service API.

Used exclusively by the worker process, which is synchronous. The worker calls
get_inline_data() for each file attachment before building the Gemini request.

Auth: file-service's download-url endpoint requires X-Owner-ID (the gateway-
injected identity header), not a Bearer JWT. The worker reads owner_id directly
from the job payload, which the router writes there from the validated X-Owner-ID.
"""

from __future__ import annotations

import base64
import logging

import httpx

_MAX_FILE_BYTES = (
    20 * 1024 * 1024
)  # Product cap for chat attachments (aligned with file-service)

logger = logging.getLogger(__name__)


def list_files_for_owner(
    *,
    owner_id: str,
    correlation_id: str,
    file_service_url: str,
    limit: int = 100,
    origin: str | None = None,
) -> list[dict]:
    """Paginate GET /internal/files (X-Owner-ID) — used by orphan reconcile."""
    base = file_service_url.rstrip("/")
    out: list[dict] = []
    offset = 0
    with httpx.Client(timeout=30.0) as client:
        while True:
            params: dict[str, str | int] = {"limit": limit, "offset": offset}
            if origin:
                params["origin"] = origin
            resp = client.get(
                f"{base}/internal/files",
                params=params,
                headers={
                    "X-Owner-ID": owner_id,
                    "X-Correlation-ID": correlation_id,
                },
            )
            if resp.status_code != 200:
                raise RuntimeError(
                    f"file-service list returned HTTP {resp.status_code} for owner {owner_id}"
                )
            body = resp.json()
            batch = body.get("data") or []
            out.extend(batch)
            total = int(body.get("total") or 0)
            offset += len(batch)
            if offset >= total or not batch:
                break
    return out


def get_download_url(
    *,
    file_id: str,
    owner_id: str,
    correlation_id: str,
    file_service_url: str,
) -> str:
    """Fetch a fresh SAS download URL from file-service for the given file_id.

    Raises RuntimeError if the request fails or the file is not accessible.
    """
    url = f"{file_service_url.rstrip('/')}/files/{file_id}/download-url"
    with httpx.Client(timeout=15.0) as client:
        resp = client.get(
            url,
            headers={
                "X-Owner-ID": owner_id,
                "X-Correlation-ID": correlation_id,
            },
        )
    if resp.status_code == 404:
        raise RuntimeError(f"file {file_id} not found in file-service")
    if resp.status_code != 200:
        raise RuntimeError(
            f"file-service returned HTTP {resp.status_code} for file {file_id}"
        )
    data = resp.json()
    sas_url: str = data.get("sasDownloadUrl") or data.get("sas_download_url") or ""
    if not sas_url:
        raise RuntimeError(
            f"file-service response missing sasDownloadUrl for file {file_id}"
        )
    return sas_url


def build_inline_data(
    *,
    file_id: str,
    mime_type: str | None,
    owner_id: str,
    correlation_id: str,
    file_service_url: str,
) -> dict | None:
    """Download file bytes and return fields for a Gemini REST `Part.inline_data` blob.

    Returns dict with snake_case keys ``mime_type`` and ``data`` (base64), to be wrapped as::

        {"inline_data": {"mime_type": ..., "data": ...}}

    Google's ``streamGenerateContent`` / ``generateContent`` JSON expects ``inline_data`` /
    ``mime_type`` in REST examples — not ``inlineData`` / ``mimeType``.

    Returns None and logs a warning if the file cannot be fetched or is too large.
    The caller should skip None entries rather than failing the whole job.
    """
    try:
        sas_url = get_download_url(
            file_id=file_id,
            owner_id=owner_id,
            correlation_id=correlation_id,
            file_service_url=file_service_url,
        )
    except RuntimeError as exc:
        logger.warning("skipping file %s: %s", file_id, exc)
        return None

    try:
        with httpx.Client(timeout=60.0) as client:
            resp = client.get(sas_url)
        if resp.status_code != 200:
            logger.warning(
                "skipping file %s: blob returned HTTP %s", file_id, resp.status_code
            )
            return None

        if len(resp.content) > _MAX_FILE_BYTES:
            logger.warning(
                "skipping file %s: size %d bytes exceeds %d MB attachment limit",
                file_id,
                len(resp.content),
                _MAX_FILE_BYTES // (1024 * 1024),
            )
            return None

        effective_mime = (
            mime_type or resp.headers.get("Content-Type") or "application/octet-stream"
        )
        return {
            "mime_type": effective_mime.split(";")[0].strip(),
            "data": base64.b64encode(resp.content).decode("ascii"),
        }
    except Exception as exc:  # noqa: BLE001
        logger.warning("skipping file %s: download failed: %s", file_id, exc)
        return None
