import { verifyWorkspace, workflowState } from './customer-reply-model'
import { workflowMonitorWindow, timestampMs } from './workflow-monitor-data'

export const CUSTOMER_REPORT_LIMIT = 100
const present = value => typeof value === 'string' && value.trim().length > 0
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const instant = value => typeof value === 'string' && timestampMs(value) !== null ? value : null
const sumKnown = values => { const known = values.filter(value => value !== null); return { value: known.length ? known.reduce((sum, value) => sum + value, 0) : null, recorded: known.length, missing: values.length - known.length } }

// Use only the current attempt explicitly bound by the existing customer-workflow
// projection. Similar names, timestamps and shared models are never join keys.
export function customerRequestEvidence(workflow) {
  const run = workflow.ai_run, action = workflow.action_request, receipt = action ? workflow.receipt : null
  const config = workflow.configuration
  const boundRun = run && present(run.id) && run.organization_id === workflow.organization_id && present(workflow.ai_request_key) && run.request_key === workflow.ai_request_key && present(workflow.configuration_id) && run.configuration_id === workflow.configuration_id && present(workflow.draft_requested_by) && run.requested_by === workflow.draft_requested_by ? run : null
  const boundAction = action && present(action.id) && action.id === workflow.action_request_id && action.organization_id === workflow.organization_id && action.customer_workflow_id === workflow.id && action.provider === 'microsoft' && action.action_type === 'send_email' ? action : null
  const boundConfig = boundRun && config?.id === boundRun.configuration_id && config.organization_id === workflow.organization_id ? config : null
  const boundReceipt = boundAction ? receipt : null
  const accepted = boundReceipt && ['ProviderAccepted', 'ConfirmedAccepted'].includes(boundReceipt.phase) || boundAction?.status === 'Executed'
  const notSent = boundReceipt?.phase === 'ConfirmedNotSent'
  const contradictory = Boolean(notSent && boundAction?.status === 'Executed')
  const email = contradictory ? { label: 'Conflicting send records', detail: 'Acceptance and a not-sent reconciliation disagree. An operator must inspect the saved records.', key: 'attention' }
    : accepted ? { label: 'Microsoft accepted', detail: 'The provider accepted the email. Delivery, reading and business resolution are not recorded.', key: 'accepted' }
    : notSent ? { label: 'Confirmed not sent', detail: 'The saved reconciliation records that this attempt was not sent.', key: 'not_sent' }
    : workflow.status === 'cancelled' && !boundReceipt ? { label: 'Cancelled before dispatch', detail: 'This request is cancelled. Earlier approval states remain in its saved history; no dispatch receipt is recorded.', key: 'cancelled' }
    : boundReceipt?.phase === 'Dispatching' || ['Executing', 'Failed'].includes(boundAction?.status) ? { label: 'Send outcome needs review', detail: 'Dispatch may have started. Do not resend while the outcome is unresolved.', key: 'attention' }
    : boundAction?.status === 'Approved' ? { label: 'Approved · not sent', detail: 'Approval is recorded. No provider acceptance is recorded.', key: 'approved' }
    : boundAction?.status === 'Pending' ? { label: 'Awaiting email review', detail: 'An independent reviewer must approve the saved email.', key: 'review' }
    : boundAction?.status === 'Rejected' ? { label: 'Email rejected', detail: 'The saved email approval was rejected.', key: 'rejected' }
    : { label: boundAction || workflow.action_request_id ? 'Send evidence unavailable' : 'No email queued', detail: boundAction || workflow.action_request_id ? 'Refresh and inspect the linked action before continuing.' : 'No email action is linked to this saved request.', key: boundAction || workflow.action_request_id ? 'attention' : 'not_queued' }
  const legacyState = workflowState(workflow)
  const state = workflow.status === 'cancelled' ? legacyState
    : email.key === 'accepted' ? { key: 'accepted', label: email.label, detail: email.detail, tone: 'success' }
    : email.key === 'not_sent' ? { key: 'closed', label: 'Email confirmed not sent', detail: email.detail, tone: 'muted' }
    : legacyState
  const usage = {
    input: integer(boundRun?.usage?.input_tokens), output: integer(boundRun?.usage?.output_tokens),
    reservation: integer(boundRun?.reserved_microusd), actualCost: null,
    provider: boundConfig?.configuration?.provider || null, model: boundConfig?.configuration?.model || null,
  }
  const events = []
  const add = (key, label, at, detail) => events.push({ key, label, at: instant(at), detail })
  add('intake', 'Customer request saved', workflow.created_at, `Request ${workflow.id}`)
  if (boundRun) {
    add('ai_reserved', 'AI request reserved', boundRun.created_at, `Request ${boundRun.id}`)
    if (boundRun.status !== 'reserved' || boundRun.finished_at) add('ai_result', 'AI outcome recorded', boundRun.finished_at, `Recorded state: ${boundRun.status || 'Unavailable'}`)
    if (boundRun.reviewed_at || ['accepted', 'rejected'].includes(boundRun.status)) add('draft_review', 'AI draft review recorded', boundRun.reviewed_at, `Decision: ${boundRun.status === 'accepted' ? 'accepted' : boundRun.status === 'rejected' ? 'rejected' : 'not recorded'}`)
  }
  if (boundAction) {
    add('email_queued', 'Exact email queued for review', boundAction.created_at, `Action ${boundAction.id}`)
    if (boundAction.approved_at) add('email_approved', 'Email approval recorded', boundAction.approved_at, 'Approval alone does not send the email.')
    if (boundAction.rejected_at) add('email_rejected', 'Email rejection recorded', boundAction.rejected_at, 'The approval was rejected.')
    if (boundReceipt) {
      if (instant(boundReceipt.dispatch_started_at)) add('dispatch', 'Email dispatch attempt recorded', boundReceipt.dispatch_started_at, `Receipt phase: ${boundReceipt.phase || 'Unavailable'}`)
      if (boundReceipt.provider_accepted_at) add('provider_accepted', 'Microsoft acceptance recorded', boundReceipt.provider_accepted_at, 'Delivery and business resolution are not confirmed.')
      if (boundReceipt.reconciled_at) add('reconciled', 'Email outcome reconciled', boundReceipt.reconciled_at, `Receipt phase: ${boundReceipt.phase || 'Unavailable'}`)
    }
    if (boundAction.executed_at) add('action_recorded', 'Email action marked executed', boundAction.executed_at, 'This action status is separate from delivery confirmation.')
  }
  if (workflow.cancelled_at || workflow.status === 'cancelled') add('cancelled', 'Request cancelled', workflow.cancelled_at, 'Cancellation does not undo provider processing that already began.')
  const start = timestampMs(boundRun?.created_at), end = timestampMs(boundRun?.finished_at)
  return { id: workflow.id, workflow, state, run: boundRun, action: boundAction, receipt: boundReceipt, email, usage,
    aiIntervalMs: start !== null && end !== null && end >= start ? end - start : null,
    events: events.filter(event => event.at).sort((a, b) => timestampMs(a.at) - timestampMs(b.at)), undatedEvents: events.filter(event => !event.at),
    currentAttemptOnly: true, delivery: 'Not recorded', resolution: 'Not recorded',
  }
}

export function buildCustomerReport(data, organizationId, userId, { days = null, now = Date.now() } = {}) {
  verifyWorkspace(data, organizationId, userId)
  // Additional reporting-boundary checks, without broadening the endpoint's
  // role/assignment rules or exposing raw service-only AI tables to the browser.
  if (data.workflows.length > CUSTOMER_REPORT_LIMIT || data.actor.role === 'member' && data.workflows.some(item => item.assigned_to !== userId)) throw new Error('workspace_unverified')
  const window = days === null ? null : workflowMonitorWindow(days, now)
  const selected = data.workflows.filter(item => !window || timestampMs(item.created_at) !== null && timestampMs(item.created_at) >= window.startMs && timestampMs(item.created_at) <= window.endMs)
  const requests = selected.map(customerRequestEvidence)
  const seen = new Set(), runs = requests.filter(item => { if (!item.run || seen.has(item.run.id)) return false; seen.add(item.run.id); return true })
  const groups = new Map()
  for (const item of runs) {
    const key = JSON.stringify([item.usage.provider, item.usage.model])
    if (!groups.has(key)) groups.set(key, { provider: item.usage.provider, model: item.usage.model, runs: [] })
    groups.get(key).runs.push(item)
  }
  const usage = items => ({ runs: items.length, input: sumKnown(items.map(item => item.usage.input)), output: sumKnown(items.map(item => item.usage.output)), reservation: sumKnown(items.map(item => item.usage.reservation)), actualCost: null })
  return { requests, window, loadedCount: data.workflows.length, limitReached: data.workflows.length >= CUSTOMER_REPORT_LIMIT,
    role: data.actor.role, undatedRequests: data.workflows.filter(item => timestampMs(item.created_at) === null).length,
    counts: { requests: requests.length, accepted: requests.filter(item => item.email.key === 'accepted').length, attention: requests.filter(item => item.email.key === 'attention' || item.state.key === 'exception').length, awaitingReview: requests.filter(item => item.email.key === 'review').length, approved: requests.filter(item => item.email.key === 'approved').length, cancelled: requests.filter(item => item.workflow.status === 'cancelled').length },
    usage: usage(runs), models: [...groups.values()].map(group => ({ provider: group.provider, model: group.model, ...usage(group.runs) })),
  }
}

export const reportingNumber = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('en-US') : 'Not recorded'
export const reportingReservation = value => value === null ? 'Not recorded' : `${reportingNumber(value)} micro-USD`
