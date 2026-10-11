import React from 'react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
const api = vi.hoisted(() => ({ resetPasswordForEmail: vi.fn(), getUser: vi.fn(), updateUser: vi.fn(), signOut: vi.fn(), onAuthStateChange: vi.fn(), getSession: vi.fn(), from: vi.fn() }))
vi.mock('../src/supabase', () => ({ supabase: { auth: api, from: api.from } }))
import PasswordRecoveryGate, { ForgotPassword } from '../src/PasswordRecovery'
import { App } from '../src/main'
import { captureRecoveryCallback, getRecoveryState, initializeRecovery, RECOVERY_NOTICE, recoveryRedirect, setRecoveryState } from '../src/password-recovery'
let emit
beforeEach(() => {
  vi.resetAllMocks()
  window.history.replaceState({}, '', '/app/kairo')
  setRecoveryState({ status: 'idle', userId: null })
  api.resetPasswordForEmail.mockResolvedValue({ error: null })
  api.signOut.mockResolvedValue({ error: null })
  api.getUser.mockResolvedValue({ data: { user: { id: 'synthetic-user' } }, error: null })
  api.getSession.mockResolvedValue({ data: { session: null }, error: null })
  api.updateUser.mockResolvedValue({ data: { user: { id: 'synthetic-user' } }, error: null })
  api.onAuthStateChange.mockImplementation(callback => { emit = callback; return { data: { subscription: { unsubscribe: vi.fn() } } } })
})
afterEach(() => { cleanup(); setRecoveryState({ status: 'idle', userId: null }); window.history.replaceState({}, '', '/') })
function ready() { setRecoveryState({ status: 'ready', userId: 'synthetic-user' }); return render(<PasswordRecoveryGate><div>Private workspace</div></PasswordRecoveryGate>) }
function fill(password = 'Synthetic-pass-123', confirm = password) {
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: password } })
  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: confirm } })
}
it('exposes the missing link, preserves email, clears the sign-in password, and returns to sign-in', async () => {
  render(<App/>); await screen.findByRole('heading', { name: 'Sign in' })
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'synthetic@example.invalid' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'not-real' } })
  fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }))
  expect(screen.getByLabelText('Email').value).toBe('synthetic@example.invalid')
  fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }))
  expect(screen.getByLabelText('Password').value).toBe('')
  expect(api.from).not.toHaveBeenCalled()
})
it('requests the exact nested callback and gives a non-enumerating response', async () => {
  render(<ForgotPassword initialEmail="synthetic@example.invalid" onBack={() => {}}/>)
  fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }))
  await screen.findByText(RECOVERY_NOTICE)
  expect(api.resetPasswordForEmail).toHaveBeenCalledWith('synthetic@example.invalid', { redirectTo: `${window.location.origin}/app/kairo?recovery=1` })
  expect(recoveryRedirect('https://example.invalid', '/mount/')).toBe('https://example.invalid/mount/app/kairo?recovery=1')
})
it.each([{ status: 400, code: 'user_not_found' }, { status: 422, code: 'email_not_confirmed' }])('does not reveal an account-specific failure: %j', async error => {
  api.resetPasswordForEmail.mockResolvedValue({ error })
  render(<ForgotPassword initialEmail="synthetic@example.invalid" onBack={() => {}}/>)
  fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }))
  await screen.findByText(RECOVERY_NOTICE)
})
it('blocks repeated submissions while pending and handles request throttling safely', async () => {
  let resolve
  api.resetPasswordForEmail.mockImplementation(() => new Promise(r => { resolve = r }))
  render(<ForgotPassword initialEmail="synthetic@example.invalid" onBack={() => {}}/>)
  fireEvent.submit(screen.getByRole('button', { name: 'Send reset link' }).closest('form'))
  fireEvent.submit(screen.getByRole('button', { name: 'Requesting link…' }).closest('form'))
  expect(api.resetPasswordForEmail).toHaveBeenCalledTimes(1)
  await act(async () => resolve({ error: { status: 429 } }))
  expect(screen.getByRole('alert').textContent).toContain('wait a few minutes')
})
it('handles request transport failure without claiming an email was sent', async () => {
  api.resetPasswordForEmail.mockRejectedValue(new Error('synthetic error'))
  render(<ForgotPassword initialEmail="synthetic@example.invalid" onBack={() => {}}/>)
  fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }))
  await screen.findByRole('alert')
  expect(screen.queryByText(RECOVERY_NOTICE)).toBeNull()
})
it('strips sensitive callback query and fragment from the existing history entry before exchange', async () => {
  window.history.replaceState({}, '', '/app/kairo?recovery=1&code=synthetic-code#access_token=synthetic-access&refresh_token=synthetic-refresh&type=recovery')
  const length = window.history.length
  const callback = captureRecoveryCallback()
  expect(window.location.search).toBe('?recovery=1'); expect(window.location.hash).toBe(''); expect(window.history.length).toBe(length)
  const auth = { setSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: 'synthetic-user' } } }, error: null }) }
  await initializeRecovery(auth, callback)
  expect(auth.setSession).toHaveBeenCalledWith({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' })
  expect(getRecoveryState()).toEqual({ status: 'ready', userId: 'synthetic-user' })
  expect(Object.values(callback).every(value => value === null)).toBe(true)
})
it.each(['?recovery=1', '?recovery=1#error=access_denied&error_description=do-not-display', '?recovery=1#type=recovery&access_token=partial'])('rejects missing, expired, and malformed recovery callbacks (%s), even with an existing session', async suffix => {
  window.history.replaceState({}, '', '/app/kairo' + suffix)
  const auth = { setSession: vi.fn(), getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: 'existing' } } } }) }
  await initializeRecovery(auth, captureRecoveryCallback())
  expect(getRecoveryState().status).toBe('invalid'); expect(auth.setSession).not.toHaveBeenCalled(); expect(auth.getSession).not.toHaveBeenCalled()
  expect(window.location.href).not.toContain('do-not-display')
})
it('handles session establishment failure without exposing provider error text or mounting private app', async () => {
  await initializeRecovery({ setSession: vi.fn().mockRejectedValue(new Error('secret-provider-error')) }, { type: 'recovery', accessToken: 'synthetic', refreshToken: 'synthetic' })
  render(<PasswordRecoveryGate><div>Private workspace</div></PasswordRecoveryGate>)
  expect(screen.queryByText('Private workspace')).toBeNull(); expect(screen.getByRole('alert').textContent).toContain('invalid, expired')
  expect(document.body.textContent).not.toContain('secret-provider-error')
})
it('accepts a recovery PKCE verifier but rejects ordinary login code exchanges', async () => {
  for (const type of ['recovery', null]) {
    await initializeRecovery({ exchangeCodeForSession: vi.fn().mockResolvedValue({ data: { redirectType: type, session: { user: { id: 'synthetic-user' } } } }) }, { code: 'synthetic' })
    expect(getRecoveryState().status).toBe(type ? 'ready' : 'invalid')
  }
})
it('validates strength and confirmation before updating', () => {
  ready(); fill('weak', 'weak'); fireEvent.submit(screen.getByRole('button', { name: 'Save new password' }).closest('form'))
  expect(screen.getByRole('alert').textContent).toContain('12 characters')
  fill('Synthetic-pass-123', 'Mismatch-pass-456'); fireEvent.submit(screen.getByRole('button', { name: 'Save new password' }).closest('form'))
  expect(screen.getByRole('alert').textContent).toContain('don’t match'); expect(api.updateUser).not.toHaveBeenCalled()
})
it('holds recovery ahead of workspace, saves once, then signs out locally before returning to sign-in', async () => {
  ready(); fill(); fireEvent.click(screen.getByRole('button', { name: 'Save new password' }))
  await screen.findByRole('heading', { name: 'Password updated' })
  expect(api.updateUser).toHaveBeenCalledTimes(1); expect(screen.queryByText('Private workspace')).toBeNull(); expect(screen.queryByLabelText('New password')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }))
  await screen.findByText('Private workspace')
  expect(api.signOut).toHaveBeenCalledWith({ scope: 'local' }); expect(window.location.search).toBe('')
})
it('blocks repeated password submissions while identity verification is pending', async () => {
  let resolve
  api.getUser.mockImplementation(() => new Promise(r => { resolve = r }))
  ready(); fill(); const form = screen.getByRole('button', { name: 'Save new password' }).closest('form')
  fireEvent.submit(form); fireEvent.submit(form); expect(api.getUser).toHaveBeenCalledTimes(1)
  await act(async () => resolve({ data: { user: { id: 'synthetic-user' } } }))
  expect(api.updateUser).toHaveBeenCalledTimes(1)
})
it('rejects an account switch or expired session rather than updating the wrong account', async () => {
  api.getUser.mockResolvedValue({ data: { user: { id: 'another-user' } } })
  ready(); fill(); fireEvent.click(screen.getByRole('button', { name: 'Save new password' }))
  await screen.findByRole('heading', { name: 'Request a new reset link' }); expect(api.updateUser).not.toHaveBeenCalled()
})
it('clears entered passwords on sign-out and denies a subsequent update', async () => {
  ready(); fill()
  act(() => emit('SIGNED_OUT', null))
  expect(screen.queryByLabelText('New password')).toBeNull(); expect(screen.getByRole('heading', { name: 'Request a new reset link' })).toBeTruthy()
  expect(api.updateUser).not.toHaveBeenCalled()
})
it.each([{ code: 'same_password', expected: 'different' }, { code: 'weak_password', expected: 'stronger' }, { code: 'session_not_found', expected: 'invalid, expired' }])('shows safe update failure for $code', async ({ code, expected }) => {
  api.updateUser.mockResolvedValue({ error: { code, message: 'do-not-display' } })
  ready(); fill(); fireEvent.click(screen.getByRole('button', { name: 'Save new password' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(expected))
  expect(document.body.textContent).not.toContain('do-not-display')
})
it('keeps recovery closed to workspace if secure sign-out fails and allows retry', async () => {
  api.signOut.mockResolvedValueOnce({ error: { message: 'failure' } }).mockResolvedValueOnce({ error: null })
  ready(); fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }))
  await screen.findByRole('alert'); expect(screen.queryByText('Private workspace')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }))
  await screen.findByText('Private workspace')
})
it('offers another request after an invalid callback', async () => {
  setRecoveryState({ status: 'invalid', userId: null })
  render(<PasswordRecoveryGate><div>Private workspace</div></PasswordRecoveryGate>)
  fireEvent.click(screen.getByRole('button', { name: 'Request another link' }))
  await screen.findByRole('heading', { name: 'Reset your password' })
  expect(screen.queryByText('Private workspace')).toBeNull()
})
