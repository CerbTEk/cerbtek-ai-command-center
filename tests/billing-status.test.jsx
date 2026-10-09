import React, { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import BillingStatus from '../src/BillingStatus'
import { billingMetricLabel, canViewBillingStatus, validateBillingStatus } from '../src/billing-status-model'

const org = { id: 'company-a', name: 'Company A' }
const session = { user: { id: 'owner-a' } }
const members = [{ user_id: 'owner-a', role: 'owner' }]
const envelope = (patch = {}) => ({ contract: 'billing_status_v1', organization_id: org.id, actor_id: session.user.id, actor_role: 'owner', authorized: true, integration_state: 'not_configured', commercial_actions_enabled: false, provider: null, customer_bound: false, binding_count: 0, credential_state: 'not_verified', webhook_state: 'not_verified', subscription_count: 0, unresolved_receipts: 0, policy_versions: 0, usage_scope: 'lifetime_observations_only', customer_charge: null, usage: [], ...patch })
const bound = (patch = {}) => envelope({ integration_state: 'bound_inactive', provider: { account_id: 'acct_SYNTHETIC', livemode: false, api_version: '2026-09-30.dahlia' }, customer_bound: true, binding_count: 1, subscription_count: 2, unresolved_receipts: 1, policy_versions: 3, ...patch })
const observation = { metric: 'ai_input_tokens', unit: 'token', measured_units: '900719925474099312345', unresolved_sources: 2 }
let client
beforeEach(() => { client = { functions: { invoke: vi.fn().mockResolvedValue({ data: envelope(), error: null }) } } })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const fixture = props => render(<BillingStatus org={org} session={session} members={members} client={client} {...props}/>)
const ready = () => screen.findByRole('heading', { name: 'Billing remains inactive' })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

describe('billing display contract', () => {
  it('allows only company owners and admins', () => {
    for (const role of ['owner', 'admin']) expect(canViewBillingStatus(role)).toBe(true)
    for (const role of ['member', 'consultant', 'viewer', 'staff', null, undefined]) expect(canViewBillingStatus(role)).toBe(false)
  })
  it('accepts unconfigured and bound inactive status with exact precision', () => {
    expect(validateBillingStatus(envelope(), org.id, session.user.id).integration_state).toBe('not_configured')
    expect(validateBillingStatus(bound({ usage: [observation] }), org.id, session.user.id).usage[0].measured_units).toBe(observation.measured_units)
  })
  it.each([
    ['missing response', null], ['wrong contract', { contract: 'billing_status_v2' }],
    ['wrong company', { organization_id: 'company-b' }], ['wrong actor', { actor_id: 'owner-b' }],
    ['unverified access', { authorized: false }], ['viewer access', { actor_role: 'viewer' }], ['staff-only access', { actor_role: 'staff' }],
    ['active commercial actions', { commercial_actions_enabled: true }], ['missing commercial flag', { commercial_actions_enabled: undefined }],
    ['unknown integration state', { integration_state: 'active' }], ['unverified scope', { usage_scope: 'month' }],
    ['calculated charge', { customer_charge: 0 }], ['absent charge field', { customer_charge: undefined }],
    ['missing usage', { usage: undefined }], ['negative count', { subscription_count: -1 }],
    ['imprecise count', { unresolved_receipts: Number.MAX_SAFE_INTEGER + 1 }], ['string count', { policy_versions: '0' }],
    ['missing provider', { provider: undefined }], ['unmapped provider', { provider: bound().provider }],
    ['contradictory customer mapping', { customer_bound: true }], ['null mapping flag', { customer_bound: null }],
    ['missing binding count', { binding_count: undefined }], ['claimed credentials', { credential_state: 'connected' }], ['claimed webhook readiness', { webhook_state: 'ready' }],
    ['backend error', { error: 'synthetic private detail' }],
    ['numeric quantity', { usage: [{ ...observation, measured_units: 4 }] }], ['decimal quantity', { usage: [{ ...observation, measured_units: '1.5' }] }], ['negative quantity', { usage: [{ ...observation, measured_units: '-1' }] }],
    ['scientific quantity', { usage: [{ ...observation, measured_units: '1e20' }] }], ['unresolved count missing', { usage: [{ ...observation, unresolved_sources: undefined }] }],
    ['unsafe metric content', { usage: [{ ...observation, metric: '<script>x</script>' }] }], ['duplicate metric unit', { usage: [observation, observation] }],
  ])('fails closed for %s', (_name, patch) => {
    expect(() => validateBillingStatus(patch === null ? null : envelope(patch), org.id, session.user.id)).toThrow('Billing status could not be verified.')
  })
  it('handles multiple mappings without selecting an arbitrary account', () => {
    const value = validateBillingStatus(bound({ binding_count: 2, provider: null }), org.id, session.user.id)
    expect(value.binding_count).toBe(2); expect(value.provider).toBeNull()
    expect(() => validateBillingStatus(bound({ binding_count: 2 }), org.id, session.user.id)).toThrow()
    expect(() => validateBillingStatus(bound({ binding_count: 0 }), org.id, session.user.id)).toThrow()
  })
  it('rejects contradictory or malformed bound provider records', () => {
    for (const patch of [{ provider: null }, { customer_bound: false }, { provider: { ...bound().provider, livemode: 'true' } }, { provider: { ...bound().provider, account_id: 'customer-secret' } }, { provider: { ...bound().provider, api_version: 'unknown' } }]) expect(() => validateBillingStatus(bound(patch), org.id, session.user.id)).toThrow()
  })
  it('keeps only the display fields and names known usage metrics', () => {
    const value = validateBillingStatus(bound({ secret: 'must not retain', provider: { ...bound().provider, secret: 'must not retain' }, usage: [{ ...observation, private_source: 'must not retain' }] }), org.id, session.user.id)
    expect(JSON.stringify(value)).not.toContain('must not retain')
    expect(billingMetricLabel('phone_dialResult_reported_seconds')).toBe('Phone dial-result seconds')
    expect(billingMetricLabel('future_metric')).toBe('future metric')
    expect(billingMetricLabel('constructor')).toBe('constructor')
  })
})

describe('read-only billing UI', () => {
  it('loads one authenticated scoped request and renders honest inactive prerequisites', async () => {
    fixture(); await ready()
    expect(client.functions.invoke).toHaveBeenCalledExactlyOnceWith('billing-status', { body: { organization_id: org.id } })
    expect(screen.getByText('Not calculated')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Configuration prerequisites' })).toBeTruthy()
    expect(screen.getByText('No usage observations are recorded. This does not establish zero usage.')).toBeTruthy()
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['Refresh billing status'])
    expect(document.querySelector('input,select,textarea,form')).toBeNull()
  })
  it('shows provider metadata, exact observed units and unresolved sources separately from charges', async () => {
    client.functions.invoke.mockResolvedValue({ data: bound({ usage: [observation] }) })
    fixture(); await ready()
    expect(screen.getByText('acct_SYNTHETIC')).toBeTruthy()
    expect(screen.getByText('Unresolved customer receipts')).toBeTruthy()
    expect(screen.getByText(/Receipt counts cover customer-linked records only/)).toBeTruthy()
    expect(screen.getByText('Test account binding; billing inactive')).toBeTruthy()
    expect(screen.getByText('900719925474099312345')).toBeTruthy()
    const row = screen.getByRole('row', { name: /AI input tokens token/ })
    expect(within(row).getByText('2')).toBeTruthy()
    expect(screen.getByText(/Lifetime recorded observations only/).textContent).toContain('not billing-period totals')
    expect(screen.getByText(/Phone-leg observations can overlap/)).toBeTruthy()
    expect(screen.getByText('Not calculated')).toBeTruthy()
  })
  it('displays multiple recorded bindings and unverified credential/webhook state without guessing an account', async () => {
    client.functions.invoke.mockResolvedValue({ data: bound({ binding_count: 2, provider: null }) })
    fixture(); await ready()
    expect(screen.getByText(/Multiple recorded bindings; review required/)).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Recorded provider binding' })).toBeNull()
    expect(screen.getAllByText('Not verified')).toHaveLength(2)
  })
  it('never labels a live account binding as active billing', async () => {
    client.functions.invoke.mockResolvedValue({ data: bound({ provider: { ...bound().provider, livemode: true } }) })
    fixture(); await ready(); expect(screen.getByText('Live account binding; billing inactive')).toBeTruthy()
  })
  it.each(['member', 'viewer', 'consultant', 'staff', undefined])('blocks %s before calling the backend', async role => {
    fixture({ members: [{ user_id: session.user.id, role }] })
    expect(screen.getByRole('heading', { name: 'Billing access restricted' })).toBeTruthy()
    expect(client.functions.invoke).not.toHaveBeenCalled()
  })
  it('does not borrow another member’s owner role or organization creator metadata', () => {
    fixture({ org: { ...org, created_by: session.user.id }, members: [{ user_id: 'other', role: 'owner' }] })
    expect(screen.getByRole('heading', { name: 'Billing access restricted' })).toBeTruthy()
    expect(client.functions.invoke).not.toHaveBeenCalled()
  })
  it('allows company admins when the backend also verifies admin access', async () => {
    client.functions.invoke.mockResolvedValue({ data: envelope({ actor_role: 'admin' }) })
    fixture({ members: [{ user_id: session.user.id, role: 'admin' }] }); await ready()
  })
  it.each([null, { user: null }])('does not request status without an authenticated user', invalidSession => {
    fixture({ session: invalidSession }); expect(screen.getByText('Sign in and select a company to continue.')).toBeTruthy(); expect(client.functions.invoke).not.toHaveBeenCalled()
  })
  it('does not request status without a company', () => {
    fixture({ org: null }); expect(screen.getByText('Sign in and select a company to continue.')).toBeTruthy(); expect(client.functions.invoke).not.toHaveBeenCalled()
  })
  it.each([
    ['missing deployment', { error: { message: 'synthetic secret deployment error' } }],
    ['missing result', { data: null }], ['wrong company', { data: bound({ organization_id: 'company-b' }) }],
    ['wrong actor', { data: bound({ actor_id: 'other' }) }], ['backend role denial', { data: bound({ actor_role: 'viewer' }) }],
    ['incompatible backend', { data: bound({ commercial_actions_enabled: true }) }],
  ])('reports %s as unavailable without fabricated counts', async (_name, result) => {
    client.functions.invoke.mockResolvedValue(result); fixture()
    await screen.findByRole('heading', { name: 'Billing status unavailable' })
    expect(screen.queryByRole('heading', { name: 'Billing remains inactive' })).toBeNull()
    expect(screen.queryByText('Recorded subscriptions')).toBeNull()
    expect(screen.queryByText('acct_SYNTHETIC')).toBeNull()
    expect(document.body.textContent).not.toContain('synthetic secret')
    expect(screen.getByRole('button', { name: 'Refresh billing status' }).disabled).toBe(false)
  })
  it('handles thrown transport errors and allows an explicit retry', async () => {
    client.functions.invoke.mockRejectedValueOnce(new Error('synthetic private detail'))
    fixture(); await screen.findByRole('heading', { name: 'Billing status unavailable' })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh billing status' })); await ready()
    expect(client.functions.invoke).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).not.toContain('synthetic private detail')
  })
  it('clears privileged data while reauthorizing and prevents duplicate refreshes', async () => {
    client.functions.invoke.mockResolvedValueOnce({ data: bound({ usage: [observation] }) }); fixture(); await ready()
    const pending = deferred(); client.functions.invoke.mockReturnValueOnce(pending.promise)
    const refresh = screen.getByRole('button', { name: 'Refresh billing status' })
    fireEvent.click(refresh); fireEvent.click(refresh)
    expect(refresh.disabled).toBe(true)
    expect(screen.queryByText('acct_SYNTHETIC')).toBeNull()
    expect(screen.queryByText(observation.measured_units)).toBeNull()
    expect(client.functions.invoke).toHaveBeenCalledTimes(2)
    await act(async () => pending.resolve({ data: envelope({ actor_role: 'viewer' }) }))
    await screen.findByRole('heading', { name: 'Billing status unavailable' })
    expect(screen.queryByText('acct_SYNTHETIC')).toBeNull()
  })
  it('synchronously clears data on company switch and ignores a previous company’s late response', async () => {
    client.functions.invoke.mockResolvedValueOnce({ data: bound() }); const view = fixture(); await ready()
    const pending = deferred(); client.functions.invoke.mockReturnValueOnce(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh billing status' }))
    client.functions.invoke.mockResolvedValueOnce({ data: envelope({ organization_id: 'company-b' }) })
    view.rerender(<BillingStatus org={{ id: 'company-b', name: 'Company B' }} session={session} members={members} client={client}/>)
    expect(screen.queryByText('acct_SYNTHETIC')).toBeNull(); await ready()
    await act(async () => pending.resolve({ data: bound() }))
    expect(screen.getByRole('heading', { name: 'Billing status for Company B' })).toBeTruthy()
    expect(screen.queryByText('acct_SYNTHETIC')).toBeNull()
    expect(client.functions.invoke.mock.calls.at(-1)[1].body.organization_id).toBe('company-b')
  })
  it('fences an earlier account request and keeps same-account token refresh stable', async () => {
    const pending = deferred(); client.functions.invoke.mockReturnValueOnce(pending.promise)
    const view = fixture()
    view.rerender(<BillingStatus org={org} session={{ ...session, access_token: 'refreshed' }} members={members} client={client}/>)
    expect(client.functions.invoke).toHaveBeenCalledTimes(1)
    client.functions.invoke.mockResolvedValueOnce({ data: envelope({ actor_id: 'owner-b' }) })
    view.rerender(<BillingStatus org={org} session={{ user: { id: 'owner-b' } }} members={[{ user_id: 'owner-b', role: 'owner' }]} client={client}/>)
    await ready(); await act(async () => pending.resolve({ data: bound() }))
    expect(screen.queryByText('acct_SYNTHETIC')).toBeNull()
    expect(client.functions.invoke).toHaveBeenCalledTimes(2)
  })
  it('clears status immediately on local role demotion and sign-out', async () => {
    client.functions.invoke.mockResolvedValue({ data: bound() }); const view = fixture(); await ready()
    view.rerender(<BillingStatus org={org} session={session} members={[{ user_id: session.user.id, role: 'viewer' }]} client={client}/>)
    expect(screen.queryByText('acct_SYNTHETIC')).toBeNull(); expect(screen.getByRole('heading', { name: 'Billing access restricted' })).toBeTruthy()
    view.rerender(<BillingStatus org={org} session={null} members={members} client={client}/>)
    expect(screen.queryByText('acct_SYNTHETIC')).toBeNull(); expect(client.functions.invoke).toHaveBeenCalledTimes(1)
  })
  it('fences unmount and StrictMode replay responses without mutating anything', async () => {
    const first = deferred(), second = deferred(); client.functions.invoke.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const view = render(<StrictMode><BillingStatus org={org} session={session} members={members} client={client}/></StrictMode>)
    expect(client.functions.invoke).toHaveBeenCalledTimes(2)
    await act(async () => second.resolve({ data: envelope() })); await ready()
    await act(async () => first.resolve({ data: bound() })); expect(screen.queryByText('acct_SYNTHETIC')).toBeNull()
    const pending = deferred(); client.functions.invoke.mockReturnValueOnce(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh billing status' })); view.unmount()
    await act(async () => pending.resolve({ data: bound() }))
    expect(screen.queryByText('acct_SYNTHETIC')).toBeNull()
    expect(client.functions.invoke.mock.calls.every(([name, options]) => name === 'billing-status' && JSON.stringify(options) === JSON.stringify({ body: { organization_id: org.id } }))).toBe(true)
  })
  it('renders company names as text and provides a keyboard-scrollable usage table', async () => {
    client.functions.invoke.mockResolvedValue({ data: envelope({ usage: [observation] }) })
    fixture({ org: { ...org, name: '<script>unsafe()</script>' } }); await ready()
    expect(document.querySelector('.billing-status script')).toBeNull()
    const region = screen.getByRole('region', { name: 'Observed usage details' }); region.focus(); expect(document.activeElement).toBe(region)
    expect(screen.getByRole('table', { name: 'Recorded usage by metric and unit' })).toBeTruthy()
  })
})
