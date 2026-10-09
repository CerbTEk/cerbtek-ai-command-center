import { activationFixture } from './activation-fixture'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import CustomerSetupJourney from '../src/CustomerSetupJourney'
import { deriveCustomerSetup, verifySetupKnowledge, verifySetupWorkspace } from '../src/customer-setup-model'
import { sectionFromHash } from '../src/use-section-navigation'
const clone = value => JSON.parse(JSON.stringify(value))
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const fixture = (company = 'company-a', actor = 'user-a', role = 'admin') => {
  const data = { ok: true, contract_version: 1, organization_id: company, actor: { id: actor, role }, context: null, configuration: null, workflows: [], people: [{ user_id: actor, role }], limit: 100, readiness: { context_ready: false, configuration_ready: false, microsoft_ready: false, microsoft_account: null, microsoft_connection_id: null, distinct_reviewer_available: false, live_inference_enabled: false } }
  const docs = []
  const client = { functions: { invoke: vi.fn(async (name, { body }) => {
    if (name === 'customer-workflow' && body.operation === 'load') return { data: clone(data) }
    if (name === 'company-knowledge' && ['access', 'list'].includes(body.operation)) return { data: { ok: true, schema_version: 1, organization_id: company, actor_user_id: actor, actor_role: role, can_manage: ['owner', 'admin'].includes(role), ...(body.operation === 'access' ? { contract: 'company-knowledge-v1', ai_connected: false } : { documents: clone(docs) }) } }
    throw new Error('Forbidden operation')
  }) } }
  return { data, docs, client, props: { org: { id: company, name: `Company ${company}` }, session: { user: { id: actor } }, client, onGo: vi.fn() } }
}
function configured(f) {
  f.data.context = { id: 'context-1', organization_id: f.props.org.id, version: 2, context: { company_name: 'Sample company', reply_guidance: 'Use only confirmed service information.' } }
  f.data.configuration = { id: 'config-1', organization_id: f.props.org.id, version: 3, configuration: { task: 'customer_reply', provider: 'openai', model: 'synthetic-test-model' } }
  f.data.people.push({ user_id: 'reviewer-2', role: 'owner' })
  Object.assign(f.data.readiness, { context_ready: true, configuration_ready: true, microsoft_ready: true, microsoft_account: 'account-1', microsoft_connection_id: 'connection-1', distinct_reviewer_available: true })
}
async function mount(f) { const view = render(<CustomerSetupJourney {...f.props}/>); await screen.findByText('Saved setup checked. No model request, connection change, or email was sent.'); return view }
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External network forbidden') })) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('truthful saved readiness', () => {
  it('recognizes a refreshable route', () => expect(sectionFromHash('#Customer%20Setup')).toBe('Customer Setup'))
  it('reads only deployed non-provider operations and presents all five stages', async () => {
    const f = fixture(); await mount(f)
    expect(f.client.functions.invoke.mock.calls.map(([name, { body }]) => [name, body.operation])).toEqual([['customer-workflow', 'load'], ['company-knowledge', 'access'], ['company-knowledge', 'list']])
    expect(screen.getAllByText(/0 of 4 setup prerequisites recorded/)).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'Live activation is not confirmed' })).toBeTruthy()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(5)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('resumes using saved configuration without treating it as provider acceptance', async () => {
    const f = fixture(); configured(f); await mount(f)
    expect(screen.getByText(/4 of 4 setup prerequisites recorded/)).toBeTruthy()
    expect(screen.getByText(/Saved selection: openai/).textContent).toContain('does not verify the credential')
    expect(screen.getByText('Verified saved connection')).toBeTruthy()
    expect(screen.getByRole('list', { name: 'Activation blockers' }).textContent).toContain('Live AI generation is disabled')
    expect(screen.queryByRole('button', { name: /activate|generate|send/i })).toBeNull()
  })
  it('never derives activation from a true workflow flag or historic sends', () => {
    const f = fixture(); configured(f); f.data.readiness.live_inference_enabled = true
    f.data.workflows = [{ action_request: { status: 'Executed' } }]
    const setup = deriveCustomerSetup(f.data, [])
    expect(setup.blockers.map(item => item.id)).toEqual(['activation'])
    expect(setup.blockers[0].detail).toContain('No saved activation approval is available')
    expect(setup.blockers[0].detail).toContain('does not verify credentials')
    expect(setup.accepted).toBe(1)
  })
  it.each(['member', 'viewer'])('explains %s role and independent reviewer requirements', async role => {
    const f = fixture('company-a', 'user-a', role); await mount(f)
    expect(screen.getByRole('list', { name: 'Activation blockers' }).textContent).toContain('Your current role can inspect this guide')
    expect(screen.getByText('Blocked · reviewer required')).toBeTruthy()
  })
  it('does not accept a stale ready flag without an independently listed reviewer', () => {
    const f = fixture(); f.data.readiness.distinct_reviewer_available = true
    expect(deriveCustomerSetup(f.data, []).steps.find(item => item.id === 'team').complete).toBe(false)
  })
  it('shows saved non-customer task as not ready', () => {
    const f = fixture(); configured(f); f.data.configuration.configuration.task = 'internal_summary'; f.data.readiness.configuration_ready = false
    expect(deriveCustomerSetup(f.data, []).steps[1].detail).toContain('not customer reply')
  })
  it('counts only current published company-wide knowledge', async () => {
    const f = fixture(); const base = { id: 'doc-1', status: 'published', audience: 'organization', freshness: 'current', review_due_at: new Date(Date.now() + 86400000).toISOString() }
    f.docs.push(base, { ...base, id: 'private', audience: 'private' }, { ...base, id: 'draft', status: 'draft' }, { ...base, id: 'archived', status: 'archived' }, { ...base, id: 'expired', review_due_at: '2020-01-01' })
    await mount(f); expect(screen.getByText(/1 current, published company-wide source visible/)).toBeTruthy()
  })
  it.each(['drafting', 'ai_unknown', 'awaiting_approval'])('flags an unresolved %s request without retrying it', state => {
    const f = fixture(); configured(f); f.data.workflows = [{ status: state }]
    const result = deriveCustomerSetup(f.data, []); expect(result.uncertain).toBe(true); expect(result.next.id).toBe('outcome')
  })
  it.each(['Executing', 'Failed'])('flags a saved %s email outcome', status => {
    const f = fixture(); f.data.workflows = [{ action_request: { status } }]
    expect(deriveCustomerSetup(f.data, []).uncertain).toBe(true)
  })
})

describe('strict boundaries and safe rechecks', () => {
  it.each(['organization', 'actor', 'contract', 'context_flag', 'config_flag', 'microsoft_binding', 'people', 'boolean'])('rejects unverified %s', async kind => {
    const f = fixture()
    if (kind === 'organization') f.data.organization_id = 'another-company'
    if (kind === 'actor') f.data.actor.id = 'another-user'
    if (kind === 'contract') f.data.contract_version = 2
    if (kind === 'context_flag') f.data.readiness.context_ready = true
    if (kind === 'config_flag') f.data.readiness.configuration_ready = true
    if (kind === 'microsoft_binding') f.data.readiness.microsoft_ready = true
    if (kind === 'people') f.data.people.push({ user_id: 'bad', role: 'superuser' })
    if (kind === 'boolean') f.data.readiness.microsoft_ready = 'false'
    render(<CustomerSetupJourney {...f.props}/>); await screen.findByRole('alert')
    expect(screen.queryByText(/of 4 setup prerequisites/)).toBeNull()
    expect(f.client.functions.invoke).toHaveBeenCalledTimes(1)
  })
  it('rejects cross-company or role-changed source metadata', () => {
    expect(() => verifySetupKnowledge({ actor_role: 'owner', documents: [] }, 'company-a', 'admin')).toThrow()
    expect(() => verifySetupKnowledge({ actor_role: 'admin', documents: [{ id: 'x', organization_id: 'other', status: 'published', audience: 'organization', review_due_at: '2030-01-01' }] }, 'company-a', 'admin')).toThrow()
  })
  it('keeps optional knowledge failures explicit and never claims missing means absent', async () => {
    const f = fixture(); const original = f.client.functions.invoke.getMockImplementation()
    f.client.functions.invoke.mockImplementation((name, options) => name === 'company-knowledge' ? Promise.resolve({ error: { message: 'denied' } }) : original(name, options))
    await mount(f); expect(screen.getByText(/Company Knowledge status could not be verified/)).toBeTruthy()
    expect(screen.queryByText(/No current, published company-wide sources are visible/)).toBeNull()
  })
  it('clears previously ready data as soon as a recheck begins and on failure', async () => {
    const f = fixture(); configured(f); await mount(f); const pending = deferred(); f.client.functions.invoke.mockReturnValue(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Recheck saved setup' }))
    expect(screen.queryByText('Verified saved connection')).toBeNull()
    await act(async () => pending.resolve({ error: { message: 'denied' } }))
    expect(screen.getByRole('alert').textContent).toContain('No readiness has been confirmed')
    expect(screen.queryByText('Verified saved connection')).toBeNull()
  })
  it('cancels a read, ignores its late result, and permits one clean retry', async () => {
    const f = fixture(), first = deferred(); f.client.functions.invoke.mockImplementationOnce(() => first.promise)
    render(<CustomerSetupJourney {...f.props}/>); expect(f.client.functions.invoke).toHaveBeenCalledTimes(1)
    const signal = f.client.functions.invoke.mock.calls[0][1].signal
    fireEvent.click(screen.getByRole('button', { name: 'Cancel check' })); expect(signal.aborted).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Check saved setup' })); await screen.findByText(/Saved setup checked/)
    await act(async () => first.resolve({ data: { ...clone(f.data), organization_id: 'wrong' } }))
    expect(screen.queryByRole('alert')).toBeNull(); expect(f.client.functions.invoke).toHaveBeenCalledTimes(4)
  })
  it('does not issue a duplicate read for repeated clicks during an in-flight check', async () => {
    const f = fixture(), pending = deferred(); f.client.functions.invoke.mockReturnValue(pending.promise)
    render(<CustomerSetupJourney {...f.props}/>); const button = screen.getByRole('button', { name: 'Check saved setup' })
    fireEvent.click(button); fireEvent.click(button); expect(f.client.functions.invoke).toHaveBeenCalledTimes(1)
  })
  it.each(['company', 'account'])('clears previous %s immediately and ignores old completion', async mode => {
    const f = fixture(), old = deferred(); f.client.functions.invoke.mockImplementationOnce(() => old.promise)
    const view = render(<CustomerSetupJourney {...f.props}/>), next = fixture(mode === 'company' ? 'company-b' : 'company-a', mode === 'account' ? 'user-b' : 'user-a')
    view.rerender(<CustomerSetupJourney {...next.props}/>); await screen.findByText(/Saved setup checked/)
    await act(async () => old.resolve({ data: f.data })); expect(next.client.functions.invoke).toHaveBeenCalledTimes(3)
    expect(screen.queryByRole('alert')).toBeNull(); expect(screen.getByRole('heading', { name: `Saved setup for Company ${next.props.org.id}` })).toBeTruthy()
  })
  it('aborts when dismissed and requires a fresh snapshot on return', async () => {
    const f = fixture(), pending = deferred(); f.client.functions.invoke.mockImplementationOnce(() => pending.promise)
    const view = render(<CustomerSetupJourney {...f.props}/>), signal = f.client.functions.invoke.mock.calls[0][1].signal
    view.unmount(); expect(signal.aborted).toBe(true); await act(async () => pending.resolve({ data: f.data }))
    expect(f.client.functions.invoke).toHaveBeenCalledTimes(1)
    await mount(f); expect(f.client.functions.invoke).toHaveBeenCalledTimes(4)
  })
  it('requires company and session before any call', () => {
    const f = fixture(); render(<CustomerSetupJourney {...f.props} session={null}/>); expect(f.client.functions.invoke).not.toHaveBeenCalled()
  })
})

describe('accessible resumable navigation', () => {
  it('links each task to its deployed screen and preserves modified link clicks', async () => {
    const f = fixture(); await mount(f)
    const destinations = [['Open reply guidance', 'Customer Follow-up'], ['Open AI Setup', 'AI Setup'], ['Review Microsoft connection', 'Integrations'], ['Review Team & Roles', 'Team Access'], ['Open Company Knowledge', 'Company Knowledge']]
    for (const [name, target] of destinations) { const link = screen.getByRole('link', { name, exact: true }); expect(link.getAttribute('href')).toBe('#' + encodeURIComponent(target)); fireEvent.click(link); expect(f.props.onGo).toHaveBeenLastCalledWith(target) }
    f.props.onGo.mockClear(); fireEvent.click(screen.getByRole('link', { name: 'Open AI Setup', exact: true }), { ctrlKey: true }); expect(f.props.onGo).not.toHaveBeenCalled()
  })
  it('has accessible status, cancel, headings and no editable activation controls', async () => {
    const f = fixture(); await mount(f)
    expect(screen.getByLabelText('Guided customer reply setup')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Recheck saved setup' }).getAttribute('type')).toBe('button')
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0)
    expect(screen.queryByRole('textbox')).toBeNull(); expect(screen.queryByRole('checkbox')).toBeNull()
  })
})

it('invalidates the entire snapshot when a later service proves the company role changed', async () => {
  const f = fixture(); const original = f.client.functions.invoke.getMockImplementation()
  f.client.functions.invoke.mockImplementation(async (name, options) => { const result = await original(name, options); if (name === 'company-knowledge') Object.assign(result.data, { actor_role: 'member', can_manage: false }); return result })
  render(<CustomerSetupJourney {...f.props}/>); await screen.findByRole('alert'); expect(screen.queryByText(/of 4 setup prerequisites/)).toBeNull()
})

it('reports valid saved activation separately from live-provider acceptance', async () => {
  const f = fixture(); configured(f)
  f.data.readiness.live_inference_enabled = true
  f.data.readiness.activation = activationFixture(f.props.org.id, f.data.configuration.id, { account_binding_verified: false })
  await mount(f)
  const blockers = screen.getByRole('list', { name: 'Activation blockers' }).textContent
  expect(blockers).toContain('Saved activation authorization is current for this exact configuration')
  expect(blockers).toContain('does not verify credentials, account binding, current model availability, or provider acceptance')
  expect(screen.getByRole('heading', { name: 'Live activation is not confirmed' })).toBeTruthy()
  expect(f.client.functions.invoke.mock.calls.map(([name]) => name)).not.toContain('ai-draft')
})

it.each(['missing', 'malformed', 'expired', 'changed', 'account_mismatch'])('keeps the guide blocked for %s activation despite a true flag', kind => {
  const f = fixture(); configured(f); f.data.readiness.live_inference_enabled = true
  const activation = activationFixture(f.props.org.id, f.data.configuration.id, { account_binding_verified: false })
  if (kind === 'expired') activation.expires_at = '2020-01-01T00:00:00Z'
  if (kind === 'changed') activation.configuration_id = 'old-config'
  if (kind === 'account_mismatch') Object.assign(activation, { enabled: false, status: 'activation_account_mismatch' })
  f.data.readiness.activation = kind === 'missing' ? undefined : kind === 'malformed' ? {} : activation
  const detail = deriveCustomerSetup(f.data, []).blockers.find(item => item.id === 'activation').detail
  expect(detail).toContain('Live AI generation is disabled')
  expect(detail).not.toContain('authorization is current')
})
