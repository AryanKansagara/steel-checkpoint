"""Fixed, isolated worker for the public synthetic demonstration API.

Only the parent creates CHECKPOINT_RUN_DIR. No caller-provided URLs or paths.
"""
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import time
import uuid

from .engine import HTTPMerchant, Journal, Runner, valid_receipt
from .fixture import Merchant, serve


def validate_config(config):
    if (not isinstance(config, dict) or set(config) != {'mode', 'fault', 'visibilityDelayMs'}
            or config['mode'] not in ('observable', 'opaque', 'idempotent')
            or config['fault'] not in ('none', 'before_commit', 'after_commit')
            or type(config['visibilityDelayMs']) is not int
            or not 0 <= config['visibilityDelayMs'] <= 300):
        raise ValueError('invalid fixed experiment configuration')
    return config


def experiment(config, root, policy):
    start = time.monotonic()
    merchant = Merchant(root/'merchant.sqlite', config['mode'], config['fault'],
                        config['visibilityDelayMs']/1000)
    journal = Journal(root/'journal.sqlite')
    reference = 'fictional-invoice'
    amount = 1250
    history = []

    def snapshot():
        row = journal.get(reference)
        history.append(dict(state=row['state'], attempts=row['attempts'],
                            pendingPolls=row['pending_polls'],
                            elapsedMs=round((time.monotonic()-start)*1000, 3)))
        return row

    with serve(merchant) as url:
        adapter = HTTPMerchant(url)
        if policy == 'naive_retry':
            with journal.owned():
                journal.bind_destination(url)
                journal.plan(reference, amount)
                for _ in range(2):
                    journal.set(reference, 'executing', 'Naive baseline persists intent then submits', attempt=True)
                    outcome, receipt = adapter.submit(reference, amount)
                    if outcome == 'success' and valid_receipt(receipt, reference, amount):
                        journal.set(reference, 'verified', 'Naive baseline accepts matching acknowledgement', receipt)
                        snapshot()
                        break
                    journal.set(reference, 'outcome_unknown', 'Naive baseline blindly retries after missing or rejected acknowledgement')
                    snapshot()
                else:
                    journal.set(reference, 'failed', 'Naive baseline exhausted its two-submit budget')
                    snapshot()
        else:
            runner = Runner(journal, adapter, max_pending_polls=30)
            runner.run(reference, amount)
            row = snapshot()
            deadline = time.monotonic()+1.0
            # Pending is explicit destination evidence, not permission to submit.
            while row['state'] == 'pending' and time.monotonic() < deadline:
                time.sleep(0.025)
                runner.reconcile(reference)
                row = snapshot()
        final = journal.get(reference)
        with journal.connect() as db:
            events = [dict(id=r[0], state=r[1], reason=r[2], timestamp=r[3])
                      for r in db.execute('SELECT id,state,reason,timestamp FROM events ORDER BY id')]
        # Oracle access occurs AFTER all driver decisions and cannot authorize retry.
        records = merchant.records()
    return dict(policy=policy, state=final['state'], attempts=final['attempts'],
                records=len(records), duplicates=max(0, len(records)-1), events=events,
                history=history, receipt=json.loads(final['receipt']) if final['receipt'] else None,
                elapsedMs=round((time.monotonic()-start)*1000, 3))


def run_comparison(config, directory=None):
    validate_config(config)
    with tempfile.TemporaryDirectory(prefix='checkpoint-experiment-', dir=directory) as temporary:
        root = Path(temporary)
        results = {}
        for key, policy in [('naive', 'naive_retry'), ('reconcile', 'reconcile')]:
            location = root/key
            location.mkdir()
            results[key] = experiment(config, location, policy)
        return dict(runId=str(uuid.uuid4()), **config, **results, summary=dict(
            amountMinor=1250, naiveDuplicates=results['naive']['duplicates'],
            reconcileDuplicates=results['reconcile']['duplicates'],
            avoidedDuplicates=results['naive']['duplicates']-results['reconcile']['duplicates'],
            provenance='real loopback HTTP; authored merchant faults',
            oracle='records/duplicates are evaluation-only fixture reads after each experiment; never recovery input',
            comparison='independent merchants/journals; same mode, one-shot fault, amount and visibility delay',
            integrationStatus='unverified',
            limitation='Controlled synthetic destination only; no browser automation, Steel integration or distributed exactly-once guarantee'))


def main():
    def terminate(_signal, _frame):
        raise SystemExit(143)
    signal.signal(signal.SIGTERM, terminate)
    try:
        raw = sys.stdin.buffer.read(16385)
        if len(raw) > 16384:
            raise ValueError('input too large')
        config = json.loads(raw)
        # Directory is a trusted, parent-created per-process workspace, never API input.
        directory = os.environ['CHECKPOINT_RUN_DIR']
        result = run_comparison(config, directory)
        print(json.dumps(result, allow_nan=False), flush=True)
    except (ValueError, TypeError, KeyError):
        print(json.dumps({'error': 'invalid experiment configuration'}), flush=True)
        raise SystemExit(2)


if __name__ == '__main__':
    main()
