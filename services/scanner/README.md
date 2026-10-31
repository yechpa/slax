# Scanner

Upload validation service, called by the API before anything is stored. It has no
published port: only the compose network (`http://scanner:8000`) reaches it.

- `POST /scan`, multipart `file` → `{"ok": bool, "reason": str|null, "sha256": str, "detected_mime": str}`
- `GET /health` → `{"status": "ok"}`

The body is read as a stream and abandoned as soon as the file passes 10 MB, whatever
`Content-Length` says. Then:

| Check | `reason` when refused |
| --- | --- |
| empty file | `empty_file` |
| more than 10 MB | `too_large` (`sha256` and `detected_mime` empty) |
| type sniffed by libmagic outside png, jpeg, gif, webp, pdf, plain text, zip | `type_not_allowed` |
| known extension (`.png`, `.jpg`/`.jpeg`, `.gif`, `.webp`, `.pdf`, `.txt`, `.zip`) disagreeing with the sniffed type | `extension_mismatch` |
| plain text that is not UTF-8 or contains NUL bytes | `invalid_text` |
| zip: unreadable central directory / encrypted entry | `zip_corrupt` / `zip_encrypted` |
| zip: more than 1000 entries | `zip_too_many_entries` |
| zip: absolute path, drive letter, `..` component, NUL byte or symbolic link | `zip_unsafe_path` |
| zip: more than 200 MB declared uncompressed | `zip_too_large` |
| zip: more than 100:1 overall, or for any entry over 1 MB | `zip_ratio_too_high` |

An unknown or missing extension is judged on the content alone; the API then appends the
canonical extension of the detected type to the display name (`notes` → `notes.txt`).
Archives are never extracted: their declared sizes are what is checked.

Tests and lint run in the `python-tools` container (`make test`, `make lint`), built from
the `dev` stage of the same Dockerfile. Dependencies are fully pinned in `requirements*.txt`.
