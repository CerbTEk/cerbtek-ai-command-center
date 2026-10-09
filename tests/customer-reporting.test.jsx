import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { buildCustomerReport, customerRequestEvidence, reportingNumber, reportingReservation } from '../src/customer-reporting-model'
import CustomerOperationsReport from '../src/CustomerOperationsReport'
import CustomerRequestEvidence, { CustomerUsageSummary } from '../src/CustomerRequestEvidence'
import WorkflowMonitor from '../src/WorkflowMonitor'

const clone = value => JSON.parse(JSON.stringify(value))
function fixture({ role = 'admin', status = 'awaiting_approval', actionStatus = 'Executed', phase = 'ProviderAccepted', input = 12, output = 6, count = 1 } = {}) {
  const org = 'org-1', user = 'user-1'
  const configuration = { id: 'config-1', organization_id: org, version: 1, configuration: { provider: 'openai', model: 'synthetic-model', task: 'customer_reply' } }
  const context = { id: 'context-1', organization_id: org, version: 1, context: { company_name: 'Synthetic company', reply_guidance: 'Use confirmed facts only.' } }
  const workflow = { id: 'request-1', organization_id: org, revision: 2, requested_by: user, assigned_to: user, customer_email: 'synthetic@example.test', subject: 'Delivery question', message: 'When is delivery?', status, created_at: '2026-10-08T08:00:00Z', context_version_id: context.id, context_version: context, configuration_id: configuration.id, configuration, ai_request_key: 'ai-key-1', draft_requested_by: user, action_request_id: 'action-1', ai_run: { id: 'ai-1', organization_id: org, configuration_id: configuration.id, request_key: 'ai-key-1', requested_by: user, status: 'accepted', usage: { input_tokens: input, output_tokens: output }, reserved_microusd: 40000, created_at: '2026-10-08T08:01:00Z', finished_at: '2026-10-08T08:01:03Z', reviewed_at: '2026-10-08T08:02:00Z', draft: { title: 'Saved draft', body: 'Please review the date.', source_ids: ['manual-1'], warnings: [] } }, action_request: { id: 'action-1', organization_id: org, customer_workflow_id: 'request-1', provider: 'microsoft', action_type: 'send_email', status: actionStatus, created_at: '2026-10-08T08:03:00Z', approved_at: '2026-10-08T08:04:00Z', executed_at: actionStatus === 'Executed' ? '2026-10-08T08:05:02Z' : null }, receipt: phase ? { phase, dispatch_started_at: '2026-10-08T08:05:00Z', provider_accepted_at: phase === 'ProviderAccepted' ? '2026-10-08T08:05:01Z' : null, reconciled_at: phase.startsWith('Confirmed') ? '2026-10-08T08:06:00Z' : null } : null }
  const data = { ok: true, contract_version: 1, organization_id: org, actor: { id: user, role }, configuration, context, workflows: [workflow], people: [{ user_id: user, role }], limit: 100 }
  if (count > 1) data.workflows = Array.from({ length: count }, (_, index) => ({ ...workflow, id: `request-${index + 1}`, ai_run: null, ai_request_key: null, action_request: null, action_request_id: null, receipt: null }))
  const client = { functions: { invoke: vi.fn(async () => ({ data: clone(data), error: null })) } }
  return { data, workflow, props: { client, organizationId: org, userId: user }, client }
}
const report = f => buildCustomerReport(f.data, f.props.organizationId, f.props.userId)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function mount(f) { const view = render(<CustomerOperationsReport {...f.props}/>); await waitFor(() => expect(screen.queryByText('Loading recorded customer activity…')).toBeNull()); return view }
beforeEach(() => { window.history.replaceState({}, '', '/app/#AI%20Ops'); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External calls prohibited') })) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('truthful current-attempt reporting', () => {
  it('keeps acceptance separate from delivery and business resolution', () => {
    const f = fixture(), r = report(f)
    expect(r.counts.accepted).toBe(1); expect(r.requests[0].delivery).toBe('Not recorded'); expect(r.requests[0].resolution).toBe('Not recorded')
    expect(r.usage.input.value).toBe(12); expect(r.usage.output.value).toBe(6); expect(r.usage.reservation.value).toBe(40000); expect(r.usage.actualCost).toBeNull()
    expect(r.requests[0].aiIntervalMs).toBe(3000)
  })
  it.each([['Approved', null, 'approved'], ['Pending', null, 'review'], ['Failed', 'Dispatching', 'attention'], ['Executing', 'Dispatching', 'attention'], ['Failed', 'ConfirmedNotSent', 'not_sent'], ['Failed', 'ProviderAccepted', 'accepted'], ['Failed', 'ConfirmedAccepted', 'accepted'], ['Executed', 'ConfirmedNotSent', 'attention']])('reports action %s and receipt %s as %s', (actionStatus, phase, expected) => {
    const f = fixture({ actionStatus, phase }); expect(report(f).requests[0].email.key).toBe(expected)
  })
  it.each([['Failed', 'ConfirmedNotSent'], ['Failed', 'ProviderAccepted'], ['Executing', 'ProviderAccepted']])('does not mark a known receipt as unresolved for %s/%s', (actionStatus, phase) => {
    const f = fixture({ actionStatus, phase }), r = report(f); expect(r.counts.attention).toBe(0); expect(r.requests[0].state.key).not.toBe('exception')
  })
  it('preserves known token zero and rejects strings, negative or absent usage', () => {
    const f = fixture({ input: 0, output: 0 }); expect(report(f).usage.input.value).toBe(0); expect(reportingNumber(0)).toBe('0')
    for (const value of [undefined, null, '0', -1, NaN, Infinity, 0.5]) { f.workflow.ai_run.usage.input_tokens = value; expect(report(f).usage.input.value).toBeNull() }
    expect(reportingNumber(null)).toBe('Not recorded'); expect(reportingReservation(null)).toBe('Not recorded')
  })
  it('reports partial token coverage without treating missing values as zero', () => {
    const f = fixture(); const next = clone(f.workflow); next.id = 'request-2'; next.ai_request_key = next.ai_run.request_key = 'key-2'; next.ai_run.id = 'ai-2'; next.ai_run.usage = null; next.action_request = null; next.action_request_id = null; f.data.workflows.push(next)
    const r = report(f); expect(r.usage.input).toEqual({ value: 12, recorded: 1, missing: 1 }); expect(r.usage.runs).toBe(2)
    render(<CustomerUsageSummary report={r}/>); expect(screen.getByText(/Input usage recorded for 1 of 2/)).toBeTruthy(); expect(screen.getByText(/not actual spend/)).toBeTruthy()
  })
  it('shows empty runs as no measured usage, never zero spend', () => {
    const f = fixture({ count: 2 }); const r = report(f); expect(r.usage.runs).toBe(0); expect(r.usage.input.value).toBeNull(); expect(r.usage.actualCost).toBeNull()
  })
  it.each(['organization', 'key', 'configuration', 'requester'])('rejects mismatched AI %s at the response boundary', dimension => {
    const f = fixture(), fields = { organization: 'organization_id', key: 'request_key', configuration: 'configuration_id', requester: 'requested_by' }; f.workflow.ai_run[fields[dimension]] = 'other'
    expect(() => report(f)).toThrow('workspace_unverified')
  })
  it('does not attribute tokens to unbound or merely matching records', () => {
    const f = fixture(); delete f.workflow.ai_request_key; delete f.workflow.ai_run.request_key
    const r = customerRequestEvidence(f.workflow); expect(r.run).toBeNull(); expect(r.usage.input).toBeNull(); expect(r.usage.model).toBeNull()
  })
  it('does not use another company configuration to label a current AI run', () => {
    const f = fixture(); f.workflow.configuration = { ...f.workflow.configuration, organization_id: 'another-company' }
    expect(customerRequestEvidence(f.workflow).usage.model).toBeNull()
  })
  it('does not report unbound receipt acceptance', () => {
    const f = fixture(); f.workflow.action_request.customer_workflow_id = 'other'
    expect(customerRequestEvidence(f.workflow).email.key).toBe('attention'); expect(customerRequestEvidence(f.workflow).receipt).toBeNull()
  })
  it('sorts real timestamps and keeps absent milestones undated without inventing times', () => {
    const f = fixture(); f.workflow.ai_run.created_at = null; f.workflow.ai_run.finished_at = 'invalid'; f.workflow.action_request.approved_at = null
    const e = customerRequestEvidence(f.workflow); expect(e.aiIntervalMs).toBeNull(); expect(e.undatedEvents.map(x => x.key)).toContain('ai_reserved'); expect(e.events.map(x => x.at)).toEqual(e.events.map(x => x.at).sort()); expect(e.events.find(x => x.key === 'email_approved')).toBeUndefined()
  })
  it('does not claim complete historical attempts, invoice spend or satisfaction', () => {
    const f = fixture(); render(<CustomerRequestEvidence workflow={f.workflow}/>); expect(screen.getByText(/earlier draft attempts and assignment changes are not returned/)).toBeTruthy(); expect(screen.getAllByText('Not recorded').length).toBeGreaterThan(2); expect(screen.getByText('40,000 micro-USD')).toBeTruthy()
  })
  it.each(['Pending', 'Approved', 'Executing'])('does not treat cancelled %s as actionable work without a receipt', actionStatus => {
    const f = fixture({ status: 'cancelled', actionStatus, phase: null }); const r = report(f); expect(r.requests[0].email.key).toBe('cancelled'); expect(r.counts.awaitingReview).toBe(0); expect(r.counts.attention).toBe(0)
  })
  it('does not invent a dispatch milestone for a pre-dispatch not-sent closure', () => {
    const f = fixture({ actionStatus: 'Failed', phase: 'ConfirmedNotSent' }); f.workflow.receipt.dispatch_started_at = null; const e = customerRequestEvidence(f.workflow); expect([...e.events, ...e.undatedEvents].some(event => event.key === 'dispatch')).toBe(false); expect(e.email.key).toBe('not_sent')
  })
  it('keeps cancelled requests and previously accepted email evidence separate', () => {
    const f = fixture({ status: 'cancelled' }); const r = report(f); expect(r.counts.cancelled).toBe(1); expect(r.counts.accepted).toBe(1); expect(r.requests[0].state.label).toBe('Cancelled')
  })
  it('hides stale knowledge source citations', () => {
    const f = fixture(); f.workflow.knowledge_stale = true; f.workflow.knowledge_sources = [{ source_id: 'hidden-source', title: 'PRIVATE CONTENT' }]
    render(<CustomerRequestEvidence workflow={f.workflow}/>); expect(screen.queryByText('PRIVATE CONTENT')).toBeNull(); expect(screen.getByText(/citations remain hidden/)).toBeTruthy()
  })
  it('hides knowledge reference metadata that expires before detail is opened', () => {
    const f = fixture(), id = '11111111-1111-4111-8111-111111111111'; f.workflow.knowledge_stale = false; f.workflow.knowledge_sources = [{ document_id: id, version_id: id, chunk_id: id, source_id: `knowledge:${id}:${id}:${id}`, title: 'Expired source title', content_text: 'Expired policy', content_sha256: 'a'.repeat(64), version_sha256: 'b'.repeat(64), version: 1, audience: 'organization', source_kind: 'manual', source_name: 'Manual', review_due_at: '2020-01-01T00:00:00Z' }]; render(<CustomerRequestEvidence workflow={f.workflow}/>); expect(screen.queryByText('Expired source title')).toBeNull(); expect(screen.getByText(/citations remain hidden/)).toBeTruthy()
  })
  it('filters by request creation, discloses undated records and limits the loaded sample', () => {
    const f = fixture({ count: 100 }); f.data.workflows[0].created_at = null
    const r = buildCustomerReport(f.data, 'org-1', 'user-1', { days: 7, now: '2026-10-09T18:00:00Z' }); expect(r.limitReached).toBe(true); expect(r.loadedCount).toBe(100); expect(r.counts.requests).toBe(99); expect(r.undatedRequests).toBe(1)
  })
  it.each(['actor', 'tenant', 'member_assignment', 'over_limit'])('fails closed on %s scope', dimension => {
    const f = fixture({ role: 'member' }); if (dimension === 'actor') f.data.actor.id = 'other'; if (dimension === 'tenant') f.workflow.organization_id = 'other'; if (dimension === 'member_assignment') f.workflow.assigned_to = 'other'; if (dimension === 'over_limit') f.data.workflows.push(...Array.from({ length: 100 }, (_, index) => ({ ...f.workflow, id: `extra-${index}` })))
    expect(() => report(f)).toThrow('workspace_unverified')
  })
})

describe('read-only operations workspace', () => {
  it('loads only existing read operation and presents usage and inspectable milestones', async () => {
    const f = fixture(); await mount(f); fireEvent.click(screen.getByRole('button', { name: 'Inspect request: Delivery question' }))
    expect(screen.getByRole('region', { name: 'Selected customer request' })).toBeTruthy(); expect(screen.getByRole('heading', { name: 'Delivery question' })).toBe(document.activeElement)
    expect(new URLSearchParams(location.search).get('kairoCustomerRequest')).toBe('request-1')
    expect(f.client.functions.invoke.mock.calls).toEqual([['customer-workflow', { body: { operation: 'load', organization_id: 'org-1' } }]])
    expect(screen.queryByRole('button', { name: /Send approved|Approve exact|Generate/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close request details' })); expect(screen.queryByRole('region', { name: 'Selected customer request' })).toBeNull(); expect(screen.getByRole('button', { name: 'Inspect request: Delivery question' })).toBe(document.activeElement)
  })
  it('responds to back/forward selections and selected period without mutation', async () => {
    const f = fixture(); await mount(f)
    act(() => { window.history.pushState({}, '', '/app/?kairoCustomerRequest=request-1&kairoCustomerDays=7#AI%20Ops'); window.dispatchEvent(new PopStateEvent('popstate')) })
    expect(screen.getByRole('region', { name: 'Selected customer request' })).toBeTruthy(); expect(screen.getByLabelText('Customer request period').value).toBe('7')
    act(() => { window.history.replaceState({}, '', '/app/#AI%20Ops'); window.dispatchEvent(new PopStateEvent('popstate')) }); expect(screen.queryByRole('region', { name: 'Selected customer request' })).toBeNull()
    expect(f.client.functions.invoke).toHaveBeenCalledTimes(1)
  })
  it('treats unknown deep links as unavailable and never fetches arbitrary request IDs', async () => {
    window.history.replaceState({}, '', '/app/?kairoCustomerRequest=foreign#AI%20Ops'); const f = fixture(); await mount(f)
    expect(screen.getByText(/not available in the loaded sample/)).toBeTruthy(); expect(screen.queryByRole('region', { name: 'Selected customer request' })).toBeNull(); expect(f.client.functions.invoke).toHaveBeenCalledTimes(1)
  })
  it('clears old data on refresh, prevents repeat refreshes and reports denied load as unavailable', async () => {
    const f = fixture(); await mount(f); const pending = deferred(); f.client.functions.invoke.mockReturnValue(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh request report' })); expect(screen.queryByText('Delivery question')).toBeNull(); expect(screen.getByRole('button', { name: 'Refresh request report' }).disabled).toBe(true)
    await act(async () => pending.resolve({ data: { ok: false, error: 'organization_access_denied' } })); expect(screen.getByRole('alert').textContent).toContain('Reporting counts are unavailable'); expect(screen.queryByLabelText('Recorded request outcomes')).toBeNull()
  })
  it.each(['organization', 'account'])('discards a late response after %s switch', async kind => {
    const f = fixture(), pending = deferred(); f.client.functions.invoke.mockReturnValue(pending.promise); const view = render(<CustomerOperationsReport {...f.props}/>)
    const next = fixture(); next.workflow.subject = 'Current request'; if (kind === 'organization') { next.props.organizationId = next.data.organization_id = next.workflow.organization_id = next.data.context.organization_id = next.data.configuration.organization_id = next.workflow.ai_run.organization_id = next.workflow.action_request.organization_id = 'org-2' } else { next.props.userId = next.data.actor.id = 'user-2' }
    view.rerender(<CustomerOperationsReport {...next.props}/>); await waitFor(() => expect(screen.getByText('Current request')).toBeTruthy()); await act(async () => pending.resolve({ data: f.data })); expect(screen.queryByText('Delivery question')).toBeNull()
  })
  it('supports viewer reporting and retains explicit assigned-only employee scope', async () => {
    const f = fixture({ role: 'viewer' }); const view = await mount(f); expect(screen.getByText('Delivery question')).toBeTruthy(); expect(screen.queryByRole('button', { name: /Approve|Send/ })).toBeNull(); view.unmount()
    const member = fixture({ role: 'member' }); await mount(member); expect(screen.getByText(/employees see assigned requests only/)).toBeTruthy()
  })
  it('discloses capped sample and keeps table filters separate from totals', async () => {
    const f = fixture({ count: 100 }); await mount(f); expect(screen.getByText(/100-request limit was reached/)).toBeTruthy(); fireEvent.change(screen.getByLabelText('Find a customer request'), { target: { value: 'nonexistent' } }); expect(screen.getByText('No loaded requests match this view.')).toBeTruthy(); expect(within(screen.getByLabelText('Recorded request outcomes')).getAllByText('100').length).toBeGreaterThan(0)
  })
  it('handles a source expiring after load without throwing or exposing its references', async () => {
    const f = fixture(), id = '11111111-1111-4111-8111-111111111111'; let now = Date.parse('2026-10-09T12:00:00Z'); vi.spyOn(Date, 'now').mockImplementation(() => now); f.data.knowledge_contract_version = 1; f.workflow.knowledge_stale = false; f.workflow.knowledge_sources = [{ document_id: id, version_id: id, chunk_id: id, source_id: `knowledge:${id}:${id}:${id}`, title: 'Expires soon', content_text: 'Confirmed policy.', content_sha256: 'a'.repeat(64), version_sha256: 'b'.repeat(64), version: 1, audience: 'organization', source_kind: 'manual', source_name: 'Manual policy', review_due_at: '2026-10-09T12:01:00Z' }]; await mount(f); now = Date.parse('2026-10-09T12:02:00Z'); fireEvent.change(screen.getByLabelText('Customer request period'), { target: { value: '7' } }); expect(screen.getByRole('alert').textContent).toContain('could not be verified'); expect(screen.queryByText('Delivery question')).toBeNull()
  })
  it('unmount during read causes no subsequent presentation', async () => {
    const f = fixture(), pending = deferred(); f.client.functions.invoke.mockReturnValue(pending.promise); const view = render(<CustomerOperationsReport {...f.props}/>); view.unmount(); await act(async () => pending.resolve({ data: f.data })); expect(screen.queryByText('Delivery question')).toBeNull()
  })
  it('keeps an open request and URL aligned when the active reporting tab is clicked again', async () => {
    window.history.replaceState({}, '', '/app/?kairoReport=customer#AI%20Ops'); const f = fixture(); render(<WorkflowMonitor {...f.props}/>); await waitFor(() => expect(screen.getByText('Delivery question')).toBeTruthy()); fireEvent.click(screen.getByRole('button', { name: 'Inspect request: Delivery question' })); const before = location.href; fireEvent.click(screen.getByRole('button', { name: 'Customer requests', exact: true })); expect(location.href).toBe(before); expect(screen.getByRole('region', { name: 'Selected customer request' })).toBeTruthy()
  })
  it('opens customer reporting as a separate monitor view without generic table reads', async () => {
    window.history.replaceState({}, '', '/app/?kairoReport=customer#AI%20Ops'); const f = fixture(); f.client.from = vi.fn(() => { throw new Error('Generic reads must not run in this view') }); render(<WorkflowMonitor {...f.props}/>); await waitFor(() => expect(screen.getByText('Delivery question')).toBeTruthy()); expect(f.client.from).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: 'Customer requests' }).getAttribute('aria-pressed')).toBe('true')
  })
})
