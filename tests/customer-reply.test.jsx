import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import CustomerReplyWorkspace from '../src/CustomerReplyWorkspace'
import { canCancelWorkflow, draftPath, emailMatchesDraft, eligibleReviewers, filterWorkflows, independentReviewer, microsoftBindingMatches, validDraft, validKnowledgeSource, knowledgeSourceRef, sourceMatchesWorkflow, verifyWorkspace, workflowState } from '../src/customer-reply-model'

let serial = 0
const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej }); return { promise, resolve, reject } }
const clone = value => JSON.parse(JSON.stringify(value))
const click = name => fireEvent.click(screen.getByRole('button', { name, exact: true }))
const directClick = element => element[Object.keys(element).find(key => key.startsWith('__reactProps$'))].onClick({ preventDefault() {} })

function fixture({ role = 'admin', status = 'intake', actionStatus, live = false } = {}) {
  const organizationId = `company-${++serial}`, actorId = `reviewer-${serial}`, requester = `employee-${serial}`
  const context = { id: 'context-1', organization_id: organizationId, version: 1, source_kind: 'manual_company_guidance', context: { company_name: 'Synthetic company', reply_guidance: 'Use confirmed delivery dates. Never promise an unverified refund.' } }
  const configuration = { id: 'config-1', organization_id: organizationId, version: 1, configuration: { provider: 'openai', model: 'synthetic-only', task: 'customer_reply' } }
  const draft = { title: 'Your delivery question', body: 'Thank you for your question. Your scheduled date is 14 October.', source_ids: ['manual-1'], warnings: ['Confirm the date before sending.'] }
  const workflow = { id: 'workflow-1', organization_id: organizationId, request_key: 'intake-key', revision: 1, requested_by: requester, assigned_to: requester, customer_name: 'Synthetic customer', customer_email: 'customer@example.test', subject: 'Delivery question', message: 'Please confirm our delivery date.', status, context_version_id: null, configuration_id: null, ai_request_key: null, draft_requested_by: null, action_request_id: null, ai_run: null, action_request: null, receipt: null, context_stale: false, configuration_stale: false, created_at: '2026-10-09T12:00:00Z' }
  if (status !== 'intake') Object.assign(workflow, { context_version_id: context.id, context_version: context, configuration_id: configuration.id, configuration, ai_request_key: 'draft-key', draft_requested_by: requester, ai_run: { id: 'ai-1', organization_id: organizationId, configuration_id: configuration.id, request_key: 'draft-key', requested_by: requester, status: status === 'draft_ready' ? 'awaiting_review' : status === 'draft_rejected' ? 'rejected' : status === 'ai_unknown' ? 'unknown' : status === 'ai_failed' ? 'failed' : status === 'drafting' ? 'reserved' : 'accepted', draft } })
  if (actionStatus) Object.assign(workflow, { status: 'awaiting_approval', action_request_id: 'action-1', action_request: { id: 'action-1', organization_id: organizationId, customer_workflow_id: workflow.id, status: actionStatus, provider: 'microsoft', action_type: 'send_email', requested_by: requester, approved_by: actionStatus === 'Pending' ? null : actorId, connection_id: 'connection-1', approved_connection_binding: actionStatus === 'Pending' ? null : { id: 'connection-1', organization_id: organizationId, external_account_id: 'microsoft-account-1' }, payload: { to: workflow.customer_email, subject: draft.title, message: draft.body } } })
  const data = { ok: true, contract_version: 1, organization_id: organizationId, actor: { id: actorId, role }, context, configuration, workflows: [workflow], people: [{ user_id: requester, role: 'member' }, { user_id: actorId, role }, { user_id: 'another-reviewer', role: 'owner' }], readiness: { context_ready: true, configuration_ready: true, live_inference_enabled: live, microsoft_ready: true, microsoft_account: 'microsoft-account-1', microsoft_connection_id: 'connection-1', distinct_reviewer_available: true }, limit: 100 }
  const client = { functions: { invoke: vi.fn(async (name, { body }) => {
    if (name === 'customer-workflow' && body.operation === 'load') return { data: clone(data), error: null }
    throw new Error('Unexpected synthetic request')
  }) } }
  const props = { org: { id: organizationId, name: 'Synthetic company' }, session: { user: { id: actorId } }, client }
  return { data, workflow, context, configuration, actorId, requester, client, props, envelope: value => ({ data: { ok: true, contract_version: 1, organization_id: organizationId, ...value }, error: null }) }
}

async function mount(f) { const view = render(<CustomerReplyWorkspace {...f.props}/>); await waitFor(() => expect(screen.queryByText('Checking saved requests and setup…')).toBeNull()); return view }
async function select(f) { await mount(f); click(new RegExp(f.workflow.subject)); return within(screen.getByRole('article')) }
const operations = f => f.client.functions.invoke.mock.calls.filter(([, args]) => args.body.operation !== 'load')
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External access forbidden in synthetic tests') })) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.sessionStorage.clear() })

describe('strict workspace and record boundaries', () => {
  it('fails closed when backend is missing; setup links stay available', async () => {
    const f = fixture(); f.client.functions.invoke.mockResolvedValue({ data: { ok: false, error: 'customer_workflow_not_installed' } }); await mount(f)
    expect(screen.getByRole('alert').textContent).toContain('backend update must be installed')
    expect(screen.getByRole('button', { name: 'New request' }).disabled).toBe(true)
    expect(screen.getByRole('link', { name: 'Microsoft connection' }).getAttribute('href')).toBe('#Integrations')
  })
  it.each(['version', 'company', 'actor', 'nested_source', 'nested_run', 'duplicate'])('rejects mismatched %s load responses', async kind => {
    const f = fixture({ status: 'draft_ready' })
    if (kind === 'version') f.data.contract_version = 2
    if (kind === 'company') f.data.organization_id = 'wrong'
    if (kind === 'actor') f.data.actor.id = 'wrong'
    if (kind === 'nested_source') f.workflow.context_version = { ...f.context, organization_id: 'wrong' }
    if (kind === 'nested_run') f.workflow.ai_run.organization_id = 'wrong'
    if (kind === 'duplicate') f.data.workflows.push(clone(f.workflow))
    await mount(f); expect(screen.getByRole('alert').textContent).toContain('could not be verified'); expect(screen.queryByText(f.workflow.message)).toBeNull()
  })
  it.each(['organization', 'account'])('ignores a delayed load after %s switches', async kind => {
    const f = fixture(), delayed = deferred(); f.client.functions.invoke.mockReturnValue(delayed.promise)
    const view = render(<CustomerReplyWorkspace {...f.props}/>), next = fixture()
    if (kind === 'account') { next.props.org = f.props.org; next.data.organization_id = f.props.org.id; next.workflow.organization_id = f.props.org.id; next.context.organization_id = f.props.org.id; next.configuration.organization_id = f.props.org.id }
    view.rerender(<CustomerReplyWorkspace {...next.props}/>); await waitFor(() => expect(screen.queryByText('Checking saved requests and setup…')).toBeNull())
    await act(async () => delayed.resolve({ data: f.data }))
    expect(screen.queryByText(`Account ${f.requester}`)).toBeNull(); expect(screen.getByText(`Account ${next.requester}`)).toBeTruthy()
  })
  it('clears dirty and busy callbacks on unmount and protects unsaved cancel', async () => {
    const f = fixture(); f.props.onDirtyChange = vi.fn(); f.props.onBusyChange = vi.fn(); const view = await mount(f)
    click('New request'); fireEvent.change(screen.getByLabelText('Customer name'), { target: { value: 'Unsaved name' } })
    expect(f.props.onDirtyChange).toHaveBeenLastCalledWith(true)
    vi.spyOn(window, 'confirm').mockReturnValue(false); click('Cancel new request'); expect(screen.getByLabelText('Customer name').value).toBe('Unsaved name')
    window.confirm.mockReturnValue(true); click('Cancel new request'); expect(screen.queryByLabelText('Customer name')).toBeNull(); expect(operations(f)).toHaveLength(0)
    view.unmount(); expect(f.props.onDirtyChange).toHaveBeenLastCalledWith(false); expect(f.props.onBusyChange).toHaveBeenLastCalledWith(false)
  })
})

describe('intake, context, and role-aware daily work', () => {
  it('saves a bounded versioned context without AI or email calls', async () => {
    const f = fixture(); await mount(f); click('Edit reply context')
    const guidance = screen.getByLabelText('Reply guidance and confirmed facts'); expect(guidance.maxLength).toBe(5000); expect(guidance.minLength).toBe(10)
    fireEvent.change(guidance, { target: { value: 'Use the new confirmed customer support hours.' } })
    f.client.functions.invoke.mockImplementation(async (name, { body }) => {
      if (body.operation === 'load') return { data: clone(f.data) }
      f.data.context = { ...f.context, version: 2, context: body.context }; return f.envelope({ context: f.data.context })
    })
    click('Save context version'); await screen.findByText(/Company reply context version 2 saved/)
    expect(operations(f)[0]).toEqual(['customer-workflow', { body: { organization_id: f.props.org.id, operation: 'save_context', expected_version: 1, context: { company_name: 'Synthetic company', reply_guidance: 'Use the new confirmed customer support hours.' } } }])
  })
  it('saves intake once under direct duplicate submissions; no inference or email follows', async () => {
    const f = fixture(), saved = deferred(); await mount(f); click('New request')
    for (const [label, value] of [['Customer name', 'New customer'], ['Customer email', 'new@example.test'], ['Request subject', 'New question'], ['Customer request and confirmed facts', 'A synthetic request to confirm service hours.']]) fireEvent.change(screen.getByLabelText(label), { target: { value } })
    expect(screen.getByLabelText('Request subject').maxLength).toBe(200)
    fireEvent.click(screen.getByRole('checkbox')); const form = screen.getByRole('form', { name: 'New customer request' })
    f.client.functions.invoke.mockImplementation((name, { body }) => body.operation === 'load' ? Promise.resolve({ data: clone(f.data) }) : saved.promise)
    act(() => { fireEvent.submit(form); fireEvent.submit(form) }); expect(operations(f)).toHaveLength(1)
    const body = operations(f)[0][1].body, workflow = { ...f.workflow, id: 'workflow-2', request_key: body.request_key, requested_by: f.actorId, assigned_to: f.actorId, ...Object.fromEntries(['customer_email', 'customer_name', 'subject', 'message'].map(key => [key, body[key]])) }
    f.data.workflows.unshift(workflow); await act(async () => saved.resolve(f.envelope({ workflow })))
    await screen.findByText('Customer request saved. No AI request or email has been sent.'); expect(operations(f)).toHaveLength(1)
  })
  it('keeps an uncertain intake locked through remount instead of submitting a replacement', async () => {
    const f = fixture(); const view = await mount(f); click('New request')
    for (const [label, value] of [['Customer name', 'Customer'], ['Customer email', 'new@example.test'], ['Request subject', 'Question'], ['Customer request and confirmed facts', 'Confirm hours.']]) fireEvent.change(screen.getByLabelText(label), { target: { value } })
    fireEvent.click(screen.getByRole('checkbox')); f.client.functions.invoke.mockRejectedValueOnce(new Error('Lost response')); click('Save request'); await screen.findByText(/An intake save is unconfirmed/)
    view.unmount(); await mount(f); expect(screen.getByRole('button', { name: 'New request' }).disabled).toBe(true); expect(operations(f)).toHaveLength(1)
  })
  it('employee can save intake but cannot generate or review AI even when enabled', async () => {
    const f = fixture({ role: 'member', live: true }); f.workflow.assigned_to = f.actorId; await select(f)
    const generate = screen.getByRole('button', { name: 'Generate AI draft' }); expect(generate.disabled).toBe(true); act(() => { directClick(generate) }); expect(operations(f)).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Edit reply context' })).toBeNull()
  })
  it('uses cached roster names only for verified people and never takes cached roles as authority', async () => {
    const f = fixture({ role: 'member', live: true }); f.workflow.assigned_to = f.actorId
    f.props.members = [{ user_id: f.actorId, email: 'employee@example.test', role: 'owner' }, { user_id: 'unverified-person', email: 'unverified@example.test', role: 'owner' }]
    await select(f); expect(screen.getByRole('article').textContent).toContain('Assigned to employee@example.test'); expect(screen.queryByText('unverified@example.test')).toBeNull(); expect(screen.getByRole('button', { name: 'Generate AI draft' }).disabled).toBe(true)
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: f.workflow.subject }))
  })
  it('disabled paid inference is visible and never bypassed by a direct handler', async () => {
    const f = fixture(); await select(f); const generate = screen.getByRole('button', { name: 'Generate AI draft' }); act(() => { directClick(generate) }); expect(generate.disabled).toBe(true); expect(operations(f)).toHaveLength(0); expect(screen.getByText(/Live AI generation is disabled/)).toBeTruthy()
  })
  it('viewer sees saved records without mutation controls', async () => {
    const f = fixture({ role: 'viewer' }); await select(f); expect(screen.getByRole('button', { name: 'New request' }).disabled).toBe(true); expect(screen.queryByRole('button', { name: 'Cancel request' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Save assignment' })).toBeNull()
  })
})

describe('pinned AI requests and exact reviewed email', () => {
  it('prepares and runs the saved workflow with no client-supplied input', async () => {
    const f = fixture({ live: true }); await select(f)
    f.client.functions.invoke.mockImplementation(async (name, { body }) => {
      if (body.operation === 'load') return { data: clone(f.data) }
      if (body.operation === 'prepare_draft') { Object.assign(f.workflow, { status: 'drafting', revision: 2, ai_request_key: body.request_key, draft_requested_by: f.actorId, configuration_id: f.configuration.id, configuration: f.configuration, context_version_id: f.context.id, context_version: f.context }); return f.envelope({ workflow: clone(f.workflow) }) }
      if (name === 'ai-draft' && body.operation === 'run') { f.workflow.status = 'draft_ready'; f.workflow.ai_run = { id: 'ai-new', organization_id: f.props.org.id, configuration_id: f.configuration.id, request_key: body.request_key, requested_by: f.actorId, status: 'awaiting_review', draft: { title: 'Reply', body: 'Please confirm the time.', source_ids: ['manual-1'], warnings: [] } }; return { data: { run: f.workflow.ai_run } } }
      throw new Error('Unexpected')
    })
    const generate = screen.getByRole('button', { name: 'Generate AI draft' }); act(() => { directClick(generate); directClick(generate) })
    await screen.findByText('AI draft saved for review. No email has been queued or sent.')
    expect(operations(f)).toHaveLength(2); const body = operations(f)[1][1].body
    expect(body).toEqual({ operation: 'run', organization_id: f.props.org.id, customer_workflow_id: f.workflow.id, expected_revision: 2, configuration_id: f.configuration.id, request_key: f.workflow.ai_request_key }); expect(body).not.toHaveProperty('input')
  })
  it('resumes a prepared request with its original key and configuration, never a replacement', async () => {
    const f = fixture({ live: true, status: 'drafting' }); f.workflow.ai_run = null; f.workflow.draft_requested_by = f.actorId; await select(f)
    f.client.functions.invoke.mockImplementation(async (_name, { body }) => {
      if (body.operation === 'load') return { data: clone(f.data) }
      return { data: { run: { id: 'ai-resumed', organization_id: f.props.org.id, configuration_id: f.configuration.id, requested_by: f.actorId, request_key: 'draft-key', status: 'reserved' } } }
    })
    click('Resume saved AI request'); await waitFor(() => expect(operations(f)).toHaveLength(1)); expect(operations(f)[0][0]).toBe('ai-draft'); expect(operations(f)[0][1].body.request_key).toBe('draft-key')
  })
  it.each(['reserved', 'unknown'])('never offers a replacement for an existing %s AI outcome', async status => {
    const f = fixture({ live: true, status: status === 'reserved' ? 'drafting' : 'ai_unknown' }); await select(f)
    expect(screen.queryByRole('button', { name: /Generate|Resume/ })).toBeNull(); expect(screen.getByText(/AI outcome is pending or unknown/)).toBeTruthy()
  })
  it('shows exact source, recipient, subject and body; draft acceptance does not queue or send', async () => {
    const f = fixture({ status: 'draft_ready' }); const detail = await select(f)
    expect(detail.getByRole('region', { name: 'Exact email preview' }).textContent).toContain('customer@example.test'); expect(detail.getByRole('region', { name: 'Saved company source' }).textContent).toContain(f.context.context.reply_guidance)
    f.client.functions.invoke.mockImplementation(async (_name, { body }) => { if (body.operation === 'load') return { data: clone(f.data) }; f.workflow.status = 'draft_accepted'; f.workflow.ai_run.status = 'accepted'; return { data: { run: f.workflow.ai_run } } })
    fireEvent.click(screen.getByLabelText('I checked the draft, source context, and warnings.')); click('Accept draft for use'); await screen.findByText(/AI draft review saved/)
    expect(operations(f)).toHaveLength(1); expect(operations(f)[0][1].body.operation).toBe('review'); expect(screen.getByRole('button', { name: 'Queue exact email for approval' }).disabled).toBe(true)
  })
  it.each(['requester', 'author', 'assignee'])('blocks the %s from independently approving', async kind => {
    const f = fixture({ status: 'draft_accepted', actionStatus: 'Pending' })
    if (kind === 'requester') f.workflow.action_request.requested_by = f.actorId
    if (kind === 'author') { f.workflow.draft_requested_by = f.actorId; f.workflow.ai_run.requested_by = f.actorId }
    if (kind === 'assignee') f.workflow.assigned_to = f.actorId
    await select(f); const approve = screen.getByRole('button', { name: 'Approve exact email' }); expect(approve.disabled).toBe(true); act(() => { directClick(approve) }); expect(operations(f)).toHaveLength(0)
  })
  it('approval only records approval; sending requires a new review and click', async () => {
    const f = fixture({ status: 'draft_accepted', actionStatus: 'Pending' }); await select(f)
    f.client.functions.invoke.mockImplementation(async (name, { body }) => {
      if (name === 'customer-workflow') return { data: clone(f.data) }
      Object.assign(f.workflow.action_request, { status: 'Approved', approved_by: f.actorId, approved_connection_binding: { id: 'connection-1', organization_id: f.props.org.id, external_account_id: 'microsoft-account-1' } }); return { data: { ok: true, request: clone(f.workflow.action_request) } }
    })
    fireEvent.click(screen.getByLabelText('I reviewed the exact email and its sources.')); click('Approve exact email'); await screen.findByText('Exact email approved. It has not been sent.')
    expect(operations(f)).toHaveLength(1); expect(operations(f)[0][1].body).toEqual({ op: 'approve', request_id: 'action-1' }); expect(screen.getByRole('button', { name: 'Send approved email' }).disabled).toBe(true)
  })
  it('queues only the frozen workflow reference and never accepts client email overrides', async () => {
    const f = fixture({ status: 'draft_accepted' }); await select(f)
    f.client.functions.invoke.mockImplementation(async (_name, { body }) => {
      if (body.operation === 'load') return { data: clone(f.data) }
      Object.assign(f.workflow, { revision: 2, status: 'awaiting_approval', action_request_id: 'action-1', action_request: { id: 'action-1', organization_id: f.props.org.id, customer_workflow_id: f.workflow.id, status: 'Pending', provider: 'microsoft', action_type: 'send_email', requested_by: f.actorId, connection_id: 'connection-1', payload: { to: f.workflow.customer_email, subject: f.workflow.ai_run.draft.title, message: f.workflow.ai_run.draft.body } } })
      return f.envelope({ workflow: clone(f.workflow), request: clone(f.workflow.action_request) })
    })
    fireEvent.click(screen.getByLabelText('I checked this recipient, subject, and message.'))
    const queue = screen.getByRole('button', { name: 'Queue exact email for approval' }); act(() => { directClick(queue); directClick(queue) })
    await screen.findByText('Exact email queued for a different authorized reviewer. It has not been sent.')
    expect(operations(f)).toHaveLength(1); expect(operations(f)[0][1].body).toEqual({ organization_id: f.props.org.id, operation: 'queue', workflow_id: f.workflow.id, expected_revision: 1 })
    expect(screen.getByRole('button', { name: 'Approve exact email' }).disabled).toBe(true)
  })
  it('a malformed approval acknowledgement never claims that approval was saved', async () => {
    const f = fixture({ status: 'draft_accepted', actionStatus: 'Pending' }); await select(f)
    fireEvent.click(screen.getByLabelText('I reviewed the exact email and its sources.')); f.client.functions.invoke.mockResolvedValueOnce({ data: { ok: true, request: { ...f.workflow.action_request, organization_id: 'different-company', status: 'Approved', approved_by: f.actorId } } }); click('Approve exact email')
    await screen.findByRole('alert'); expect(screen.queryByText('Exact email approved. It has not been sent.')).toBeNull(); expect(screen.getByRole('button', { name: 'Approve exact email' }).disabled).toBe(true)
  })
  it('ignores a late approval after account and company switch', async () => {
    const f = fixture({ status: 'draft_accepted', actionStatus: 'Pending' }), response = deferred(), view = await mount(f); click(new RegExp(f.workflow.subject))
    fireEvent.click(screen.getByLabelText('I reviewed the exact email and its sources.')); f.client.functions.invoke.mockReturnValueOnce(response.promise); click('Approve exact email')
    const next = fixture(); view.rerender(<CustomerReplyWorkspace {...next.props}/>); await waitFor(() => expect(screen.queryByText('Checking saved requests and setup…')).toBeNull())
    await act(async () => response.resolve({ data: { ok: true, request: { ...f.workflow.action_request, status: 'Approved', approved_by: f.actorId } } }))
    expect(screen.queryByText('Exact email approved. It has not been sent.')).toBeNull(); expect(f.client.functions.invoke.mock.calls.filter(([, { body }]) => body.operation === 'load')).toHaveLength(1)
  })
  it.each(['payload', 'source', 'configuration', 'account', 'receipt'])('blocks sending with changed %s evidence', async kind => {
    const f = fixture({ status: 'draft_accepted', actionStatus: 'Approved' })
    if (kind === 'payload') f.workflow.action_request.payload.message = 'Substituted unreviewed text'
    if (kind === 'source') f.workflow.context_stale = true
    if (kind === 'configuration') f.workflow.configuration_stale = true
    if (kind === 'account') f.data.readiness.microsoft_account = 'reconnected-account'
    if (kind === 'receipt') f.workflow.receipt = { phase: 'Dispatching' }
    await select(f); const send = screen.getByRole('button', { name: 'Send approved email' }); expect(send.disabled).toBe(true); act(() => { directClick(send) }); expect(operations(f)).toHaveLength(0)
  })
  it('persists a no-resend lock after a lost response and remount', async () => {
    const f = fixture({ status: 'draft_accepted', actionStatus: 'Approved' }); const view = await mount(f); click(new RegExp(f.workflow.subject))
    fireEvent.click(screen.getByLabelText('I checked the approved email and Microsoft account.')); f.client.functions.invoke.mockRejectedValueOnce(new Error('Lost response')); const send = screen.getByRole('button', { name: 'Send approved email' }); act(() => { directClick(send); directClick(send) })
    await screen.findByText(/Email outcome needs review\. Do not resend/); expect(operations(f)).toHaveLength(1)
    view.unmount(); await select(f); expect(screen.getByRole('button', { name: 'Send approved email' }).disabled).toBe(true); expect(screen.queryByRole('button', { name: 'Cancel request' })).toBeNull()
  })
  it('an accepted response for a different email never becomes a confirmed result', async () => {
    const f = fixture({ status: 'draft_accepted', actionStatus: 'Approved' }); await select(f)
    fireEvent.click(screen.getByLabelText('I checked the approved email and Microsoft account.')); f.client.functions.invoke.mockResolvedValueOnce({ data: { ok: true, status: 'Executed', outcome: 'provider_accepted', request_id: 'other-action' } }); click('Send approved email')
    await screen.findByText(/Email outcome needs review\. Do not resend/); expect(screen.queryByText('Microsoft accepted the approved email. Delivery is not confirmed.')).toBeNull(); expect(screen.getByRole('button', { name: 'Send approved email' }).disabled).toBe(true)
  })
  it('missing saved source cannot be reviewed or queued even with a valid AI draft', async () => {
    const f = fixture({ status: 'draft_accepted' }); f.workflow.context_version = null; await select(f)
    fireEvent.click(screen.getByLabelText('I checked this recipient, subject, and message.')); const queue = screen.getByRole('button', { name: 'Queue exact email for approval' }); expect(queue.disabled).toBe(true); act(() => { directClick(queue) }); expect(operations(f)).toHaveLength(0)
  })
  it('explains a missing uninvolved reviewer even when generic company readiness is true', async () => {
    const f = fixture({ status: 'draft_accepted' }); f.data.people = [{ user_id: f.requester, role: 'owner' }, { user_id: f.actorId, role: 'admin' }]; await select(f)
    fireEvent.click(screen.getByLabelText('I checked this recipient, subject, and message.')); const queue = screen.getByRole('button', { name: 'Queue exact email for approval' }); expect(queue.disabled).toBe(true); act(() => { directClick(queue) })
    expect(screen.getByText(/This reply needs another authorized owner, admin, or consultant/)).toBeTruthy(); expect(operations(f)).toHaveLength(0)
    expect(eligibleReviewers(f.workflow, f.data.people, f.actorId)).toEqual([])
  })
  it('shows the latest saved source before generating a replacement for a stale terminal draft', async () => {
    const f = fixture({ status: 'draft_accepted', live: true }); f.data.context = { ...f.context, id: 'context-new', version: 2, context: { company_name: 'Synthetic company', reply_guidance: 'New approved opening hours: 9 am to 5 pm.' } }; f.workflow.context_stale = true
    await select(f); expect(screen.getByText('Latest context for a new draft · version 2')).toBeTruthy(); expect(screen.getByText('New approved opening hours: 9 am to 5 pm.')).toBeTruthy(); expect(screen.getByRole('button', { name: 'Generate a new draft' }).disabled).toBe(false)
  })
  it('only the original draft author can resume a pinned no-run request', async () => {
    const f = fixture({ status: 'drafting', live: true }); f.workflow.ai_run = null; await select(f); const resume = screen.getByRole('button', { name: 'Resume saved AI request' }); expect(resume.disabled).toBe(true); act(() => { directClick(resume) }); expect(operations(f)).toHaveLength(0)
  })
  it('reports Microsoft acceptance separately from delivery and does not offer another send', async () => {
    const f = fixture({ status: 'draft_accepted', actionStatus: 'Approved' }); await select(f)
    f.client.functions.invoke.mockImplementation(async (name) => { if (name === 'customer-workflow') return { data: clone(f.data) }; f.workflow.action_request.status = 'Executed'; f.workflow.receipt = { phase: 'ProviderAccepted' }; return { data: { ok: true, status: 'Executed', outcome: 'provider_accepted', request_id: 'action-1', delivered: false } } })
    fireEvent.click(screen.getByLabelText('I checked the approved email and Microsoft account.')); click('Send approved email'); await waitFor(() => expect(screen.queryByRole('button', { name: 'Send approved email' })).toBeNull())
    expect(screen.getAllByText('Microsoft accepted the approved email. Delivery is not confirmed.')).toHaveLength(1); expect(operations(f)).toHaveLength(1)
  })
  it.each(['Pending', 'Approved', 'Executing'])('cancels a pre-dispatch %s workflow while preserving action history', async status => {
    const f = fixture({ status: 'draft_accepted', actionStatus: status }); await select(f)
    f.client.functions.invoke.mockImplementation(async (_name, { body }) => { if (body.operation === 'load') return { data: clone(f.data) }; f.workflow.status = 'cancelled'; f.workflow.revision++; return f.envelope({ workflow: clone(f.workflow) }) })
    click('Cancel request'); await screen.findByText('Request cancelled and retained in saved history.')
    expect(screen.getByRole('article').textContent).toContain('This request was cancelled'); expect(screen.queryByRole('button', { name: 'Cancel request' })).toBeNull()
    const actionButton = screen.queryByRole('button', { name: status === 'Pending' ? 'Approve exact email' : 'Send approved email' }); if (actionButton) expect(actionButton.disabled).toBe(true)
  })
})

describe('projection and workflow helpers', () => {
  it('keeps pending, approved, accepted and exceptions separate', () => {
    const items = ['Pending', 'Approved', 'Executed', 'Executing', 'Failed', 'Rejected'].map(actionStatus => fixture({ status: 'draft_accepted', actionStatus }).workflow)
    expect(items.map(item => workflowState(item).key)).toEqual(['review', 'approved', 'accepted', 'exception', 'exception', 'exception'])
    expect(filterWorkflows(items, 'approved', 'employee')).toHaveLength(1); expect(filterWorkflows(items, 'exception', 'employee')).toHaveLength(3)
  })
  it('cancelled workflow is authoritative over an old approved action', () => {
    const f = fixture({ status: 'draft_accepted', actionStatus: 'Approved' }); f.workflow.status = 'cancelled'
    expect(workflowState(f.workflow).key).toBe('closed'); expect(canCancelWorkflow(f.workflow)).toBe(false); expect(draftPath(f.workflow)).toBeNull()
  })
  it('verifies matching records and exact payload, including no extra mail fields', () => {
    const f = fixture({ status: 'draft_accepted', actionStatus: 'Approved' }); expect(verifyWorkspace(f.data, f.props.org.id, f.actorId)).toBe(f.data); expect(emailMatchesDraft(f.workflow)).toBe(true); expect(independentReviewer(f.workflow, f.actorId)).toBe(true); expect(microsoftBindingMatches(f.workflow, f.data.readiness)).toBe(true)
    f.workflow.action_request.payload.cc = 'extra@example.test'; expect(emailMatchesDraft(f.workflow)).toBe(false)
  })
  it('never changes a pinned request into replacement after a stale source', () => {
    const f = fixture({ status: 'drafting' }); f.workflow.ai_run = null; f.workflow.context_stale = true
    expect(draftPath(f.workflow, 'draft-key')).toBeNull(); f.workflow.context_stale = false; expect(draftPath(f.workflow, 'draft-key')).toBe('resume')
    f.workflow.status = 'ai_failed'; f.workflow.ai_run = { status: 'failed' }; expect(draftPath(f.workflow)).toBe('prepare')
  })
  it.each(['extra-field', 'long-title', 'long-body', 'forged-source', 'duplicate-source', 'too-many-warnings', 'long-warning'])('rejects malformed AI output: %s', kind => {
    const draft = clone(fixture({ status: 'draft_ready' }).workflow.ai_run.draft)
    if (kind === 'extra-field') draft.permission = 'send'
    if (kind === 'long-title') draft.title = 'x'.repeat(201)
    if (kind === 'long-body') draft.body = 'x'.repeat(30001)
    if (kind === 'forged-source') draft.source_ids = ['external-unverified-source']
    if (kind === 'duplicate-source') draft.source_ids = ['manual-1', 'manual-1']
    if (kind === 'too-many-warnings') draft.warnings = Array(11).fill('Warning')
    if (kind === 'long-warning') draft.warnings = ['x'.repeat(1001)]
    expect(validDraft(draft)).toBe(false)
  })
})

function knowledgeSource(index = 1, overrides = {}) {
  const document_id = `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`, version_id = `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`, chunk_id = `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`
  return { document_id, version_id, chunk_id, source_id: `knowledge:${document_id}:${version_id}:${chunk_id}`, title: `Service policy ${index}`, content_text: `Confirmed business policy excerpt ${index}.`, content_sha256: String(index).repeat(64), version_sha256: 'a'.repeat(64), version: 1, review_due_at: '2099-01-01T00:00:00Z', audience: 'organization', source_kind: index % 2 ? 'manual' : 'text_upload', source_name: index % 2 ? 'Pasted text' : 'support.md', ...overrides }
}
function knowledgeFixture(options = {}) {
  const f = fixture({ live: true, ...options })
  f.data.knowledge_contract_version = 1
  f.workflow.knowledge_sources = []
  f.workflow.knowledge_stale = false
  f.sources = [knowledgeSource()]
  f.knowledgeEnvelope = value => f.envelope({ actor: clone(f.data.actor), ...value })
  f.client.functions.invoke.mockImplementation(async (name, { body }) => {
    if (body.operation === 'load') return { data: clone(f.data) }
    if (body.operation === 'knowledge_search') return f.knowledgeEnvelope({ results: clone(f.sources) })
    if (body.operation === 'knowledge_source') return f.knowledgeEnvelope({ source: clone(f.sources.find(source => source.chunk_id === body.chunk_id)) })
    if (body.operation === 'prepare_draft') {
      Object.assign(f.workflow, { status: 'drafting', revision: f.workflow.revision + 1, ai_run: null, ai_request_key: body.request_key, draft_requested_by: f.actorId, configuration_id: f.configuration.id, configuration: f.configuration, context_version_id: f.context.id, context_version: f.context, knowledge_sources: body.knowledge_sources.map(ref => clone(f.sources.find(source => source.chunk_id === ref.chunk_id))) })
      return f.envelope({ workflow: clone(f.workflow) })
    }
    if (name === 'ai-draft' && body.operation === 'run') {
      f.workflow.status = 'draft_ready'
      f.workflow.ai_run = { id: 'ai-knowledge', organization_id: f.props.org.id, configuration_id: f.configuration.id, request_key: body.request_key, requested_by: f.actorId, status: 'awaiting_review', draft: { title: 'Policy reply', body: 'A reply grounded in the approved service policy.', source_ids: ['manual-1', ...f.workflow.knowledge_sources.map(source => source.source_id)], warnings: [] } }
      return { data: { run: clone(f.workflow.ai_run) } }
    }
    throw new Error('Unexpected synthetic knowledge request')
  })
  return f
}
async function searchKnowledge() {
  fireEvent.change(screen.getByLabelText('Search current company-wide knowledge'), { target: { value: 'service policy' } })
  click('Search excerpts')
  await screen.findByRole('list', { name: 'Knowledge search results' })
}
async function chooseKnowledge(f, index = 0) {
  click(`Review excerpt from ${f.sources[index].title}`)
  await screen.findByRole('region', { name: 'Knowledge excerpt preview' })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Select this excerpt' }).disabled).toBe(false))
  click('Select this excerpt')
  await screen.findByRole('button', { name: `Remove excerpt from ${f.sources[index].title}` })
}

describe('explicit Company Knowledge selection and pinned citations', () => {
  it('never searches or selects automatically and sends only selected immutable refs when generating', async () => {
    const f = knowledgeFixture(); await select(f)
    expect(operations(f)).toHaveLength(0)
    expect(screen.getByText(/no automatic document sync or background search/)).toBeTruthy()
    await searchKnowledge()
    expect(screen.getByText('Selected for new draft: 0 of 5')).toBeTruthy()
    await chooseKnowledge(f)
    const preview = within(screen.getByRole('region', { name: 'Knowledge excerpt preview' }))
    expect(preview.getByText(f.sources[0].content_text)).toBeTruthy()
    expect(preview.getByText(f.sources[0].source_id)).toBeTruthy()
    expect(preview.getByText(f.sources[0].content_sha256)).toBeTruthy()
    expect(preview.getByText(f.sources[0].version_sha256)).toBeTruthy()
    expect(operations(f).map(([, { body }]) => body.operation)).toEqual(['knowledge_search', 'knowledge_source', 'knowledge_source'])
    click('Generate AI draft')
    await screen.findByText('AI draft saved for review. No email has been queued or sent.')
    const prepare = operations(f).find(([, { body }]) => body.operation === 'prepare_draft')[1].body
    expect(prepare.knowledge_sources).toEqual([knowledgeSourceRef(f.sources[0])])
    expect(prepare).not.toHaveProperty('input')
    const run = operations(f).find(([name]) => name === 'ai-draft')[1].body
    expect(run).not.toHaveProperty('knowledge_sources')
    expect(run).not.toHaveProperty('input')
    expect(screen.getByLabelText('Pinned Company Knowledge sources').textContent).toContain(f.sources[0].source_id)
    expect(screen.getByLabelText('Draft citations').textContent).toContain(`Service policy 1 · ${f.sources[0].source_id}`)
    expect(screen.getByRole('button', { name: 'Accept draft for use' }).disabled).toBe(true)
  })
  it('supports zero sources and keeps a removed excerpt out of prepare', async () => {
    const f = knowledgeFixture(); await select(f); await searchKnowledge(); await chooseKnowledge(f)
    click(`Remove excerpt from ${f.sources[0].title}`)
    expect(screen.getByText('Selected for new draft: 0 of 5')).toBeTruthy()
    click('Generate AI draft'); await screen.findByText('AI draft saved for review. No email has been queued or sent.')
    expect(operations(f).find(([, { body }]) => body.operation === 'prepare_draft')[1].body.knowledge_sources).toEqual([])
  })
  it('guards duplicate search and selection clicks before React paints', async () => {
    const f = knowledgeFixture(); await select(f)
    fireEvent.change(screen.getByLabelText('Search current company-wide knowledge'), { target: { value: 'service' } })
    const form = screen.getByRole('form', { name: 'Search Company Knowledge' })
    act(() => { fireEvent.submit(form); fireEvent.submit(form) })
    await screen.findByRole('list', { name: 'Knowledge search results' })
    click(`Review excerpt from ${f.sources[0].title}`)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select this excerpt' }).disabled).toBe(false))
    const selectButton = screen.getByRole('button', { name: 'Select this excerpt' })
    act(() => { directClick(selectButton); directClick(selectButton) })
    await screen.findByText('Selected for new draft: 1 of 5')
    expect(operations(f).map(([, { body }]) => body.operation)).toEqual(['knowledge_search', 'knowledge_source', 'knowledge_source'])
  })
  it('limits selection to five excerpts, including direct handler calls', async () => {
    const f = knowledgeFixture(); f.sources = Array.from({ length: 6 }, (_, index) => knowledgeSource(index + 1))
    await select(f); await searchKnowledge()
    for (let index = 0; index < 5; index++) await chooseKnowledge(f, index)
    click(`Review excerpt from ${f.sources[5].title}`)
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Knowledge excerpt preview' })).getByText(f.sources[5].content_text)).toBeTruthy())
    const button = screen.getByRole('button', { name: 'Select this excerpt' }), count = operations(f).length
    expect(button.disabled).toBe(true); act(() => { directClick(button) })
    expect(operations(f)).toHaveLength(count); expect(screen.getByText('Selected for new draft: 5 of 5')).toBeTruthy()
  })
  it.each(['member', 'viewer'])('does not expose source search to %s roles', async role => {
    const f = knowledgeFixture({ role }); await select(f)
    expect(screen.queryByRole('form', { name: 'Search Company Knowledge' })).toBeNull(); expect(operations(f)).toHaveLength(0)
  })
  it.each(['company', 'actor', 'role', 'private', 'expired', 'hash', 'source-id', 'too-many', 'duplicate'])('rejects unverified %s search responses before showing source text', async kind => {
    const f = knowledgeFixture(); await select(f)
    const response = f.knowledgeEnvelope({ results: [knowledgeSource()] })
    if (kind === 'company') response.data.organization_id = 'wrong-company'
    if (kind === 'actor') response.data.actor.id = 'wrong-account'
    if (kind === 'role') response.data.actor.role = 'member'
    if (kind === 'private') response.data.results[0].audience = 'private'
    if (kind === 'expired') response.data.results[0].review_due_at = '2000-01-01T00:00:00Z'
    if (kind === 'hash') response.data.results[0].content_sha256 = 'forged'
    if (kind === 'source-id') response.data.results[0].source_id = 'knowledge:forged:version:chunk'
    if (kind === 'too-many') response.data.results = Array.from({ length: 11 }, (_, index) => knowledgeSource(index + 1))
    if (kind === 'duplicate') response.data.results.push(clone(response.data.results[0]))
    f.client.functions.invoke.mockResolvedValueOnce(response)
    fireEvent.change(screen.getByLabelText('Search current company-wide knowledge'), { target: { value: 'service' } }); click('Search excerpts')
    await screen.findByText(/customer workspace could not be verified/)
    expect(screen.queryByText('Service policy 1')).toBeNull(); expect(screen.queryByText(f.sources[0].content_text)).toBeNull()
    expect(screen.getByRole('button', { name: 'Generate AI draft' }).disabled).toBe(true)
  })
  it.each(['role', 'version', 'hash'])('rechecks %s on explicit selection and clears the earlier preview after failure', async kind => {
    const f = knowledgeFixture(); await select(f); await searchKnowledge()
    click(`Review excerpt from ${f.sources[0].title}`)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select this excerpt' }).disabled).toBe(false))
    const response = f.knowledgeEnvelope({ source: clone(f.sources[0]) })
    if (kind === 'role') response.data.actor.role = 'viewer'
    if (kind === 'version') { response.data.source.version_id = knowledgeSource(2).version_id; response.data.source.source_id = `knowledge:${response.data.source.document_id}:${response.data.source.version_id}:${response.data.source.chunk_id}` }
    if (kind === 'hash') response.data.source.version_sha256 = 'b'.repeat(64)
    f.client.functions.invoke.mockResolvedValueOnce(response); click('Select this excerpt')
    await screen.findByText(/customer workspace could not be verified/)
    expect(screen.queryByText(f.sources[0].content_text)).toBeNull(); expect(screen.getByText('Selected for new draft: 0 of 5')).toBeTruthy()
  })
  it.each(['navigation', 'clear', 'company', 'account'])('ignores a late source selection after %s changes', async kind => {
    const f = knowledgeFixture(), view = await mount(f); click(new RegExp(f.workflow.subject)); await searchKnowledge()
    click(`Review excerpt from ${f.sources[0].title}`)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select this excerpt' }).disabled).toBe(false))
    const delayed = deferred(); f.client.functions.invoke.mockReturnValueOnce(delayed.promise); click('Select this excerpt')
    if (kind === 'navigation') { click('Back to requests'); click(new RegExp(f.workflow.subject)) }
    if (kind === 'clear') click('Clear source selection')
    if (['company', 'account'].includes(kind)) {
      const next = knowledgeFixture()
      if (kind === 'account') { next.props.org = f.props.org; next.data.organization_id = f.props.org.id; next.workflow.organization_id = f.props.org.id; next.context.organization_id = f.props.org.id; next.configuration.organization_id = f.props.org.id }
      view.rerender(<CustomerReplyWorkspace {...next.props}/>); await waitFor(() => expect(screen.queryByText('Checking saved requests and setup…')).toBeNull()); click(new RegExp(next.workflow.subject))
    }
    await act(async () => delayed.resolve(f.knowledgeEnvelope({ source: clone(f.sources[0]) })))
    expect(screen.queryByText(f.sources[0].content_text)).toBeNull(); expect(screen.getByText('Selected for new draft: 0 of 5')).toBeTruthy()
    expect(screen.getByLabelText('Search current company-wide knowledge').value).toBe('')
  })
  it('clears transient selected sources on refresh and return navigation', async () => {
    const f = knowledgeFixture(); await select(f); await searchKnowledge(); await chooseKnowledge(f)
    click('Back to requests'); click(new RegExp(f.workflow.subject)); expect(screen.getByText('Selected for new draft: 0 of 5')).toBeTruthy()
    await searchKnowledge(); await chooseKnowledge(f); click('Refresh saved results')
    await waitFor(() => expect(screen.queryByText('Checking saved requests and setup…')).toBeNull())
    expect(screen.getByText('Selected for new draft: 0 of 5')).toBeTruthy(); expect(screen.queryByText(f.sources[0].content_text)).toBeNull()
  })
  it('cancels a request during a pending source read and ignores its late result', async () => {
    const f = knowledgeFixture(); await select(f)
    const delayed = deferred(); f.client.functions.invoke.mockReturnValueOnce(delayed.promise)
    fireEvent.change(screen.getByLabelText('Search current company-wide knowledge'), { target: { value: 'service' } }); click('Search excerpts')
    f.client.functions.invoke.mockImplementation(async (_name, { body }) => {
      if (body.operation === 'load') return { data: clone(f.data) }
      if (body.operation === 'cancel') { f.workflow.status = 'cancelled'; f.workflow.revision++; return f.envelope({ workflow: clone(f.workflow) }) }
      throw new Error('Unexpected synthetic request')
    })
    click('Cancel request'); await screen.findByText('Request cancelled and retained in saved history.')
    await act(async () => delayed.resolve(f.knowledgeEnvelope({ results: clone(f.sources) })))
    expect(screen.queryByRole('form', { name: 'Search Company Knowledge' })).toBeNull()
    expect(screen.queryByText(f.sources[0].content_text)).toBeNull()
    expect(operations(f).map(([, { body }]) => body.operation)).toEqual(['knowledge_search', 'cancel'])
  })
  it('blocks generation while a source check is unresolved', async () => {
    const f = knowledgeFixture(); await select(f)
    const delayed = deferred(); f.client.functions.invoke.mockReturnValueOnce(delayed.promise)
    fireEvent.change(screen.getByLabelText('Search current company-wide knowledge'), { target: { value: 'service' } }); click('Search excerpts')
    const generate = screen.getByRole('button', { name: 'Generate AI draft' }); expect(generate.disabled).toBe(true); act(() => { directClick(generate) })
    expect(operations(f)).toHaveLength(1)
    await act(async () => delayed.resolve(f.knowledgeEnvelope({ results: clone(f.sources) })))
  })
  it('does not call inference when prepare returns a substituted source snapshot', async () => {
    const f = knowledgeFixture(); await select(f); await searchKnowledge(); await chooseKnowledge(f)
    f.client.functions.invoke.mockResolvedValueOnce(f.envelope({ workflow: { ...clone(f.workflow), status: 'drafting', revision: 2, knowledge_sources: [knowledgeSource(2)] } }))
    click('Generate AI draft'); await screen.findByText(/customer workspace could not be verified/)
    expect(operations(f).some(([name]) => name === 'ai-draft')).toBe(false)
  })
  it('resumes only the existing pinned source versions and never sends replacements or searches', async () => {
    const f = knowledgeFixture({ status: 'drafting' }); f.workflow.ai_run = null; f.workflow.draft_requested_by = f.actorId; f.workflow.knowledge_sources = [clone(f.sources[0])]
    await select(f)
    expect(screen.queryByRole('form', { name: 'Search Company Knowledge' })).toBeNull()
    expect(screen.getByLabelText('Pinned Company Knowledge sources').textContent).toContain(f.sources[0].source_id)
    click('Resume saved AI request'); await screen.findByText('AI draft saved for review. No email has been queued or sent.')
    expect(operations(f)).toHaveLength(1)
    expect(operations(f)[0][1].body).toEqual({ operation: 'run', organization_id: f.props.org.id, customer_workflow_id: f.workflow.id, expected_revision: 1, configuration_id: f.configuration.id, request_key: 'draft-key' })
  })
  it.each(['draft_ready', 'draft_accepted', 'Pending', 'Approved', 'drafting'])('hides stale knowledge and blocks %s advancement', async status => {
    const f = knowledgeFixture(['Pending', 'Approved'].includes(status) ? { status: 'draft_accepted', actionStatus: status } : { status })
    f.workflow.knowledge_stale = true
    if (f.workflow.ai_run) f.workflow.ai_run.draft = null
    if (f.workflow.action_request) f.workflow.action_request.payload = null
    await select(f)
    expect(screen.getByText(/A saved Company Knowledge source changed/)).toBeTruthy()
    expect(screen.queryByText('Thank you for your question. Your scheduled date is 14 October.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Accept draft for use' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Generate|Resume/ })).toBeNull()
    for (const name of ['Queue exact email for approval', 'Approve exact email', 'Send approved email']) {
      const button = screen.queryByRole('button', { name }); if (button) { expect(button.disabled).toBe(true); act(() => { directClick(button) }) }
    }
    expect(operations(f)).toHaveLength(0)
  })
  it('rejects stale server responses that fail to redact model or email content', async () => {
    const f = knowledgeFixture({ status: 'draft_accepted', actionStatus: 'Approved' }); f.workflow.knowledge_stale = true
    await mount(f); expect(screen.getByText(/customer workspace could not be verified/)).toBeTruthy()
    expect(screen.queryByText(f.workflow.ai_run.draft.body)).toBeNull()
  })
  it('allows only exact citations from the verified pinned source list and manual-only defaults remain strict', () => {
    const f = knowledgeFixture({ status: 'draft_accepted', actionStatus: 'Pending' }), source = f.sources[0]
    f.workflow.knowledge_sources = [source]; f.workflow.ai_run.draft.source_ids = ['manual-1', source.source_id]
    expect(validDraft(f.workflow.ai_run.draft)).toBe(false)
    expect(validDraft(f.workflow.ai_run.draft, [source])).toBe(true)
    expect(sourceMatchesWorkflow(f.workflow)).toBe(true); expect(emailMatchesDraft(f.workflow)).toBe(true)
    f.workflow.ai_run.draft.source_ids = [`knowledge:${source.document_id}:${knowledgeSource(2).version_id}:${source.chunk_id}`]
    expect(validDraft(f.workflow.ai_run.draft, [source])).toBe(false)
    expect(sourceMatchesWorkflow(f.workflow)).toBe(false); expect(emailMatchesDraft(f.workflow)).toBe(false)
    expect(validKnowledgeSource({ ...source, audience: 'private' })).toBe(false)
  })
  it('never approves an exact email with citations to a different immutable version', async () => {
    const f = knowledgeFixture({ status: 'draft_accepted', actionStatus: 'Pending' }); f.workflow.knowledge_sources = [f.sources[0]]; f.workflow.ai_run.draft.source_ids = [`knowledge:${f.sources[0].document_id}:${knowledgeSource(2).version_id}:${f.sources[0].chunk_id}`]
    await select(f); const approve = screen.getByRole('button', { name: 'Approve exact email' })
    expect(approve.disabled).toBe(true); act(() => { directClick(approve) }); expect(operations(f)).toHaveLength(0)
    expect(screen.getByText('No complete, validated draft is available.')).toBeTruthy()
  })
})
