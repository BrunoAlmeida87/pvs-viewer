"""Serve the viewer locally.

  python serve.py [port] [--no-browser] [--model DIR] [--host ADDRESS]

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
host = args[args.index("--host") + 1] if "--host" in args else "127.0.0.1"
model_dir = None
if "--model" in args:
    model_dir = os.path.abspath(args[args.index("--model") + 1])
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # keep-alive: the viewer fetches thousands of files
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".json": "application/json", ".bin": "application/octet-stream",
                      ".webmanifest": "application/manifest+json"}

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


# By default use loopback on both IPv4 and IPv6; --host can expose it to the local network.
httpd = Server((host, port), Handler)
httpd6 = None
if host == "127.0.0.1":
    try:
        httpd6 = Server6(("::1", port), Handler)
        threading.Thread(target=httpd6.serve_forever, daemon=True).start()
    except OSError:
        pass

url = "http://%s:%d/" % ("localhost" if host == "127.0.0.1" else host, port)
print("Visualizador em", url, "(modelo: %s)" % model_dir if model_dir else "")
if "--no-browser" not in args:
    webbrowser.open(url)
try:
    httpd.serve_forever()
finally:
    httpd.server_close()
    if httpd6:
        httpd6.shutdown()
