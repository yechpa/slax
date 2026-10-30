"""A fake service for the uptime monitor's test: answers every GET with the behaviour named in
/ctl/status (read at each request): an HTTP status code ("200", "503"), "hang" (no answer for
30 s) or "close" (the connection closed without a reply). Runs in a pinned python image
(deploy/monitoring/test/monitor-test.sh).
"""

import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 (http.server's naming)
        try:
            with open("/ctl/status", encoding="utf-8") as ctl:
                behaviour = ctl.read().strip() or "200"
        except OSError:
            behaviour = "200"
        if behaviour == "hang":
            time.sleep(30)
            return
        if behaviour == "close":
            self.close_connection = True
            return
        body = b'{"status":"ok"}' if behaviour.startswith("2") else b'{"status":"error"}'
        self.send_response(int(behaviour))
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
