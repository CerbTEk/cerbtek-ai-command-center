import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { webcrypto } from 'node:crypto'
import { captureCompanyEmailReturn, prepareBrowserProof, saveBrowserProof, companyEmailReturn } from '../src/company-email-callback'
import CompanyEmailConnections, { verifyCompanyEmailStatus } from '../src/CompanyEmailConnections'
import { emailBindingMatches, emailConnections, safeAuthorizationUrl, workflowEmailConnection } from '../src/company-email-model'
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const org = { id: id(1), name: 'Fixture company' }, session = { user: { id: id(2) } }
const callback = provider => `https://suohuogalotxhsnkumvy.supabase.co/functions/v1/${provider}-oauth-callback`
const authorize = provider => ({ connection_id: id(3), redirect_uri: callback(provider), authorize_url: `${provider === 'google' ? 'https://accounts.google.com/o/oauth2/v2/auth' : 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize'}?state=${id(11)}&redirect_uri=${encodeURIComponent(callback(provider))}` })
const connection = (provider = 'google') => ({ id: id(3), integration_id: id(4), provider, status: 'Connected', account_email: 'support@example.test', account_name: 'Company support', scopes: ['synthetic-provider-scope'], capabilities: { mail_read: true, mail_send: true }, connected_by: id(2), is_own_connection: true, oauth_revision: id(5) })
function fixture(patch = {}) {
  const data = { ok: true, contract_version: 1, organization_id: org.id, can_manage: true, providers: { microsoft: { configured: true }, google: { configured: true } }, connections: [], ...patch }
  const client = { functions: { invoke: vi.fn(async (route, { body }) => {
    if (route === 'company-email-connections') return { data: body.action === 'list' ? data : body.action === 'finalize' ? { ok: true, connected: true, organization_id: org.id, provider: 'google', state: body.state, connection_id: id(3) } : { disconnected: true } }
    if (route.endsWith('-connect')) return { data: authorize(route.startsWith('google') ? 'google' : 'microsoft') }
    throw new Error('Unexpected operation')
  }) } }
  return { data, client, props: { org, session, client, navigate: vi.fn(), onChanged: vi.fn() } }
}
const mutations = f => f.client.functions.invoke.mock.calls.filter(([, { body }]) => body.action !== 'list')
async function mount(f) { const view = render(<CompanyEmailConnections {...f.props}/>); await screen.findByRole('button', { name: 'Connect Google / Gmail' }); return view }
function chooseGoogle() { fireEvent.click(screen.getByRole('button', { name: 'Connect Google / Gmail' })) }
function consent({ read = true, send = false } = {}) {
  if (read) fireEvent.click(screen.getByLabelText('Read email for manager-selected customer request intake'))
  if (send) fireEvent.click(screen.getByLabelText('Send separately reviewed and approved customer replies'))
  fireEvent.click(screen.getByLabelText('I authorize this access request for Fixture company.'))
}
beforeEach(() => { vi.stubGlobal('crypto', webcrypto) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.sessionStorage.clear(); window.history.replaceState({}, '', '/') })

describe('per-company email connection onboarding', () => {
  it('loads only saved configuration and connection metadata; no developer credentials are collected', async () => {
    const f = fixture(); await mount(f)
    expect(f.client.functions.invoke).toHaveBeenCalledWith('company-email-connections', { body: { organization_id: org.id, action: 'list' } })
    expect(mutations(f)).toHaveLength(0)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText(/One connected account per provider per company/)).toBeTruthy()
  })
  it.each([['read', true, false], ['send', false, true], ['read_send', true, true]])('requests only the explicitly chosen %s capabilities', async (intent, read, send) => {
    const f = fixture(); await mount(f); chooseGoogle()
    expect(screen.getByRole('button', { name: 'Continue to company sign-in' }).disabled).toBe(true)
    consent({ read, send }); fireEvent.click(screen.getByRole('button', { name: 'Continue to company sign-in' }))
    await waitFor(() => expect(f.props.navigate).toHaveBeenCalledTimes(1))
    expect(mutations(f)).toEqual([['google-connect', { body: { organization_id: org.id, intent, browser_challenge: expect.stringMatching(/^[a-f0-9]{64}$/) } }]])
    expect(f.props.navigate).toHaveBeenCalledWith(authorize('google').authorize_url)
  })
  it('explains mailbox-wide Gmail consent separately from selected-label import', async () => {
    const f = fixture(); await mount(f); chooseGoogle(); consent()
    expect(screen.getByText(/does not narrow the provider’s mailbox-wide read permission/).textContent).toContain('Gmail label')
    expect(screen.getByText(/CerbTek manages the app registration/)).toBeTruthy()
    expect(screen.queryByLabelText(/Client secret/)).toBeNull()
  })
  it('clears confirmation when capabilities change and cancellation never requests consent', async () => {
    const f = fixture(); await mount(f); chooseGoogle(); consent()
    fireEvent.click(screen.getByLabelText('Send separately reviewed and approved customer replies'))
    expect(screen.getByLabelText('I authorize this access request for Fixture company.').checked).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('form', { name: 'Review company email access' })).toBeNull()
    expect(mutations(f)).toHaveLength(0)
    chooseGoogle(); expect(screen.getByLabelText('Read email for manager-selected customer request intake').checked).toBe(false)
  })
  it('locks duplicate submissions and Cancel until the consent preparation settles', async () => {
    const f = fixture(); await mount(f); chooseGoogle(); consent(); let finish
    f.client.functions.invoke.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const form = screen.getByRole('form', { name: 'Review company email access' })
    act(() => { fireEvent.submit(form); fireEvent.submit(form) })
    await waitFor(() => expect(mutations(f)).toHaveLength(1))
    expect(screen.getByRole('button', { name: 'Cancel' }).closest('fieldset').disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(form).toBeTruthy()
    await act(async () => finish({ data: authorize('google') }))
    expect(f.props.navigate).toHaveBeenCalledTimes(1)
  })
  it.each(['company', 'account', 'client', 'unmount'])('never redirects a late consent result after %s changes', async kind => {
    const f = fixture(); const view = await mount(f); chooseGoogle(); consent(); let finish
    f.client.functions.invoke.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue to company sign-in' }))
    await waitFor(() => expect(mutations(f)).toHaveLength(1))
    const next = fixture(); next.data.organization_id = kind === 'company' ? id(20) : org.id
    if (kind === 'unmount') view.unmount()
    else view.rerender(<CompanyEmailConnections {...next.props} org={kind === 'company' ? { id: id(20), name: 'Other company' } : org} session={kind === 'account' ? { user: { id: id(21) } } : session}/>)
    await act(async () => finish({ data: authorize('google') }))
    expect(f.props.navigate).not.toHaveBeenCalled(); expect(next.props.navigate).not.toHaveBeenCalled()
  })
  it('fails closed on mismatched-company status and never offers a connection mutation', async () => {
    const f = fixture({ organization_id: id(99) }); render(<CompanyEmailConnections {...f.props}/>); await screen.findByRole('alert')
    expect(screen.queryByRole('button', { name: 'Connect Google / Gmail' })).toBeNull(); expect(mutations(f)).toHaveLength(0)
  })
  it('disables changes for nonmanagers and unconfigured providers', async () => {
    const f = fixture({ can_manage: false }); await mount(f)
    expect(screen.getByRole('button', { name: 'Connect Google / Gmail' }).disabled).toBe(true)
    cleanup(); const blocked = fixture(); blocked.data.providers.google.configured = false; await mount(blocked)
    expect(screen.getByRole('button', { name: 'Connect Google / Gmail' }).disabled).toBe(true)
    expect(screen.getByText(/platform operator must configure this provider/)).toBeTruthy()
  })
  it('binds reconnect to the saved connection revision and warns about immediate invalidation', async () => {
    const f = fixture({ connections: [connection()] }); render(<CompanyEmailConnections {...f.props}/>); fireEvent.click(await screen.findByRole('button', { name: 'Reconnect Google / Gmail' }))
    expect(screen.getByText(/Starting reconnection immediately invalidates/)).toBeTruthy(); consent({ read: false, send: true })
    fireEvent.click(screen.getByRole('button', { name: 'Continue to company sign-in' })); await waitFor(() => expect(f.props.navigate).toHaveBeenCalled())
    expect(mutations(f)[0][1].body).toEqual({ organization_id: org.id, intent: 'send', connection_id: id(3), expected_revision: id(5), browser_challenge: expect.stringMatching(/^[a-f0-9]{64}$/) })
  })
  it('disconnects only after explicit confirmation and does not claim provider consent was revoked', async () => {
    const f = fixture({ connections: [connection()] }); render(<CompanyEmailConnections {...f.props}/>); fireEvent.click(await screen.findByRole('button', { name: 'Disconnect Google / Gmail' }))
    expect(mutations(f)).toHaveLength(0); expect(screen.getByRole('button', { name: 'Confirm disconnect' }).disabled).toBe(true)
    fireEvent.click(screen.getByLabelText('I authorize this disconnection for Fixture company.')); fireEvent.click(screen.getByRole('button', { name: 'Confirm disconnect' }))
    await screen.findByText(/Kairo disconnected this company email connection/)
    expect(mutations(f)[0]).toEqual(['company-email-connections', { body: { organization_id: org.id, action: 'disconnect', connection_id: id(3), expected_revision: id(5) } }])
    expect(screen.getByText(/Provider account consent may remain/)).toBeTruthy(); expect(f.props.onChanged).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Reconnect Google / Gmail' }).disabled).toBe(true)
  })
  it('blocks repeat mutations after a lost result until saved status is refreshed', async () => {
    const f = fixture(); await mount(f); chooseGoogle(); consent(); f.client.functions.invoke.mockRejectedValueOnce(new Error('Lost result'))
    fireEvent.click(screen.getByRole('button', { name: 'Continue to company sign-in' })); await screen.findByRole('alert')
    fireEvent.submit(screen.getByRole('form', { name: 'Review company email access' })); expect(mutations(f)).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh connection status' })); await waitFor(() => expect(screen.queryByRole('form', { name: 'Review company email access' })).toBeNull())
    expect(screen.getByRole('button', { name: 'Connect Google / Gmail' }).disabled).toBe(false)
  })
  it('rejects forged redirects instead of navigating away from Kairo', async () => {
    const f = fixture(); await mount(f); chooseGoogle(); consent()
    f.client.functions.invoke.mockResolvedValueOnce({ data: { ...authorize('google'), authorize_url: 'https://evil.example.test/consent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue to company sign-in' })); await screen.findByRole('alert'); expect(f.props.navigate).not.toHaveBeenCalled()
  })
})

describe('provider-bound email identity', () => {
  const google = { id: id(3), provider: 'google', account_name: 'Company support', external_account_id: 'google-sub', mail_read: true, mail_send: true, oauth_revision: id(5) }
  const ms = { ...google, id: id(4), provider: 'microsoft', external_account_id: 'entra-oid' }
  it('requires an explicit sending choice when two providers are connected', () => {
    const readiness = { email_connections: [google, ms], microsoft_ready: true, microsoft_account: 'entra-oid', microsoft_connection_id: ms.id }
    expect(workflowEmailConnection({}, readiness)).toBeNull()
    expect(workflowEmailConnection({}, readiness, google.id)).toBe(google)
    expect(workflowEmailConnection({ email_connection_id: ms.id, email_provider: 'microsoft' }, readiness, google.id)).toBe(ms)
    expect(workflowEmailConnection({ email_connection_id: ms.id, email_provider: 'google' }, readiness)).toBeNull()
  })
  it('rejects malformed new readiness rather than selecting legacy Microsoft silently', () => {
    expect(emailConnections({ email_connections: [null], microsoft_ready: true, microsoft_connection_id: 'legacy', microsoft_account: 'legacy-account' })).toEqual([])
  })
  it('binds approval to provider, company, account, connection, and OAuth revision', () => {
    const action = { status: 'Approved', connection_id: google.id, provider: 'google', approved_connection_binding: { id: google.id, organization_id: org.id, external_account_id: google.external_account_id, provider: 'google', oauth_revision: google.oauth_revision } }
    const workflow = { organization_id: org.id, action_request: action }, readiness = { email_connections: [google] }
    expect(emailBindingMatches(workflow, readiness)).toBe(true)
    for (const patch of [{ provider: 'microsoft' }, { id: id(9) }, { organization_id: id(9) }, { external_account_id: 'other-account' }, { oauth_revision: id(9) }]) expect(emailBindingMatches({ ...workflow, action_request: { ...action, approved_connection_binding: { ...action.approved_connection_binding, ...patch } } }, readiness)).toBe(false)
  })
  it('validates provider hosts and the exact same-server OAuth callback', () => {
    for (const provider of ['google', 'microsoft']) { const value = authorize(provider); expect(safeAuthorizationUrl(value.authorize_url, provider, value.redirect_uri)).toBe(true) }
    expect(safeAuthorizationUrl(authorize('google').authorize_url, 'microsoft', callback('google'))).toBe(false)
    expect(safeAuthorizationUrl(authorize('google').authorize_url, 'google', 'https://evil.example.test/callback')).toBe(false)
    const f = fixture(); expect(() => verifyCompanyEmailStatus({ ...f.data, contract_version: 2 }, org.id)).toThrow()
  })
})


async function returnedSignIn(patch = {}) {
  const proof = await prepareBrowserProof({ organizationId: org.id, actorId: session.user.id, provider: 'google' })
  saveBrowserProof({ ...proof.record, ...patch }, authorize('google'))
  window.history.replaceState({}, '', '/app/kairo?google=consent_returned#email_oauth_state=' + id(11) + '&email_oauth_provider=google&email_oauth_completion=' + 'C'.repeat(43))
  captureCompanyEmailReturn()
  return proof
}
describe('browser-bound provider callback completion', () => {
  it('strips callback proofs before rendering and never sends either proof to the provider', async () => {
    const proof = await returnedSignIn()
    expect(window.location.hash).toBe('#Integrations')
    expect(window.location.href).not.toContain('email_oauth_completion')
    expect(window.location.search).not.toContain('consent_returned')
    expect(authorize('google').authorize_url).not.toContain(proof.record.browser_verifier)
    expect(companyEmailReturn()).toMatchObject({ organization_id: org.id, actor_id: session.user.id, provider: 'google' })
    const f = fixture(); await mount(f)
    await screen.findByText(/Google \/ Gmail sign-in completed for Fixture company/)
    expect(mutations(f)).toEqual([['company-email-connections', { body: { organization_id: org.id, action: 'finalize', state: id(11), browser_verifier: proof.record.browser_verifier, completion_secret: 'C'.repeat(43) } }]])
    expect(companyEmailReturn()).toBeNull()
  })
  it('refuses a return without the original browser proof and strips its fragment', async () => {
    window.history.replaceState({}, '', '/app/kairo?google=consent_returned#email_oauth_state=' + id(11) + '&email_oauth_provider=google&email_oauth_completion=' + 'C'.repeat(43))
    captureCompanyEmailReturn(); const f = fixture(); await mount(f)
    expect(screen.getByText(/no matching proof in this browser/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Finish company sign-in' })).toBeNull()
    expect(mutations(f)).toHaveLength(0); expect(window.location.hash).toBe('#Integrations')
  })
  it.each([{ organization_id: id(70) }, { actor_id: id(70) }])('cannot finalize a returned connection in the wrong company or account: %j', async patch => {
    await returnedSignIn(patch); const f = fixture(); await mount(f)
    expect(screen.getByText(/different company or Kairo user/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Finish company sign-in' })).toBeNull(); expect(mutations(f)).toHaveLength(0)
  })
  it('does not retry a single-use finalization after a lost result, including remount and refresh', async () => {
    await returnedSignIn(); const f = fixture(); const original = f.client.functions.invoke.getMockImplementation()
    f.client.functions.invoke.mockImplementation((route, args) => args.body.action === 'finalize' ? Promise.reject(new Error('Lost finalization acknowledgement')) : original(route, args))
    const view = await mount(f); await screen.findByText(/earlier sign-in completion is unconfirmed/)
    expect(screen.getByRole('button', { name: 'Finish company sign-in' }).disabled).toBe(true)
    await screen.findByRole('alert'); view.unmount(); await mount(f)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh connection status' })); await waitFor(() => expect(screen.getByRole('button', { name: 'Finish company sign-in' }).disabled).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Finish company sign-in' })); expect(mutations(f)).toHaveLength(1)
  })
  it('fails closed if browser storage is unavailable before starting OAuth', async () => {
    const f = fixture(); await mount(f); chooseGoogle(); consent()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked') })
    fireEvent.click(screen.getByRole('button', { name: 'Continue to company sign-in' })); await screen.findByText(/cannot safely retain the sign-in proof/)
    expect(mutations(f)).toHaveLength(0); expect(f.props.navigate).not.toHaveBeenCalled()
  })
})


describe('returned OAuth status reconciliation', () => {
  it('clears an uncertain completion only after exact provider and connection status is verified', async () => {
    await returnedSignIn(); const f = fixture(); const original = f.client.functions.invoke.getMockImplementation()
    f.client.functions.invoke.mockImplementation((route, args) => args.body.action === 'finalize' ? Promise.reject(new Error('Lost acknowledgement')) : original(route, args))
    await mount(f); await screen.findByRole('alert')
    f.data.connections=[connection('microsoft')]
    fireEvent.click(screen.getByRole('button', { name: 'Refresh connection status' })); await screen.findByRole('button', { name: 'Reconnect Microsoft 365' })
    expect(companyEmailReturn()?.attempted).toBe(true)
    f.data.connections=[connection('google')]
    fireEvent.click(screen.getByRole('button', { name: 'Refresh connection status' })); await screen.findByText(/saved connection is now verified as connected/)
    expect(companyEmailReturn()).toBeNull(); expect(mutations(f)).toHaveLength(1)
  })
  it('handles provider denial as a failed return without storing or replaying a grant', async () => {
    window.history.replaceState({}, '', '/app/kairo?google=error&message=untrusted-provider-message')
    captureCompanyEmailReturn(); const f = fixture(); await mount(f)
    expect(screen.getByText(/provider did not complete email authorization/)).toBeTruthy()
    expect(screen.queryByText('untrusted-provider-message')).toBeNull(); expect(window.location.search).toBe(''); expect(mutations(f)).toHaveLength(0)
  })
})


describe('existing disconnected status compatibility', () => {
  it.each(['Disabled', 'Disconnected'])('shows %s honestly and offers reconnect without redundant disconnect', async status => {
    const f = fixture({ connections: [{ ...connection(), status, account_email: null, account_name: null, scopes: [], capabilities: { mail_read: false, mail_send: false } }] })
    render(<CompanyEmailConnections {...f.props}/>)
    expect(await screen.findByText(status)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reconnect Google / Gmail' }).disabled).toBe(false)
    expect(screen.queryByRole('button', { name: 'Disconnect Google / Gmail' })).toBeNull()
    expect(mutations(f)).toHaveLength(0)
  })
})
