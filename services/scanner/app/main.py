"""Slax upload scanner: `POST /scan` (multipart `file`) and `GET /health`.

Reachable only on the internal network, from the API. The body is read as a stream and
reading stops as soon as the file exceeds the size limit, whatever Content-Length claims.
"""

import hashlib
import tempfile
from typing import IO

from fastapi import FastAPI, HTTPException, Request
from python_multipart.exceptions import MultipartParseError
from python_multipart.multipart import MultipartParser, parse_options_header
from starlette.concurrency import run_in_threadpool

from app.validation import MAX_FILE_BYTES, Rejected, check, detect_mime

# Room for the multipart framing around the file (and a few small extra fields).
MAX_BODY_BYTES = MAX_FILE_BYTES + 64 * 1024

app = FastAPI(title="slax-scanner", docs_url=None, redoc_url=None, openapi_url=None)


class Upload:
    """Collects the `file` part of a multipart body: size, SHA-256 and a temporary copy."""

    def __init__(self) -> None:
        self.found = False
        self.filename: str | None = None
        self.size = 0
        self.too_large = False
        self.sha256 = hashlib.sha256()
        # A real file (on the container's /tmp tmpfs): libmagic sniffs it by path.
        self.spool: IO[bytes] = tempfile.NamedTemporaryFile(prefix="scan-")
        self._headers: dict[bytes, bytes] = {}
        self._field = b""
        self._value = b""
        self._in_file = False

    def callbacks(self) -> dict:
        return {
            "on_part_begin": self._part_begin,
            "on_header_field": self._header_field,
            "on_header_value": self._header_value,
            "on_header_end": self._header_end,
            "on_headers_finished": self._headers_finished,
            "on_part_data": self._part_data,
            "on_part_end": self._part_end,
        }

    def _part_begin(self) -> None:
        self._headers = {}
        self._in_file = False

    def _header_field(self, data: bytes, start: int, end: int) -> None:
        self._field += data[start:end]

    def _header_value(self, data: bytes, start: int, end: int) -> None:
        self._value += data[start:end]

    def _header_end(self) -> None:
        self._headers[self._field.lower()] = self._value
        self._field = self._value = b""

    def _headers_finished(self) -> None:
        _, options = parse_options_header(self._headers.get(b"content-disposition", b""))
        if options.get(b"name") == b"file" and not self.found:
            self.found = self._in_file = True
            raw = options.get(b"filename")
            self.filename = raw.decode("utf-8", "replace") if raw is not None else None

    def _part_data(self, data: bytes, start: int, end: int) -> None:
        if not self._in_file or self.too_large:
            return
        chunk = data[start:end]
        self.size += len(chunk)
        if self.size > MAX_FILE_BYTES:
            self.too_large = True
            return
        self.sha256.update(chunk)
        self.spool.write(chunk)

    def _part_end(self) -> None:
        self._in_file = False


async def receive_upload(request: Request) -> Upload:
    content_type, options = parse_options_header(request.headers.get("content-type", ""))
    boundary = options.get(b"boundary")
    if content_type != b"multipart/form-data" or not boundary:
        raise HTTPException(400, "Expected multipart/form-data with a `file` part.")

    upload = Upload()
    parser = MultipartParser(boundary, upload.callbacks())
    received = 0
    try:
        async for chunk in request.stream():
            received += len(chunk)
            if received > MAX_BODY_BYTES:
                upload.too_large = True
            if upload.too_large:
                break
            parser.write(chunk)
        else:
            parser.finalize()
    except MultipartParseError as error:
        raise HTTPException(400, "Malformed multipart body.") from error

    if not upload.found and not upload.too_large:
        raise HTTPException(400, "Missing `file` part.")
    return upload


def result(ok: bool, reason: str | None, sha256: str, detected_mime: str) -> dict:
    return {"ok": ok, "reason": reason, "sha256": sha256, "detected_mime": detected_mime}


def inspect_upload(upload: Upload) -> dict:
    sha256 = upload.sha256.hexdigest()
    upload.spool.flush()
    mime = detect_mime(upload.spool.name)
    try:
        check(upload.spool, upload.size, upload.filename, mime)
    except Rejected as rejection:
        return result(False, rejection.reason, sha256, mime)
    return result(True, None, sha256, mime)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/scan")
async def scan(request: Request) -> dict:
    upload = await receive_upload(request)
    with upload.spool:
        if upload.too_large:
            return result(False, "too_large", "", "")
        # libmagic and the archive checks block: keep them off the event loop.
        return await run_in_threadpool(inspect_upload, upload)
