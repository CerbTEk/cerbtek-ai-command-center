import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
const api = vi.hoisted(() => ({ invoke: vi.fn(), from: vi.fn(), getSession: vi.fn(), onAuthStateChange: vi.fn(), signOut: vi.fn() }))
vi.mock('../src/supabase', () => ({ supabase: { functions: { invoke: api.invoke }, from: api.from, auth: { getSession: api.getSession, onAuthStateChange: api.onAuthStateChange, signOut: api.signOut } } }))
import { App } from '../src/main'
let emit, actor
const setup = company => ({ ok: true, contract_version: 1, organization_id: company, actor: { id: actor, role: 'admin' }, context: null, configuration: null, workflows: [], people: [{ user_id: actor, role: 'admin' }], limit: 100, readiness: { context_ready: false, configuration_ready: false, microsoft_ready: false, microsoft_account: null, microsoft_connection_id: null, distinct_reviewer_available: false, live_inference_enabled: false } })
beforeEach(() => {
  actor = 'owner-a'; window.history.replaceState({}, '', '/app/?kairoCompany=company-a#Customer%20Setup')
  api.signOut.mockReset(); api.from.mockReset(); api.invoke.mockReset()
  api.getSession.mockResolvedValue({ data: { session: { user: { id: actor }, access_token: 'synthetic' } } })
  api.onAuthStateChange.mockImplementation(callback => { emit = callback; return { data: { subscription: { unsubscribe: vi.fn() } } } })
  api.invoke.mockImplementation(async (name, { body }) => {
    if (name === 'customer-workflow') return { data: setup(body.organization_id) }
    if (name === 'company-knowledge') return { data: { ok: true, schema_version: 1, organization_id: body.organization_id, actor_user_id: actor, actor_role: 'admin', can_manage: true, ...(body.operation === 'access' ? { contract: 'company-knowledge-v1', ai_connected: false } : { documents: [] }) } }
    return { data: { members: [] }, error: null }
  })
  api.from.mockImplementation(table => { let single = false; const result = () => ({ data: table === 'organizations' ? [{ id: 'company-a', name: 'Company A' }, { id: 'company-b', name: 'Company B' }] : single ? null : [], error: null }); const q = { select: () => q, eq: () => q, order: () => q, limit: () => q, maybeSingle: () => { single = true; return Promise.resolve(result()) }, then: (resolve, reject) => Promise.resolve(result()).then(resolve, reject) }; return q })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.replaceState({}, '', '/'); window.sessionStorage.clear() })
const opened = () => screen.findByText('Saved setup checked. No model request, connection change, or email was sent.')
it('opens and refreshes the direct Customer Setup route', async () => {
  render(<App/>); await opened(); expect(screen.getByRole('heading', { level: 1, name: 'Customer Setup' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Recheck saved setup' })); await opened()
  expect(api.invoke.mock.calls.filter(([name]) => name === 'customer-workflow')).toHaveLength(2)
})
it('offers the guide from overview without changing prior setup navigation', async () => {
  window.history.replaceState({}, '', '/app/#Overview'); render(<App/>); fireEvent.click(await screen.findByRole('button', { name: 'Open guided customer setup' })); await opened()
  expect(window.location.hash).toBe('#Customer%20Setup')
  fireEvent.click(screen.getByRole('link', { name: 'Return to overview' })); await screen.findByRole('heading', { level: 1, name: 'Overview' })
})
it('follows task links through normal section history', async () => {
  render(<App/>); await opened(); fireEvent.click(screen.getByRole('link', { name: 'Review Team & Roles' })); await screen.findByRole('heading', { level: 1, name: 'Team & Roles' })
  expect(window.location.hash).toBe('#Team%20Access')
  await act(async () => { window.history.back(); await new Promise(r => setTimeout(r, 50)) }); await opened(); expect(window.location.hash).toBe('#Customer%20Setup')
})
it('rechecks the selected company and resets the prior guide snapshot', async () => {
  const view = render(<App/>); await opened(); fireEvent.change(view.container.querySelector('.org-switcher select'), { target: { value: 'company-b' } }); await opened()
  await screen.findByRole('heading', { name: 'Saved setup for Company B' })
  expect(api.invoke.mock.calls.filter(([name]) => name === 'customer-workflow').at(-1)[1].body.organization_id).toBe('company-b')
})
it('keeps a token refresh stable but remounts for a new authenticated account', async () => {
  render(<App/>); await opened(); const count = () => api.invoke.mock.calls.filter(([name]) => name === 'customer-workflow').length
  await act(async () => emit('TOKEN_REFRESHED', { user: { id: actor }, access_token: 'new' })); expect(count()).toBe(1)
  actor = 'owner-b'; await act(async () => emit('SIGNED_IN', { user: { id: actor }, access_token: 'other' })); await opened(); expect(count()).toBe(2)
})
it('closes cleanly on sign-out and permits no setup snapshot on signed-out page', async () => {
  render(<App/>); await opened(); await act(async () => emit('SIGNED_OUT', null))
  expect(screen.queryByRole('heading', { name: 'Saved setup for Company A' })).toBeNull(); await screen.findByRole('button', { name: 'Sign in' })
})
it('supports narrow DOM with semantic headings and interactive links', async () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 }); render(<App/>); await opened()
  expect(screen.getByRole('heading', { name: 'Reply to a customer with a reviewed email' })).toBeTruthy()
  const link = screen.getByRole('link', { name: 'Review Microsoft connection' }); link.focus(); expect(document.activeElement).toBe(link)
  fireEvent.click(link); await screen.findByRole('heading', { level: 1, name: 'Integrations' })
})
