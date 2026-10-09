import { appRoute } from './app-routing.js'
// Preserve old command-center bookmarks and existing provider return URLs.
// This public module intentionally imports no auth client or private app code.
export const LEGACY_SECTIONS = ['Overview', 'Customer Setup', 'Customer Follow-up', 'Company Knowledge', 'Team Access', 'Onboarding', 'AI Readiness', 'AI Setup', 'Systems', 'Workflows', 'Opportunities', 'Integrations', 'Agents', 'AI Ops', 'Governance', 'Blueprints', 'Audit', 'CerbTek Staff', 'Funding']
const APP_QUERY_KEYS = ['invite', 'kairoCompany', 'kairoWorkflow', 'kairoRun', 'kairoDays', 'kairoCustomerRequest', 'kairoCustomerDays', 'kairoReport', 'code', 'access_token', 'refresh_token', 'error', 'error_code', 'error_description', 'token_hash']
const AUTH_HASH_KEYS = ['access_token', 'refresh_token', 'error', 'error_code', 'error_description', 'token_hash', 'code']
export function legacyAppTarget({ pathname = '', search = '', hash = '' }, base = '/') {
  const route = appRoute({ pathname, search, hash }, base)
  if (route.kind === 'legacy') return route.target
  if (route.kind !== 'outside') return null
  const prefix = base.replace(/\/$/, '')
  const publicEntries = ['', prefix, `${prefix}/`, `${prefix}/index.html`, `${prefix}/products/kairo`, `${prefix}/products/kairo/`, `${prefix}/products/kairo/index.html`]
  if (!publicEntries.includes(pathname)) return null
  let section = ''
  try { section = decodeURIComponent(hash.replace(/^#/, '')) } catch { /* malformed hashes stay public */ }
  const query = new URLSearchParams(search)
  const fragment = new URLSearchParams(hash.replace(/^#/, ''))
  const isApp = LEGACY_SECTIONS.includes(section) || APP_QUERY_KEYS.some(key => query.has(key)) || AUTH_HASH_KEYS.some(key => fragment.has(key))
  return isApp ? `${base.replace(/\/$/, '')}/app/kairo${search}${hash}` : null
}
