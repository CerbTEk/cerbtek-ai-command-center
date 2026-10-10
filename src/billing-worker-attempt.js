import { readSandboxBillingResult } from './billing-worker-model'

// One fixed approved test, shared by all same-origin tabs. Only an exact server
// rejection proving no worker ran may release its own marker. No reset UI or
// automatic retry. Storage and Web Locks are mandatory, never fallbacks.
export const BILLING_ATTEMPT_KEY = 'kairo:billing:approved-sandbox-pass-v1'
const releaseFailures = new WeakSet()
const blocked = message => ({ code: 'client_blocked', message, counters: null, httpStatus: null })
export function sandboxAttemptState(platform = globalThis) {
  try {
    if (typeof platform.navigator?.locks?.request !== 'function') return 'unavailable'
    const storage = platform.localStorage
    if (releaseFailures.has(storage)) return 'attempted'
    return storage.getItem(BILLING_ATTEMPT_KEY) === null ? 'available' : 'attempted'
  } catch { return 'unavailable' }
}

export async function runSandboxBillingOnce(client, { isCurrent, onClaim }, platform = globalThis) {
  try {
    const storage = platform.localStorage
    if (sandboxAttemptState(platform) !== 'available') return blocked('This test is already attempted, or its browser safety checks are unavailable. No new request was sent.')
    return await platform.navigator.locks.request(BILLING_ATTEMPT_KEY, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock || !isCurrent()) return blocked('This test cannot safely start in this view. No request was sent.')
      let marker
      try {
        if (storage.getItem(BILLING_ATTEMPT_KEY) !== null) return blocked('This test was already attempted. No new request was sent.')
        marker = `attempted:${globalThis.crypto.randomUUID()}`
        storage.setItem(BILLING_ATTEMPT_KEY, marker)
        if (storage.getItem(BILLING_ATTEMPT_KEY) !== marker) return blocked('The safety marker could not be verified. No request was sent.')
      } catch { return blocked('The safety marker could not be saved and verified. No request was sent.') }
      onClaim()
      if (!isCurrent()) return blocked('This view changed before dispatch. No request was sent.')
      let response
      try {
        // Existing SDK session only: no token reads, body, explicit headers,
        // caller-selected tenant/job/binding, or automatic retry.
        response = await client.functions.invoke('billing-worker', { method: 'POST' })
      } catch { response = null }
      const result = await readSandboxBillingResult(response)
      if (result.retrySafe === true) {
        // Still inside the exclusive lock. Never erase another tab's marker,
        // and never release host failures, unknown results or any HTTP 200.
        let released = false
        try {
          if (storage.getItem(BILLING_ATTEMPT_KEY) === marker) {
            storage.removeItem(BILLING_ATTEMPT_KEY)
            released = storage.getItem(BILLING_ATTEMPT_KEY) === null
          }
        } catch { /* A retained marker or unavailable storage blocks repeat runs. */ }
        if (!released) {
          // A transient read failure must not re-open this test on the next
          // render/remount. Restore our marker only if the key is still absent;
          // never replace another tab's marker. The local latch also fails shut
          // when persistent storage cannot be repaired.
          releaseFailures.add(storage)
          try { if (storage.getItem(BILLING_ATTEMPT_KEY) === null) storage.setItem(BILLING_ATTEMPT_KEY, marker) } catch { /* Remain blocked. */ }
        }
        return { ...result, retrySafe: released }
      }
      return result
    })
  } catch { return blocked('The browser safety lock is unavailable. No new request was sent.') }
}
