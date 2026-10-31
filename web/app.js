import { validateRun, presentation, settingsLabel, exportName, createThemeController } from './view-model.js';
const byId = id => document.getElementById(id);
let themeStorage = null;
try { themeStorage = window.localStorage; } catch {}
const theme = createThemeController({root:document.documentElement, button:byId('theme-toggle'), systemButton:byId('theme-system'), status:byId('theme-status'), meta:document.querySelector('meta[name="theme-color"]'), media:window.matchMedia('(prefers-color-scheme: dark)'), storage:themeStorage});
window.addEventListener('storage', event => { if (event.key === 'checkpoint-theme' || event.key === null) theme.sync(); });
const form = byId('scenario-form');
const results = byId('results');
const runButton = byId('run-button');
const downloadButton = byId('download');
let lastRun = null;
let lastSettings = null;
let selectedPolicy = 'reconcile';
let running = false;
let stale = false;

function readSettings() {
  return {mode:new FormData(form).get('mode'), fault:byId('fault').value, visibilityDelayMs:Number(byId('delay').value)};
}
function status(message, type = '') {
  byId('status').className = `status-line ${type}`;
  byId('status-message').textContent = message;
}
function badge(text, tone = '') {
  byId('run-badge').textContent = text;
  byId('run-badge').className = `run-badge ${tone}`;
}
function markSettings() {
  byId('delay-value').textContent = `${byId('delay').value} ms`;
  const help = {none:'The destination returns a clean acknowledgement.', before_commit:'The destination explicitly rejects the first attempt before any commit.', after_commit:'The record is committed, but its acknowledgement never arrives.'};
  byId('fault-help').textContent = help[byId('fault').value];
  if (lastRun && !running) {
    stale = JSON.stringify(readSettings()) !== JSON.stringify(lastSettings);
    if (stale) {
      badge('PREVIOUS RUN', 'stale');
      status('Settings changed. The evidence below belongs to the previous run. Run again to compare the new scenario.', 'stale');
    } else {
      badge('RUN COMPLETE', 'active');
      status('Showing the completed run for the selected scenario.');
    }
  }
}
form.addEventListener('input', markSettings);
form.addEventListener('change', markSettings);
function setBusy(value) {
  running = value;
  results.setAttribute('aria-busy', String(value));
  runButton.disabled = value;
  byId('run-label').textContent = value ? 'Running experiment…' : 'Run both policies';
  for (const element of form.elements) element.disabled = value;
  downloadButton.disabled = value || !lastRun;
}
function renderPolicy(name, policy) {
  const view = presentation(policy);
  const state = byId(`${name}-state`);
  state.textContent = view.label;
  state.className = `policy-state ${view.tone}`;
  for (const metric of ['attempts', 'records', 'duplicates']) byId(`${name}-${metric}`).textContent = String(policy[metric]);
  byId(`${name}-duplicates`).classList.toggle('has-duplicates', policy.duplicates > 0);
  byId(`${name}-note`).textContent = view.note;
  byId(`${name}-receipt-tag`).textContent = policy.receipt ? 'returned evidence' : 'none returned';
  byId(`${name}-receipt`).textContent = policy.receipt ? JSON.stringify(policy.receipt, null, 2) : 'No validated receipt was returned by this policy. Oracle record counts do not substitute for a receipt.';
}
function renderJournal() {
  const timeline = byId('timeline');
  timeline.replaceChildren();
  for (const button of document.querySelectorAll('.journal-tab')) button.setAttribute('aria-pressed', String(button.dataset.policy === selectedPolicy));
  if (!lastRun) return;
  const policy = lastRun[selectedPolicy];
  byId('journal-empty').hidden = policy.events.length > 0;
  timeline.hidden = policy.events.length === 0;
  policy.events.forEach((event, index) => {
    const item = document.createElement('li');
    if (index === policy.events.length - 1) item.className = 'last';
    const head = document.createElement('div'); head.className = 'event-head';
    const state = document.createElement('span'); state.className = 'event-state'; state.textContent = event.state.replaceAll('_', ' ');
    const count = document.createElement('span'); count.className = 'event-count'; count.textContent = `EVENT ${String(index + 1).padStart(2, '0')}`;
    const reason = document.createElement('p'); reason.className = 'event-reason'; reason.textContent = event.reason;
    head.append(state, count); item.append(head, reason); timeline.append(item);
  });
  const history = document.createElement('li');
  const heading = document.createElement('span'); heading.className = 'event-state'; heading.textContent = 'Recorded observations';
  const observations = document.createElement('p'); observations.className = 'event-reason';
  observations.textContent = policy.history.map(row => `${String(row.state).replaceAll('_', ' ')}${typeof row.elapsedMs === 'number' ? ` at ${row.elapsedMs.toFixed(1)} ms` : ''}`).join(' → ') || 'No polling snapshots were returned.';
  history.append(heading, observations); timeline.append(history);
}
for (const button of document.querySelectorAll('.journal-tab')) button.addEventListener('click', () => { selectedPolicy = button.dataset.policy; renderJournal(); });
function render(data, settings) {
  lastRun = data; lastSettings = settings; stale = false;
  renderPolicy('naive', data.naive); renderPolicy('reconcile', data.reconcile);
  byId('run-context').textContent = `${settingsLabel(settings)} / run ${data.runId}`;
  byId('raw-json').textContent = JSON.stringify(data, null, 2);
  const summary = data.summary;
  byId('summary-text').textContent = typeof summary.provenance === 'string' ? `Measured execution: ${summary.provenance}.` : 'Engine results recorded; inspect complete JSON for scope and provenance.';
  renderJournal();
  const unresolved = [data.naive.state, data.reconcile.state].some(state => state === 'pending' || state === 'needs_review');
  status(unresolved ? 'Run complete. At least one policy has an unresolved outcome; inspect its evidence before any retry.' : 'Run complete. Compare the observed records with each policy’s knowledge.');
  badge('RUN COMPLETE', 'active');
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (running) return;
  const settings = readSettings();
  setBusy(true); badge('RUNNING', 'stale');
  status(lastRun ? 'Running both policies in isolated stores. Previous results remain below until the new run completes.' : 'Running both policies against the local fixture. Waiting for actual engine evidence…', 'loading');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch('/api/run', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(settings), signal:controller.signal});
    if (!response.ok) {
      if (response.status === 429 || response.status === 503) throw new Error('The recovery desk is busy. Wait for the active run to finish, then try again. No automatic retry was sent.');
      throw new Error(`The engine could not complete this request (HTTP ${response.status}). No automatic retry was sent.`);
    }
    const data = validateRun(await response.json());
    render(data, settings);
    byId('results-title').focus({preventScroll:true});
  } catch (error) {
    const message = error.name === 'AbortError' ? 'The request timed out. Its outcome is unknown; no automatic retry was sent. Previous evidence, if any, remains unchanged.' : error instanceof SyntaxError ? 'The engine returned unreadable evidence. No successful outcome is being inferred.' : error.message || 'Unable to reach the local engine. Check that the server is running.';
    status(message, 'error'); badge(lastRun ? 'PREVIOUS RUN' : 'NO RESULT', 'stale');
    if (lastRun) stale = true;
  } finally {
    clearTimeout(timeout); setBusy(false);
  }
});
downloadButton.addEventListener('click', () => {
  if (!lastRun || running) return;
  const payload = {exportSchemaVersion:1, scenario:lastSettings, result:lastRun};
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2) + '\n'], {type:'application/json'}));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = exportName(lastRun.runId); anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
markSettings();
