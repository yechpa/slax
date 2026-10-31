"""Small, valid sample files built in memory (no binary fixtures in the repository)."""

import io
import struct
import zipfile
import zlib


def png() -> bytes:
    """A 1x1 grey PNG."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    header = struct.pack(">IIBBBBB", 1, 1, 8, 0, 0, 0, 0)
    pixels = zlib.compress(b"\x00\x80")
    return (
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", pixels) + chunk(b"IEND", b"")
    )


def jpeg() -> bytes:
    """Start of a JFIF JPEG: enough for signature sniffing."""
    app0 = b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    return b"\xff\xd8\xff\xe0" + struct.pack(">H", len(app0) + 2) + app0 + b"\xff\xd9"


def gif() -> bytes:
    return (
        b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff"
        b"!\xf9\x04\x01\x00\x00\x00\x00"
        b",\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;"
    )


def webp() -> bytes:
    """A lossless 1x1 WebP."""
    vp8l = b"\x2f\x00\x00\x00\x00\x88\x88\x08\x00"
    chunk = b"VP8L" + struct.pack("<I", len(vp8l)) + vp8l + b"\x00"
    return b"RIFF" + struct.pack("<I", 4 + len(chunk)) + b"WEBP" + chunk


def pdf() -> bytes:
    return (
        b"%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n"
        b"2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n"
        b"trailer << /Root 1 0 R >>\n%%EOF\n"
    )


def exe() -> bytes:
    """A DOS/PE executable header."""
    header = bytearray(b"MZ" + b"\x90\x00" + b"\x00" * 56 + struct.pack("<I", 64))
    return bytes(header) + b"PE\x00\x00\x4c\x01" + b"\x00" * 200


def zip_of(entries: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            archive.writestr(zipfile.ZipInfo(name), data, zipfile.ZIP_DEFLATED)
    return buffer.getvalue()


def zip_declaring(sizes: list[int]) -> bytes:
    """Tiny entries whose central directory claims the given uncompressed sizes (lying headers)."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for index, _ in enumerate(sizes):
            archive.writestr(f"part{index}.bin", b"x")
        for info, size in zip(archive.filelist, sizes, strict=True):
            info.file_size = size
    return buffer.getvalue()


def zip_flagged_encrypted() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("secret.txt", b"not really encrypted")
        archive.filelist[0].flag_bits |= 0x1
    return buffer.getvalue()
