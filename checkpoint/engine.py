"""Durable intent recovery for a controlled, loopback-only HTTP destination."""
from contextlib import contextmanager
from dataclasses import dataclass
import fcntl
from http.client import HTTPException
import json
import os
from pathlib import Path
import sqlite3
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit, urlunsplit
from urllib.request import ProxyHandler, Request, build_opener


class OwnershipBusy(RuntimeError):
    """Another process owns this canonical journal path right now."""


class DestinationMismatch(ValueError):
    """A journal is bound to a different destination or has unsafe legacy state."""


def canonical_destination(base_url):
    parts = urlsplit(base_url)
    if (parts.scheme != "http" or parts.hostname not in {"127.0.0.1", "localhost", "::1"}
            or parts.username is not None or parts.password is not None
            or parts.query or parts.fragment):
        raise ValueError("the fixture adapter requires a plain loopback HTTP origin")
    port = parts.port if parts.port is not None else 80
    if not 1 <= port <= 65535:
        raise ValueError("invalid fixture port")
    if parts.path not in {"", "/"}:
        raise ValueError("the fixture adapter does not support a base path")
    host = "[::1]" if parts.hostname == "::1" else parts.hostname.lower()
    return urlunsplit(("http", f"{host}:{port}", "", "", ""))


@dataclass(frozen=True)
class LookupObservation:
    kind: str
    records: tuple = ()


def valid_receipt(receipt, reference, amount):
    return (isinstance(receipt, dict) and receipt.get("reference") == reference
            and type(receipt.get("amount")) is int and receipt["amount"] == amount
            and type(receipt.get("id")) is int and receipt["id"] > 0)


class Journal:
    def __init__(self, path):
        # Symlink/path aliases resolve to one lock path. Hard-link aliases are unsupported.
        self.path = str(Path(path).resolve())
        with self.connect() as db:
            # executescript implicitly commits: never split schema creation from its
            # safety marker. SQLite DDL is transactional inside this explicit write
            # transaction, including rollback after process death.
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("BEGIN IMMEDIATE")
            db.execute("""CREATE TABLE IF NOT EXISTS intents (
                reference TEXT PRIMARY KEY, amount INTEGER NOT NULL,
                state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
                receipt TEXT, reason TEXT NOT NULL DEFAULT '',
                pending_polls INTEGER NOT NULL DEFAULT 0)""")
            db.execute("""CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY, reference TEXT, state TEXT,
                reason TEXT, timestamp REAL)""")
            db.execute("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            columns = {r[1] for r in db.execute("PRAGMA table_info(intents)")}
            if "pending_polls" not in columns:
                db.execute("ALTER TABLE intents ADD COLUMN pending_polls INTEGER NOT NULL DEFAULT 0")
            # Also detect artifacts left by an interrupted older migration, where
            # metadata already exists but no destination was ever established.
            unbound = not db.execute("SELECT 1 FROM metadata WHERE key='destination'").fetchone()
            if unbound and db.execute("SELECT 1 FROM intents LIMIT 1").fetchone():
                db.execute("INSERT OR IGNORE INTO metadata VALUES ('legacy_unbound','true')")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path)
        try:
            db.execute("PRAGMA synchronous=FULL")
            with db:
                yield db
        finally:
            db.close()

    @contextmanager
    def owned(self):
        """Nonblocking single-host ownership; the kernel releases it on process exit."""
        fd = os.open(self.path + ".lock", os.O_CREAT | os.O_RDWR | os.O_CLOEXEC, 0o600)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise OwnershipBusy("journal already has an active owner") from exc
            yield
        finally:
            os.close(fd)

    def bind_destination(self, destination):
        """Caller holds ownership. Binding cannot silently adopt a populated old journal."""
        destination = canonical_destination(destination)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM metadata WHERE key='legacy_unbound'").fetchone():
                raise DestinationMismatch("populated legacy journal has no provable destination; inspect/export it and create a new bound journal")
            db.execute("INSERT OR IGNORE INTO metadata VALUES ('destination',?)", (destination,))
            current = db.execute("SELECT value FROM metadata WHERE key='destination'").fetchone()[0]
            if current != destination:
                raise DestinationMismatch("journal is already bound to another destination")

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

    def set(self, reference, state, reason, receipt=None, attempt=False, pending_poll=False):
        with self.connect() as db:
            db.execute("UPDATE intents SET state=?, reason=?, receipt=COALESCE(?,receipt), attempts=attempts+?, pending_polls=pending_polls+? WHERE reference=?",
                       (state, reason, json.dumps(receipt) if receipt else None, int(attempt), int(pending_poll), reference))
            db.execute("INSERT INTO events(reference,state,reason,timestamp) VALUES (?,?,?,?)", (reference, state, reason, time.time()))

    def events(self, reference):
        with self.connect() as db:
            return [dict(state=r[0], reason=r[1]) for r in db.execute("SELECT state,reason FROM events WHERE reference=? ORDER BY id", (reference,))]


class HTTPMerchant:
    def __init__(self, base_url):
        self.base_url = canonical_destination(base_url)
        # Explicit fixture adapter; do not inherit ambient proxy configuration.
        self.open = build_opener(ProxyHandler({})).open

    def submit(self, reference, amount):
        request = Request(self.base_url + "/invoices", data=json.dumps(dict(reference=reference, amount=amount)).encode(), headers={"Content-Type": "application/json"}, method="POST")
        try:
            with self.open(request, timeout=3) as response:
                detail = json.load(response)
                return ("success", detail) if isinstance(detail, dict) else ("unknown", {})
        except HTTPError as error:
            try:
                detail = json.load(error)
            except (ValueError, TypeError):
                detail = {}
            if (isinstance(detail, dict) and error.code == 503
                    and detail.get("committed") is False and detail.get("retryable") is True):
                return "rejected", detail
            return "unknown", {"http_status": error.code}
        except (OSError, URLError, ValueError, HTTPException):
            return "unknown", {}

    def lookup(self, reference):
        try:
            with self.open(self.base_url + "/invoices?" + urlencode({"reference": reference}), timeout=3) as response:
                detail = json.load(response)
            if not isinstance(detail, dict) or not isinstance(detail.get("records"), list):
                return LookupObservation("invalid")
            rows = detail["records"]
            if any(not isinstance(r, dict) for r in rows) or type(detail.get("pending", False)) is not bool:
                return LookupObservation("invalid")
            # A destination-specific explicit pending signal is not a proof of absence.
            if detail.get("pending", False):
                return LookupObservation("pending", tuple(rows))
            return LookupObservation("found" if rows else "absent", tuple(rows))
        except (OSError, URLError, ValueError, KeyError, TypeError, HTTPException):
            return LookupObservation("unavailable")


class Runner:
    """One canonical journal owner per run; no distributed exactly-once guarantee."""
    def __init__(self, journal, merchant, max_pending_polls=3):
        if type(max_pending_polls) is not int or not 1 <= max_pending_polls <= 100:
            raise ValueError("max_pending_polls must be an integer in 1..100")
        self.journal, self.merchant = journal, merchant
        self.max_pending_polls = max_pending_polls

    def reconcile(self, reference):
        with self.journal.owned():
            self.journal.bind_destination(self.merchant.base_url)
            return self._reconcile(reference)

    def _reconcile(self, reference):
        intent = self.journal.get(reference)
        if intent["state"] == "verified":
            return intent
        self.journal.set(reference, "reconciling", "Looking up durable destination evidence")
        observation = self.merchant.lookup(reference)
        if not isinstance(observation, LookupObservation):
            observation = LookupObservation("invalid")
        rows = observation.records
        if observation.kind == "found" and len(rows) == 1 and valid_receipt(rows[0], reference, intent["amount"]):
            self.journal.set(reference, "verified", "One matching destination receipt", rows[0])
        elif observation.kind == "pending" and not rows:
            polls = intent["pending_polls"] + 1
            state = "pending" if polls < self.max_pending_polls else "needs_review"
            reason = ("Destination reports delayed evidence; poll later without resubmitting" if state == "pending"
                      else "Pending evidence budget exhausted; do not resubmit")
            self.journal.set(reference, state, reason, pending_poll=True)
        else:
            # An empty ordinary search, conflicting rows, or malformed data never permits retry.
            self.journal.set(reference, "needs_review", "No unique validated receipt; absence, unavailable, or conflicting evidence cannot authorize retry")
        return self.journal.get(reference)

    def run(self, reference, amount):
        with self.journal.owned():
            self.journal.bind_destination(self.merchant.base_url)
            return self._run(reference, amount)

    def _run(self, reference, amount):
        self.journal.plan(reference, amount)
        intent = self.journal.get(reference)
        if intent["state"] == "verified":
            return intent
        if intent["state"] in {"executing", "outcome_unknown", "reconciling", "needs_review", "pending"}:
            return self._reconcile(reference)
        for _ in range(2 - intent["attempts"]):
            self.journal.set(reference, "executing", "Intent committed before external submit", attempt=True)
            outcome, receipt = self.merchant.submit(reference, amount)
            if outcome == "success":
                if valid_receipt(receipt, reference, amount):
                    self.journal.set(reference, "verified", "Validated acknowledgement", receipt)
                    return self.journal.get(reference)
                self.journal.set(reference, "outcome_unknown", "Invalid acknowledgement")
                return self._reconcile(reference)
            if outcome != "rejected":
                self.journal.set(reference, "outcome_unknown", "Submit acknowledgement lost or indeterminate")
                return self._reconcile(reference)
            self.journal.set(reference, "retryable", "Destination explicitly rejected before commit")
        self.journal.set(reference, "failed", "Retry budget exhausted")
        return self.journal.get(reference)
