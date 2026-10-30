"""Controlled merchant. Its internal database is an evaluation oracle only."""
import json
import socket
import sqlite3
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


class Merchant:
    def __init__(self, path, mode="observable", fault="none"):
        if mode not in {"observable", "idempotent", "opaque"}:
            raise ValueError("invalid merchant mode")
        if fault not in {"none", "before_commit", "after_commit"}:
            raise ValueError("invalid fault")
        self.path, self.mode, self.fault = str(path), mode, fault
        self.lock = threading.Lock()
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS invoices (id INTEGER PRIMARY KEY, reference TEXT, amount INTEGER)")

    def connect(self):
        return sqlite3.connect(self.path)

    def records(self):
        with self.connect() as db:
            return [dict(id=r[0], reference=r[1], amount=r[2]) for r in db.execute("SELECT id, reference, amount FROM invoices ORDER BY id")]

    def handler(self):
        merchant = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def respond(self, status, data):
                raw = json.dumps(data).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                parsed = urlparse(self.path)
                if parsed.path != "/invoices":
                    return self.respond(404, {})
                if merchant.mode == "opaque":
                    return self.respond(403, {"error": "no outcome lookup"})
                ref = parse_qs(parsed.query).get("reference", [None])[0]
                rows = [r for r in merchant.records() if r["reference"] == ref]
                self.respond(200, {"records": rows})

            def do_POST(self):
                if self.path != "/invoices":
                    return self.respond(404, {})
                try:
                    data = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                    ref, amount = data["reference"], data["amount"]
                    if not isinstance(ref, str) or not ref or type(amount) is not int or amount <= 0:
                        raise ValueError()
                except (ValueError, KeyError, TypeError):
                    return self.respond(400, {"error": "invalid invoice"})
                with merchant.lock:
                    fault, merchant.fault = merchant.fault, "none"
                    if fault == "before_commit":
                        # Explicit contractual rejection; absence is known, not inferred.
                        return self.respond(503, {"committed": False, "retryable": True})
                    with merchant.connect() as db:
                        existing = db.execute("SELECT id, reference, amount FROM invoices WHERE reference=?", (ref,)).fetchone()
                        if merchant.mode == "idempotent" and existing:
                            if existing[2] != amount:
                                return self.respond(409, {"error": "reference conflict"})
                            receipt = dict(id=existing[0], reference=existing[1], amount=existing[2])
                        else:
                            cursor = db.execute("INSERT INTO invoices(reference, amount) VALUES (?,?)", (ref, amount))
                            receipt = dict(id=cursor.lastrowid, reference=ref, amount=amount)
                    if fault == "after_commit":
                        self.close_connection = True
                        try:
                            self.connection.shutdown(socket.SHUT_RDWR)
                        except OSError:
                            pass
                        self.connection.close()
                        return
                    self.respond(201, receipt)

        return Handler


@contextmanager
def serve(merchant):
    server = ThreadingHTTPServer(("127.0.0.1", 0), merchant.handler())
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join()

