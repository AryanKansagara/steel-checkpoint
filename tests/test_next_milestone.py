import json
import multiprocessing
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener
from http.server import BaseHTTPRequestHandler

from checkpoint.engine import (DestinationMismatch, HTTPMerchant, Journal,
                               LookupObservation, OwnershipBusy, Runner)
from checkpoint.fixture import Merchant, serve


def own_until_released(path, ready, release):
    with Journal(path).owned():
        ready.set()
        release.wait(10)


def own_then_crash(path, ready, crash):
    with Journal(path).owned():
        ready.set()
        crash.wait(10)
        os._exit(23)


def crash_during_migration(path):
    connect = sqlite3.connect

    def traced_connect(*args, **kwargs):
        db = connect(*args, **kwargs)

        def trace(statement):
            if "INSERT OR IGNORE INTO metadata VALUES ('legacy_unbound'" in statement:
                os._exit(29)
        db.set_trace_callback(trace)
        return db

    with patch('checkpoint.engine.sqlite3.connect', traced_connect):
        Journal(path)


class FakeClock:
    def __init__(self):
        self.value = 1000.0

    def __call__(self):
        return self.value


class PayloadMerchant:
    """Malformed upstream shapes, not malformed client requests."""
    def __init__(self, post, get, status=200):
        self.post, self.get, self.status = post, get, status

    def handler(self):
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def reply(self, value, status):
                raw = json.dumps(value).encode()
                self.send_response(status)
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                self.reply(outer.get, 200)

            def do_POST(self):
                self.reply(outer.post, outer.status)
        return Handler


class NextMilestoneTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.open = build_opener(ProxyHandler({})).open

    def tearDown(self):
        self.temp.cleanup()

    def test_immutable_destination_blocks_other_destination_before_any_action(self):
        journal = Journal(self.root/'journal.sqlite')
        first, other = Merchant(self.root/'one.sqlite'), Merchant(self.root/'two.sqlite')
        with serve(first) as one, serve(other) as two:
            self.assertEqual(Runner(journal, HTTPMerchant(one+'/')).run('same', 10)['state'], 'verified')
            with self.assertRaises(DestinationMismatch):
                Runner(Journal(journal.path), HTTPMerchant(two)).run('same', 10)
            self.assertEqual(other.records(), [])
            self.assertEqual(journal.get('same')['attempts'], 1)

    def test_verified_evidence_is_terminal_even_when_later_lookup_is_unavailable(self):
        merchant = Merchant(self.root/'merchant.sqlite')
        with serve(merchant) as url:
            runner = Runner(Journal(self.root/'journal.sqlite'), HTTPMerchant(url))
            self.assertEqual(runner.run('one', 10)['state'], 'verified')
            merchant.mode = 'opaque'
            self.assertEqual(runner.reconcile('one')['state'], 'verified')
            self.assertEqual(len(merchant.records()), 1)

    def test_populated_legacy_journal_requires_explicit_inspection(self):
        path = self.root/'legacy.sqlite'
        with sqlite3.connect(path) as db:
            db.execute("CREATE TABLE intents(reference TEXT PRIMARY KEY, amount INTEGER, state TEXT, attempts INTEGER DEFAULT 0, receipt TEXT, reason TEXT DEFAULT '')")
            db.execute("INSERT INTO intents(reference,amount,state) VALUES ('old',10,'executing')")
        journal = Journal(path)
        with serve(Merchant(self.root/'destination.sqlite')) as url:
            with self.assertRaises(DestinationMismatch):
                Runner(journal, HTTPMerchant(url)).run('old', 10)

    def test_process_death_during_migration_rolls_back_schema_and_still_blocks_adoption(self):
        path = self.root/'interrupted.sqlite'
        with sqlite3.connect(path) as db:
            db.execute("CREATE TABLE intents(reference TEXT PRIMARY KEY, amount INTEGER, state TEXT, attempts INTEGER DEFAULT 0, receipt TEXT, reason TEXT DEFAULT '')")
            db.execute("INSERT INTO intents(reference,amount,state) VALUES ('old',10,'verified')")
        child = multiprocessing.get_context('spawn').Process(target=crash_during_migration, args=(str(path),))
        child.start()
        child.join(5)
        if child.is_alive():
            child.terminate()
            child.join(5)
            self.fail('migration child did not terminate')
        self.assertEqual(child.exitcode, 29)
        with sqlite3.connect(path) as db:
            self.assertFalse(db.execute("SELECT 1 FROM sqlite_master WHERE name='metadata'").fetchone())
            self.assertNotIn('pending_polls', {r[1] for r in db.execute('PRAGMA table_info(intents)')})
        journal = Journal(path)
        with self.assertRaises(DestinationMismatch):
            with journal.owned():
                journal.bind_destination('http://127.0.0.1:8765')
        self.assertEqual(journal.get('old')['state'], 'verified')

    def test_previous_partial_migration_cannot_adopt_populated_unbound_journal(self):
        path = self.root/'partial.sqlite'
        journal = Journal(path)
        journal.plan('old', 10)
        journal.set('old', 'verified', 'Unbound preexisting outcome')
        # This reproduces an older migration committing metadata before its marker.
        with serve(Merchant(self.root/'fresh.sqlite')) as url:
            with self.assertRaises(DestinationMismatch):
                Runner(Journal(path), HTTPMerchant(url)).run('old', 10)
        with sqlite3.connect(path) as db:
            self.assertFalse(db.execute("SELECT 1 FROM metadata WHERE key='destination'").fetchone())

    def test_delayed_receipt_can_be_polled_across_runner_restarts_without_duplicate(self):
        clock = FakeClock()
        merchant = Merchant(self.root/'merchant.sqlite', fault='after_commit', visibility_delay=10, clock=clock)
        path = self.root/'journal.sqlite'
        with serve(merchant) as url:
            first = Runner(Journal(path), HTTPMerchant(url)).run('one', 10)
            self.assertEqual((first['state'], first['attempts'], first['pending_polls']), ('pending', 1, 1))
            clock.value += 5
            second = Runner(Journal(path), HTTPMerchant(url)).run('one', 10)
            self.assertEqual((second['state'], second['attempts'], second['pending_polls']), ('pending', 1, 2))
            self.assertEqual(len(merchant.records()), 1)
            clock.value += 6
            final = Runner(Journal(path), HTTPMerchant(url)).run('one', 10)
            self.assertEqual((final['state'], final['attempts']), ('verified', 1))
            self.assertEqual(len(merchant.records()), 1)

    def test_pending_budget_abstains_without_resubmission_and_late_evidence_can_resolve(self):
        clock = FakeClock()
        merchant = Merchant(self.root/'merchant.sqlite', fault='after_commit', visibility_delay=100, clock=clock)
        path = self.root/'journal.sqlite'
        with serve(merchant) as url:
            runner = Runner(Journal(path), HTTPMerchant(url), max_pending_polls=2)
            self.assertEqual(runner.run('one', 10)['state'], 'pending')
            for _ in range(4):
                result = Runner(Journal(path), HTTPMerchant(url), max_pending_polls=2).run('one', 10)
                self.assertEqual((result['state'], result['attempts']), ('needs_review', 1))
            self.assertEqual(len(merchant.records()), 1)
            clock.value += 101
            self.assertEqual(runner.run('one', 10)['state'], 'verified')

    def test_second_process_cannot_run_until_owner_releases(self):
        ctx = multiprocessing.get_context('spawn')
        path = self.root/'journal.sqlite'
        Journal(path)
        ready, release = ctx.Event(), ctx.Event()
        child = ctx.Process(target=own_until_released, args=(str(path), ready, release))
        child.start()
        try:
            self.assertTrue(ready.wait(5), 'owner failed to acquire lock')
            merchant = Merchant(self.root/'merchant.sqlite')
            with serve(merchant) as url:
                runner = Runner(Journal(path), HTTPMerchant(url))
                with self.assertRaises(OwnershipBusy):
                    runner.run('one', 10)
                self.assertEqual(merchant.records(), [])
                with self.assertRaises(KeyError):
                    runner.journal.get('one')
                release.set()
                child.join(5)
                self.assertEqual(child.exitcode, 0)
                self.assertEqual(runner.run('one', 10)['state'], 'verified')
        finally:
            release.set()
            if child.is_alive():
                child.terminate()
            child.join(5)

    def test_crashed_owner_lock_is_released_even_when_lock_file_remains(self):
        ctx = multiprocessing.get_context('spawn')
        path = self.root/'journal.sqlite'
        Journal(path)
        ready, crash = ctx.Event(), ctx.Event()
        child = ctx.Process(target=own_then_crash, args=(str(path), ready, crash))
        child.start()
        try:
            self.assertTrue(ready.wait(5))
            with self.assertRaises(OwnershipBusy):
                with Journal(path).owned():
                    self.fail('contending owner acquired lock')
            crash.set()
            child.join(5)
            self.assertEqual(child.exitcode, 23)
            self.assertTrue(Path(str(path)+'.lock').exists())
            with Journal(path).owned():
                pass
        finally:
            crash.set()
            if child.is_alive():
                child.terminate()
            child.join(5)

    def test_bad_response_shapes_fail_closed(self):
        payloads = [[], None, {'records': {}}, {'records': [None]},
                    {'records': [], 'pending': 'yes'},
                    {'records': [{'id': True, 'amount': 10, 'reference': 'one'}]},
                    {'records': [{'id': 1, 'amount': True, 'reference': 'one'}]},
                    {'records': [{'id': 1, 'amount': 10, 'reference': 'one'}], 'pending': True}]
        for index, payload in enumerate(payloads):
            with self.subTest(payload=payload), serve(PayloadMerchant([], payload)) as url:
                result = Runner(Journal(self.root/f'journal-{index}.sqlite'), HTTPMerchant(url)).run('one', 10)
                self.assertEqual((result['state'], result['attempts']), ('needs_review', 1))
        with serve(PayloadMerchant([], [], 503)) as url:
            self.assertEqual(HTTPMerchant(url).submit('one', 10)[0], 'unknown')

    def test_unknown_adapter_outcome_is_not_a_retry_permission(self):
        class UnexpectedAdapter:
            base_url = 'http://127.0.0.1:8765'
            submissions = 0

            def submit(self, reference, amount):
                self.submissions += 1
                return 'unexpected', {}

            def lookup(self, reference):
                return LookupObservation('absent')

        adapter = UnexpectedAdapter()
        result = Runner(Journal(self.root/'journal.sqlite'), adapter).run('one', 10)
        self.assertEqual((result['state'], result['attempts'], adapter.submissions), ('needs_review', 1, 1))

    def test_portal_serves_form_and_read_only_visible_state_and_lookup(self):
        clock = FakeClock()
        merchant = Merchant(self.root/'merchant.sqlite', visibility_delay=10, clock=clock)
        with serve(merchant) as url:
            with self.open(url) as response:
                html = response.read().decode()
                self.assertIn('text/html', response.headers['Content-Type'])
                self.assertIn('id="invoice-form"', html)
                self.assertIn('id="check-outcome"', html)
                self.assertIn('textContent', html)
            request = Request(url+'/invoices', data=json.dumps({'reference': 'portal', 'amount': 17}).encode(), headers={'Content-Type': 'application/json'}, method='POST')
            with self.open(request) as response:
                self.assertEqual(json.load(response)['amount'], 17)
            with self.open(url+'/state') as response:
                state = json.load(response)
                self.assertEqual((state['records'], state['pending']), ([], True))
            clock.value += 11
            with self.open(url+'/state') as response:
                self.assertEqual(len(json.load(response)['records']), 1)
            self.assertEqual(HTTPMerchant(url).lookup('portal').kind, 'found')
            self.assertEqual(len(merchant.records()), 1)

    def test_opaque_portal_state_does_not_leak_outcome(self):
        merchant = Merchant(self.root/'merchant.sqlite', mode='opaque')
        with serve(merchant) as url:
            HTTPMerchant(url).submit('one', 10)
            with self.open(url+'/state') as response:
                self.assertIsNone(json.load(response)['records'])
            self.assertEqual(HTTPMerchant(url).lookup('one').kind, 'unavailable')

    def test_portal_rejects_nonobject_and_oversized_requests(self):
        with serve(Merchant(self.root/'merchant.sqlite')) as url:
            for data, content_type in [(b'[]', 'application/json'), (b'x'*17000, 'application/json'), (b'reference=one&amount=10', 'application/x-www-form-urlencoded')]:
                with self.subTest(data=data[:10]), self.assertRaises(HTTPError) as caught:
                    self.open(Request(url+'/invoices', data=data, headers={'Content-Type': content_type}, method='POST'))
                self.assertIn(caught.exception.code, (400, 415))

    def test_portal_rejects_unpaired_surrogates_before_destination_state_changes(self):
        merchant = Merchant(self.root/'surrogate.sqlite', fault='before_commit')
        with serve(merchant) as url:
            for ref in ['\ud800', '\udfff']:
                body = json.dumps({'reference': ref, 'amount': 1}).encode()
                with self.subTest(reference=repr(ref)), self.assertRaises(HTTPError) as caught:
                    self.open(Request(url+'/invoices', data=body, headers={'Content-Type': 'application/json'}, method='POST'))
                self.assertEqual(caught.exception.code, 400)
            self.assertEqual(merchant.records(), [])
            self.assertEqual(merchant.fault, 'before_commit')
            self.assertEqual(HTTPMerchant(url).submit('valid-😀', 1)[0], 'rejected')
            self.assertEqual(HTTPMerchant(url).submit('valid-😀', 1)[0], 'success')

    def test_fixture_destination_rejects_remote_or_credential_urls(self):
        for url in ['https://127.0.0.1', 'http://example.com', 'http://user:password@localhost', 'http://localhost:0', 'http://localhost/path', 'http://localhost#fragment']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                HTTPMerchant(url)


if __name__ == '__main__':
    unittest.main()
