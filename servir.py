"""Servidor local para probar la app en la PC, con los tipos MIME correctos (módulos JS, wasm, manifest).

    python servir.py            # sirve esta carpeta en http://127.0.0.1:8123
"""
import functools, http.server, sys
class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".mjs": "text/javascript", ".js": "text/javascript",
                      ".wasm": "application/wasm", ".webmanifest": "application/manifest+json", ".onnx": "application/octet-stream",
                      ".json": "application/json", ".css": "text/css", ".png": "image/png"}
    def log_message(self, *a): pass
carpeta = sys.argv[1] if len(sys.argv) > 1 else "."
puerto = int(sys.argv[2]) if len(sys.argv) > 2 else 8123
print(f"http://127.0.0.1:{puerto}")
http.server.ThreadingHTTPServer(("127.0.0.1", puerto), functools.partial(H, directory=carpeta)).serve_forever()
