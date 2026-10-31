/** Product presentation boundary. Network and business success are kept distinct. */
const STATES = new Set(['queued','delivering','delivered','unknown','failed','needs_review']);
export const stateLabel = state => ({queued:'Ready to send',delivering:'Sending',delivered:'HTTP acknowledged',unknown:'Outcome unknown',failed:'Failed',needs_review:'Needs review'}[state] || 'Unrecognized state');
export function validateDelivery(value) {
  if (!value || typeof value !== 'object' || !['id','reference','destination','createdAt','updatedAt'].every(key=>typeof value[key] === 'string') || !value.id || !STATES.has(value.state) || !Array.isArray(value.attempts) || !Array.isArray(value.events) || typeof value.canRetrySafely !== 'boolean') throw new Error('The server returned an incomplete delivery record.');
  if (!value.events.every(event=>event && typeof event.state==='string' && typeof event.reason==='string')) throw new Error('The delivery journal is unreadable.');
  return value;
}
export function actionAvailability(delivery) {
  const active = delivery.state === 'delivering';
  return {send:delivery.state==='queued', reconcile:!active && Boolean(delivery.lookup) && ['unknown','failed','needs_review'].includes(delivery.state), retry:!active && !['queued','delivered'].includes(delivery.state), riskRequired:delivery.canRetrySafely !== true};
}
export function outcomeExplanation(delivery) {
  switch(delivery.state) {
    case 'queued':return 'Saved, not sent. Review the destination and payload before making a real HTTP POST.';
    case 'delivering':return 'A send is in progress or was interrupted. Do not assume that no response means no side effect.';
    case 'delivered':return 'The destination acknowledged the HTTP request, or a receipt matched the configured lookup. This does not independently prove that the business action committed.';
    case 'unknown':return 'No conclusive acknowledgement was received. The destination may already have acted. Look up a receipt before considering another POST.';
    case 'needs_review':return 'The available evidence did not uniquely resolve this delivery. An empty or conflicting lookup does not authorize a safe retry.';
    default:return 'The attempt did not establish successful delivery. Review its actual status and reason. Retry safety is determined by the server.';
  }
}
export function httpsURL(text, label='Destination') {
  let url;try{url=new URL(text);}catch{throw new Error(`${label} must be a valid public HTTPS URL.`);}
  if(url.protocol!=='https:' || url.username || url.password || url.hash)throw new Error(`${label} requires HTTPS, no embedded credentials, and no URL fragment.`);
  return url.href;
}
export function createInput({destination,reference,payloadText,idempotencyEnabled,idempotencyHeader,idempotencyKey,lookupURL,recordsPointer,referencePointer}) {
  let payload;try{payload=JSON.parse(payloadText);}catch{throw new Error('Enter a valid JSON payload before creating the delivery.');}
  if(new TextEncoder().encode(JSON.stringify(payload)).length>16384)throw new Error('The JSON payload exceeds 16 KiB.');
  if(typeof reference!=='string'||!reference.trim()||reference.trim().length>120)throw new Error('Choose a delivery reference between 1 and 120 characters.');
  const ref=reference.trim();
  return {destination:httpsURL(destination),reference:ref,payload,
    idempotency:idempotencyEnabled?{header:idempotencyHeader.trim()||'Idempotency-Key',key:idempotencyKey?.trim()||ref,contract:true}:null,
    lookup:lookupURL.trim()?{url:httpsURL(lookupURL,'Lookup'),recordsPointer:recordsPointer.trim()||'/receipts',referencePointer:referencePointer.trim()||'/reference'}:null,credential:null};
}
export function exportName(id) {return `checkpoint-${String(id).replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,80)}.json`;}

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
