// Read-only display contract. Only the authenticated status endpoint establishes
// availability; missing fields never become zero, an inactive state, or a charge.
export const canViewBillingStatus = role => role === 'owner' || role === 'admin'
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const count = value => Number.isSafeInteger(value) && value >= 0
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(value)
const quantity = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 100

export function validateBillingStatus(data, organizationId, actorId) {
  const invalid = () => { throw new Error('Billing status could not be verified.') }
  if (!organizationId || !actorId || !record(data) || data.error
    || data.contract !== 'billing_status_v1' || data.organization_id !== organizationId || data.actor_id !== actorId
    || data.authorized !== true || !canViewBillingStatus(data.actor_role)
    || !['not_configured', 'bound_inactive'].includes(data.integration_state)
    || data.commercial_actions_enabled !== false || data.usage_scope !== 'lifetime_observations_only'
    || data.customer_charge !== null || typeof data.customer_bound !== 'boolean'
    || !count(data.binding_count) || data.credential_state !== 'not_verified' || data.webhook_state !== 'not_verified'
    || !count(data.subscription_count) || !count(data.unresolved_receipts) || !count(data.policy_versions)
    || !Array.isArray(data.usage) || data.usage.length > 100) invalid()
  const provider = data.provider
  if (provider !== null && (!record(provider) || typeof provider.account_id !== 'string'
    || !/^acct_[A-Za-z0-9]{1,100}$/.test(provider.account_id) || typeof provider.livemode !== 'boolean'
    || typeof provider.api_version !== 'string' || !/^\d{4}-\d{2}-\d{2}(\.[a-z]+)?$/.test(provider.api_version))) invalid()
  // A provider binding is visible only through the selected company's customer
  // mapping. Reject contradictory state rather than infer a usable setup.
  if (data.integration_state === 'not_configured' && (provider !== null || data.customer_bound !== false || data.binding_count !== 0)) invalid()
  if (data.integration_state === 'bound_inactive' && (data.customer_bound !== true || data.binding_count < 1 || (data.binding_count === 1 ? provider === null : provider !== null))) invalid()
  const seen = new Set()
  const usage = data.usage.map(item => {
    if (!record(item) || !identifier(item.metric) || !identifier(item.unit) || !quantity(item.measured_units) || !count(item.unresolved_sources)) invalid()
    const key = `${item.metric}:${item.unit}`
    if (seen.has(key)) invalid()
    seen.add(key)
    return { metric: item.metric, unit: item.unit, measured_units: item.measured_units, unresolved_sources: item.unresolved_sources }
  })
  // Keep only the approved display fields, never arbitrary endpoint properties.
  return {
    contract: data.contract, organization_id: organizationId, actor_id: actorId, actor_role: data.actor_role,
    authorized: true, integration_state: data.integration_state, commercial_actions_enabled: false,
    provider: provider === null ? null : { account_id: provider.account_id, livemode: provider.livemode, api_version: provider.api_version },
    customer_bound: data.customer_bound, binding_count: data.binding_count, credential_state: 'not_verified', webhook_state: 'not_verified', subscription_count: data.subscription_count,
    unresolved_receipts: data.unresolved_receipts, policy_versions: data.policy_versions,
    usage_scope: 'lifetime_observations_only', customer_charge: null, usage,
  }
}

const metricNames = {
  ai_input_tokens: 'AI input tokens', ai_output_tokens: 'AI output tokens', workflow_runs: 'Workflow runs',
  phone_parent_reported_seconds: 'Phone parent-leg seconds', phone_child_reported_seconds: 'Phone child-leg seconds',
  phone_dialResult_reported_seconds: 'Phone dial-result seconds',
}
export const billingMetricLabel = metric => Object.hasOwn(metricNames, metric) ? metricNames[metric] : metric.replaceAll('_', ' ')
