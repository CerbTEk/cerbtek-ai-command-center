import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
const api = vi.hoisted(() => ({ invoke: vi.fn(), from: vi.fn(), getSession: vi.fn(), onAuthStateChange: vi.fn(), signOut: vi.fn() }))
vi.mock('../src/supabase', () => ({ supabase: { functions: { invoke: api.invoke }, from: api.from, auth: { getSession: api.getSession, onAuthStateChange: api.onAuthStateChange, signOut: api.signOut } } }))
import { App } from '../src/main'
import { sectionFromHash } from '../src/use-section-navigation'
import { legacyAppTarget } from '../src/marketing-routing'
let emit, actor, role, statusRequest, staff
const envelope = (company, user = actor, patch = {}) => ({ contract: 'billing_status_v1', organization_id: company, actor_id: user, actor_role: role, authorized: true, integration_state: 'not_configured', commercial_actions_enabled: false, provider: null, customer_bound: false, binding_count: 0, credential_state: 'not_verified', webhook_state: 'not_verified', subscription_count: 0, unresolved_receipts: 0, policy_versions: 0, usage_scope: 'lifetime_observations_only', customer_charge: null, usage: [], ...patch })
const bound = (company, user = actor) => envelope(company, user, { integration_state: 'bound_inactive', provider: { account_id: 'acct_SYNTHETIC', livemode: false, api_version: '2026-09-30.dahlia' }, customer_bound: true, binding_count: 1 })
const calls = () => api.invoke.mock.calls.filter(([name]) => name === 'billing-status')
const ready = () => screen.findByRole('heading', { name: 'Billing remains inactive' })
beforeEach(() => {
  actor = 'owner-a'; role = 'owner'; statusRequest = null; staff = null
  window.history.replaceState({}, '', '/app/?kairoCompany=company-a#Billing')
  api.signOut.mockReset(); api.from.mockReset(); api.invoke.mockReset()
  api.getSession.mockResolvedValue({ data: { session: { user: { id: actor }, access_token: 'synthetic' } } })
  api.onAuthStateChange.mockImplementation(callback => { emit = callback; return { data: { subscription: { unsubscribe: vi.fn() } } } })
  api.invoke.mockImplementation(async (name, { body }) => {
    if (name === 'billing-status') return statusRequest ? statusRequest(body) : { data: envelope(body.organization_id) }
    return { data: { members: [{ user_id: actor, role }] }, error: null }
  })
  api.from.mockImplementation(table => {
    let single = false
    const result = () => ({ data: table === 'organizations' ? [{ id: 'company-a', name: 'Company A' }, { id: 'company-b', name: 'Company B' }] : table === 'staff_accounts' ? staff : single ? null : [], error: null })
    const q = { select: () => q, eq: () => q, order: () => q, limit: () => q, maybeSingle: () => { single = true; return Promise.resolve(result()) }, then: (resolve, reject) => Promise.resolve(result()).then(resolve, reject) }; return q
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.replaceState({}, '', '/'); window.sessionStorage.clear() })

it('recognizes Billing without altering existing section identifiers or root routing', () => {
  expect(legacyAppTarget({ pathname: '/', search: '', hash: '#Billing' })).toBeNull()
  for (const section of ['Billing', 'Company Knowledge', 'Customer Follow-up', 'Customer Setup', 'Team Access', 'Funding', 'AI Ops']) expect(sectionFromHash(`#${encodeURIComponent(section)}`)).toBe(section)
})
it('opens a direct Billing link and scopes the lazy status view to the selected company and account', async () => {
  render(<App/>); await ready()
  expect(screen.getByRole('heading', { level: 1, name: 'Billing' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Billing status for Company A' })).toBeTruthy()
  expect(calls()).toEqual([['billing-status', { body: { organization_id: 'company-a' } }]])
  expect(screen.getByRole('button', { name: 'Billing' })).toBeTruthy()
})
it('keeps the existing Overview load unchanged and does not prefetch billing status', async () => {
  window.history.replaceState({}, '', '/app/#Overview'); render(<App/>)
  await screen.findByRole('button', { name: 'Open guided customer setup' })
  expect(calls()).toHaveLength(0)
  expect(api.invoke.mock.calls.map(([name]) => name)).toEqual(['organization-members'])
  expect(screen.getByRole('button', { name: 'Billing' })).toBeTruthy()
})
it.each(['viewer', 'member', 'consultant', undefined])('hides the Billing navigation and denies the deep link for %s', async currentRole => {
  role = currentRole; render(<App/>); await screen.findByRole('heading', { name: 'Billing access restricted' })
  expect(screen.queryByRole('button', { name: 'Billing' })).toBeNull()
  expect(calls()).toHaveLength(0)
})
it('does not let a CerbTEK staff role bypass company billing authorization', async () => {
  role = 'viewer'; staff = { user_id: actor, role: 'owner', active: true }; render(<App/>)
  await screen.findByRole('heading', { name: 'Billing access restricted' })
  expect(screen.queryByRole('button', { name: 'Billing' })).toBeNull(); expect(calls()).toHaveLength(0)
})
it('uses the existing section history for Back and Forward and rechecks when reopened', async () => {
  window.history.replaceState({}, '', '/app/?kairoCompany=company-a#Overview'); render(<App/>)
  fireEvent.click(await screen.findByRole('button', { name: 'Billing' })); await ready()
  expect(window.location.hash).toBe('#Billing')
  await act(async () => { window.history.back(); await new Promise(resolve => setTimeout(resolve, 50)) })
  await screen.findByRole('heading', { level: 1, name: 'Overview' })
  expect(screen.queryByRole('heading', { name: 'Billing remains inactive' })).toBeNull()
  await act(async () => { window.history.forward(); await new Promise(resolve => setTimeout(resolve, 50)) }); await ready()
  expect(calls()).toHaveLength(2); expect(window.location.search).toBe('?kairoCompany=company-a')
})
it('clears the previous company and ignores an obsolete request after a company change', async () => {
  statusRequest = body => ({ data: bound(body.organization_id) }); const view = render(<App/>); await ready()
  let resolve
  statusRequest = body => body.organization_id === 'company-a' ? new Promise(done => { resolve = () => done({ data: bound('company-a') }) }) : { data: envelope(body.organization_id) }
  fireEvent.click(screen.getByRole('button', { name: 'Refresh billing status' }))
  fireEvent.change(view.container.querySelector('.org-switcher select'), { target: { value: 'company-b' } })
  expect(screen.queryByText('acct_SYNTHETIC')).toBeNull()
  await screen.findByRole('heading', { name: 'Billing status for Company B' }); await ready()
  await act(async () => resolve())
  expect(screen.queryByText('acct_SYNTHETIC')).toBeNull(); expect(calls().at(-1)[1].body.organization_id).toBe('company-b')
})
it('keeps a token refresh stable but discards the old account snapshot on account change', async () => {
  statusRequest = body => ({ data: actor === 'owner-a' ? bound(body.organization_id) : envelope(body.organization_id) })
  render(<App/>); await ready()
  await act(async () => emit('TOKEN_REFRESHED', { user: { id: actor }, access_token: 'new' })); expect(calls()).toHaveLength(1)
  actor = 'owner-b'; await act(async () => emit('SIGNED_IN', { user: { id: actor }, access_token: 'other' })); await ready()
  expect(calls()).toHaveLength(2); expect(screen.queryByText('acct_SYNTHETIC')).toBeNull()
})
it('unmounts privileged status on sign-out even with an outstanding status check', async () => {
  render(<App/>); await ready(); let resolve
  statusRequest = () => new Promise(done => { resolve = () => done({ data: bound('company-a', 'owner-a') }) })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh billing status' }))
  await act(async () => emit('SIGNED_OUT', null)); await screen.findByRole('button', { name: 'Sign in' })
  await act(async () => resolve())
  expect(screen.queryByRole('heading', { name: 'Billing remains inactive' })).toBeNull()
  expect(screen.queryByText('acct_SYNTHETIC')).toBeNull()
})
it('allows navigation during a pending read and never restores a dismissed status view', async () => {
  let resolve
  statusRequest = () => new Promise(done => { resolve = () => done({ data: bound('company-a') }) })
  render(<App/>); await screen.findByText('Checking authorized billing status…')
  fireEvent.click(screen.getByRole('button', { name: 'Overview' }))
  await screen.findByRole('heading', { level: 1, name: 'Overview' })
  await act(async () => resolve())
  expect(screen.queryByText('acct_SYNTHETIC')).toBeNull()
  expect(window.location.hash).toBe('#Overview')
})
