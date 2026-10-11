export const EMAIL_PROVIDERS = ['microsoft', 'google']
export const emailProviderName = provider => provider === 'google' ? 'Google / Gmail' : provider === 'microsoft' ? 'Microsoft 365' : 'Email provider'
export const EMAIL_RETURN_URL = 'https://www.cerbtek.com/app/kairo'
const text = value => typeof value === 'string' && value.trim().length > 0
export const validEmailConnection = connection => Boolean(connection && text(connection.id) && EMAIL_PROVIDERS.includes(connection.provider) && text(connection.external_account_id) && text(connection.account_name) && typeof connection.mail_read === 'boolean' && typeof connection.mail_send === 'boolean')
export function emailConnections(readiness) {
  // Never fall back to a legacy Microsoft account when a new contract is present
  // but malformed. The caller must refresh the current company instead.
  if (readiness?.email_connections !== undefined) {
    const rows = readiness.email_connections
    return Array.isArray(rows) && rows.every(validEmailConnection) && new Set(rows.map(row => row.id)).size === rows.length ? rows : []
  }
  return readiness?.microsoft_ready === true && text(readiness.microsoft_connection_id) && text(readiness.microsoft_account)
    ? [{ id: readiness.microsoft_connection_id, provider: 'microsoft', external_account_id: readiness.microsoft_account, account_name: readiness.microsoft_account, mail_read: false, mail_send: true }] : []
}
export const sendingConnections = readiness => emailConnections(readiness).filter(row => row.mail_send)
export function workflowEmailConnection(workflow, readiness, selectedId) {
  const connections = sendingConnections(readiness)
  const boundId = workflow?.action_request?.connection_id || workflow?.email_connection_id
  const connection = connections.find(row => row.id === (boundId || selectedId)) || (!boundId && !selectedId && connections.length === 1 ? connections[0] : null)
  const provider = workflow?.action_request?.provider || workflow?.email_provider
  return connection && (!provider || connection.provider === provider) ? connection : null
}
export function emailBindingMatches(workflow, readiness) {
  const action = workflow?.action_request, binding = action?.approved_connection_binding
  const connection = workflowEmailConnection(workflow, readiness)
  if (!action || !connection || action.provider !== connection.provider) return false
  if (action.status === 'Pending') return true
  return Boolean(binding?.id === action.connection_id && binding.organization_id === workflow.organization_id && binding.external_account_id === connection.external_account_id && (!connection.oauth_revision || binding.oauth_revision === connection.oauth_revision) && (binding.provider === connection.provider || connection.provider === 'microsoft' && binding.provider === undefined))
}
export function safeAuthorizationUrl(value, provider, redirectUri, backendUrl = import.meta.env.VITE_SUPABASE_URL || 'https://suohuogalotxhsnkumvy.supabase.co') {
  const callback = `${backendUrl.replace(/\/$/, '')}/functions/v1/${provider}-oauth-callback`
  if (redirectUri !== callback) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && url.searchParams.get('redirect_uri') === callback && Boolean(url.searchParams.get('state')) && (provider === 'google'
      ? url.hostname === 'accounts.google.com' && url.pathname === '/o/oauth2/v2/auth'
      : provider === 'microsoft' && url.hostname === 'login.microsoftonline.com' && /^\/(?:organizations|[0-9a-f-]+)\/oauth2\/v2\.0\/authorize$/i.test(url.pathname))
  } catch { return false }
}
