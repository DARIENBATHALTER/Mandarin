#!/usr/bin/env python3
"""Static server for the web build. Range requests and correct MIME for .bin/.wasm."""
import http.server, os, socketserver, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".bin": "application/octet-stream",
                      ".wasm": "application/wasm",
                      ".mjs": "text/javascript",
                      ".js": "text/javascript"}

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "404" in (args[1] if len(args) > 1 else ""):
            sys.stderr.write("404 %s\n" % (args[0],))


def already_serving(port):
    """Is something on this port, and is it us?"""
    import urllib.request
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/world/meta.json", timeout=1.5) as r:
            return r.status == 200 and b'"Mandarin"' in r.read(400)
    except Exception:
        return False


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8099
    socketserver.TCPServer.allow_reuse_address = True
    for attempt in range(12):
        try:
            httpd = socketserver.TCPServer(("127.0.0.1", port), Handler)
        except OSError as e:
            if e.errno not in (48, 98):          # not "address in use"
                raise
            # A stale copy of this server left running is the usual cause, and a
            # bare traceback here reads as "the app is broken" rather than
            # "something is already on the port".
            if already_serving(port):
                print(f"Mandarin is already being served at http://127.0.0.1:{port}/")
                print(f"Nothing to do. To restart it: kill $(lsof -t -iTCP:{port} -sTCP:LISTEN)")
                return 0
            print(f"port {port} is busy and it is not Mandarin, trying {port + 1}")
            port += 1
            continue
        with httpd:
            print(f"Mandarin serving http://127.0.0.1:{port}/")
            httpd.serve_forever()
        return 0
    print("could not find a free port", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
