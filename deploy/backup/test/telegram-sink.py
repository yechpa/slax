"""A fake Telegram Bot API for the backup test: records every sendMessage call.

Each request is appended to /out/requests.jsonl ({"path": ..., "form": {...}}), and its path,
chat id and text (newlines as spaces) to /out/paths, /out/chats and /out/texts, one line per
request, for grep. Answers like Telegram ({"ok": true}). Runs in a pinned python image
(deploy/backup/test/backup-test.sh).
"""

import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802 (http.server's naming)
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length).decode()
        form = {key: values[0] for key, values in parse_qs(body).items()}
        with open("/out/requests.jsonl", "a", encoding="utf-8") as out:
            out.write(json.dumps({"path": self.path, "form": form}) + "\n")
        for name, value in (("paths", self.path), ("chats", form.get("chat_id", "")), ("texts", form.get("text", ""))):
            with open(f"/out/{name}", "a", encoding="utf-8") as out:
                out.write(value.replace("\n", " ") + "\n")
        reply = b'{"ok":true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(reply)))
        self.end_headers()
        self.wfile.write(reply)

    def log_message(self, *args):
        pass


HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
