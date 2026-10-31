"""Controlled merchant and browser-facing portal; database access is evaluation-only."""
import json
import math
import socket
import sqlite3
import threading
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


PORTAL_HTML = '''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Checkpoint Invoice Lab</title>
<style>body{font:16px system-ui;max-width:760px;margin:3rem auto;padding:0 1rem;background:#f5f7fb;color:#17233a}form,section{background:white;padding:1.3rem;border-radius:12px;margin:1rem 0}label{display:block;margin:.6rem 0}input,button{font:inherit;padding:.5rem}button{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere}small{display:block}</style>
<h1>Checkpoint Invoice Lab</h1><p>A controlled local merchant. Invoices and amounts are fictional. A missing acknowledgement is an unknown outcome.</p>
<form id="invoice-form"><label>Reference <input id="reference" name="reference" required maxlength="128"></label><label>Amount (minor units) <input id="amount" name="amount" type="number" min="1" step="1" required></label><button type="submit">Create fictional invoice</button><button type="button" id="check-outcome">Check outcome</button><small>After an uncertain submission, check the same reference before considering another action. This portal does not run the recovery journal.</small></form>
<section aria-live="polite"><h2>Submission and evidence</h2><pre id="outcome">No action yet.</pre></section><section><h2>Visible destination state</h2><button id="refresh-state">Refresh visible state</button><pre id="state"></pre></section>
<script>
const show=(id,value)=>document.getElementById(id).textContent=typeof value==='string'?value:JSON.stringify(value,null,2);
async function refresh(){try{const r=await fetch('/state');show('state',await r.json());}catch{show('state','Destination state unavailable.');}}
document.getElementById('invoice-form').addEventListener('submit',async event=>{event.preventDefault();const reference=document.getElementById('reference').value;const amount=Number(document.getElementById('amount').value);if(!Number.isSafeInteger(amount)||amount<=0){show('outcome','Enter a positive safe integer amount.');return;}try{const r=await fetch('/invoices',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reference,amount})});show('outcome',{http_status:r.status,evidence:await r.json()});}catch{show('outcome','Acknowledgement missing. Outcome unknown. Check the reference; do not blindly submit again.');}await refresh();});
document.getElementById('check-outcome').addEventListener('click',async()=>{try{const r=await fetch('/invoices?reference='+encodeURIComponent(document.getElementById('reference').value));show('outcome',{http_status:r.status,evidence:await r.json()});}catch{show('outcome','Lookup unavailable; outcome remains unknown.');}});
document.getElementById('refresh-state').addEventListener('click',refresh);refresh();
</script></html>'''


class Merchant:
    def __init__(self, path, mode="observable", fault="none", visibility_delay=0, clock=time.time):
        if mode not in {"observable", "idempotent", "opaque"}:
            raise ValueError("invalid merchant mode")
        if fault not in {"none", "before_commit", "after_commit"}:
            raise ValueError("invalid fault")
        if isinstance(visibility_delay, bool) or not isinstance(visibility_delay, (int, float)) or not math.isfinite(visibility_delay) or not 0 <= visibility_delay <= 3600:
            raise ValueError("visibility_delay must be finite and in 0..3600 seconds")
        self.path, self.mode, self.fault = str(path), mode, fault
        self.visibility_delay, self.clock = visibility_delay, clock
        self.lock = threading.Lock()
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS invoices (id INTEGER PRIMARY KEY, reference TEXT, amount INTEGER, visible_after REAL NOT NULL DEFAULT 0)")
            if "visible_after" not in {r[1] for r in db.execute("PRAGMA table_info(invoices)")}:
                db.execute("ALTER TABLE invoices ADD COLUMN visible_after REAL NOT NULL DEFAULT 0")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path)
        try:
            with db:
                yield db
        finally:
            db.close()

    def records(self):
        with self.connect() as db:
            return [dict(id=r[0], reference=r[1], amount=r[2]) for r in db.execute("SELECT id, reference, amount FROM invoices ORDER BY id")]

    def observation(self, reference=None):
        with self.connect() as db:
            rows = db.execute("SELECT id,reference,amount,visible_after FROM invoices ORDER BY id").fetchall()
        selected = [r for r in rows if reference is None or r[1] == reference]
        now = self.clock()
        return {"records": [dict(id=r[0], reference=r[1], amount=r[2]) for r in selected if r[3] <= now],
                "pending": any(r[3] > now for r in selected)}

    def handler(self):
        merchant = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def respond(self, status, data, content_type="application/json"):
                raw = data.encode() if isinstance(data, str) else json.dumps(data).encode()
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(raw)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                parsed = urlparse(self.path)
                if parsed.path == "/":
                    return self.respond(200, PORTAL_HTML, "text/html; charset=utf-8")
                if parsed.path == "/state":
                    if merchant.mode == "opaque":
                        return self.respond(200, {"mode": "opaque", "records": None, "notice": "No outcome lookup capability"})
                    return self.respond(200, dict(mode=merchant.mode, **merchant.observation()))
                if parsed.path != "/invoices":
                    return self.respond(404, {})
                if merchant.mode == "opaque":
                    return self.respond(403, {"error": "no outcome lookup"})
                ref = parse_qs(parsed.query).get("reference", [None])[0]
                if not ref:
                    return self.respond(400, {"error": "reference required"})
                self.respond(200, merchant.observation(ref))

            def do_POST(self):
                if self.path != "/invoices":
                    return self.respond(404, {})
                if self.headers.get("Content-Type", "").split(";", 1)[0].strip() != "application/json":
                    return self.respond(415, {"error": "application/json required"})
                try:
                    length = int(self.headers.get("Content-Length", 0))
                    if not 0 < length <= 16384:
                        raise ValueError()
                    data = json.loads(self.rfile.read(length))
                    if not isinstance(data, dict):
                        raise ValueError()
                    ref, amount = data["reference"], data["amount"]
                    if not isinstance(ref, str) or not ref or len(ref) > 128 or type(amount) is not int or not 0 < amount <= 2**53-1:
                        raise ValueError()
                    # JSON accepts escaped lone surrogates; SQLite requires valid
                    # UTF-8 strings. Reject these before acquiring destination state.
                    ref.encode("utf-8", errors="strict")
                except (ValueError, KeyError, TypeError):
                    return self.respond(400, {"error": "invalid invoice"})
                with merchant.lock:
                    fault, merchant.fault = merchant.fault, "none"
                    if fault == "before_commit":
                        return self.respond(503, {"committed": False, "retryable": True})
                    with merchant.connect() as db:
                        existing = db.execute("SELECT id, reference, amount FROM invoices WHERE reference=?", (ref,)).fetchone()
                        if merchant.mode == "idempotent" and existing:
                            if existing[2] != amount:
                                return self.respond(409, {"error": "reference conflict"})
                            receipt = dict(id=existing[0], reference=existing[1], amount=existing[2])
                        else:
                            cursor = db.execute("INSERT INTO invoices(reference, amount, visible_after) VALUES (?,?,?)", (ref, amount, merchant.clock()+merchant.visibility_delay))
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
def serve(merchant, port=0):
    server = ThreadingHTTPServer(("127.0.0.1", port), merchant.handler())
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
