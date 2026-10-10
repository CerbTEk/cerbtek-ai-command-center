import React, { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createClient } from '@supabase/supabase-js'
import BillingSandboxRun from '../src/BillingSandboxRun'
import BillingStatus from '../src/BillingStatus'
import { BILLING_ATTEMPT_KEY, runSandboxBillingOnce, sandboxAttemptState } from '../src/billing-worker-attempt'
import { BILLING_SANDBOX_OPERATOR as actor, BILLING_SANDBOX_ORGANIZATION as orgId, BILLING_SANDBOX_ORIGIN as origin, canRunSandboxBilling, readSandboxBillingResult } from '../src/billing-worker-model'

const session = { user: { id: actor } }
const snapshot = { contract: 'billing_status_v1', organization_id: orgId, actor_id: actor, actor_role: 'owner', authorized: true, commercial_actions_enabled: false, integration_state: 'not_configured', provider: null, customer_bound: false, binding_count: 0, credential_state: 'not_verified', webhook_state: 'not_verified', subscription_count: 0, unresolved_receipts: 0, policy_versions: 0, usage_scope: 'lifetime_observations_only', customer_charge: null, usage: [] }
const outcome = patch => ({ code: 'billing_worker_run', discovered: 1, claimed: 1, completed: 1, superseded: 0, retried: 0, lease_lost: 0, errors: [], ...patch })
const success = patch => ({ data: outcome(patch), error: null, response: { status: 200 } })
const inactive = () => { const context = { status: 503, json: async () => ({ code: 'billing_inactive' }) }; return { data: null, error: { name: 'FunctionsHttpError', context }, response: context } }
let client
const button = () => screen.getByRole('button', { name: 'Run one sandbox billing pass' })
const fixture = props => render(<BillingSandboxRun snapshot={snapshot} session={session} client={client} {...props}/>)
beforeEach(() => {
  vi.stubGlobal('location', { origin })
  vi.stubGlobal('navigator', { locks: { request: vi.fn(async (_name, _options, callback) => callback({ name: BILLING_ATTEMPT_KEY })) } })
  // Each case has a distinct browser-storage identity so a deliberate safety
  // failure in one simulated browser cannot authorize/reset another case.
  const backingStorage = window.localStorage
  vi.stubGlobal('localStorage', Object.fromEntries(['getItem', 'setItem', 'removeItem', 'clear'].map(name => [name, backingStorage[name].bind(backingStorage)])))
  window.localStorage.clear()
  client = { functions: { invoke: vi.fn().mockResolvedValue(inactive()) } }
})
afterEach(() => {
  cleanup()
  window.localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})

describe('sandbox billing guard and response contract', () => {
  it('requires the exact origin, operator, QA company and verified owner role', () => {
    expect(canRunSandboxBilling(snapshot, session, origin)).toBe(true)
    for (const wrongOrigin of ['https://cerbtek.com', 'https://www.cerbtek.com.evil.test', 'http://www.cerbtek.com', 'null', undefined]) expect(canRunSandboxBilling(snapshot, session, wrongOrigin)).toBe(false)
    for (const patch of [{ actor_role: 'admin' }, { actor_role: 'viewer' }, { actor_id: 'another-owner' }, { organization_id: 'another-company' }, { authorized: false }, { commercial_actions_enabled: true }]) expect(canRunSandboxBilling({ ...snapshot, ...patch }, session, origin)).toBe(false)
    for (const wrongSession of [null, { user: { id: 'another-owner' } }, { user: { id: actor, is_anonymous: true } }]) expect(canRunSandboxBilling(snapshot, wrongSession, origin)).toBe(false)
  })
  it('reads an actual non-2xx status from the SDK HTTP error context', async () => {
    const result = await readSandboxBillingResult(inactive())
    expect(result.code).toBe('billing_inactive'); expect(result.httpStatus).toBe(503)
    expect(JSON.stringify(result)).not.toContain('never-display')
  })
  it('retains only bounded report counters', async () => {
    const value = await readSandboxBillingResult(success({ secret: 'never-display' }))
    expect(value.code).toBe('billing_worker_run'); expect(value.counters.completed).toBe(1)
    expect(JSON.stringify(value)).not.toContain('never-display')
  })
  it.each([
    null, { data: { ok: true }, response: { status: 200 } }, { data: { code: 'billing_inactive' }, response: { status: 200 } },
    { data: outcome() }, success({ completed: 2 }), success({ claimed: 0 }), success({ retried: 1 }), success({ claimed: 1.5 }),
    success({ errors: ['secret'] }), success({ code: 'arbitrary-secret' }), { error: new Error('never-display') },
  ])('does not infer success from incomplete or contradictory responses: %#', async response => {
    const result = await readSandboxBillingResult(response)
    expect(result.code).toBe('outcome_unknown'); expect(result.counters).toBeNull()
    expect(JSON.stringify(result)).not.toContain('never-display')
  })
  it('reports no completed job for an empty, superseded, or deferred pass', async () => {
    for (const patch of [
      { discovered: 0, claimed: 0, completed: 0 },
      { completed: 0, superseded: 1 },
      { completed: 0, retried: 1, errors: ['provider_unavailable'] },
      { completed: 0, lease_lost: 1, errors: ['worker_lease_lost'] },
    ]) {
      const result = await readSandboxBillingResult(success(patch))
      expect(result.code).toBe('billing_worker_run'); expect(result.message).toContain('No completed job')
    }
  })
})

describe('one manual owner sandbox invocation', () => {
  it('does not invoke on render or StrictMode replay', () => {
    render(<StrictMode><BillingSandboxRun snapshot={snapshot} session={session} client={client}/></StrictMode>)
    expect(button().disabled).toBe(false); expect(client.functions.invoke).not.toHaveBeenCalled()
  })
  it('dispatches an empty POST exactly once and latches before a second click', async () => {
    let resolve
    client.functions.invoke.mockReturnValue(new Promise(done => { resolve = done }))
    fixture(); const run = button(); fireEvent.click(run); fireEvent.click(run)
    expect(run.disabled).toBe(true)
    expect(client.functions.invoke).toHaveBeenCalledExactlyOnceWith('billing-worker', { method: 'POST' })
    await act(async () => resolve(inactive()))
    expect(screen.getByText('Server result: billing_inactive (HTTP 503)')).toBeTruthy()
    expect(run.disabled).toBe(false); expect(document.body.textContent).not.toContain('never-display')
  })
  it.each(['completed', 'network-error', 'malformed'])('keeps %s latched through unmount and reopen', async kind => {
    client.functions.invoke.mockImplementation(async () => {
      if (kind === 'network-error') throw new Error('never-display')
      return kind === 'completed' ? success() : { data: { ok: true }, response: { status: 200 } }
    })
    const view = fixture(); fireEvent.click(button())
    await screen.findByText(/Server result:|Outcome unknown\./)
    view.unmount(); fixture()
    expect(button().disabled).toBe(true)
    expect(screen.getByText(/previously attempted/)).toBeTruthy()
    fireEvent.click(button()); expect(client.functions.invoke).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).not.toContain('never-display')
  })
  it('does not restore a dismissed result after sign-out or company switch', async () => {
    let resolve
    client.functions.invoke.mockReturnValue(new Promise(done => { resolve = done }))
    const view = fixture(); fireEvent.click(button())
    view.rerender(<BillingSandboxRun snapshot={snapshot} session={null} client={client}/>)
    expect(screen.queryByRole('button')).toBeNull()
    await act(async () => resolve(success()))
    expect(screen.queryByText(/Server result:/)).toBeNull()
    view.rerender(<BillingSandboxRun snapshot={{ ...snapshot, organization_id: 'other' }} session={session} client={client}/>)
    expect(screen.queryByRole('button')).toBeNull()
    view.rerender(<BillingSandboxRun snapshot={snapshot} session={session} client={client}/>)
    expect(button().disabled).toBe(true); expect(client.functions.invoke).toHaveBeenCalledTimes(1)
  })
  it('hides the control on role demotion and other origins without invoking', () => {
    const view = fixture({ snapshot: { ...snapshot, actor_role: 'admin' } })
    expect(screen.queryByRole('button')).toBeNull()
    vi.stubGlobal('location', { origin: 'https://cerbtek.com' })
    view.rerender(<BillingSandboxRun snapshot={snapshot} session={session} client={client}/>)
    expect(screen.queryByRole('button')).toBeNull(); expect(client.functions.invoke).not.toHaveBeenCalled()
  })
  it('mounts only after a verified BillingStatus response and does not auto-run', async () => {
    client.functions.invoke.mockResolvedValue({ data: snapshot, error: null })
    render(<BillingStatus org={{ id: orgId, name: 'QA Company' }} session={session} members={[{ user_id: actor, role: 'owner' }]} client={client}/>)
    expect(screen.queryByRole('button', { name: 'Run one sandbox billing pass' })).toBeNull()
    await screen.findByRole('button', { name: 'Run one sandbox billing pass' })
    expect(client.functions.invoke).toHaveBeenCalledExactlyOnceWith('billing-status', { body: { organization_id: orgId } })
  })
})

describe('billing-only persistent safety latch', () => {
  const execute = options => runSandboxBillingOnce(client, { isCurrent: () => true, onClaim: vi.fn(), ...options })
  it('fails closed when Web Locks are unavailable', async () => {
    vi.stubGlobal('navigator', {})
    expect(sandboxAttemptState()).toBe('unavailable')
    expect((await execute()).code).toBe('client_blocked')
    expect(client.functions.invoke).not.toHaveBeenCalled()
    fixture(); expect(button().disabled).toBe(true)
  })
  it('fails closed when another tab holds the lock', async () => {
    navigator.locks.request.mockImplementation(async (_name, options, callback) => {
      expect(options).toEqual({ mode: 'exclusive', ifAvailable: true })
      return callback(null)
    })
    expect((await execute()).code).toBe('client_blocked')
    expect(localStorage.getItem(BILLING_ATTEMPT_KEY)).toBeNull()
    expect(client.functions.invoke).not.toHaveBeenCalled()
  })
  it('rechecks the marker after acquiring the lock', async () => {
    navigator.locks.request.mockImplementation(async (_name, _options, callback) => {
      localStorage.setItem(BILLING_ATTEMPT_KEY, 'another-tab-attempted')
      return callback({})
    })
    expect((await execute()).code).toBe('client_blocked')
    expect(client.functions.invoke).not.toHaveBeenCalled()
  })
  it.each(['read', 'write', 'readback'])('does not dispatch when persistent storage %s fails', async failure => {
    const storage = {
      getItem: vi.fn(() => { if (failure === 'read') throw new Error('private storage error'); return null }),
      setItem: vi.fn(() => { if (failure === 'write') throw new Error('private storage error') }),
    }
    const result = await runSandboxBillingOnce(client, { isCurrent: () => true, onClaim: vi.fn() }, { navigator, localStorage: storage })
    expect(result.code).toBe('client_blocked'); expect(client.functions.invoke).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('private storage error')
  })
  it('writes and verifies the persistent marker before the SDK invocation', async () => {
    client.functions.invoke.mockImplementation(async () => {
      expect(localStorage.getItem(BILLING_ATTEMPT_KEY)).toMatch(/^attempted:[0-9a-f-]{36}$/)
      return success()
    })
    await execute(); expect(client.functions.invoke).toHaveBeenCalledTimes(1)
    expect(sandboxAttemptState()).toBe('attempted')
    await execute(); expect(client.functions.invoke).toHaveBeenCalledTimes(1)
  })
  it('does not dispatch after a delayed lock arrives for an obsolete view', async () => {
    let current = true, grant
    navigator.locks.request.mockImplementation((_name, _options, callback) => new Promise(resolve => { grant = () => resolve(callback({})) }))
    const result = execute({ isCurrent: () => current })
    current = false; grant()
    expect((await result).code).toBe('client_blocked')
    expect(localStorage.getItem(BILLING_ATTEMPT_KEY)).toBeNull(); expect(client.functions.invoke).not.toHaveBeenCalled()
  })
  it('a persisted marker from an earlier page load blocks a new component', () => {
    localStorage.setItem(BILLING_ATTEMPT_KEY, 'attempted-review-required')
    fixture(); expect(button().disabled).toBe(true)
    fireEvent.click(button()); expect(client.functions.invoke).not.toHaveBeenCalled()
  })
  it('receives a marker from another tab without enabling a second request', () => {
    fixture(); expect(button().disabled).toBe(false)
    localStorage.setItem(BILLING_ATTEMPT_KEY, 'attempted-review-required')
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: BILLING_ATTEMPT_KEY })))
    expect(button().disabled).toBe(true); expect(client.functions.invoke).not.toHaveBeenCalled()
  })
  it('keeps an attempt latched after refreshing billing status', async () => {
    client.functions.invoke.mockImplementation(async name => name === 'billing-status' ? { data: snapshot } : success())
    render(<BillingStatus org={{ id: orgId, name: 'QA Company' }} session={session} members={[{ user_id: actor, role: 'owner' }]} client={client}/>)
    await screen.findByRole('button', { name: 'Run one sandbox billing pass' })
    fireEvent.click(button()); await screen.findByText('Server result: billing_worker_run (HTTP 200)')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh billing status' }))
    await screen.findByRole('button', { name: 'Run one sandbox billing pass' })
    expect(button().disabled).toBe(true)
    expect(client.functions.invoke.mock.calls.filter(([name]) => name === 'billing-worker')).toHaveLength(1)
  })
})

describe('pinned SDK transport without network', () => {
  it.each([200, 503])('sends a bodyless POST once and exposes HTTP %s', async status => {
    const fetch = vi.fn(async (url, options) => {
      expect(String(url)).toBe('https://suohuogalotxhsnkumvy.supabase.co/functions/v1/billing-worker')
      expect(options.method).toBe('POST'); expect(options.body).toBeUndefined()
      const headers = new Headers(options.headers)
      expect([...headers.keys()].sort()).toEqual(['apikey', 'authorization', 'x-client-info'])
      // These are synthetic fixture values; no real browser session is read.
      expect(headers.get('apikey')).toBe('synthetic-public-key')
      expect(headers.get('authorization')).toBe('Bearer synthetic-public-key')
      return new Response(JSON.stringify(status === 200 ? outcome() : { code: 'billing_inactive' }), { status, headers: { 'Content-Type': 'application/json' } })
    })
    const sdk = createClient('https://suohuogalotxhsnkumvy.supabase.co', 'synthetic-public-key', {
      global: { fetch }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
    const response = await sdk.functions.invoke('billing-worker', { method: 'POST' })
    const result = await readSandboxBillingResult(response)
    expect(result.httpStatus).toBe(status)
    expect(result.code).toBe(status === 200 ? 'billing_worker_run' : 'billing_inactive')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('release only this attempt after an exact no-job rejection', () => {
  const deniedResponse = (code, status) => { const context = { status, json: async () => ({ code }) }; return { error: { name: 'FunctionsHttpError', context }, response: context } }
  const execute = () => runSandboxBillingOnce(client, { isCurrent: () => true, onClaim: vi.fn() })
  it.each([['billing_inactive', 503], ['authentication_required', 401], ['operator_required', 403], ['origin_not_allowed', 403], ['method_not_allowed', 405], ['empty_body_required', 400]])('releases %s only after the exact no-job server response', async (code, status) => {
    client.functions.invoke.mockResolvedValue(deniedResponse(code, status))
    const result = await execute()
    expect(result.retrySafe).toBe(true); expect(localStorage.getItem(BILLING_ATTEMPT_KEY)).toBeNull()
    expect(client.functions.invoke).toHaveBeenCalledTimes(1)
  })
  it('offers a new explicit click after OFF is corrected, without retrying automatically', async () => {
    client.functions.invoke.mockResolvedValueOnce(inactive()).mockResolvedValueOnce(success())
    fixture(); fireEvent.click(button()); await screen.findByText('Server result: billing_inactive (HTTP 503)')
    expect(button().disabled).toBe(false); expect(client.functions.invoke).toHaveBeenCalledTimes(1)
    fireEvent.click(button()); await screen.findByText('Server result: billing_worker_run (HTTP 200)')
    expect(button().disabled).toBe(true); expect(client.functions.invoke).toHaveBeenCalledTimes(2)
  })
  it('never removes a different tab marker even after a known no-job response', async () => {
    client.functions.invoke.mockImplementation(async () => {
      localStorage.setItem(BILLING_ATTEMPT_KEY, 'another-tab-attempt')
      return inactive()
    })
    await execute(); expect(localStorage.getItem(BILLING_ATTEMPT_KEY)).toBe('another-tab-attempt')
    await execute(); expect(client.functions.invoke).toHaveBeenCalledTimes(1)
  })
  it.each([deniedResponse('billing_host_unavailable', 503), deniedResponse('billing_inactive', 500), success(), { error: new Error('secret') }])('retains host, mismatched, completed and unknown outcomes: %#', async response => {
    client.functions.invoke.mockResolvedValue(response)
    await execute(); expect(localStorage.getItem(BILLING_ATTEMPT_KEY)).toMatch(/^attempted:/)
    await execute(); expect(client.functions.invoke).toHaveBeenCalledTimes(1)
  })
  it('keeps another tab excluded until the no-job rejection is verified', async () => {
    let resolve
    client.functions.invoke.mockReturnValue(new Promise(done => { resolve = done }))
    const first = execute()
    expect(localStorage.getItem(BILLING_ATTEMPT_KEY)).toMatch(/^attempted:/)
    expect((await execute()).code).toBe('client_blocked')
    resolve(inactive()); await first
    expect(localStorage.getItem(BILLING_ATTEMPT_KEY)).toBeNull()
    expect(client.functions.invoke).toHaveBeenCalledTimes(1)
  })
  it('retains a contradictory rejection that contains execution facts', async () => {
    const context = { status: 503, json: async () => ({ code: 'billing_inactive', completed: 1, secret: 'never-display' }) }
    client.functions.invoke.mockResolvedValue({ error: { name: 'FunctionsHttpError', context }, response: context })
    const result = await execute()
    expect(result.code).toBe('outcome_unknown'); expect(localStorage.getItem(BILLING_ATTEMPT_KEY)).toMatch(/^attempted:/)
    expect(JSON.stringify(result)).not.toContain('never-display')
  })
  it('requires the real SDK HTTP-error envelope before releasing a rejection', async () => {
    client.functions.invoke.mockResolvedValue({ data: { code: 'billing_inactive' }, error: null, response: { status: 503 } })
    const result = await execute()
    expect(result.code).toBe('outcome_unknown'); expect(localStorage.getItem(BILLING_ATTEMPT_KEY)).toMatch(/^attempted:/)
  })
  it('restores its marker and stays blocked across remount after one transient release-read failure', async () => {
    let stored = null, failNextRead = false
    const storage = {
      getItem: vi.fn(() => { if (failNextRead) { failNextRead = false; throw new Error('temporary') } return stored }),
      setItem: vi.fn((_key, value) => { stored = value }),
      removeItem: vi.fn(() => { stored = null; failNextRead = true }),
      clear: vi.fn(() => { stored = null }),
    }
    vi.stubGlobal('localStorage', storage)
    const result = await execute()
    expect(result.retrySafe).toBe(false); expect(stored).toMatch(/^attempted:/)
    expect(sandboxAttemptState()).toBe('attempted')
    const view = fixture(); expect(button().disabled).toBe(true); view.unmount()
    fixture(); expect(button().disabled).toBe(true)
    await execute(); expect(client.functions.invoke).toHaveBeenCalledTimes(1)
    expect(storage.setItem).toHaveBeenCalledTimes(2)
  })
  it.each(['delete', 'readback', 'mismatch'])('does not grant retry when marker release %s fails', async failure => {
    let stored = null, removed = false
    const storage = {
      getItem: vi.fn(() => { if (removed && failure === 'readback') throw new Error('unavailable'); return stored }),
      setItem: vi.fn((_key, value) => { stored = value }),
      removeItem: vi.fn(() => { if (failure === 'delete') throw new Error('unavailable'); removed = true; stored = failure === 'mismatch' ? 'another-marker' : null }),
    }
    const platform = { navigator, localStorage: storage }
    const result = await runSandboxBillingOnce(client, { isCurrent: () => true, onClaim: vi.fn() }, platform)
    expect(result.retrySafe).toBe(false)
    expect(sandboxAttemptState(platform)).not.toBe('available')
    await runSandboxBillingOnce(client, { isCurrent: () => true, onClaim: vi.fn() }, platform)
    expect(client.functions.invoke).toHaveBeenCalledTimes(1)
  })
})
