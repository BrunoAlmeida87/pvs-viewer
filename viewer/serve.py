"""Serve the viewer locally: python serve.py [port]  ->  http://localhost:8080"""
import http.server
import os
import sys
import webbrowser

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".json": "application/json", ".bin": "application/octet-stream"}

    def log_message(self, *args):
        pass


with http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler) as httpd:
    url = "http://localhost:%d/" % port
    print("Visualizador em", url)
    if "--no-browser" not in sys.argv:
        webbrowser.open(url)
    httpd.serve_forever()
