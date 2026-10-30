"""A fake Telegram Bot API for the backup test: records every sendMessage call.

Each request is appended to /out/requests.jsonl ({"path": ..., "form": {...}}), and its path,
chat id and text (newlines as spaces) to /out/paths, /out/chats and /out/texts, one line per
request, for grep. Answers like Telegram ({"ok": true}). Runs in a pinned python image
(deploy/backup/test/backup-test.sh, deploy/monitoring/test/monitor-test.sh).

A Telegram that stops answering: while /out/hang holds a number N, a request arriving when
N or more messages are already recorded is held for 30 s and dropped (not recorded, no
answer), as if Telegram had gone silent.
"""

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

lock = threading.Lock()


def recorded() -> int:
    try:
        with open("/out/texts", encoding="utf-8") as texts:
            return sum(1 for _ in texts)
    except OSError:
        return 0


def hanging() -> bool:
    try:
        with open("/out/hang", encoding="utf-8") as hang:
            return recorded() >= int(hang.read().strip())
    except (OSError, ValueError):
        return False


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802 (http.server's naming)
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length).decode()
        if hanging():
            time.sleep(30)
            self.close_connection = True
            return
        form = {key: values[0] for key, values in parse_qs(body).items()}
        with lock, open("/out/requests.jsonl", "a", encoding="utf-8") as out:
            out.write(json.dumps({"path": self.path, "form": form}) + "\n")
        fields = (
            ("paths", self.path),
            ("chats", form.get("chat_id", "")),
            ("texts", form.get("text", "")),
        )
        with lock:
            for name, value in fields:
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


ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
