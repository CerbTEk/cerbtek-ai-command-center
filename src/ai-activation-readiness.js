import { useEffect, useState } from 'react'

// Read-only display checks. Only the server can authorize or reserve paid usage.
// Configuration defaults and the legacy enabled flag never grant authorization.
const nonempty = value => typeof value === 'string' && Boolean(value.trim())
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const isoTime = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value))
const limitKeys = ['request_microusd', 'daily_microusd', 'total_microusd', 'daily_runs', 'total_runs']
export const activationMessages = {
  activation_missing: 'Live AI generation is disabled. No saved activation approval is available.',
  activation_disabled: 'Live AI generation is disabled by the saved activation setting.',
  activation_expired: 'Live AI generation is disabled. The saved activation approval has expired.',
  activation_configuration_changed: 'Live AI generation is disabled. The saved activation approval does not cover this configuration version.',
  activation_invalid: 'Live AI generation is disabled. The saved activation approval could not be verified.',
  activation_budget_exhausted: 'Live AI generation is disabled. The approved spending allowance is exhausted.',
  activation_run_limit: 'Live AI generation is disabled. The approved run limit is exhausted.',
  activation_account_mismatch: 'Live AI generation is disabled. The provider account does not match the saved activation approval.',
  activation_unavailable: 'Live AI generation is disabled. Activation status could not be checked.',
  activation_authorized: 'Saved activation authorization is current for this exact configuration. Provider acceptance is not confirmed.',
}
export function activationState(activation, organizationId, configurationId, now = Date.now()) {
  const result = status => ({ authorized: status === 'activation_authorized', status, detail: activationMessages[status] })
  if (activation == null) return result('activation_missing')
  if (typeof activation !== 'object' || Array.isArray(activation) || activation.contract_version !== 1 || !nonempty(organizationId) || activation.organization_id !== organizationId || typeof activation.enabled !== 'boolean' || typeof activation.account_binding_verified !== 'boolean' || !Object.hasOwn(activationMessages, activation.status)) return result('activation_invalid')
  if (!activation.enabled) return result(activation.status === 'activation_authorized' ? 'activation_invalid' : activation.status)
  if (!nonempty(configurationId) || activation.configuration_id !== configurationId) return result('activation_configuration_changed')
  const limits = activation.limits
  const validLimits = limits && typeof limits === 'object' && !Array.isArray(limits)
    && Object.keys(limits).sort().join(',') === [...limitKeys].sort().join(',')
    && limitKeys.every(key => Number.isSafeInteger(limits[key]) && limits[key] > 0)
    && limits.request_microusd <= 1000000 && limits.daily_microusd <= 100000000 && limits.total_microusd <= 100000000
    && limits.request_microusd <= limits.daily_microusd && limits.daily_microusd <= limits.total_microusd
    && limits.daily_runs <= 100 && limits.total_runs <= 10000 && limits.daily_runs <= limits.total_runs
  if (activation.status !== 'activation_authorized' || !uuid(activation.activation_id) || !isoTime(activation.expires_at) || !validLimits) return result('activation_invalid')
  if (Date.parse(activation.expires_at) <= now) return result('activation_expired')
  return result('activation_authorized')
}
export const savedActivationAuthorized = (workspace, now = Date.now()) => workspace?.readiness?.live_inference_enabled === true && activationState(workspace.readiness.activation, workspace.organization_id, workspace.configuration?.id, now).authorized
export const draftActivationReady = (readiness, organizationId, configurationId, now = Date.now()) => Boolean(readiness?.live_enabled === true && readiness.status === 'activation_authorized' && readiness.credential_configured === true && readiness.activation?.account_binding_verified === true && activationState(readiness.activation, organizationId, configurationId, now).authorized)

// Expiry changes the visible controls without making a provider/network request.
export function useActivationExpiry(expiresAt) {
  const [, refresh] = useState(0)
  useEffect(() => {
    const expires = Date.parse(expiresAt)
    if (!Number.isFinite(expires)) return
    let timer
    const check = () => {
      const remaining = expires - Date.now()
      if (remaining <= 0) refresh(value => value + 1)
      else timer = setTimeout(check, Math.min(remaining, 2147483647))
    }
    check()
    return () => clearTimeout(timer)
  }, [expiresAt])
}
