import argparse
import json
import tempfile
import time
from pathlib import Path
from .engine import HTTPMerchant, Journal, Runner
from .fixture import Merchant, serve


def demo():
    results = []
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        for mode in ("observable", "opaque", "idempotent"):
            for fault in ("before_commit", "after_commit"):
                for policy in ("naive_retry", "reconcile"):
                    name = f"{mode}-{fault}-{policy}"
                    merchant = Merchant(root / (name + ".sqlite"), mode, fault)
                    with serve(merchant) as url:
                        client = HTTPMerchant(url)
                        start = time.perf_counter()
                        if policy == "naive_retry":
                            outcome, _ = client.submit(name, 1250)
                            attempts = 1
                            if outcome != "success":
                                outcome, _ = client.submit(name, 1250)
                                attempts += 1
                            state = "verified" if outcome == "success" else "failed"
                        else:
                            journal = Journal(root / (name + "-journal.sqlite"))
                            result = Runner(journal, client).run(name, 1250)
                            state, attempts = result["state"], result["attempts"]
                        elapsed = (time.perf_counter() - start) * 1000
                        records = merchant.records()  # Evaluation oracle, not used by Runner.
                        results.append(dict(mode=mode, fault=fault, policy=policy, state=state, attempts=attempts, records=len(records), duplicates=max(0, len(records)-1), elapsed_ms=round(elapsed, 2)))
    return results


def main():
    parser = argparse.ArgumentParser(description="Checkpoint local HTTP recovery laboratory")
    parser.add_argument("command", choices=["demo"])
    args = parser.parse_args()
    if args.command == "demo":
        print(json.dumps({"validation": "controlled_http_fixture", "runs": demo()}, indent=2))


if __name__ == "__main__":
    main()

