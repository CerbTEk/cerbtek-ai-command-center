import { useEffect, useRef, useState } from 'react'

// A ref takes the lock before React paints. Keyed sections and this scope check
// prevent a late response from updating or redirecting a different account.
export function useSafeOperation(scope) {
  const currentScope = useRef(scope)
  currentScope.current = scope
  const mounted = useRef(true)
  const lock = useRef(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    mounted.current = true
    lock.current = null
    setBusy(false)
    return () => { mounted.current = false; lock.current = null }
  }, [scope])
  async function run(operation, onError) {
    if (lock.current) return
    const token = { scope }
    lock.current = token
    setBusy(true)
    const isCurrent = () => mounted.current && currentScope.current === scope && lock.current === token
    try { await operation(isCurrent) }
    catch (error) { if (isCurrent()) onError?.(error) }
    finally { if (isCurrent()) { lock.current = null; setBusy(false) } }
  }
  return { busy, run }
}

const attempts = new Map()
function readAttempt(key) {
  if (attempts.has(key)) return attempts.get(key)
  try { return window.sessionStorage.getItem(key) || null } catch { return null }
}
export function useExecutionAttempts(scope) {
  const [, redraw] = useState(0)
  const keyFor = id => `kairo:execution-attempt:${scope}:${id}`
  const get = id => readAttempt(keyFor(id))
  // Save before dispatch. An unmount, dropped response, reload or route change
  // cannot turn an uncertain execution into another offered send/run.
  const mark = (id, outcome = 'review') => {
    const key = keyFor(id)
    attempts.set(key, outcome)
    try { window.sessionStorage.setItem(key, outcome) } catch { /* Memory still blocks in this session. */ }
    redraw(value => value + 1)
  }
  const clear = id => {
    const key = keyFor(id)
    attempts.delete(key)
    try { window.sessionStorage.removeItem(key) } catch { /* No persisted value can be removed in this context. */ }
    redraw(value => value + 1)
  }
  return { get, mark, clear }
}

export const needsReconciliation = data => data?.status === 'Executing' || data?.retryable === false && data?.ok === false || ['unknown', 'provider_accepted_needs_reconciliation', 'not_dispatched_needs_reconciliation'].includes(data?.outcome)
export const acceptedEmail = data => data?.ok === true && data?.status === 'Executed' && data?.outcome === 'provider_accepted'
export const reviewEmailMessage = data => data?.outcome === 'provider_accepted_needs_reconciliation'
  ? 'Microsoft accepted the email; its saved record needs review. Do not resend. Delivery is not confirmed.'
  : 'Email outcome needs review. Do not resend. Check the saved request and Microsoft account before taking any further action.'
