"""Serve the viewer locally.

  python serve.py [port] [--no-browser] [--model DIR]

--model DIR also serves an original Creo View folder (.pvs + .ol) under /model/,
so it can be opened with  http://localhost:8080/?pvs=model/NAME.pvs
"""
import http.server
import os
import socket
import sys
import threading
import urllib.parse
import webbrowser

args = sys.argv[1:]
port = int(args[0]) if args and args[0].isdigit() else 8080
model_dir = None
if "--model" in args:
    model_dir = os.path.abspath(args[args.index("--model") + 1])
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # keep-alive: the viewer fetches thousands of files
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".json": "application/json", ".bin": "application/octet-stream"}

    def translate_path(self, path):
        if model_dir and path.startswith("/model/"):
            name = urllib.parse.unquote(path[len("/model/"):].split("?")[0])
            return os.path.join(model_dir, os.path.basename(name))
        return super().translate_path(path)

    def end_headers(self):
        # the viewer's own files change during development: always revalidate them
        if not self.path.startswith(("/model/", "/data/")):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *args):
        pass


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True


class Server6(Server):
    address_family = socket.AF_INET6


# Loopback only, on both IPv4 and IPv6, so "localhost" never waits for an IPv6 timeout.
httpd = Server(("127.0.0.1", port), Handler)
try:
    httpd6 = Server6(("::1", port), Handler)
    threading.Thread(target=httpd6.serve_forever, daemon=True).start()
except OSError:
    httpd6 = None

url = "http://localhost:%d/" % port
print("Visualizador em", url, "(modelo: %s)" % model_dir if model_dir else "")
if "--no-browser" not in args:
    webbrowser.open(url)
try:
    httpd.serve_forever()
finally:
    httpd.server_close()
    if httpd6:
        httpd6.shutdown()
