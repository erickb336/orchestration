# The Python fixture's tiny page (unit E2): the preview serves it on PORT, on the container's loopback only, with
# pytest, the dependency the prepare phase installed from PyPI. Without the dependency it would not start.
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

PAGE = f"""<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Python fixture</title></head>
  <body style="font: 28px system-ui, sans-serif; padding: 48px; background: #eef3f8; color: #14202b">
    <h1>Python fixture</h1>
    <p>pytest <strong>{pytest.__version__}</strong> imported with no network; 2 + 3 = {2 + 3}.</p>
  </body>
</html>""".encode()


class Page(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(PAGE)

    def log_message(self, *args):
        pass


port = int(os.environ["PORT"])
print(f"serving on 127.0.0.1:{port}", flush=True)
HTTPServer(("127.0.0.1", port), Page).serve_forever()
