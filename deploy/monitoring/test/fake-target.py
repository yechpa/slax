"""A fake service for the uptime monitor's test: answers every GET with the behaviour named in
/ctl/status (read at each request): an HTTP status code ("200", "503"), "hang" (no answer for
30 s) or "close" (the connection closed without a reply). Runs in a pinned python image
(deploy/monitoring/test/monitor-test.sh).

On port 9090, a silent listener: it accepts every connection and never reads or answers. A
check against it (HTTPS, PostgreSQL, Redis) waits for its own timeout, the same way on every
host, unlike an unroutable address whose failure depends on the host's network.
"""

import socket
import threading
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


def hold_silently(port):
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("0.0.0.0", port))
    listener.listen(64)
    held = []  # kept open, never read
    while True:
        connection, _ = listener.accept()
        held.append(connection)


threading.Thread(target=hold_silently, args=(9090,), daemon=True).start()
ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
