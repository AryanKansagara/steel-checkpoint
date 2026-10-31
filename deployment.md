# Checkpoint service deployment

This repository now includes a same-origin Node HTTP service and an isolated Python recovery worker. It is ready for local/container validation; no live hosting, vendor integration or deployed production reliability is claimed.

## Local startup

Requirements are Node.js 22+ and Python 3.11+, including standard-library SQLite. There are no npm or pip runtime packages to install. Node orchestration was checked on 24.22.1 and Python 3.12.14/Linux; CI also targets Python 3.11.

```sh
npm test
npm run smoke
PORT=3000 npm start
```

`npm run dev` is the same launch command for preview environments. The service binds `0.0.0.0`; `PORT` defaults to 3000 and must be an integer 1–65535. Preview launchers may pass `--host 0.0.0.0 --port 4173 --strictPort`; explicit port flags override `PORT`. Binding always fails if the requested port is occupied; no fallback port is selected. The root serves `web/index.html`; JavaScript/CSS stay on the same origin. No API keys, arbitrary destination URLs, file paths or customer data enter requests. `.env.example` documents environment settings; the program reads the process environment and does not load dotenv files.

```sh
curl http://127.0.0.1:3000/api/health
curl http://127.0.0.1:3000/api/ready
curl -H 'Content-Type: application/json' -d '{"mode":"observable","fault":"after_commit","visibilityDelayMs":100}' http://127.0.0.1:3000/api/run
```

## API and actual work

`POST /api/run` requires exactly those three keys. `mode` is `observable`, `opaque` or `idempotent`; `fault` is `none`, `before_commit` or `after_commit`; `visibilityDelayMs` is an integer 0–300. Amount is fixed at 1250 fictional minor units. Duplicate/unknown keys, nested data, invalid enums, compressed payloads, wrong methods/types, malformed JSON and bodies above 16 KiB are rejected.

Each request starts a fixed `python3 -m checkpoint.service_worker` process. The caller cannot choose executable, arguments, URLs or paths. For each policy, the worker creates an independent actual loopback Merchant HTTP server and SQLite destination/journal. Both get the same configuration. The naive baseline journals its intentional blind retry; reconciliation uses the existing `Runner`, actual HTTP receipts and journal events. Pending evidence is polled at most 30 times with a one-second polling deadline and never resubmitted. Opaque uncertainty stays `needs_review`. Browser-facing histories/receipts come from this execution, not a prepared result file.

`records` and `duplicates` are explicitly labeled **evaluation oracle** counts read only after each policy has finished its decisions. They do not help the reconciliation driver. The response includes unique `runId`, both policy results/traces/histories and a provenance summary. Each run is disposable; there is no saved-run API, persistent user database or public merchant endpoint.

## Bounded execution and shutdown

The single Node process admits at most two workers and 20 accepted runs per sliding 60-second global window. Its rate ledger contains at most 20 timestamps; it does not accumulate per-IP identities. Busy/rate responses are HTTP 429 with `Retry-After` and `retryAfterMs`. Budgets are per process; multiple replicas need an ingress-wide budget if one global cap is desired.

Body receipt is limited to two seconds, worker execution to six seconds, followed by a 250 ms termination escalation. These are configured time budgets, not real-time scheduling guarantees. Slow/disconnected clients release capacity. HTTP limits also bound connections, headers, idle time and requests per connection. Worker stdout is capped at 256 KiB; stderr is drained without exposing environment, paths or tracebacks to callers.

Node creates and owns each job directory and passes it as `CHECKPOINT_RUN_DIR` and `TMPDIR`; Python creates nested temporary stores there. After process exit, including hard termination, Node recursively removes that entire directory. Worker SIGTERM unwinds its own merchant/thread/file contexts first when possible. The parent signals the child's process group and escalates to SIGKILL if needed. HTTP tests verify timeout/disconnect process death and absence of leftover job directories.

SIGTERM/SIGINT stop admissions and close the listener. Existing work can finish; after seven seconds active jobs are aborted and remaining HTTP connections closed. Concurrent shutdown callers await one shared shutdown promise. Health is a liveness response; readiness also verifies the Python modules and presence of the frontend entrypoint. No CORS policy grants another origin access. The service uses self-only script/style CSP, safe text JSON errors and static traversal/symlink confinement.

## Container

```sh
docker build -t checkpoint-lab .
docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m --memory 256m --cpus 1 -p 3000:3000 checkpoint-lab
```

The image pins official Node `24.22.2-bookworm-slim`, installs Debian's maintained Python 3 package, runs as the unprivileged `node` user, exposes a readiness healthcheck and uses an exec-form Node entrypoint. Python apt resolution is not pinned, so builds are not bit-for-bit reproducible; production release processes should record image digests and package inventory. Container limits bound total temporary storage and process memory. TLS, public ingress limits, process supervision and access policy belong to the hosting environment; this synthetic demo itself has no authentication or real merchant credentials.

Docker is unavailable in the authoring environment. The Dockerfile has **not** been built locally. The prepared GitHub Actions job builds it, starts it with a read-only root and bounded `/tmp`, checks health and performs a real API comparison; that hosted check remains unverified until the workflow runs. A passing local Node/Python smoke does not establish container or hosting behavior.

## References

- [Official Node image catalog](https://hub.docker.com/_/node): versioned bookworm slim image tags, checked 2026-10-31.
- [Official Node image source](https://github.com/nodejs/docker-node): image runtime and nonroot user conventions.
- [Dockerfile reference](https://docs.docker.com/reference/dockerfile/): `USER`, exec `CMD`, `HEALTHCHECK` and shutdown instructions.
