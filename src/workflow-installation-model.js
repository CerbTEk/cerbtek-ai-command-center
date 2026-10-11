// Installation records describe explicit setup. They never authorize model calls or sending.
export const INSTALLATION_CONTRACT = 1
export const RECIPE_KEY = 'customer_followup'
export const RECIPE_VERSION = 1
export const MANAGERS = ['owner', 'admin', 'consultant']
const text = value => typeof value === 'string' && Boolean(value.trim())
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
export const emptyInstallation = () => ({ installation_id: null, expected_revision: 0, recipe_key: RECIPE_KEY, recipe_version: RECIPE_VERSION, name: 'Customer follow-up', outcome: '', bindings: { context_version_id: null, configuration_id: null, email_connection_id: null, assigned_to: null, reviewer_id: null }, limits: { max_open_requests: 20 } })
export function validInstallation(record, orgId) {
  return Boolean(record && uuid(record.id) && record.organization_id === orgId && record.recipe_key === RECIPE_KEY && record.recipe_version === RECIPE_VERSION && Number.isSafeInteger(record.revision) && record.revision > 0 && text(record.name) && text(record.outcome) && ['setup_needed', 'configured'].includes(record.status) && record.bindings && ['context_version_id', 'configuration_id', 'assigned_to', 'reviewer_id'].every(key => record.bindings[key] === null || uuid(record.bindings[key])) && ['email_connection_id', 'microsoft_connection_id'].some(key => Object.hasOwn(record.bindings, key) && (record.bindings[key] === null || uuid(record.bindings[key]))) && !(record.bindings.email_connection_id && record.bindings.microsoft_connection_id && record.bindings.email_connection_id !== record.bindings.microsoft_connection_id) && Number.isSafeInteger(record.limits?.max_open_requests) && record.limits.max_open_requests >= 1 && record.limits.max_open_requests <= 100 && record.readiness?.live_inference_enabled === false && record.readiness?.automatic_execution_enabled === false && typeof record.readiness.can_start === 'boolean' && Array.isArray(record.readiness.reasons) && record.readiness.reasons.every(reason => typeof reason === 'string') && (record.readiness.start_blocker == null || typeof record.readiness.start_blocker === 'string'))
}
export function verifyInstallations(value, orgId, actorId) {
  if (value?.ok !== true || value.contract_version !== INSTALLATION_CONTRACT || value.organization_id !== orgId || value.actor?.id !== actorId || ![...MANAGERS, 'member', 'viewer'].includes(value.actor.role) || !Array.isArray(value.installations) || !value.installations.every(row => validInstallation(row, orgId)) || new Set(value.installations.map(row => row.id)).size !== value.installations.length || !Array.isArray(value.recipes) || !value.recipes.some(recipe => recipe.recipe_key === RECIPE_KEY && recipe.recipe_version === RECIPE_VERSION)) throw new Error('installation_unverified')
  const workspace = value.workspace
  if (!workspace || workspace.actor?.id !== actorId || workspace.actor.role !== value.actor.role || !Array.isArray(workspace.people) || !workspace.people.every(person => person && uuid(person.user_id) && [...MANAGERS, 'member', 'viewer'].includes(person.role)) || workspace.context && workspace.context.organization_id !== orgId || workspace.configuration && workspace.configuration.organization_id !== orgId) throw new Error('installation_unverified')
  return value
}
export function installationForm(record) {
  return { installation_id: record.id, expected_revision: record.revision, recipe_key: record.recipe_key, recipe_version: record.recipe_version, name: record.name, outcome: record.outcome, bindings: { context_version_id: record.bindings.context_version_id, configuration_id: record.bindings.configuration_id, assigned_to: record.bindings.assigned_to, reviewer_id: record.bindings.reviewer_id, email_connection_id: record.bindings.email_connection_id || record.bindings.microsoft_connection_id || null }, limits: { ...record.limits } }
}
export const canStartInstallation = (record, actor) => record.status === 'configured' && record.readiness?.can_start !== false && actor?.id !== record.bindings.reviewer_id && (MANAGERS.includes(actor?.role) || actor?.role === 'member' && record.bindings.assigned_to === actor.id)
export function validInstallationForm(form) {
  return text(form.name) && form.name.trim().length <= 100 && text(form.outcome) && form.outcome.trim().length >= 10 && form.outcome.trim().length <= 1000 && Number.isSafeInteger(form.limits.max_open_requests) && form.limits.max_open_requests >= 1 && form.limits.max_open_requests <= 100 && (!form.bindings.assigned_to || form.bindings.assigned_to !== form.bindings.reviewer_id)
}
export const installationError = () => 'This setup could not be verified or saved. Refresh the saved records before continuing. No AI request or email was sent by this screen.'
