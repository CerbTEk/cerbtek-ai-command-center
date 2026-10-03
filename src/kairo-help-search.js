import { HELP_ARTICLES, helpDestination } from './kairo-help-content'

const STOP_WORDS = new Set(['a','an','and','are','can','do','does','for','how','i','in','is','it','me','my','of','on','the','to','what','where','with','about','am','at','be','by','could','from','has','have','into','please','should','that','this','was','we','when','which','why','will','would','you','your','kairo','implement','implementing','implementation','configure','configuring','need','want','help','trying','set','up','use','using'])
const SYNONYMS = Object.freeze({
  start:['setup','begin'], chatbot:['help'], bot:['help'], connect:['connection','integration'],
  connected:['connection'], connecting:['connection'], outlook:['microsoft'], mail:['email'], sending:['send'],
  approvals:['approval'], approved:['approval'], scores:['score'], workflows:['workflow'],
  saving:['save'], saved:['save'], rating:['score'], ratings:['score'], costs:['cost'],
  benefits:['benefit'], returns:['roi'], invitations:['invite'], invite:['invitation'],
  teammates:['team'], stuck:['error'], errors:['error'], failed:['failure'],
  automation:['workflow'], automate:['automation'], pdf:['blueprint'], next:['setup'],
  controls:['control'], permissions:['permission'], scopes:['scope'], schedules:['schedule'],
  logs:['log','logging'], calls:['call'], phones:['phone','telephony'], phone:['telephony'],
  telephone:['telephony'], queues:['queue'], routing:['route'], recordings:['recording'],
  transcripts:['transcript','transcription'], transcript:['transcription'],
  retry:['retries'], retries:['retry'], webhook:['webhooks'], webhooks:['webhook'],
  troubleshooting:['troubleshoot','diagnose'], diagnose:['diagnostic','diagnostics'],
  broken:['error'], failing:['failure','error'], expired:['expiry'], entra:['microsoft']
})
const normalize = value => String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim()
const list = value => Array.isArray(value) ? value : []
const safeCount = value => list(value).length

// Strict projection: no IDs, company names, free text, credentials, raw records,
// messages, invitation details, or staff-only data enter help/search context.
// This is for local suggestions only; it is not a server authorization boundary.
export function buildHelpContext({ section, data, ready = false } = {}) {
  const currentSection = helpDestination(section) || 'Overview'
  if (!ready || !data) return { currentSection, ready:false, suggestedArticle:'getting-started' }
  const profileComplete = ['Ready for Assessment','Complete'].includes(data.onboarding?.status)
  const assessmentComplete = data.readiness?.status === 'Complete'
  const systemsCount = safeCount(data.systems)
  const workflowsCount = safeCount(data.workflows)
  const opportunitiesCount = safeCount(data.opps)
  const microsoftConnected = list(data.oauth).some(item => item?.provider === 'microsoft' && item?.status === 'Connected')
  const pendingApproval = list(data.actionRequests).some(item => ['Pending','Approved'].includes(item?.status))
  let suggestedArticle = 'automation'
  if (!profileComplete) suggestedArticle='company-profile'
  else if (!assessmentComplete) suggestedArticle='readiness'
  else if (!systemsCount) suggestedArticle='systems'
  else if (!workflowsCount) suggestedArticle='workflow-basics'
  else if (!opportunitiesCount) suggestedArticle='business-case'
  else if (!microsoftConnected) suggestedArticle='microsoft-setup'
  else if (pendingApproval) suggestedArticle='email-approval'
  else if (list(data.workflowRuns).some(run => run?.status === 'Error')) suggestedArticle='run-status'
  return { currentSection, ready:true, profileComplete, assessmentComplete, systemsCount, workflowsCount, opportunitiesCount, microsoftConnected, pendingApproval, suggestedArticle }
}

export function searchHelp(query, context = {}, limit = 6) {
  const normalized = normalize(String(query || '').slice(0,240))
  const tokens = [...new Set(normalized.split(' ').filter(token => token && !STOP_WORDS.has(token)))]
  const expanded = tokens.map(token => [token,...(SYNONYMS[token] || [])])
  const suggestionsOnly = !normalized
  if (!suggestionsOnly && !tokens.length) return []
  return HELP_ARTICLES.map((article, index) => {
    const title=normalize(article.title), keywords=normalize(article.keywords.join(' '))
    const body=normalize([article.summary,...article.prerequisites,...article.steps,...article.troubleshooting].join(' '))
    const termScores=expanded.map(variants => Math.max(...variants.map(term => {
      const matches = text => (` ${text} `).includes(` ${term} `)
      return matches(title) ? 10 : matches(keywords) ? 7 : matches(body) ? 2 : 0
    })))
    // Every meaningful query term needs coverage, and at least one must match
    // the curated topic/title. Generic shared words cannot answer an uncovered
    // subject. Disclaimers and source labels do not establish topic coverage.
    const covered=termScores.length>0 && termScores.every(score=>score>0) && termScores.some(score=>score>=7)
    const score=termScores.reduce((total,value)=>total+value,0)
    const related = article.section === context.currentSection ? 4 : 0
    const next = article.id === context.suggestedArticle ? 3 : 0
    return {article, covered, score, rank:score+related+next, index}
  }).filter(result => suggestionsOnly ? result.article.kind==='platform' && result.rank > 0 : result.covered)
    .sort((a,b) => b.rank-a.rank || a.index-b.index)
    .slice(0,Math.max(0,Math.min(16,limit)))
    .map(result => result.article)
}
