import multiprocessing
import os
import tempfile
import unittest
from pathlib import Path
from checkpoint.engine import HTTPMerchant, Journal, Runner
from checkpoint.fixture import Merchant, serve


def crash_after_submit(path, url):
    journal = Journal(path)
    # A real executor must establish its destination before any external action.
    with journal.owned():
        journal.bind_destination(url)
    journal.plan("durable", 100)
    journal.set("durable", "executing", "Persisted before submit", attempt=True)
    HTTPMerchant(url).submit("durable", 100)
    os._exit(17)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def scenario(self, mode="observable", fault="none"):
        return Merchant(self.root / "merchant.sqlite", mode, fault)

    def test_success_is_not_resubmitted(self):
        merchant = self.scenario()
        with serve(merchant) as url:
            runner = Runner(Journal(self.root / "journal.sqlite"), HTTPMerchant(url))
            self.assertEqual(runner.run("one", 10)["state"], "verified")
            self.assertEqual(runner.run("one", 10)["attempts"], 1)
            self.assertEqual(len(merchant.records()), 1)

    def test_lost_ack_reconciles_without_duplicate(self):
        merchant = self.scenario(fault="after_commit")
        with serve(merchant) as url:
            result = Runner(Journal(self.root / "journal.sqlite"), HTTPMerchant(url)).run("one", 10)
            self.assertEqual((result["state"], result["attempts"]), ("verified", 1))
            self.assertEqual(len(merchant.records()), 1)

    def test_explicit_precommit_rejection_retries(self):
        merchant = self.scenario(fault="before_commit")
        with serve(merchant) as url:
            result = Runner(Journal(self.root / "journal.sqlite"), HTTPMerchant(url)).run("one", 10)
            self.assertEqual((result["state"], result["attempts"]), ("verified", 2))
            self.assertEqual(len(merchant.records()), 1)

    def test_opaque_lost_ack_stops_for_review(self):
        merchant = self.scenario(mode="opaque", fault="after_commit")
        with serve(merchant) as url:
            runner = Runner(Journal(self.root / "journal.sqlite"), HTTPMerchant(url))
            self.assertEqual(runner.run("one", 10)["state"], "needs_review")
            self.assertEqual(runner.run("one", 10)["attempts"], 1)
            self.assertEqual(len(merchant.records()), 1)

    def test_empty_lookup_does_not_prove_absence(self):
        merchant = self.scenario()
        journal = Journal(self.root / "journal.sqlite")
        journal.plan("one", 10)
        journal.set("one", "executing", "Interrupted with unknown outcome", attempt=True)
        with serve(merchant) as url:
            self.assertEqual(Runner(journal, HTTPMerchant(url)).run("one", 10)["state"], "needs_review")
            self.assertEqual(merchant.records(), [])

    def test_duplicate_or_conflicting_receipts_are_not_success(self):
        merchant = self.scenario()
        with serve(merchant) as url:
            client = HTTPMerchant(url)
            client.submit("one", 10)
            client.submit("one", 10)
            journal = Journal(self.root / "journal.sqlite")
            journal.plan("one", 10)
            journal.set("one", "executing", "Unknown", attempt=True)
            self.assertEqual(Runner(journal, client).run("one", 10)["state"], "needs_review")

    def test_process_death_after_commit_is_recoverable(self):
        merchant = self.scenario()
        path = str(self.root / "journal.sqlite")
        with serve(merchant) as url:
            process = multiprocessing.get_context("spawn").Process(target=crash_after_submit, args=(path, url))
            process.start()
            process.join(10)
            if process.is_alive():
                process.terminate()
                process.join()
                self.fail("child did not terminate")
            self.assertEqual(process.exitcode, 17)
            self.assertEqual(Journal(path).get("durable")["state"], "executing")
            result = Runner(Journal(path), HTTPMerchant(url)).run("durable", 100)
            self.assertEqual((result["state"], result["attempts"]), ("verified", 1))
            self.assertEqual(len(merchant.records()), 1)

    def test_conflicting_destination_receipt_is_not_success(self):
        merchant = self.scenario()
        with serve(merchant) as url:
            client = HTTPMerchant(url)
            client.submit("one", 99)
            journal = Journal(self.root / "journal.sqlite")
            journal.plan("one", 10)
            journal.set("one", "executing", "Unknown", attempt=True)
            result = Runner(journal, client).run("one", 10)
            self.assertEqual(result["state"], "needs_review")
            self.assertEqual(result["attempts"], 1)
            self.assertEqual(len(merchant.records()), 1)

    def test_naive_retry_duplicates_after_commit(self):
        merchant = self.scenario(fault="after_commit")
        with serve(merchant) as url:
            client = HTTPMerchant(url)
            self.assertEqual(client.submit("one", 10)[0], "unknown")
            self.assertEqual(client.submit("one", 10)[0], "success")
            self.assertEqual(len(merchant.records()), 2)

    def test_reference_cannot_change_intent(self):
        journal = Journal(self.root / "journal.sqlite")
        journal.plan("one", 10)
        with self.assertRaises(ValueError):
            journal.plan("one", 11)


if __name__ == "__main__":
    unittest.main()
