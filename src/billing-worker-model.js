// Display/dispatch guard only. The worker must independently authenticate and
// enforce its fixed sandbox binding, tenant, operator, and one-job limit.
export const BILLING_SANDBOX_ORIGIN = 'https://www.cerbtek.com'
export const BILLING_SANDBOX_OPERATOR = '02ca6114-7550-496e-bf19-30af0898e89e'
export const BILLING_SANDBOX_ORGANIZATION = 'ca93bfdd-c163-4a20-8ee8-10bb24273c38'

export function canRunSandboxBilling(snapshot, session, origin) {
  return origin === BILLING_SANDBOX_ORIGIN
    && session?.user?.id === BILLING_SANDBOX_OPERATOR && session.user.is_anonymous !== true
    && snapshot?.authorized === true && snapshot.actor_role === 'owner'
    && snapshot.actor_id === BILLING_SANDBOX_OPERATOR
    && snapshot.organization_id === BILLING_SANDBOX_ORGANIZATION
    && snapshot.commercial_actions_enabled === false
}

const denied = {
  billing_inactive: [503, 'The server reports that billing is inactive. No sandbox job was run.'],
  authentication_required: [401, 'The server requires an authenticated owner session. No job completion is confirmed.'],
  operator_required: [403, 'The server rejected this operator. No job completion is confirmed.'],
  origin_not_allowed: [403, 'The server rejected this origin. No job completion is confirmed.'],
  method_not_allowed: [405, 'The server rejected the request method. No job completion is confirmed.'],
  empty_body_required: [400, 'The server rejected the request body. No job completion is confirmed.'],
  billing_host_unavailable: [503, 'The server is unavailable. The job outcome needs review before another attempt.'],
}
const fields = ['discovered', 'claimed', 'completed', 'superseded', 'retried', 'lease_lost']
const boundedCount = value => Number.isSafeInteger(value) && value >= 0 && value <= 1
const unknown = () => ({ code: 'outcome_unknown', message: 'The sandbox job outcome could not be verified. Review the server records before another attempt.', counters: null, httpStatus: null })

export async function readSandboxBillingResult(result) {
  try {
    const { error, response } = result || {}
    const httpStatus = response?.status
    let data = result?.data
    if (error) {
      if (error.name !== 'FunctionsHttpError' || typeof error.context?.json !== 'function'
        || error.context.status !== httpStatus) return unknown()
      data = await error.context.json()
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return unknown()
    if (Object.hasOwn(denied, data.code)) {
      if (!error || Object.keys(data).length !== 1) return unknown()
      const [expectedStatus, message] = denied[data.code]
      return httpStatus === expectedStatus ? { code: data.code, message, counters: null, httpStatus,
        retrySafe: data.code !== 'billing_host_unavailable' } : unknown()
    }
    if (error || httpStatus !== 200 || data.code !== 'billing_worker_run'
      || fields.some(field => !boundedCount(data[field]))
      || data.claimed !== data.completed + data.superseded + data.retried + data.lease_lost
      || !Array.isArray(data.errors) || data.errors.length > 1
      || data.errors.length !== data.retried + data.lease_lost) return unknown()
    // Only bounded numeric facts leave this parser. Never render server error
    // details, arbitrary properties, provider data, or credentials.
    const counters = Object.fromEntries(fields.map(field => [field, data[field]]))
    const message = data.completed === 1
      ? 'The server reports one completed sandbox job. Customer charges and billing activation are not established by this result.'
      : 'The server returned a sandbox pass result. No completed job is confirmed.'
    return { code: data.code, message, counters, httpStatus }
  } catch { return unknown() }
}
