# Checkpoint service deployment

This repository now includes a same-origin Node HTTP service and an isolated Python recovery worker. The live frontend is [steel-checkpoint.vercel.app](https://steel-checkpoint.vercel.app/) and its Docker backend is [checkpoint-production-81f4.up.railway.app](https://checkpoint-production-81f4.up.railway.app). The browser-to-backend comparison and theme persistence have been verified. This remains a controlled synthetic laboratory; no Steel integration or production reliability guarantee is claimed.

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

SIGTERM/SIGINT stop admissions and close the listener. Existing work can finish; after seven seconds active jobs are aborted and remaining HTTP connections closed. Concurrent shutdown callers await one shared shutdown promise. Health is a liveness response; readiness also verifies the Python modules and presence of the frontend entrypoint. By default only a browser origin matching the actual socket scheme and Host is accepted; clients without an Origin header remain supported. An optional exact `PUBLIC_ORIGIN` allows the separate frontend described below. The service uses self-only script/style CSP, safe text JSON errors and static traversal/symlink confinement.

## Container

```sh
docker build -t checkpoint-lab .
docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m --memory 256m --cpus 1 -p 3000:3000 checkpoint-lab
```

The image pins official Node `24.22.2-bookworm-slim`, installs Debian's maintained Python 3 package, runs as the unprivileged `node` user, exposes a readiness healthcheck and uses an exec-form Node entrypoint. Python apt resolution is not pinned, so builds are not bit-for-bit reproducible; production release processes should record image digests and package inventory. Container limits bound total temporary storage and process memory. TLS, public ingress limits, process supervision and access policy belong to the hosting environment; this synthetic demo itself has no authentication or real merchant credentials.

Docker is unavailable in the authoring environment. The Dockerfile has **not** been built locally. The GitHub Actions job builds it, starts it with a read-only root and bounded `/tmp`, checks health and performs a real API comparison. That container smoke passed for published commit `2335d78815800a6d8a07af11ba1caccba963f035` ([run](https://github.com/AryanKansagara/steel-checkpoint/actions/runs/41245773813)); subsequent source changes require a fresh run. A passing local Node/Python smoke does not establish container or hosting behavior.

## Split hosting: Vercel frontend and Railway backend

`railway.json` selects the repository Dockerfile, `/api/ready` healthcheck, one replica, bounded failure restarts, zero overlap and ten seconds of shutdown drain. Deploy the **repository root** to Railway, keep the Docker entrypoint, let the platform provide `PORT`, and configure one region/one replica. The per-process two-worker/20-run budget is not a distributed quota; avoid extra replicas or a multi-region dashboard override. No persistent volume is required because all experiment data is disposable. Railway health checks use no browser Origin and work before the frontend hostname exists.

The actual Railway backend is `https://checkpoint-production-81f4.up.railway.app`. Root `vercel.json` contains literal destinations for `/api/:path*`, `/healthz` and `/readyz` on that backend; no `BACKEND_ORIGIN` variable is required. It preserves the same security headers, runs `node scripts/build-frontend.mjs`, and publishes the explicit static asset allowlist from `dist`. Keep the Vercel project root at this repository root. The rejected programmatic `vercel.ts` has been removed, so only one Vercel configuration file remains. There is no Python worker in a Vercel function. If the Railway domain changes, deliberately update the three static destinations before deploying the frontend.

Railway's `PUBLIC_ORIGIN` is configured as `https://steel-checkpoint.vercel.app`, the intended Vercel frontend origin. If the frontend hostname changes, update that exact origin and redeploy the backend. Do not use `*`, preview-domain patterns, a comma-separated list, HTTP, credentials, a path, trailing slash, query or fragment. For example syntax, see the commented setting in `.env.example`; it is not a configured live address. Preview deployments with different hostnames require an explicit deliberate origin change; subdomains do not inherit permission.

The backend validates this setting at startup and only grants API CORS access to that exact origin or a direct same-connection origin. Preflight permits only POST `/api/run` with Content-Type; no credentialed CORS or wildcard reflection is enabled. Disallowed origins/methods/headers return 403 before consuming worker/rate capacity. Forwarded and X-Forwarded-* headers never establish origin trust. CORS is a browser boundary, not authentication: no-Origin CLI clients can still use this bounded fictional demo.

Railway terminates TLS before the plain HTTP Node listener. A browser opening the backend domain's own HTTPS UI is therefore **not** automatically treated as a verified same-connection origin; that direct HTTPS UI path is not a configured supported frontend until separately validated. The intended public browser path is Vercel's explicitly allowed origin. Local HTTP same-origin use is preserved. Never weaken this check by trusting arbitrary forwarding headers.

After both real domains exist, verify the deployed Vercel page, rewritten readiness, a real default comparison, opaque abstention, idempotent control, delayed evidence, theme persistence and report download. Confirm rejected near-match origins and 429 behavior separately. Live verification is complete for Vercel Git deployment `dpl_41somtdXswvt85BgBTPKQPuXQw7Q` at source commit `34ed17000782197a6b783c27649bfd1af9ca58b8`, with the Railway backend successfully deployed. The actual browser flow produced two attempts/two records/one duplicate for the observable naive baseline versus one attempt/one record/no duplicate for reconciliation; the opaque control remained `needs_review`. Light/dark theme preference survived reload. These observations validate this deployed fictional workflow, not a Steel integration, real merchant behavior or a general reliability guarantee.

## References

- [Official Node image catalog](https://hub.docker.com/_/node): versioned bookworm slim image tags, checked 2026-10-31.
- [Official Node image source](https://github.com/nodejs/docker-node): image runtime and nonroot user conventions.
- [Vercel static configuration](https://vercel.com/docs/project-configuration/vercel-json): literal rewrite destinations, build commands and response headers.
- [Railway configuration reference](https://docs.railway.com/config-as-code/reference) and [current schema](https://railway.com/railway.schema.json): Docker builder, healthcheck and single-replica settings checked 2026-10-31.
- [Dockerfile reference](https://docs.docker.com/reference/dockerfile/): `USER`, exec `CMD`, `HEALTHCHECK` and shutdown instructions.
