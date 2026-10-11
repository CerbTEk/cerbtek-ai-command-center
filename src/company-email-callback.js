// Short-lived, tab-local OAuth proofs. Never put either proof into a query string,
// logs, analytics, localStorage, or a provider authorization URL.
const PREFIX = 'kairo:company-email-proof:'
const RETURN_KEY = 'kairo:company-email-return'
const MAX_AGE = 15 * 60 * 1000
const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(value)
const stateOK = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const providerOK = value => ['microsoft', 'google'].includes(value)
const proofKey = (provider, state) => `${PREFIX}${provider}:${state}`
const fail = message => { const error = new Error(message); error.notApplied = true; throw error }
function sessionStorageFor(runtime) { try { return runtime.sessionStorage } catch { return null } }
function read(storage, key) { try { return JSON.parse(storage.getItem(key) || 'null') } catch { return null } }
function fresh(record) { return record && Number.isFinite(record.created_at) && record.created_at <= Date.now() + 1000 && Date.now() - record.created_at < MAX_AGE }
export async function prepareBrowserProof({ organizationId, actorId, provider }, runtime = window) {
  if (!providerOK(provider) || !organizationId || !actorId) fail('browser_proof_unavailable')
  try { runtime.sessionStorage.setItem(`${PREFIX}check`, 'ok'); runtime.sessionStorage.removeItem(`${PREFIX}check`) } catch { fail('browser_storage_required') }
  if (!runtime.crypto?.subtle || !runtime.crypto?.getRandomValues) fail('browser_crypto_required')
  const bytes = runtime.crypto.getRandomValues(new Uint8Array(32))
  const verifier = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
  const digest = await runtime.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const challenge = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
  return { challenge, record: { organization_id: organizationId, actor_id: actorId, provider, browser_verifier: verifier, created_at: Date.now() } }
}
export function saveBrowserProof(record, authorization, runtime = window) {
  const state = new URL(authorization.authorize_url).searchParams.get('state')
  if (!stateOK(state) || !authorization.connection_id || !token(record.browser_verifier)) fail('browser_proof_unavailable')
  const saved = { ...record, state, connection_id: authorization.connection_id }
  try {
    runtime.sessionStorage.setItem(proofKey(record.provider, state), JSON.stringify(saved))
    if (read(sessionStorageFor(runtime), proofKey(record.provider, state))?.browser_verifier !== record.browser_verifier) fail('browser_storage_required')
  } catch { fail('browser_storage_required') }
}
export function captureCompanyEmailReturn(runtime = window) {
  const url = new URL(runtime.location.href), fragment = new URLSearchParams(url.hash.replace(/^#/, ''))
  const failedProvider = ['microsoft', 'google'].find(provider => url.searchParams.get(provider) === 'error')
  if (!failedProvider && !fragment.has('email_oauth_state') && !fragment.has('email_oauth_completion') && !['microsoft', 'google'].some(provider => url.searchParams.get(provider) === 'consent_returned')) return
  const state = fragment.get('email_oauth_state'), provider = fragment.get('email_oauth_provider'), completion = fragment.get('email_oauth_completion')
  // Remove all return credentials before authentication, rendering or navigation.
  url.hash = 'Integrations'; url.searchParams.delete('google'); url.searchParams.delete('microsoft'); url.searchParams.delete('message')
  runtime.history.replaceState(runtime.history.state, '', url.pathname + url.search + url.hash)
  let marker = { error: failedProvider ? 'provider_authorization_failed' : 'missing_browser_proof' }
  if (!failedProvider && providerOK(provider) && stateOK(state) && token(completion)) {
    const key = proofKey(provider, state), record = read(sessionStorageFor(runtime), key)
    if (fresh(record) && record.provider === provider && record.state === state && token(record.browser_verifier)) {
      try {
        runtime.sessionStorage.setItem(key, JSON.stringify({ ...record, completion_secret: completion, completion_received_at: Date.now() }))
        marker = { provider, state }
      } catch { marker = { error: 'browser_storage_required' } }
    }
  }
  try { runtime.sessionStorage.setItem(RETURN_KEY, JSON.stringify(marker)) } catch { /* Rendering still cannot finalize without both local proofs. */ }
}
export function companyEmailReturn(runtime = window) {
  const marker = read(sessionStorageFor(runtime), RETURN_KEY)
  if (!marker || marker.error) return marker
  const record = read(sessionStorageFor(runtime), proofKey(marker.provider, marker.state))
  if (!fresh(record) || !Number.isFinite(record.completion_received_at) || Date.now() - record.completion_received_at >= 5 * 60 * 1000 || !token(record.browser_verifier) || !token(record.completion_secret)) return { error: 'missing_browser_proof' }
  return { provider: record.provider, state: record.state, organization_id: record.organization_id, actor_id: record.actor_id, connection_id: record.connection_id, attempted: record.attempted === true }
}
export function finalizationProof(organizationId, actorId, runtime = window) {
  const pending = companyEmailReturn(runtime)
  if (!pending || pending.error) fail('missing_browser_proof')
  if (pending.organization_id !== organizationId || pending.actor_id !== actorId) fail('email_return_context_mismatch')
  const record = read(sessionStorageFor(runtime), proofKey(pending.provider, pending.state))
  return { ...pending, browser_verifier: record.browser_verifier, completion_secret: record.completion_secret }
}
export function markFinalizationAttempt(provider, state, runtime = window) {
  const key = proofKey(provider, state), record = read(sessionStorageFor(runtime), key)
  if (!fresh(record)) fail('missing_browser_proof')
  try { runtime.sessionStorage.setItem(key, JSON.stringify({ ...record, attempted: true })) } catch { fail('browser_storage_required') }
}
export function clearCompanyEmailReturn(provider, state, runtime = window) {
  try { runtime.sessionStorage.removeItem(proofKey(provider, state)); runtime.sessionStorage.removeItem(RETURN_KEY) } catch { /* A server-consumed state cannot grant twice. */ }
}
