import asyncio
import hashlib
import io
import json
import zipfile

import pytest
import samples
from fastapi.testclient import TestClient

from app.main import app
from app.validation import MAX_FILE_BYTES

client = TestClient(app)


def scan(data: bytes, filename: str | None = "upload.bin") -> dict:
    response = client.post("/scan", files={"file": (filename, data, "application/octet-stream")})
    assert response.status_code == 200, response.text
    return response.json()


def assert_rejected(result: dict, reason: str) -> None:
    assert result["ok"] is False
    assert result["reason"] == reason


def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_rejects_empty_file():
    result = scan(b"", "empty.txt")
    assert_rejected(result, "empty_file")
    assert result["sha256"] == hashlib.sha256(b"").hexdigest()


def test_rejects_exe_renamed_to_png():
    result = scan(samples.exe(), "holiday.png")
    assert_rejected(result, "type_not_allowed")
    assert result["detected_mime"] == "application/vnd.microsoft.portable-executable"


def test_accepts_valid_png():
    data = samples.png()
    result = scan(data, "pixel.png")
    assert result == {
        "ok": True,
        "reason": None,
        "sha256": hashlib.sha256(data).hexdigest(),
        "detected_mime": "image/png",
    }


@pytest.mark.parametrize(
    ("data", "filename", "mime"),
    [
        (samples.jpeg(), "photo.jpg", "image/jpeg"),
        (samples.jpeg(), "photo.JPEG", "image/jpeg"),
        (samples.gif(), "anim.gif", "image/gif"),
        (samples.webp(), "pic.webp", "image/webp"),
        (samples.pdf(), "doc.pdf", "application/pdf"),
        ("שלום עולם\n".encode(), "notes.txt", "text/plain"),
        (samples.zip_of({"a/readme.txt": b"hello world"}), "bundle.zip", "application/zip"),
    ],
)
def test_accepts_allowed_types(data, filename, mime):
    result = scan(data, filename)
    assert result["ok"] is True, result
    assert result["detected_mime"] == mime


def test_returns_the_sha256_of_the_whole_content():
    data = b"line\n" * 300_000  # 1.5 MB: spans several upload chunks
    result = scan(data, "big.txt")
    assert result["ok"] is True
    assert result["sha256"] == hashlib.sha256(data).hexdigest()


def test_rejects_over_10mb():
    exactly_10mb = b"line\n" * (MAX_FILE_BYTES // 5)
    assert len(exactly_10mb) == MAX_FILE_BYTES
    assert scan(exactly_10mb, "limit.txt")["ok"] is True
    assert_rejected(scan(exactly_10mb + b"x", "big.txt"), "too_large")


def test_size_is_enforced_while_streaming_whatever_content_length_says():
    """Drives the ASGI app directly: TestClient would buffer the whole body first."""
    mib = b"a" * (1024 * 1024)
    chunks = [
        b'--b\r\nContent-Disposition: form-data; name="file"; filename="x.txt"\r\n\r\n',
        *[mib] * 100,  # 100 MB offered
        b"\r\n--b--\r\n",
    ]
    consumed = 0
    sent = []

    async def receive():
        nonlocal consumed
        if consumed == len(chunks):
            return {"type": "http.disconnect"}
        consumed += 1
        return {
            "type": "http.request",
            "body": chunks[consumed - 1],
            "more_body": consumed < len(chunks),
        }

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/scan",
        "raw_path": b"/scan",
        "query_string": b"",
        "root_path": "",
        "client": ("127.0.0.1", 1234),
        "server": ("scanner", 8000),
        # A lying length: the limit is enforced on the bytes actually received.
        "headers": [
            (b"content-type", b"multipart/form-data; boundary=b"),
            (b"content-length", b"1000"),
        ],
    }
    asyncio.run(app(scope, receive, send))

    assert sent[0]["status"] == 200
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    assert_rejected(json.loads(body), "too_large")
    assert consumed <= 12  # stopped reading just past the limit


@pytest.mark.parametrize(
    ("data", "filename"),
    [
        (samples.jpeg(), "photo.png"),
        (samples.png(), "pixel.jpg"),
        (samples.png(), "pixel.txt"),
        (samples.pdf(), "doc.zip"),
        (b"plain words\n", "notes.pdf"),
    ],
)
def test_rejects_extension_mismatch(data, filename):
    assert_rejected(scan(data, filename), "extension_mismatch")


@pytest.mark.parametrize("filename", ["pixel", None, "pixel.unknownext", "PIXEL.exe"])
def test_unknown_or_missing_extension_is_judged_on_content(filename):
    assert scan(samples.png(), filename)["ok"] is True
    assert_rejected(scan(samples.exe(), filename), "type_not_allowed")


def test_rejects_binary_in_txt():
    assert scan(b"\x00\x01\x02\xff\xfe" * 100, "data.txt")["ok"] is False


def test_rejects_text_that_is_not_utf8():
    assert_rejected(
        scan("café au lait, déjà vu\n".encode("latin-1") * 20, "notes.txt"), "invalid_text"
    )


def test_rejects_script_disguised_as_text():
    result = scan(b"#!/bin/sh\nrm -rf / --no-preserve-root\n", "notes.txt")
    assert_rejected(result, "type_not_allowed")


@pytest.mark.parametrize(
    "name", ["../evil.txt", "a/../../evil.txt", "/etc/cron.d/x", "C:/x.txt", "..\\evil.txt"]
)
def test_rejects_traversal_zip(name):
    assert_rejected(scan(samples.zip_of({name: b"x"}), "bundle.zip"), "zip_unsafe_path")


def test_rejects_zip_with_symlink():
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        link = zipfile.ZipInfo("link")
        link.create_system = 3
        link.external_attr = 0o120777 << 16
        archive.writestr(link, "/etc/passwd")
    assert_rejected(scan(buffer.getvalue(), "bundle.zip"), "zip_unsafe_path")


def test_rejects_zip_bomb_by_compression_ratio():
    bomb = samples.zip_of({"zeros.bin": b"\x00" * (5 * 1024 * 1024)})
    assert len(bomb) < 50_000
    assert_rejected(scan(bomb, "bomb.zip"), "zip_ratio_too_high")


def test_rejects_zip_declaring_over_200mb():
    sizes = [70 * 1024 * 1024] * 3
    assert_rejected(scan(samples.zip_declaring(sizes), "bomb.zip"), "zip_too_large")


def test_rejects_zip_with_too_many_entries():
    archive = samples.zip_of({f"f{i}.txt": b"" for i in range(1001)})
    assert_rejected(scan(archive, "many.zip"), "zip_too_many_entries")
    assert scan(samples.zip_of({f"f{i}.txt": b"" for i in range(1000)}), "ok.zip")["ok"] is True


def test_rejects_encrypted_zip():
    assert_rejected(scan(samples.zip_flagged_encrypted(), "secret.zip"), "zip_encrypted")


def test_rejects_corrupt_zip():
    result = scan(b"PK\x03\x04" + b"\x14\x00" + b"garbage" * 50, "broken.zip")
    assert result["ok"] is False
    assert result["reason"] in {"zip_corrupt", "type_not_allowed"}


def test_rejects_types_outside_the_list():
    assert_rejected(
        scan(b"<!DOCTYPE html><html><script>alert(1)</script></html>", "x.html"), "type_not_allowed"
    )
    svg = b'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>'
    assert_rejected(scan(svg, "x.svg"), "type_not_allowed")


def test_missing_file_part_is_a_bad_request():
    response = client.post("/scan", data={"other": "x"}, files={"note": ("a.txt", b"x")})
    assert response.status_code == 400


def test_non_multipart_body_is_a_bad_request():
    response = client.post(
        "/scan", content=b"raw", headers={"Content-Type": "application/octet-stream"}
    )
    assert response.status_code == 400


def test_api_docs_are_not_exposed():
    assert client.get("/docs").status_code == 404
    assert client.get("/openapi.json").status_code == 404
