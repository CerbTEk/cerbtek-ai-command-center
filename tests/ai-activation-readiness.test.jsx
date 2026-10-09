import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import AIDraftSetup from '../src/AIDraftSetup'
import { activationState, draftActivationReady, savedActivationAuthorized } from '../src/ai-activation-readiness'
import { activationFixture, aiReadinessFixture } from './activation-fixture'

const configuration = { id: 'config', version: 1, configuration: { schema_version: 1, provider: 'openai', model: 'synthetic-model', task: 'customer_reply', instructions: 'Draft from synthetic business facts.', source: 'manual_context', max_input_bytes: 6000, max_output_tokens: 1000, max_daily_runs: 10, daily_budget_microusd: 1000000, human_review: true } }
const load = readiness => ({ configuration, runs: [], catalog: [{ provider: 'openai', model: 'synthetic-model', available: true, structured_outputs: true }], readiness })
const clientFor = fn => ({ functions: { invoke: vi.fn(async (_, { body }) => ({ data: await fn(body) })) } })
const directClick = element => element[Object.keys(element).find(key => key.startsWith('__reactProps$'))].onClick()
async function mount(readiness, respond) {
  const client = clientFor(body => body.operation === 'load' ? load(readiness) : respond?.(body))
  await act(async () => { render(<AIDraftSetup organizationId="org" client={client}/>) })
  fireEvent.change(screen.getByLabelText('Business context'), { target: { value: 'Synthetic context only.' } })
  return client
}
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External network forbidden') })) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const malformed = [
  ['missing', undefined], ['null', null], ['array', []], ['legacy boolean', true],
  ['future contract', activationFixture('org', 'config', { contract_version: 2 })],
  ['string enabled', activationFixture('org', 'config', { enabled: 'true' })],
  ['string account verification', activationFixture('org', 'config', { account_binding_verified: 'true' })],
  ['unknown status', activationFixture('org', 'config', { status: 'configured' })],
  ['contradictory status', activationFixture('org', 'config', { status: 'activation_disabled' })],
  ['other organization', activationFixture('other')], ['other configuration', activationFixture('org', 'other')],
  ['missing activation ID', activationFixture('org', 'config', { activation_id: null })],
  ['invalid activation ID', activationFixture('org', 'config', { activation_id: 'not-a-uuid' })],
  ['missing expiry', activationFixture('org', 'config', { expires_at: null })],
  ['date-only expiry', activationFixture('org', 'config', { expires_at: '2099-01-01' })],
  ['expired', activationFixture('org', 'config', { expires_at: '2020-01-01T00:00:00Z' })],
  ['missing caps', activationFixture('org', 'config', { limits: null })],
  ...[
    { request_microusd: 0 }, { request_microusd: -1 }, { request_microusd: '1000' }, { request_microusd: 1.5 },
    { request_microusd: 1000001 }, { daily_microusd: 100000001 }, { total_microusd: 100000001 },
    { daily_microusd: 1 }, { total_microusd: 1 }, { daily_runs: 101 }, { total_runs: 10001 },
    { total_runs: 1 }, { daily_runs: Number.MAX_SAFE_INTEGER + 1 }, { unrecognized_cap: 1 },
  ].map((limits, index) => [`malformed caps ${index}`, activationFixture('org', 'config', { limits: { ...activationFixture().limits, ...limits } })]),
]

describe('strict saved activation contract', () => {
  it.each(malformed)('cannot authorize %s even with true readiness flags', (_label, activation) => {
    const readiness = { ...aiReadinessFixture(), activation }
    expect(activationState(activation, 'org', 'config').authorized).toBe(false)
    expect(draftActivationReady(readiness, 'org', 'config')).toBe(false)
    expect(savedActivationAuthorized({ organization_id: 'org', configuration, readiness: { live_inference_enabled: true, activation } })).toBe(false)
  })
  it('separates saved approval from provider-bound AI readiness', () => {
    const activation = activationFixture('org', 'config', { account_binding_verified: false })
    const workspace = { organization_id: 'org', configuration, readiness: { live_inference_enabled: true, activation } }
    expect(savedActivationAuthorized(workspace)).toBe(true)
    expect(draftActivationReady({ ...aiReadinessFixture(), activation }, 'org', 'config')).toBe(false)
    expect(draftActivationReady(aiReadinessFixture(), 'org', 'config')).toBe(true)
  })
  it.each(['live_enabled', 'credential_configured', 'status'])('rejects a missing or contradictory top-level %s', key => {
    expect(draftActivationReady({ ...aiReadinessFixture(), [key]: undefined }, 'org', 'config')).toBe(false)
    expect(draftActivationReady({ ...aiReadinessFixture(), [key]: key === 'status' ? 'activation_disabled' : 'true' }, 'org', 'config')).toBe(false)
  })
})

describe('OFF-by-default paid inference controls', () => {
  it.each(['activation_missing', 'activation_disabled', 'activation_expired', 'activation_configuration_changed', 'activation_invalid', 'activation_budget_exhausted', 'activation_run_limit', 'activation_account_mismatch', 'activation_unavailable'])('keeps %s OFF and blocks direct handler dispatch', async status => {
    const readiness = { ...aiReadinessFixture(), activation: activationFixture('org', 'config', { enabled: false, status }) }
    const client = await mount(readiness)
    const button = screen.getByRole('button', { name: 'Generate review-only draft' })
    expect(button.disabled).toBe(true)
    await act(async () => directClick(button))
    expect(client.functions.invoke).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('heading', { name: 'Paid inference activation · OFF' })).toBeTruthy()
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each([undefined, { live_enabled: true, credential_configured: true, status: 'configured' }, { ...aiReadinessFixture(), activation: {} }])('does not trust legacy or malformed readiness %#', async readiness => {
    await mount(readiness)
    expect(screen.getByRole('button', { name: 'Generate review-only draft' }).disabled).toBe(true)
    expect(screen.queryByText(/Approved caps:/)).toBeNull()
  })
  it('shows explicit approved caps and provider limits of verification without an enable switch', async () => {
    await mount(aiReadinessFixture())
    const section = within(screen.getByRole('region', { name: 'Paid inference activation' }))
    expect(section.getByRole('heading', { name: 'Paid inference activation · Authorized' })).toBeTruthy()
    expect(section.getByText(/Approved caps:/).textContent).toContain('10 daily runs · 20 total runs')
    expect(section.getByText(/Provider acceptance is not confirmed/)).toBeTruthy()
    expect(section.queryByRole('button')).toBeNull()
    expect(screen.getByText(/These are proposed configuration limits, not spending approval/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Generate review-only draft' }).disabled).toBe(false)
  })
  it('does not authorize an unverified account or an unavailable selected model', async () => {
    await mount({ ...aiReadinessFixture(), activation: activationFixture('org', 'config', { account_binding_verified: false }) })
    expect(screen.getByRole('button', { name: 'Generate review-only draft' }).disabled).toBe(true)
    expect(screen.getByText('The approved provider account binding has not been verified.')).toBeTruthy()
    cleanup()
    const client = clientFor(() => ({ ...load(aiReadinessFixture()), catalog: [] }))
    await act(async () => render(<AIDraftSetup organizationId="org" client={client}/>))
    fireEvent.change(screen.getByLabelText('Business context'), { target: { value: 'Synthetic context.' } })
    expect(screen.getByRole('button', { name: 'Generate review-only draft' }).disabled).toBe(true)
  })
  it.each([{ available: undefined }, { available: 'true' }, { structured_outputs: undefined }, { structured_outputs: 'true' }])('requires explicit model compatibility before inference %#', async flags => {
    const payload = load(aiReadinessFixture()); Object.assign(payload.catalog[0], flags)
    const client = clientFor(() => payload)
    await act(async () => render(<AIDraftSetup organizationId="org" client={client}/>))
    fireEvent.change(screen.getByLabelText('Business context'), { target: { value: 'Synthetic context.' } })
    const button = screen.getByRole('button', { name: 'Generate review-only draft' })
    expect(button.disabled).toBe(true)
    await act(async () => directClick(button))
    expect(client.functions.invoke).toHaveBeenCalledTimes(1)
  })
  it.each(['config', 'config-next'])('invalidates authorization before save completes and stays OFF after save returns %s', async nextId => {
    let resolve
    const client = await mount(aiReadinessFixture(), body => body.operation === 'models' ? { provider: 'openai', credential_configured: true, model_status: 'ready', catalog: load().catalog } : new Promise(done => { resolve = done }))
    fireEvent.click(screen.getByRole('button', { name: 'Save configuration version' }))
    expect(screen.getByRole('heading', { name: 'Paid inference activation · OFF' })).toBeTruthy()
    await act(async () => resolve({ configuration: { ...configuration, id: nextId, version: 2 } }))
    expect(screen.getByText(/Configuration version 2 saved/).textContent).toContain('separate approval for this exact version')
    const button = screen.getByRole('button', { name: 'Generate review-only draft' })
    expect(button.disabled).toBe(true)
    await act(async () => directClick(button))
    expect(client.functions.invoke.mock.calls.map(([, { body }]) => body.operation)).toEqual(['load', 'save'])
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh models' })))
    expect(screen.getByRole('button', { name: 'Generate review-only draft' }).disabled).toBe(true)
    expect(client.functions.invoke.mock.calls.map(([, { body }]) => body.operation)).toEqual(['load', 'save', 'models'])
  })
  it('expires a currently visible authorization locally without making a request', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-09T12:00:00Z'))
    const readiness = { ...aiReadinessFixture(), activation: activationFixture('org', 'config', { expires_at: '2026-10-09T12:00:01Z' }) }
    const client = await mount(readiness)
    expect(screen.getByRole('button', { name: 'Generate review-only draft' }).disabled).toBe(false)
    await act(async () => vi.advanceTimersByTime(1001))
    expect(screen.getByRole('button', { name: 'Generate review-only draft' }).disabled).toBe(true)
    expect(screen.getByText(/saved activation approval has expired/)).toBeTruthy()
    expect(client.functions.invoke).toHaveBeenCalledTimes(1)
  })
  it('recognizes a server activation rejection as blocked before dispatch, not an unknown outcome', async () => {
    const client = await mount(aiReadinessFixture(), () => ({ error: 'activation_account_mismatch' }))
    fireEvent.click(screen.getByRole('button', { name: 'Generate review-only draft' }))
    await screen.findByText('Live AI generation is disabled. The provider account does not match the saved activation approval.')
    expect(screen.queryByText(/A request is unresolved/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Generate review-only draft' }).disabled).toBe(true)
    expect(client.functions.invoke).toHaveBeenCalledTimes(2)
  })
})
