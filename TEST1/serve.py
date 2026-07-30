#!/usr/bin/env python3
"""
Serves the benchmark folder locally with Cross-Origin-Opener-Policy and
Cross-Origin-Embedder-Policy headers set. Without these, the browser can't
use SharedArrayBuffer, which knocks WASM inference (Kokoro/onnxruntime-web)
down to a slower single-threaded path -- a real confound for this benchmark.

Usage: python3 serve.py [port]   (default port 8000)
Then open http://localhost:<port>/benchmark.html
"""
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler


class IsolatedHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = HTTPServer(("localhost", port), IsolatedHandler)
    print(f"Serving with COOP/COEP headers at http://localhost:{port}/benchmark.html")
    print("Ctrl+C to stop.")
    server.serve_forever()
