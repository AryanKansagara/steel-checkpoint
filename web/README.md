# Recovery desk frontend

Same-origin, dependency-free UI for the local Checkpoint demo server. Open its root URL; do not open index.html directly from disk. The Run button POSTs exactly `{mode, fault, visibilityDelayMs}` to `/api/run`. No policy results are invented client-side. The page preserves previous evidence with a stale label during configuration changes, request failures, busy responses and timeouts. Export includes both the executed scenario and full returned evidence.

Assets are self-contained and compatible with a self-only Content Security Policy: no CDN, inline JavaScript, remote fonts or arbitrary destinations. Returned text is assigned with `textContent`; events are created as DOM nodes. Native form controls, visible keyboard focus, a skip link, live status messages, semantic headings and reduced-motion support are included.

Run presentation-boundary checks with `node --test web/view-model.test.js` from the repository root, or `npm test` inside web/. Browser integration and responsive visual QA must be reported separately. The Python server/engine remain the source of truth.
