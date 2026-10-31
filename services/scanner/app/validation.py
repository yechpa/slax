"""Content checks for an uploaded file.

The type comes from the bytes (libmagic), never from the client. A known extension must
agree with it; an unknown or missing extension is judged on the content alone (the API
then appends the canonical extension to the display name). Text must be UTF-8 without
NUL bytes; zip archives are inspected through their central directory, never extracted.
"""

import codecs
import re
import stat
import zipfile
from typing import BinaryIO

import magic

MAX_FILE_BYTES = 10 * 1024 * 1024

# Detected type -> the extensions a file of that type may carry.
ALLOWED_TYPES: dict[str, tuple[str, ...]] = {
    "image/png": ("png",),
    "image/jpeg": ("jpg", "jpeg"),
    "image/gif": ("gif",),
    "image/webp": ("webp",),
    "application/pdf": ("pdf",),
    "text/plain": ("txt",),
    "application/zip": ("zip",),
}
TYPE_OF_EXTENSION = {ext: mime for mime, exts in ALLOWED_TYPES.items() for ext in exts}

ZIP_MAX_ENTRIES = 1000
ZIP_MAX_TOTAL_BYTES = 200 * 1024 * 1024
ZIP_MAX_RATIO = 100
# Below this many uncompressed bytes an entry's ratio is not a threat (and tiny runs of
# repeated bytes compress far beyond 100:1).
ZIP_RATIO_MIN_BYTES = 1024 * 1024

_DRIVE = re.compile(r"^[A-Za-z]:")


class Rejected(Exception):
    """The file is refused; `reason` is a stable code returned to the API."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def detect_mime(path: str) -> str:
    """By path, not from a buffer: libmagic recognises zip archives by their end of file."""
    return magic.from_file(path, mime=True)


def extension_of(filename: str | None) -> str | None:
    """Lower-cased text after the last dot of the base name, if any."""
    if not filename:
        return None
    base = re.split(r"[/\\]", filename)[-1]
    _, dot, ext = base.rpartition(".")
    return ext.lower() if dot and ext else None


def check(file: BinaryIO, size: int, filename: str | None, mime: str) -> None:
    """Raises Rejected unless `file` (of `size` bytes, sniffed as `mime`) is acceptable."""
    if size == 0:
        raise Rejected("empty_file")
    if size > MAX_FILE_BYTES:
        raise Rejected("too_large")
    if mime not in ALLOWED_TYPES:
        raise Rejected("type_not_allowed")

    expected = TYPE_OF_EXTENSION.get(extension_of(filename) or "")
    if expected is not None and expected != mime:
        raise Rejected("extension_mismatch")

    if mime == "text/plain":
        _check_text(file)
    elif mime == "application/zip":
        _check_zip(file, size)


def _check_text(file: BinaryIO) -> None:
    """Valid UTF-8 without NUL bytes: no binary payload passed off as text."""
    file.seek(0)
    decoder = codecs.getincrementaldecoder("utf-8")()
    try:
        while chunk := file.read(64 * 1024):
            if b"\x00" in chunk:
                raise Rejected("invalid_text")
            decoder.decode(chunk)
        decoder.decode(b"", final=True)
    except UnicodeDecodeError as error:
        raise Rejected("invalid_text") from error


def _check_zip(file: BinaryIO, size: int) -> None:
    """Central directory only: entry count, paths, encryption, declared sizes and ratios."""
    file.seek(0)
    try:
        with zipfile.ZipFile(file) as archive:
            entries = archive.infolist()
    except (zipfile.BadZipFile, zipfile.LargeZipFile, OSError, EOFError, ValueError) as error:
        raise Rejected("zip_corrupt") from error

    if len(entries) > ZIP_MAX_ENTRIES:
        raise Rejected("zip_too_many_entries")

    total = 0
    for info in entries:
        if info.flag_bits & 0x1:
            raise Rejected("zip_encrypted")
        if _is_unsafe(info):
            raise Rejected("zip_unsafe_path")
        total += info.file_size

    if total > ZIP_MAX_TOTAL_BYTES:
        raise Rejected("zip_too_large")
    if total > ZIP_MAX_RATIO * size:
        raise Rejected("zip_ratio_too_high")
    for info in entries:
        if info.file_size > ZIP_RATIO_MIN_BYTES and info.file_size > ZIP_MAX_RATIO * max(
            info.compress_size, 1
        ):
            raise Rejected("zip_ratio_too_high")


def _is_unsafe(info: zipfile.ZipInfo) -> bool:
    """Absolute paths, drive letters, `..` components, NUL bytes and symbolic links."""
    for name in (info.orig_filename, info.filename):
        if "\x00" in name:
            return True
        path = name.replace("\\", "/")
        if path.startswith("/") or _DRIVE.match(path) or ".." in path.split("/"):
            return True
    mode = info.external_attr >> 16
    return info.create_system == 3 and stat.S_ISLNK(mode)
