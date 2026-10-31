# Checkpoint delivery workspace

A same-origin, dependency-free UI for the real delivery API. The default page is blank onboarding, not a fixture or invented result. “Load example payload” only fills JSON and a reference; it does not create a job or contact an endpoint. Creating a delivery saves a queued draft. A separate explicit Send action makes a real HTTPS POST. The destination receives the user JSON without a payload wrapper and an X-Checkpoint-Reference header.

An anonymous server-created workspace access key is stored under `checkpoint-workspace` in localStorage. It is sent only as a same-origin API Authorization header, never in a URL or export. This is browser-key identity, not an authenticated account. Payloads and journals are private server-side job data. Endpoint Authorization values are entered per action, cleared from the input when used and retained only for the in-flight request, and never stored by this frontend. A reload requires re-entry.

The UI renders actual saved jobs, attempt response metadata and durable state transitions with textContent and created DOM nodes. A 2xx acknowledgement is labeled HTTP acknowledged, never independently proven business completion. Unknown outcomes and receipt ambiguity remain unresolved. Retry permissions come from the server’s recorded safety contract; an otherwise ambiguous retry requires an explicit duplicate-risk dialog and checkbox. A lost UI response disables further delivery actions until saved evidence is refreshed. Deleting a job cannot undo a request already sent.

Appearance follows the system until overridden. The header light/dark control persists the choice; Use system clears it. Storage failures do not block appearance switching. No inline JavaScript, CDN or remote fonts are used. Native controls, visible focus, a skip link, live status messages, modal keyboard behavior and reduced-motion support are included. The layout adapts through 320px widths.

Presentation tests: `node --test web/view-model.test.js` from the repository root. Browser integration, actual destination delivery and hosting readiness require separate verification by the server/deployment owner.
