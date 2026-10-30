"""Single-owner execution with a durable write-ahead intent journal."""
import json
import sqlite3
import time
from http.client import HTTPException
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import ProxyHandler, Request, build_opener


class Journal:
    def __init__(self, path):
        self.path = str(path)
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS intents (
                    reference TEXT PRIMARY KEY, amount INTEGER NOT NULL,
                    state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
                    receipt TEXT, reason TEXT NOT NULL DEFAULT '');
                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY, reference TEXT, state TEXT,
                    reason TEXT, timestamp REAL);
            """)

    def connect(self):
        db = sqlite3.connect(self.path)
        db.execute("PRAGMA synchronous=FULL")
        return db

    def plan(self, reference, amount):
        if not isinstance(reference, str) or not reference or type(amount) is not int or amount <= 0:
            raise ValueError("reference and positive integer amount required")
        with self.connect() as db:
            db.execute("INSERT OR IGNORE INTO intents(reference,amount,state) VALUES (?,?,'planned')", (reference, amount))
            row = db.execute("SELECT amount FROM intents WHERE reference=?", (reference,)).fetchone()
            if row[0] != amount:
                raise ValueError("reference already belongs to a different intent")

    def get(self, reference):
        with self.connect() as db:
            db.row_factory = sqlite3.Row
            row = db.execute("SELECT * FROM intents WHERE reference=?", (reference,)).fetchone()
            if row is None:
                raise KeyError(reference)
            return dict(row)

    def set(self, reference, state, reason, receipt=None, attempt=False):
        with self.connect() as db:
            db.execute("UPDATE intents SET state=?, reason=?, receipt=COALESCE(?,receipt), attempts=attempts+? WHERE reference=?", (state, reason, json.dumps(receipt) if receipt else None, int(attempt), reference))
            db.execute("INSERT INTO events(reference,state,reason,timestamp) VALUES (?,?,?,?)", (reference, state, reason, time.time()))

    def events(self, reference):
        with self.connect() as db:
            return [dict(state=r[0], reason=r[1]) for r in db.execute("SELECT state,reason FROM events WHERE reference=? ORDER BY id", (reference,))]


class HTTPMerchant:
    def __init__(self, base_url):
        self.base_url = base_url.rstrip("/")
        # This adapter targets the localhost fixture, never ambient proxy settings.
        self.open = build_opener(ProxyHandler({})).open

    def submit(self, reference, amount):
        request = Request(self.base_url + "/invoices", data=json.dumps(dict(reference=reference, amount=amount)).encode(), headers={"Content-Type": "application/json"}, method="POST")
        try:
            with self.open(request, timeout=3) as response:
                return "success", json.load(response)
        except HTTPError as error:
            try:
                detail = json.load(error)
            except (ValueError, TypeError):
                detail = {}
            # This acknowledgement is fixture-specific, not a generic 503 guarantee.
            if error.code == 503 and detail.get("committed") is False and detail.get("retryable") is True:
                return "rejected", detail
            return "unknown", {"http_status": error.code}
        except (OSError, URLError, ValueError, HTTPException):
            return "unknown", {}

    def lookup(self, reference):
        try:
            with self.open(self.base_url + "/invoices?" + urlencode({"reference": reference}), timeout=3) as response:
                return json.load(response)["records"]
        except (OSError, URLError, ValueError, KeyError, HTTPException):
            return None


class Runner:
    """One runner per journal; concurrent owners are deliberately unsupported."""
    def __init__(self, journal, merchant):
        self.journal, self.merchant = journal, merchant

    def reconcile(self, reference):
        intent = self.journal.get(reference)
        self.journal.set(reference, "reconciling", "Looking up durable destination evidence")
        rows = self.merchant.lookup(reference)
        if rows is not None and len(rows) == 1 and rows[0].get("reference") == reference and rows[0].get("amount") == intent["amount"] and type(rows[0].get("id")) is int:
            self.journal.set(reference, "verified", "One matching destination receipt", rows[0])
        else:
            # Empty search does not establish absence: a write might still be pending.
            reason = "Outcome lookup unavailable" if rows is None else "No unique matching receipt; absence or conflict cannot authorize retry"
            self.journal.set(reference, "needs_review", reason)
        return self.journal.get(reference)

    def run(self, reference, amount):
        self.journal.plan(reference, amount)
        intent = self.journal.get(reference)
        if intent["state"] == "verified":
            return intent
        if intent["state"] in {"executing", "outcome_unknown", "reconciling", "needs_review"}:
            return self.reconcile(reference)
        for _ in range(2 - intent["attempts"]):
            self.journal.set(reference, "executing", "Intent committed before external submit", attempt=True)
            outcome, receipt = self.merchant.submit(reference, amount)
            if outcome == "success":
                if receipt.get("reference") == reference and receipt.get("amount") == amount and type(receipt.get("id")) is int:
                    self.journal.set(reference, "verified", "Validated acknowledgement", receipt)
                    return self.journal.get(reference)
                self.journal.set(reference, "outcome_unknown", "Invalid acknowledgement")
                return self.reconcile(reference)
            if outcome == "unknown":
                self.journal.set(reference, "outcome_unknown", "Submit acknowledgement lost or indeterminate")
                return self.reconcile(reference)
            self.journal.set(reference, "retryable", "Destination explicitly rejected before commit")
        self.journal.set(reference, "failed", "Retry budget exhausted")
        return self.journal.get(reference)

