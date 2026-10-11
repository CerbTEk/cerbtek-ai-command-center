import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { supabase } from './supabase'
import { clearRecoveryUrl, getRecoveryState, INVALID_RECOVERY, RECOVERY_NOTICE, recoveryRedirect, setRecoveryState, strongPassword, subscribeRecovery } from './password-recovery'

export function ForgotPassword({ initialEmail = '', onBack }) {
  const [email, setEmail] = useState(initialEmail)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  async function submit(event) {
    event.preventDefault()
    if (pending.current || sent) return
    pending.current = true; setBusy(true); setError('')
    try {
      const { error: resultError } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: recoveryRedirect(window.location.origin, import.meta.env.BASE_URL) })
      if (!mounted.current) return
      // Account-specific errors must not reveal whether an address is registered.
      if (resultError && (resultError.status === 429 || resultError.code === 'over_email_send_rate_limit' || resultError.code === 'over_request_rate_limit')) setError('Please wait a few minutes before requesting another reset link.')
      else if (resultError && (!resultError.status || resultError.status >= 500 || ['captcha_failed', 'email_provider_disabled', 'email_address_invalid', 'validation_failed', 'unexpected_failure'].includes(resultError.code))) setError('We couldn’t request a reset link right now. Please try again shortly.')
      else setSent(true)
    } catch {
      if (mounted.current) setError('We couldn’t request a reset link right now. Please check your connection and try again.')
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return <>
    <h1>Reset your password</h1>
    <p>Enter your account email and we’ll send a secure reset link.</p>
    {sent ? <p role="status">{RECOVERY_NOTICE}</p> : <form onSubmit={submit} aria-busy={busy}>
      <label>Email<input type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} required disabled={busy}/></label>
      <button className="primary" disabled={busy}>{busy ? 'Requesting link…' : 'Send reset link'}</button>
    </form>}
    {error && <p role="alert">{error}</p>}
    <button type="button" className="link" disabled={busy} onClick={onBack}>Back to sign in</button>
  </>
}

export default function PasswordRecoveryGate({ children }) {
  const recovery = useSyncExternalStore(subscribeRecovery, getRecoveryState, getRecoveryState)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [request, setRequest] = useState(false)
  const pending = useRef(false)
  const current = useRef(recovery)
  current.current = recovery
  useEffect(() => {
    if (recovery.status !== 'ready') { setPassword(''); setConfirm(''); return }
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (current.current.status === 'ready' && (event === 'SIGNED_OUT' || (session?.user?.id && session.user.id !== current.current.userId))) {
        setRecoveryState({ status: 'invalid', userId: null })
      }
    })
    return () => subscription.unsubscribe()
  }, [recovery.status, recovery.userId])
  async function leave(showRequest = false) {
    if (pending.current) return
    pending.current = true; setBusy(true); setError('')
    try {
      const result = await supabase.auth.signOut({ scope: 'local' })
      if (result.error) throw result.error
      clearRecoveryUrl()
      setPassword(''); setConfirm('')
      if (showRequest) { setRecoveryState({ status: 'invalid', userId: null }); setRequest(true) }
      else { setRequest(false); setRecoveryState({ status: 'idle', userId: null }) }
    } catch { setError('Please try again to close this recovery session securely.') }
    finally { pending.current = false; setBusy(false) }
  }
  async function submit(event) {
    event.preventDefault()
    if (pending.current || recovery.status !== 'ready') return
    setError('')
    if (!strongPassword(password)) { setError('Use at least 12 characters with uppercase, lowercase, a number, and a symbol.'); return }
    if (password !== confirm) { setError('The passwords don’t match. Please enter them again.'); return }
    pending.current = true; setBusy(true)
    const userId = recovery.userId
    try {
      const checked = await supabase.auth.getUser()
      if (checked.error || checked.data?.user?.id !== userId || current.current.status !== 'ready') {
        setRecoveryState({ status: 'invalid', userId: null }); return
      }
      const result = await supabase.auth.updateUser({ password })
      if (result.error) {
        if (['session_not_found', 'refresh_token_not_found', 'user_not_found', 'bad_jwt'].includes(result.error.code) || result.error.status === 401 || result.error.status === 403) setRecoveryState({ status: 'invalid', userId: null })
        else if (result.error.code === 'same_password') setError('Choose a password different from your current password.')
        else if (result.error.code === 'weak_password') setError('This password doesn’t meet the security requirements. Choose a stronger password.')
        else setError('We couldn’t update your password. Please try again.')
      } else if (current.current.status === 'ready' && current.current.userId === userId) {
        setPassword(''); setConfirm('')
        setRecoveryState({ status: 'complete', userId: null })
      }
    } catch { setError('We couldn’t update your password. Please check your connection and try again.') }
    finally { pending.current = false; setBusy(false) }
  }
  if (recovery.status === 'idle') return children
  return <div className="auth-shell"><div className="auth-card">
    <p className="eyebrow">KAIRO ACCOUNT RECOVERY</p>
    {recovery.status === 'loading' ? <p role="status">Checking your reset link…</p> : request ? <ForgotPassword onBack={() => leave(false)}/> : <>
      {recovery.status === 'invalid' ? <><h1>Request a new reset link</h1><p role="alert">{INVALID_RECOVERY}</p><button className="primary" disabled={busy} onClick={() => leave(true)}>Request another link</button></> : recovery.status === 'complete' ? <><h1>Password updated</h1><p role="status">Your new password is saved. Return to sign in with it.</p></> : <>
        <h1>Choose a new password</h1>
        <p>Use a unique password you haven’t used elsewhere.</p>
        <form onSubmit={submit} aria-busy={busy}>
          <label>New password<input type="password" autoComplete="new-password" minLength={12} value={password} onChange={event => setPassword(event.target.value)} required disabled={busy}/></label>
          <small className="password-hint">12+ characters • upper & lowercase • number • symbol</small>
          <label>Confirm new password<input type="password" autoComplete="new-password" minLength={12} value={confirm} onChange={event => setConfirm(event.target.value)} required disabled={busy}/></label>
          <button className="primary" disabled={busy}>{busy ? 'Saving password…' : 'Save new password'}</button>
        </form>
      </>}
      <button type="button" className="link" disabled={busy} onClick={() => leave(false)}>Back to sign in</button>
    </>}
    {error && <p role="alert">{error}</p>}
  </div></div>
}
