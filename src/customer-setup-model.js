import { REVIEW_ROLES, validContext, verifyWorkspace } from './customer-reply-model'
import { activationState, savedActivationAuthorized } from './ai-activation-readiness'
import { assessmentComplete, onboardingComplete } from './first-use-guidance'

const present = value => typeof value === 'string' && Boolean(value.trim())
const roles = ['owner', 'admin', 'consultant', 'member', 'viewer']
// This contract reads saved records only. AI Setup's load/models endpoints are
// intentionally excluded because they may call a provider for model discovery.
export function verifySetupWorkspace(value, organizationId, actorId) {
  const data = verifyWorkspace(value, organizationId, actorId)
  const readiness = data.readiness
  if (!readiness || !['context_ready', 'configuration_ready', 'microsoft_ready', 'distinct_reviewer_available', 'live_inference_enabled'].every(key => typeof readiness[key] === 'boolean') || !Array.isArray(data.people) || data.people.some(person => !present(person.user_id) || !roles.includes(person.role)) || new Set(data.people.map(person => person.user_id)).size !== data.people.length) throw new Error('setup_unverified')
  if (readiness.context_ready !== validContext(data.context) || readiness.configuration_ready !== Boolean(data.configuration?.configuration?.task === 'customer_reply')) throw new Error('setup_unverified')
  if (data.configuration && (!present(data.configuration.id) || !Number.isInteger(data.configuration.version) || data.configuration.version < 1 || !present(data.configuration.configuration?.provider) || !present(data.configuration.configuration?.model))) throw new Error('setup_unverified')
  if (readiness.microsoft_ready && (!present(readiness.microsoft_account) || !present(readiness.microsoft_connection_id))) throw new Error('setup_unverified')
  return data
}
export function verifySetupKnowledge(value, organizationId, role) {
  if (value.actor_role !== role || !Array.isArray(value.documents) || value.documents.some(item => !present(item.id) || item.organization_id != null && item.organization_id !== organizationId || !['draft', 'published', 'archived'].includes(item.status) || !['private', 'organization'].includes(item.audience) || !Number.isFinite(Date.parse(item.review_due_at))) || new Set(value.documents.map(item => item.id)).size !== value.documents.length) throw new Error('setup_unverified')
  return value.documents
}
export function deriveCustomerSetup(workspace, documents, planning = {}, now = Date.now()) {
  const manager = REVIEW_ROLES.includes(workspace.actor.role)
  const ready = workspace.readiness
  const reviewers = workspace.people.filter(person => REVIEW_ROLES.includes(person.role) && person.user_id !== workspace.actor.id)
  const reviewerAvailable = ready.distinct_reviewer_available && reviewers.length > 0
  const knowledgeCount = documents?.filter(item => item.status === 'published' && item.audience === 'organization' && item.freshness === 'current' && Date.parse(item.review_due_at) > now).length
  const config = workspace.configuration
  const steps = [
    { id: 'context', title: 'Save company reply guidance', section: 'Customer Follow-up', action: 'Open reply guidance', complete: ready.context_ready, status: ready.context_ready ? `Saved · version ${workspace.context.version}` : 'Needs setup', detail: ready.context_ready ? 'A saved company name and reply guidance are available. Review the facts before using them in a draft.' : 'An owner, admin, or consultant saves the company name and approved reply guidance in Customer Follow-up.' },
    { id: 'model', title: 'Configure the customer-reply model', section: 'AI Setup', action: 'Open AI Setup', complete: ready.configuration_ready, status: ready.configuration_ready ? `Saved · version ${config.version}` : 'Needs setup', detail: ready.configuration_ready ? `Saved selection: ${config.configuration.provider} / ${config.configuration.model}. This read-only check does not verify the credential, current model availability, pricing approval, or live inference.` : config ? 'The saved AI task is not customer reply. An owner, admin, or consultant must review the task and model in AI Setup.' : 'An authorized administrator sets up the provider securely, approves a supported model and pricing, and saves customer-reply instructions and limits in AI Setup. No key is collected here.' },
    { id: 'microsoft', title: 'Connect the sending account', section: 'Integrations', action: 'Review Microsoft connection', complete: ready.microsoft_ready, status: ready.microsoft_ready ? 'Verified saved connection' : 'Blocked · connection required', detail: ready.microsoft_ready ? 'The saved contract confirms one verified Microsoft connection with Mail.Send and a matching connected integration. This check does not contact Microsoft or prove a live send will succeed.' : 'Customer email requires one verified Microsoft 365 account with Mail.Send and a matching connected integration. A provider plan or an integration named Connected is not enough. Review setup with your Microsoft administrator.' },
    { id: 'team', title: 'Choose an independent reviewer', section: 'Team Access', action: 'Review Team & Roles', complete: reviewerAvailable, status: reviewerAvailable ? 'Reviewer role available' : 'Blocked · reviewer required', detail: reviewerAvailable ? 'Another owner, admin, or consultant is recorded. Eligibility is checked again for each exact email: the requester, draft author, assigned employee, and queuing person cannot approve their own work.' : 'Another owner, admin, or consultant is required to review an email independently. Ask a company owner to review Team & Roles; this guide does not change access.' },
  ]
  const uncertain = workspace.workflows.some(item => ['drafting', 'ai_unknown'].includes(item.status) || ['reserved', 'unknown'].includes(item.ai_run?.status) || item.status === 'awaiting_approval' && !item.action_request || ['Executing', 'Failed'].includes(item.action_request?.status) || item.receipt && item.action_request?.status !== 'Executed')
  const accepted = workspace.workflows.filter(item => item.action_request?.status === 'Executed').length
  const blockers = steps.filter(step => !step.complete).map(step => ({ id: step.id, detail: step.detail, section: step.section }))
  if (!manager) blockers.unshift({ id: 'role', detail: 'Your current role can inspect this guide. An owner, admin, or consultant must manage the model and approve draft work.', section: 'Team Access' })
  if (uncertain) blockers.unshift({ id: 'outcome', detail: 'A visible AI or email outcome is pending or uncertain. Inspect the saved request before considering another attempt; this guide will not retry it.', section: 'Customer Follow-up' })
  const activation = activationState(ready.activation, workspace.organization_id, config?.id, now)
  blockers.push({ id: 'activation', detail: `${savedActivationAuthorized(workspace, now) ? activation.detail : activation.authorized ? 'Live AI generation is disabled in the current workflow contract.' : activation.detail} This saved-record check does not verify credentials, account binding, current model availability, or provider acceptance. Saving setup cannot enable paid inference.`, section: 'AI Setup' })
  return { steps, blockers, manager, uncertain, accepted, knowledgeCount, next: blockers[0], profileComplete: onboardingComplete(planning.onboarding), assessmentComplete: assessmentComplete(planning.readiness), configuredCount: steps.filter(step => step.complete).length }
}
