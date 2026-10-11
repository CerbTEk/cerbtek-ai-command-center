import { validEmail } from './customer-reply-model'

export const MAILBOX_INTAKE_CONTRACT = 2
export const PREVIEW_LIFETIME_MS = 15 * 60 * 1000
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const keys = (value, expected) => object(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',')
const text = (value, max = 1024) => typeof value === 'string' && value.trim().length > 0 && value.length <= max
const providerId = value => text(value) && !/[\x00-\x1f\x7f]/.test(value)
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const revision = value => Number.isSafeInteger(value) && value > 0
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
const unique = (rows, key) => new Set(rows.map(row => row[key])).size === rows.length
const list = (value, max, validate) => Array.isArray(value) && value.length <= max && value.every(validate)
const envelope = ['ok', 'contract_version', 'organization_id', 'installation_id', 'installation_revision']

export function validMailboxSource(source, mailboxId) {
  return keys(source, ['id', 'revision', 'folder_id', 'folder_name', 'mailbox_id']) && uuid(source.id) && revision(source.revision) && providerId(source.folder_id) && text(source.folder_name, 200) && providerId(source.mailbox_id) && source.mailbox_id === mailboxId
}
export function validMailboxPreview(preview, now = Date.now()) {
  const intake = preview?.intake
  return keys(preview, ['id', 'expires_at', 'message_id', 'thread_id', 'received_at', 'has_attachments', 'intake']) && uuid(preview.id) && providerId(preview.message_id) && providerId(preview.thread_id) && date(preview.received_at) && date(preview.expires_at) && Date.parse(preview.expires_at) <= now + PREVIEW_LIFETIME_MS + 30000 && typeof preview.has_attachments === 'boolean' && keys(intake, ['customer_name', 'customer_email', 'subject', 'message']) && text(intake.customer_name, 200) && validEmail(intake.customer_email) && text(intake.subject, 200) && !/[\r\n]/.test(intake.subject) && text(intake.message, 6000)
}
export function verifyMailboxResponse(value, operation, context) {
  const fields = { load: ['source', 'capabilities', 'imports'], folders: ['folders', 'has_more'], save: ['source'], preview: ['previews', 'has_more', 'skipped'], import: ['workflow_id', 'replayed'] }[operation]
  const invalid = () => { throw new Error('mailbox_response_unverified') }
  if (!fields || !keys(value, [...envelope, ...fields]) || value.ok !== true || value.contract_version !== MAILBOX_INTAKE_CONTRACT || value.organization_id !== context.organizationId || value.installation_id !== context.installationId || value.installation_revision !== context.installationRevision) invalid()
  if (operation === 'load') {
    const capability = value.capabilities
    if (!keys(capability, ['mail_read', 'mailbox_id', 'account_name', 'provider', 'connection_id']) || !['microsoft', 'google'].includes(capability.provider) || !uuid(capability.connection_id) || context.connectionId && capability.connection_id !== context.connectionId || context.provider && capability.provider !== context.provider || typeof capability.mail_read !== 'boolean' || !providerId(capability.mailbox_id) || !text(capability.account_name) || value.source !== null && !validMailboxSource(value.source, capability.mailbox_id) || !list(value.imports, 20, row => keys(row, ['preview_id', 'workflow_id', 'message_id']) && uuid(row.preview_id) && uuid(row.workflow_id) && providerId(row.message_id)) || !unique(value.imports, 'preview_id')) invalid()
  } else if (operation === 'folders') {
    if (!list(value.folders, 50, row => keys(row, ['id', 'name']) && providerId(row.id) && text(row.name, 200)) || !unique(value.folders, 'id') || typeof value.has_more !== 'boolean') invalid()
  } else if (operation === 'save') {
    if (!validMailboxSource(value.source, context.mailboxId) || value.source.revision !== context.sourceRevision + 1 || value.source.folder_id !== context.folderId || context.sourceId && value.source.id !== context.sourceId) invalid()
  } else if (operation === 'preview') {
    if (!list(value.previews, 10, row => validMailboxPreview(row)) || !unique(value.previews, 'id') || !unique(value.previews, 'message_id') || typeof value.has_more !== 'boolean' || !Number.isSafeInteger(value.skipped) || value.skipped < 0) invalid()
  } else if (!uuid(value.workflow_id) || typeof value.replayed !== 'boolean') invalid()
  return value
}
export function mailboxError(error) {
  return ({
    mail_read_required: 'The connected email account is missing read permission. A company manager can review and explicitly grant read access in Connections, then refresh intake status. This screen cannot grant access.',
    mailbox_intake_not_installed: 'Mailbox intake is not available in this environment. Ask an authorized administrator to review deployment status. No mailbox access has been enabled.',
    organization_access_denied: 'Your company access could not be verified. Close mailbox intake and ask an authorized company manager to review your current access.',
    mailbox_source_changed_or_not_ready: 'The mailbox source or workflow setup changed or is not ready. Refresh intake status, or close this screen and refresh workflows to review the current setup.',
    mailbox_connection_unavailable: 'The workflow’s email connection is unavailable. Review the connection in Connections, then reopen mailbox intake.',
    source_changed: 'The saved mailbox source changed. Refresh intake status and review the current source before continuing.',
    installation_changed: 'This workflow setup changed. Close mailbox intake and refresh workflows before continuing.',
    preview_expired: 'This preview expired. Explicitly preview messages again and review the new preview before importing.',
  })[error?.code] || 'Mailbox intake could not be verified. Refresh intake status before continuing.'
}
