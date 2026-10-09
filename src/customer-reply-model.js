// The workspace only displays saved, tenant-bound records. Availability is never
// inferred from a configured provider, a draft, or an accepted approval.
export const CUSTOMER_WORKFLOW_CONTRACT = 1
export const REVIEW_ROLES = ['owner', 'admin', 'consultant']
export const WORKFLOW_STATES = ['intake', 'drafting', 'draft_ready', 'draft_accepted', 'draft_rejected', 'awaiting_approval', 'cancelled', 'ai_failed', 'ai_unknown']
const nonempty = value => typeof value === 'string' && Boolean(value.trim())
export const validEmail = value => typeof value === 'string' && value.length <= 320 && /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value)
export const validContext = value => nonempty(value?.id) && Number.isInteger(value.version) && value.version > 0 && nonempty(value.context?.company_name) && nonempty(value.context?.reply_guidance)
export const validDraft = value => value && typeof value === 'object' && Object.keys(value).sort().join(',') === 'body,source_ids,title,warnings' && nonempty(value.title) && value.title.length <= 200 && !/[\r\n]/.test(value.title) && nonempty(value.body) && value.body.length <= 30000 && Array.isArray(value.source_ids) && value.source_ids.length <= 1 && value.source_ids.every(item => item === 'manual-1') && Array.isArray(value.warnings) && value.warnings.length <= 10 && value.warnings.every(item => typeof item === 'string' && item.length <= 1000)
export const validWorkflow = (value, organizationId) => nonempty(value?.id) && value.organization_id === organizationId && Number.isInteger(value.revision) && value.revision > 0 && WORKFLOW_STATES.includes(value.status) && nonempty(value.requested_by) && validEmail(value.customer_email) && nonempty(value.subject) && nonempty(value.message)

export function draftPath(workflow, pendingKey) {
  if (!workflow || workflow.status === 'cancelled' || workflow.action_request_id) return null
  const run = workflow.ai_run
  if (workflow.status === 'drafting' && !run && !workflow.context_stale && !workflow.configuration_stale && nonempty(workflow.ai_request_key) && nonempty(workflow.configuration_id) && (!pendingKey || pendingKey === workflow.ai_request_key)) return 'resume'
  if (pendingKey || ['reserved', 'unknown'].includes(run?.status) || ['drafting', 'ai_unknown'].includes(workflow.status)) return null
  if (workflow.status === 'intake' && !run || ['ai_failed', 'draft_rejected'].includes(workflow.status) || (workflow.context_stale || workflow.configuration_stale) && ['awaiting_review', 'accepted', 'rejected', 'failed'].includes(run?.status)) return 'prepare'
  return null
}

export const canCancelWorkflow = workflow => Boolean(workflow && workflow.status !== 'cancelled' && !workflow.receipt && !['Executed', 'Failed'].includes(workflow.action_request?.status))
export const independentReviewer = (workflow, actorId) => Boolean(actorId && workflow?.requested_by !== actorId && workflow?.action_request?.requested_by && workflow.action_request.requested_by !== actorId && workflow.draft_requested_by && workflow.draft_requested_by !== actorId && workflow.assigned_to && workflow.assigned_to !== actorId)
export function eligibleReviewers(workflow, people = [], queueActor) {
  const excluded = new Set([queueActor, workflow?.requested_by, workflow?.action_request?.requested_by, workflow?.draft_requested_by, workflow?.assigned_to].filter(Boolean))
  return people.filter(person => REVIEW_ROLES.includes(person.role) && nonempty(person.user_id) && !excluded.has(person.user_id))
}
export function microsoftBindingMatches(workflow, readiness) {
  const action = workflow?.action_request, binding = action?.approved_connection_binding
  if (!action || readiness?.microsoft_ready !== true || !nonempty(readiness.microsoft_account) || !nonempty(readiness.microsoft_connection_id) || action.connection_id !== readiness.microsoft_connection_id) return false
  if (action.status === 'Pending') return true
  return Boolean(binding?.id === action.connection_id && binding.organization_id === workflow.organization_id && binding.external_account_id === readiness.microsoft_account)
}

export function verifyWorkspace(data, organizationId, userId) {
  if (data?.ok !== true || data.contract_version !== CUSTOMER_WORKFLOW_CONTRACT || data.organization_id !== organizationId || data.actor?.id !== userId || !['owner', 'admin', 'consultant', 'member', 'viewer'].includes(data.actor.role) || !Array.isArray(data.workflows) || !data.workflows.every(item => validWorkflow(item, organizationId))) throw new Error('workspace_unverified')
  if (new Set(data.workflows.map(item => item.id)).size !== data.workflows.length || data.context != null && (!validContext(data.context) || data.context.organization_id !== organizationId)) throw new Error('workspace_unverified')
  if (data.configuration && data.configuration.organization_id !== organizationId) throw new Error('workspace_unverified')
  for (const item of data.workflows) {
    if (item.ai_run && (item.ai_run.organization_id !== organizationId || item.ai_run.request_key !== item.ai_request_key || item.ai_run.configuration_id !== item.configuration_id || item.ai_run.requested_by !== item.draft_requested_by)) throw new Error('workspace_unverified')
    if (item.context_version && (item.context_version.organization_id !== organizationId || item.context_version.id !== item.context_version_id)) throw new Error('workspace_unverified')
    if (item.action_request && (item.action_request.organization_id !== organizationId || item.action_request.id !== item.action_request_id || item.action_request.customer_workflow_id !== item.id)) throw new Error('workspace_unverified')
  }
  return data
}

export function emailMatchesDraft(workflow) {
  const request = workflow?.action_request, draft = workflow?.ai_run?.draft
  return Boolean(sourceMatchesWorkflow(workflow) && request && request.id === workflow.action_request_id && request.customer_workflow_id === workflow.id && request.organization_id === workflow.organization_id && request.provider === 'microsoft' && request.action_type === 'send_email' && nonempty(request.requested_by) && nonempty(request.connection_id) && validDraft(draft) && request.payload?.to === workflow.customer_email && request.payload?.subject === draft.title && request.payload?.message === draft.body && Object.keys(request.payload).sort().join(',') === 'message,subject,to')
}

export function sourceMatchesWorkflow(workflow) {
  return Boolean(validContext(workflow?.context_version) && workflow.context_version.id === workflow.context_version_id && workflow.context_version.organization_id === workflow.organization_id && workflow.configuration?.id === workflow.configuration_id && workflow.configuration?.organization_id === workflow.organization_id && workflow.configuration?.configuration?.task === 'customer_reply' && workflow.ai_run?.organization_id === workflow.organization_id && workflow.ai_run?.request_key === workflow.ai_request_key && workflow.ai_run?.configuration_id === workflow.configuration_id && workflow.ai_run?.requested_by === workflow.draft_requested_by)
}

export function workflowState(workflow) {
  if (workflow?.status === 'cancelled') return { key: 'closed', label: 'Cancelled', tone: 'muted', detail: 'This request was cancelled. Its saved history remains available.' }
  const action = workflow?.action_request
  if (action?.status === 'Executed') return { key: 'accepted', label: 'Microsoft accepted', tone: 'success', detail: 'Microsoft accepted the email. Delivery is not confirmed.' }
  if (action?.status === 'Approved') return { key: 'approved', label: 'Approved · not sent', tone: 'ready', detail: 'The exact email is approved. Sending is a separate action.' }
  if (action?.status === 'Pending') return { key: 'review', label: 'Awaiting review', tone: 'pending', detail: 'A different authorized person must review this email.' }
  if (['Executing', 'Failed'].includes(action?.status)) return { key: 'exception', label: 'Email outcome needs review', tone: 'error', detail: 'Check the saved request and Microsoft account. Do not resend.' }
  if (action?.status === 'Rejected') return { key: 'exception', label: 'Email rejected', tone: 'error', detail: 'The reviewer rejected this email. It has not been approved for sending.' }
  const states = {
    intake: { key: 'pending', label: 'Ready for a draft', tone: 'pending', detail: 'The customer request is saved. Review its company context before generating.' },
    drafting: { key: 'exception', label: 'AI outcome pending', tone: 'pending', detail: 'The AI request is pending or interrupted. Check its recorded outcome; do not generate a replacement.' },
    draft_ready: { key: 'pending', label: 'Draft ready', tone: 'ready', detail: 'Review the draft and sources before requesting approval.' },
    draft_accepted: { key: 'pending', label: 'Draft reviewed', tone: 'ready', detail: 'The draft review is saved. Queue the exact email for a separate authorized reviewer.' },
    draft_rejected: { key: 'exception', label: 'AI draft rejected', tone: 'error', detail: 'The draft was rejected. Review the saved sources before preparing another draft.' },
    awaiting_approval: { key: 'exception', label: 'Approval record unavailable', tone: 'error', detail: 'The linked email record could not be verified. Refresh before continuing.' },
    cancelled: { key: 'closed', label: 'Cancelled', tone: 'muted', detail: 'This request was cancelled.' },
    ai_failed: { key: 'exception', label: 'AI request failed', tone: 'error', detail: 'Review the saved AI result. No email has been queued by this result.' },
    ai_unknown: { key: 'exception', label: 'AI outcome unknown', tone: 'error', detail: 'The provider may have processed the request. Do not generate a replacement.' },
  }
  return states[workflow?.status] || { key: 'exception', label: 'Status unavailable', tone: 'error', detail: 'Refresh to verify the saved result.' }
}

export function filterWorkflows(items, filter, actorId) {
  return items.filter(item => filter === 'all' ? true : filter === 'mine' ? item.assigned_to === actorId && !['accepted', 'closed'].includes(workflowState(item).key) : filter === 'open' ? !['accepted', 'closed'].includes(workflowState(item).key) : workflowState(item).key === filter)
}

export function workflowStep(workflow) {
  if (!workflow) return 1
  if (['accepted', 'exception', 'closed'].includes(workflowState(workflow).key) && workflow.status !== 'drafting') return 5
  if (workflow.action_request_id) return 4
  if (workflow.ai_run?.id || workflow.status === 'drafting') return 3
  return 2
}

export const formatTime = value => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString() : 'Not recorded'
export const employeeName = (id, people = []) => people.find(person => person.user_id === id)?.email || people.find(person => person.user_id === id)?.name || (id ? `Account ${id}` : 'Unassigned')

const errorMessages = {
  workspace_unverified: 'The customer workspace could not be verified for this company and account. Actions are unavailable. Refresh to check again.',
  live_inference_disabled: 'Live AI generation is disabled. Saving context or selecting a model does not enable it.',
  organization_access_denied: 'Your company access could not be verified. Ask a company owner to check your role.',
  context_required: 'Save company reply context before generating a draft.',
  stale_revision: 'This request changed while you were working. Refresh and review the latest saved version.',
  configuration_or_run_conflict: 'The AI configuration or request changed. Refresh before continuing.',
  invalid_context: 'The combined request and company context exceed the saved AI limit. Review the context and AI setup.',
  workspace_unavailable: 'Customer reply is not available yet. Its backend update must be installed and verified before this workspace can save or run requests.',
  customer_workflow_not_installed: 'Customer reply is not available yet. Its backend update must be installed and verified before this workspace can save or run requests.',
  customer_workflow_unavailable: 'The customer reply service is unavailable. No saved or external outcome has been confirmed.',
  workflow_storage_unavailable: 'Saved customer reply records could not be verified. Refresh before continuing.',
  workflow_changed_or_not_ready: 'The saved request or setup changed. Refresh and review the latest records before continuing.',
}
export const customerReplyError = error => errorMessages[error?.message] || 'The action was not confirmed. Refresh the saved records before continuing. Do not repeat a draft or email request with an unknown outcome.'
