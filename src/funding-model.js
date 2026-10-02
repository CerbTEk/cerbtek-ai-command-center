export const FUNDING_TABLE = 'cerbtek_funding_opportunities'
export const VENTURES = ['CerbTek AI Enablement', 'ForgeCIF Career Intelligence', 'Company-wide']
export const CATEGORIES = ['Grant', 'Accelerator', 'Equity', 'Cloud credits', 'Competition', 'Other']
export const STATUSES = ['Researching', 'Eligibility review', 'Preparing', 'Submitted', 'In conversation', 'Awarded', 'Declined', 'Closed']
export const READINESS = ['Unreviewed', 'Potential fit', 'Needs evidence', 'Ready', 'Not eligible']
export const DEADLINES = ['Unannounced', 'Rolling', 'Fixed', 'Closed']
export const FUNDING_COLUMNS = 'id,venture,opportunity,provider,category,official_url,fit,eligibility,readiness,deadline_state,deadline_date,deadline_note,amount_terms,status,next_action,owner,notes,last_verified,version,created_at,updated_at'
export const MAX_LENGTHS = { opportunity: 180, provider: 180, official_url: 2048, fit: 2000, eligibility: 4000, deadline_note: 1000, amount_terms: 2000, next_action: 2000, owner: 180, notes: 8000 }
export function canManageFunding(staff, userId) { return Boolean(userId && staff?.user_id === userId && staff?.active === true && staff?.role === 'platform_admin') }
export function emptyOpportunity(id) { return { id, venture: VENTURES[0], opportunity: '', provider: '', category: 'Grant', official_url: '', fit: '', eligibility: '', readiness: 'Unreviewed', deadline_state: 'Unannounced', deadline_date: '', deadline_note: '', amount_terms: '', status: 'Researching', next_action: '', owner: '', notes: '', last_verified: '' } }
export function officialUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password ? url.href : null } catch { return null }
}
export function validDate(value) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const d = new Date(`${value}T00:00:00Z`); return Number.isFinite(d.valueOf()) && d.toISOString().slice(0,10) === value }
export function validateOpportunity(draft, today = new Date().toISOString().slice(0,10)) {
  for (const field of ['opportunity', 'provider']) if (!draft[field]?.trim()) return `${field === 'opportunity' ? 'Opportunity' : 'Provider'} is required.`
  if (!officialUrl(draft.official_url)) return 'Use a complete HTTPS official-source URL without embedded credentials.'
  for (const [field, values] of [['venture', VENTURES], ['category', CATEGORIES], ['status', STATUSES], ['readiness', READINESS], ['deadline_state', DEADLINES]]) if (!values.includes(draft[field])) return `Choose a valid ${field.replaceAll('_', ' ')}.`
  for (const [field, limit] of Object.entries(MAX_LENGTHS)) if ((draft[field] || '').length > limit) return `${field.replaceAll('_', ' ')} must be ${limit} characters or fewer.`
  if (draft.deadline_date && !validDate(draft.deadline_date)) return 'Enter a valid deadline date.'
  if (draft.deadline_state === 'Fixed' && !draft.deadline_date) return 'A fixed deadline needs a date.'
  if (draft.last_verified && (!validDate(draft.last_verified) || draft.last_verified > today)) return 'Last verified must be a valid date on or before today.'
  return ''
}
export function opportunityPayload(draft) {
  const fields = [...Object.keys(MAX_LENGTHS), 'venture', 'category', 'status', 'readiness', 'deadline_state']
  const payload = Object.fromEntries(fields.map(field => [field, String(draft[field] || '').trim()]))
  payload.official_url = officialUrl(payload.official_url)
  payload.deadline_date = ['Fixed', 'Closed'].includes(draft.deadline_state) ? draft.deadline_date || null : null
  payload.last_verified = draft.last_verified || null
  return payload
}
export function deadlineLabel(row, today = new Date().toISOString().slice(0,10)) {
  if (row.deadline_state === 'Closed') return row.deadline_date ? `Closed · ${row.deadline_date}` : 'Closed · next cycle unknown'
  if (row.deadline_state === 'Fixed' && row.deadline_date) return `${row.deadline_date < today ? 'Past date · verify' : 'Due'} · ${row.deadline_date}`
  return row.deadline_state === 'Rolling' ? 'Rolling · verify intake' : 'Next deadline unannounced'
}
export function filterOpportunities(rows, query, status, venture) { const term = query.trim().toLowerCase(); return rows.filter(r => (status === 'All' || r.status === status) && (venture === 'All' || r.venture === venture) && (!term || [r.opportunity, r.provider, r.owner, r.next_action].some(x => String(x || '').toLowerCase().includes(term)))) }
