// Synthetic approvals only. No fixture reaches a provider or live database.
export const activationFixture = (organizationId = 'org', configurationId = 'config', overrides = {}) => ({
  contract_version: 1,
  organization_id: organizationId,
  configuration_id: configurationId,
  enabled: true,
  status: 'activation_authorized',
  activation_id: '00000000-0000-4000-8000-000000000001',
  expires_at: '2099-01-01T00:00:00.000Z',
  account_binding_verified: true,
  limits: { request_microusd: 100000, daily_microusd: 1000000, total_microusd: 2000000, daily_runs: 10, total_runs: 20 },
  ...overrides,
})
export const aiReadinessFixture = (organizationId = 'org', configurationId = 'config') => ({
  live_enabled: true,
  credential_configured: true,
  status: 'activation_authorized',
  activation: activationFixture(organizationId, configurationId),
})
