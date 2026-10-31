/** Pure presentation boundary: invalid evidence never becomes a success badge. */
const STATES = new Set(['verified', 'failed', 'pending', 'needs_review']);
const integer = value => Number.isSafeInteger(value) && value >= 0;
export function validateRun(data) {
  if (!data || typeof data !== 'object' || typeof data.runId !== 'string' || !data.runId || data.runId.length > 200) throw new Error('The engine returned an invalid run identifier.');
  for (const name of ['naive', 'reconcile']) {
    const policy = data[name];
    if (!policy || !STATES.has(policy.state) || !['attempts', 'records', 'duplicates'].every(key => integer(policy[key]))) throw new Error('The engine returned incomplete outcome evidence.');
    if (!Array.isArray(policy.events) || !policy.events.every(event => event && typeof event.state === 'string' && typeof event.reason === 'string')) throw new Error('The engine returned an invalid audit journal.');
    if (policy.receipt !== null && (typeof policy.receipt !== 'object' || !policy.receipt || !integer(policy.receipt.id) || policy.receipt.id === 0 || typeof policy.receipt.reference !== 'string' || !integer(policy.receipt.amount))) throw new Error('The engine returned an invalid receipt.');
    if (!Array.isArray(policy.history) || !policy.history.every(row => row && typeof row.state === 'string' && typeof row.elapsedMs === 'number' && Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0)) throw new Error('The engine returned invalid recovery history.');
  }
  if (!data.summary || typeof data.summary !== 'object') throw new Error('The engine returned no run summary.');
  return data;
}
export function presentation(policy) {
  const label = {verified:'Verified', failed:'Failed', pending:'Pending evidence', needs_review:'Needs review'}[policy.state] || 'Unknown';
  const tone = policy.duplicates > 0 ? 'danger' : policy.state === 'needs_review' ? 'review' : policy.state === 'pending' ? 'pending' : policy.state === 'failed' ? 'danger' : 'success';
  let note;
  if (policy.duplicates > 0) note = `${policy.duplicates} duplicate ${policy.duplicates === 1 ? 'record was' : 'records were'} created. A verified acknowledgement does not erase duplicate side effects.`;
  else if (policy.state === 'needs_review') note = 'Outcome unresolved. Human review is required; the engine has not treated missing evidence as permission to resubmit.';
  else if (policy.state === 'pending') note = 'Evidence is still pending. This result does not prove failure or authorize another submission.';
  else if (policy.state === 'failed') note = 'The policy did not verify completion. Inspect the journal for its actual decision and evidence.';
  else note = 'Completion verified with no duplicate records observed by the fixture oracle.';
  return {label, tone, note};
}
export function settingsLabel(settings) {
  const modes = {observable:'Observable', opaque:'Opaque', idempotent:'Idempotent'};
  const faults = {none:'No interruption', before_commit:'Before commit', after_commit:'After commit'};
  return `${modes[settings.mode]} · ${faults[settings.fault]} · ${settings.visibilityDelayMs} ms visibility delay`;
}
export function exportName(id) { return `checkpoint-${String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)}.json`; }


/** Theme state is independent of run state; blocked storage never blocks recovery. */
export const themePreference = value => value === 'light' || value === 'dark' ? value : null;
export const resolveTheme = (preference, systemDark) => themePreference(preference) || (systemDark ? 'dark' : 'light');
export function createThemeController({root, button, systemButton, status, meta, media, storage}) {
  const read = () => { try { return themePreference(storage?.getItem('checkpoint-theme')); } catch { return null; } };
  let preference = read();
  function render(announce = false) {
    const current = resolveTheme(preference, media.matches);
    root.dataset.theme = current;
    button.hidden = false;
    button.textContent = current === 'dark' ? '☾ Dark' : '☀ Light';
    button.setAttribute('aria-pressed', String(current === 'dark'));
    button.setAttribute('title', `Switch to ${current === 'dark' ? 'light' : 'dark'} theme`);
    systemButton.hidden = preference === null;
    meta?.setAttribute('content', current === 'dark' ? '#181d18' : '#f5f3ed');
    if (announce) status.textContent = `${current === 'dark' ? 'Dark' : 'Light'} theme. ${preference === null ? 'Following system preference.' : 'Personal preference selected.'}`;
  }
  function setPreference(value) {
    preference = themePreference(value);
    try { if (preference === null) storage?.removeItem('checkpoint-theme'); else storage?.setItem('checkpoint-theme', preference); } catch {}
    render(true);
  }
  button.addEventListener('click', () => setPreference(resolveTheme(preference, media.matches) === 'dark' ? 'light' : 'dark'));
  systemButton.addEventListener('click', () => setPreference(null));
  const change = () => { if (preference === null) render(true); };
  if (media.addEventListener) media.addEventListener('change', change);
  else media.addListener?.(change);
  render();
  return {setPreference, sync() { preference = read(); render(true); }};
}
