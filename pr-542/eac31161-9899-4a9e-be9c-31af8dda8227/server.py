# A stand-in for the packed CodeDen server (Linux side of the probe), answering the URLs the CI
# step checks.
#   "/"         the published build's index.html (5,640 bytes, 80 lines, <title> line ends at
#               byte 849), sent in one piece as the real server usually does.
#   "/?slow"    the same page with the rest sent 50 ms after the first 4,500 bytes (a slow chunk).
#   "/api/automations/templates"         ~18 KB of single-line JSON (what Hono's c.json sends).
#   "/api/automations/templates?pretty"  the same JSON with line breaks, the rest 50 ms later.
import json, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

port = int(sys.argv[1]) if len(sys.argv) > 1 else 4791
page = open("index.html", "rb").read()
ids = ["dependency-updates", "issue-triage", "refactor-sweep", "security-audit", "stale-pr-follow-up", "test-coverage", "ui-review"]
data = [{"id": i, "prompt": "p" * 2500} for i in ids]
flat = json.dumps(data).encode()
pretty = json.dumps(data, indent=2).encode()

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *args):
        pass
    def send(self, body, ctype, cut=None):
        self.send_response(200); self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body))); self.send_header("connection", "close")
        self.end_headers()
        try:
            if cut is None:
                self.wfile.write(body)
            else:
                self.wfile.write(body[:cut]); self.wfile.flush()
                time.sleep(0.05)
                self.wfile.write(body[cut:])
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
    def do_GET(self):
        if self.path == "/":
            self.send(page, "text/html")
        elif self.path == "/?slow":
            self.send(page, "text/html", 4500)
        elif self.path == "/api/automations/templates":
            self.send(flat, "application/json", flat.index(b"security-audit") + 2000)
        elif self.path == "/api/automations/templates?pretty":
            self.send(pretty, "application/json", pretty.index(b"security-audit") + 2000)
        else:
            self.send_response(404); self.send_header("content-length", "0"); self.end_headers()

ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
