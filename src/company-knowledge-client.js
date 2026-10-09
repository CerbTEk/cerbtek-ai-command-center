export const KNOWLEDGE_MAX_BYTES = 32768
export const knowledgeBytes = value => new TextEncoder().encode(value).byteLength
export const knowledgeKey = () => crypto.randomUUID()
export const knowledgeAudience = value => value === 'organization' ? 'All company members' : 'Company admins only'
export const defaultKnowledgeDraft = () => ({ title: '', content_text: '', audience: 'private', source_kind: 'manual', source_name: 'Pasted text', review_due_at: new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10) })
export function knowledgeError(error) {
  if (error?.code === '40001') return 'This source changed. Refresh it before making another change.'
  if (['42501', 'P0002'].includes(error?.code)) return 'This source or your company access is no longer available. Refresh to check access.'
  if (error?.code === '22023' || error?.code === 'too_large') return error.message
  return 'The request could not be confirmed. Retry the same request to check its outcome.'
}
export async function knowledgeRequest(client, organizationId, actorId, operation, payload = {}, signal) {
  const { data, error } = await client.functions.invoke('company-knowledge', {
    body: { schema_version: 1, organization_id: organizationId, operation, ...payload },
    ...(signal ? { signal } : {}),
  })
  let failure = data?.error ? data : null
  if (error?.context?.json) { try { failure = await error.context.json() } catch { /* safe generic message */ } }
  if (error || failure) { const problem = new Error(failure?.error || error?.message || 'Request failed'); problem.code = failure?.code || error?.code; throw problem }
  if (!data || data.ok !== true || data.schema_version !== 1 || data.organization_id !== organizationId || data.actor_user_id !== actorId || !['owner', 'admin', 'consultant', 'member', 'viewer'].includes(data.actor_role) || data.can_manage !== ['owner', 'admin'].includes(data.actor_role)) throw new Error('Unverified Company Knowledge response')
  return data
}
export async function readKnowledgeFile(file) {
  if (!file || !/\.(txt|md|markdown)$/i.test(file.name) || file.size < 1 || file.size > KNOWLEDGE_MAX_BYTES || file.name.length > 160) throw new Error('Choose a .txt or .md UTF-8 file up to 32 KiB.')
  const bytes = await file.arrayBuffer()
  if (bytes.byteLength > KNOWLEDGE_MAX_BYTES) throw new Error('Choose a .txt or .md UTF-8 file up to 32 KiB.')
  let content
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new Error('This file is not valid UTF-8 text.') }
  if (!content.trim() || content.includes('\0')) throw new Error('Choose a nonempty UTF-8 text file without binary content.')
  return { content_text: content, source_kind: 'text_upload', source_name: file.name }
}
