// Preserve old command-center bookmarks and existing provider return URLs.
// This public module intentionally imports no auth client or private app code.
export const LEGACY_SECTIONS = ['Overview', 'Team Access', 'Onboarding', 'AI Readiness', 'AI Setup', 'Systems', 'Workflows', 'Opportunities', 'Integrations', 'Agents', 'AI Ops', 'Governance', 'Blueprints', 'Audit', 'CerbTek Staff', 'Funding']
const APP_QUERY_KEYS = ['invite', 'kairoCompany', 'kairoWorkflow', 'kairoRun', 'kairoDays', 'code', 'access_token', 'refresh_token', 'error', 'error_code', 'error_description', 'token_hash']
const AUTH_HASH_KEYS = ['access_token', 'refresh_token', 'error', 'error_code', 'error_description', 'token_hash', 'code']
export function legacyAppTarget({ search = '', hash = '' }, base = '/') {
  let section = ''
  try { section = decodeURIComponent(hash.replace(/^#/, '')) } catch { /* malformed hashes stay public */ }
  const query = new URLSearchParams(search)
  const fragment = new URLSearchParams(hash.replace(/^#/, ''))
  const isApp = LEGACY_SECTIONS.includes(section) || APP_QUERY_KEYS.some(key => query.has(key)) || AUTH_HASH_KEYS.some(key => fragment.has(key))
  return isApp ? `${base.replace(/\/$/, '')}/app/${search}${hash}` : null
}
