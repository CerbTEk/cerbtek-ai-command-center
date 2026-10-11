// Recovery state contains no credentials. Callback credentials stay only in the
// initialization call and are removed from the current history entry immediately.
export const RECOVERY_NOTICE = 'If an account exists for that email, you’ll receive a password-reset link. Check your inbox and spam folder.'
export const INVALID_RECOVERY = 'This reset link is invalid, expired, or has already been used. Request a new link and open it in the same browser.'
const sensitiveKeys = ['access_token', 'refresh_token', 'provider_token', 'provider_refresh_token', 'token_hash', 'token', 'code', 'error', 'error_code', 'error_description', 'expires_in', 'expires_at', 'token_type', 'type']
let state = { status: 'idle', userId: null }
const listeners = new Set()
export const getRecoveryState = () => state
export function subscribeRecovery(listener) { listeners.add(listener); return () => listeners.delete(listener) }
export function setRecoveryState(next) { state = next; for (const listener of listeners) listener() }
export function recoveryRedirect(origin, base = '/') {
  return `${origin}${base.replace(/\/$/, '')}/app/kairo?recovery=1`
}
export function strongPassword(value) {
  return value.length >= 12 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value) && /[^A-Za-z0-9]/.test(value)
}
export function clearRecoveryUrl(browser = window, keepMarker = false) {
  const url = new URL(browser.location.href)
  for (const key of sensitiveKeys) url.searchParams.delete(key)
  const fragment = new URLSearchParams(url.hash.slice(1))
  if (sensitiveKeys.some(key => fragment.has(key))) url.hash = ''
  if (keepMarker) url.searchParams.set('recovery', '1')
  else url.searchParams.delete('recovery')
  browser.history.replaceState(browser.history.state, '', url.pathname + url.search + url.hash)
}
export function captureRecoveryCallback(browser = window) {
  const url = new URL(browser.location.href)
  const hash = new URLSearchParams(url.hash.slice(1))
  const get = key => hash.get(key) || url.searchParams.get(key)
  const active = url.searchParams.get('recovery') === '1' || get('type') === 'recovery'
  if (!active) return null
  const callback = { type: get('type'), accessToken: get('access_token'), refreshToken: get('refresh_token'), code: get('code'), failed: Boolean(get('error') || get('error_code')) }
  clearRecoveryUrl(browser, true)
  setRecoveryState({ status: 'loading', userId: null })
  return callback
}
export async function initializeRecovery(auth, callback) {
  if (!callback) return
  try {
    let result
    if (callback.failed) throw new Error('Invalid recovery')
    if (callback.type === 'recovery' && callback.accessToken && callback.refreshToken) {
      result = await auth.setSession({ access_token: callback.accessToken, refresh_token: callback.refreshToken })
    } else if (callback.code) {
      result = await auth.exchangeCodeForSession(callback.code)
      // The verifier must have originated from a password-recovery request.
      if (result.data?.redirectType !== 'recovery') throw new Error('Invalid recovery')
    } else throw new Error('Invalid recovery')
    if (result.error || !result.data?.session?.user?.id) throw new Error('Invalid recovery')
    setRecoveryState({ status: 'ready', userId: result.data.session.user.id })
  } catch {
    setRecoveryState({ status: 'invalid', userId: null })
  } finally {
    // Do not keep credentials alive in a module variable or log provider errors.
    for (const key of Object.keys(callback)) callback[key] = null
  }
}
