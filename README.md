# Checkpoint

[Live application](https://steel-checkpoint.vercel.app/) — deployment of the durable product upgrade is managed separately from this source change.

Checkpoint is a private webhook delivery and recovery workspace. Supply your own public HTTPS endpoint, JSON payload and logical reference; save the intent, then explicitly send a real POST. The interface starts empty. No fabricated invoice outcomes, duplicate counts or fixture records drive the product.

A successful 2xx response means **HTTP acknowledged**, not proof of the destination's business transaction. A timeout, disconnect, process interruption, redirect or non-2xx response after dispatch leaves the outcome unknown. Nothing automatically retries it. Configure a real read-only receipt lookup to reconcile, declare an endpoint idempotency contract for an explicit retry, or deliberately confirm duplicate risk. An empty lookup never establishes safe retry permission.

## Use

1. Create a private anonymous workspace. Its 256-bit bearer access key is returned once and stored by your browser; the server retains only its SHA-256 hash. Anyone with that key can access the workspace. Losing it means losing access.
2. Enter a public HTTPS destination on port 443, a reference and JSON payload. The raw JSON is sent unchanged; `X-Checkpoint-Reference` carries the reference separately. Ensure the receiver's own receipt contract preserves the reference if you intend to reconcile later.
3. Save the queued intent. Review it, then explicitly send. Optional credential headers are entered for that action only, never saved or automatically reused. Re-enter the appropriate credential separately for lookup or retry.
4. Inspect actual request attempts, response status, redacted body preview, timestamps and journal. Reload retains the private history from SQLite. Export a delivery or the workspace; delete history without pretending deletion reverses a remote effect.

Receipt lookup is a real GET to the configured HTTPS URL. `recordsPointer` selects an array and `referencePointer` selects the reference inside each record. Only one exact matching reference among structurally valid records resolves the delivery. The record digest, matching criterion and observation time are shown as evidence. This relies on the configured receiver's reference uniqueness/identity contract; payload equality, financial settlement and arbitrary business completion are not claimed.

## Run

Node.js 24+ supplies native SQLite. Product dependencies are standard library only. The old Python research engine is retained separately and does not handle product requests.

```sh
npm test
npm run smoke
# Nonroot local account:
DATA_DIR=/absolute/private/checkpoint-data npm run dev
# Root-owned Railway volume: initialize the trusted directory, then drop before HTTP.
DROP_PRIVILEGES=1 DATA_DIR=/data/checkpoint npm start
```

The service binds port 3000 by default and accepts preview `--host`, `--port` and `--strictPort` flags. A configured data directory must be writable; startup never falls back to temporary storage. See [deployment.md](deployment.md) for Railway volume, root-drop, native Vercel relay and operational bounds.

## Privacy and boundaries

Workspace separation is enforced on every history, action, deletion and export query. Tokens and credential header values are not stored in SQLite or logs. Responses from credentialed operations are omitted from saved body previews to prevent reflected-secret leakage. Payloads and endpoint URLs are intentionally persisted as private user data: do not put credentials in a payload or URL if you do not want them stored. History expires with the workspace after seven days. Operators with access to the volume can read stored payloads; application privacy is not encryption against the infrastructure owner.

Outbound requests require public HTTPS/443. Every DNS answer must pass conservative public-IP checks, including mapped/tunneled addresses and metadata ranges. The connection is pinned to a validated IP while retaining TLS hostname verification. Redirects and ambient proxy settings are not used. Payload, response, connection, operation, retention and SQLite file bounds are enforced. This is a single-instance service with durable local volume storage, not a distributed exactly-once queue or a guaranteed credential vault.

Checkpoint is independent of Steel and has no Steel integration. Historical browser-agent recovery research remains in `checkpoint/`, `benchmarks/`, and the separate `lab-server.mjs`; it is not exposed by the production product API. `python -m checkpoint demo` still runs those explicitly labeled controlled experiments.

Primary background: [Steel session lifecycle](https://docs.steel.dev/overview/sessions-api/session-lifecycle), [Steel traces](https://docs.steel.dev/overview/agent-traces/api), and [Temporal activity semantics](https://github.com/temporalio/documentation/blob/main/docs/encyclopedia/activities/activity-definition.mdx). Existing tools already provide traces/replay; this project concentrates on durable uncertainty and explicit recovery decisions.
