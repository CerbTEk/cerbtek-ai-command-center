// Authenticated service-only adapter. The database derives readiness and binds all
// references; no caller can submit actor identity, readiness, or an execution flag.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const bindingKeys = ['context_version_id', 'configuration_id', 'microsoft_connection_id', 'assigned_to', 'reviewer_id'];
const intakeKeys = ['customer_email', 'customer_name', 'subject', 'message'];
const operations = {
  load: [],
  save: ['installation_id', 'expected_revision', 'request_key', 'recipe_key', 'recipe_version', 'name', 'outcome', 'bindings', 'limits'],
  start: ['installation_id', 'expected_revision', 'request_key', 'intake'],
};
class InstallationError extends Error {
  constructor(code, status = 400, writeOutcome = 'not_applied') { super(code); this.code = code; this.status = status; this.writeOutcome = writeOutcome; }
}
const roles = ['owner', 'admin', 'consultant', 'member', 'viewer'];
function validInstallation(value, org) {
  return object(value) && value.organization_id === org && uuid(value.id) && value.installation_id === value.id
    && Number.isSafeInteger(value.revision) && value.revision > 0
    && value.recipe_key === 'customer_followup' && value.recipe_version === 1
    && (exact(value.bindings, bindingKeys) || exact(value.bindings, bindingKeys.map(key => key === 'microsoft_connection_id' ? 'email_connection_id' : key))) && Object.values(value.bindings).every(value => value === null || uuid(value))
    && object(value.readiness) && Array.isArray(value.readiness.reasons) && value.readiness.reasons.every(reason => typeof reason === 'string')
    && typeof value.readiness.configured === 'boolean' && typeof value.readiness.can_start === 'boolean'
    && value.readiness.live_inference_enabled === false && value.readiness.automatic_execution_enabled === false
    && value.status === (value.readiness.configured ? 'configured' : 'setup_needed');
}
function validWorkflow(value, org) {
  return object(value) && value.organization_id === org && uuid(value.id)
    && ['context_version', 'configuration', 'ai_run', 'action_request'].every(key => value[key] == null || object(value[key]) && value[key].organization_id === org);
}
export function createHandler({ supabase, allowedOrigins = [] }) {
  return async request => {
    const origin = request.headers.get('origin');
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' };
    if (origin && allowedOrigins.includes(origin)) Object.assign(headers, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    });
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
    if (origin && !allowedOrigins.includes(origin)) return reply({ ok: false, error: 'origin_not_allowed', write_outcome: 'not_applied' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return reply({ ok: false, error: 'method_not_allowed', write_outcome: 'not_applied' }, 405);
    try {
      const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1];
      if (!token) throw new InstallationError('sign_in_required', 401);
      const { data: session, error } = await supabase.auth.getUser(token);
      if (error || !uuid(session?.user?.id) || session.user.is_anonymous === true) throw new InstallationError('sign_in_required', 401);
      const raw = await request.text();
      if (new TextEncoder().encode(raw).length > 45000) throw new InstallationError('request_too_large', 413);
      let body;
      try { body = JSON.parse(raw); } catch { throw new InstallationError('invalid_request'); }
      if (!object(body) || !Object.hasOwn(operations, body.operation) || !exact(body, ['operation', 'organization_id', ...operations[body.operation]])) throw new InstallationError('unsupported_request_fields');
      if (!uuid(body.organization_id)) throw new InstallationError('invalid_organization');
      const args = { p_org: body.organization_id, p_actor: session.user.id };
      if (body.operation !== 'load') {
        if (!uuid(body.request_key) || !(uuid(body.installation_id) || body.operation === 'save' && body.installation_id === null)) throw new InstallationError('invalid_reference');
        if (!Number.isSafeInteger(body.expected_revision) || body.expected_revision < (body.installation_id === null ? 0 : 1) || body.installation_id === null && body.expected_revision !== 0) throw new InstallationError('invalid_revision');
        Object.assign(args, { p_installation: body.installation_id, p_expected_revision: body.expected_revision, p_request_key: body.request_key });
      }
      if (body.operation === 'save') {
        if (body.recipe_key !== 'customer_followup' || body.recipe_version !== 1) throw new InstallationError('unsupported_recipe');
        if (typeof body.name !== 'string' || body.name.trim().length < 1 || body.name.trim().length > 120 || typeof body.outcome !== 'string' || body.outcome.trim().length < 10 || body.outcome.trim().length > 1000) throw new InstallationError('invalid_installation');
        const requestBindingKeys = Object.hasOwn(body.bindings || {}, 'email_connection_id') ? bindingKeys.map(key => key === 'microsoft_connection_id' ? 'email_connection_id' : key) : bindingKeys;
        if (!exact(body.bindings, requestBindingKeys) || !requestBindingKeys.every(key => body.bindings[key] === null || uuid(body.bindings[key]))) throw new InstallationError('invalid_bindings');
        if (!exact(body.limits, ['max_open_requests']) || !Number.isSafeInteger(body.limits.max_open_requests) || body.limits.max_open_requests < 1 || body.limits.max_open_requests > 100) throw new InstallationError('invalid_limits');
        args.p_spec = Object.fromEntries(['recipe_key', 'recipe_version', 'name', 'outcome', 'bindings', 'limits'].map(key => [key, body[key]]));
      } else if (body.operation === 'start') {
        if (!exact(body.intake, intakeKeys) || !intakeKeys.every(key => typeof body.intake[key] === 'string')) throw new InstallationError('invalid_intake');
        args.p_intake = body.intake;
      }
      const result = await supabase.rpc(`workflow_installations_${body.operation}`, args);
      if (result.error) {
        if (['42P01', '42883', '3F000', 'PGRST202'].includes(result.error.code)) throw new InstallationError('workflow_installations_not_installed', 503);
        if (result.error.code === '42501' || result.error.code === 'P0001' && /access denied|authorization required/i.test(result.error.message || '')) throw new InstallationError('organization_access_denied', 403);
        if (!['P0001', '23514', '23503', '23505', '22P02', '22003', '40001', '40P01', '55P03', '57014'].includes(result.error.code)) throw new InstallationError('installation_storage_unavailable', 503, 'unknown');
        if (result.error.message === 'reviewer_conflict') throw new InstallationError('reviewer_conflict', 409);
        if (/Idempotency conflict/i.test(result.error.message || '')) throw new InstallationError('idempotency_conflict', 409);
        throw new InstallationError(body.operation === 'load' ? 'installation_storage_unavailable' : 'installation_changed_or_not_ready', body.operation === 'load' ? 503 : 409);
      }
      const data = result.data, org = body.organization_id;
      const unavailable = () => { throw new InstallationError('installation_storage_unavailable', 503, 'unknown'); };
      if (!object(data)) unavailable();
      const envelope = { ok: true, contract_version: 1, organization_id: org };
      if (body.operation === 'load') {
        if (data.organization_id !== org || data.actor?.id !== session.user.id || !roles.includes(data.actor?.role)
          || !Array.isArray(data.recipes) || !data.recipes.every(recipe => recipe.recipe_key === 'customer_followup' && recipe.version === 1 && recipe.recipe_version === 1 && recipe.definition?.automatic_execution === false && recipe.definition?.live_inference_enabled === false)
          || !Array.isArray(data.installations) || !data.installations.every(item => validInstallation(item, org))
          || !Array.isArray(data.operation_receipts) || !data.operation_receipts.every(receipt => ['save', 'start'].includes(receipt.operation) && uuid(receipt.request_key) && uuid(receipt.installation_id) && (receipt.workflow_id === null || uuid(receipt.workflow_id)))
          || !object(data.workspace) || data.workspace.actor?.id !== session.user.id || data.workspace.actor?.role !== data.actor.role
          || !Array.isArray(data.workspace.workflows) || !data.workspace.workflows.every(item => validWorkflow(item, org))
          || !['context', 'configuration'].every(key => data.workspace[key] == null || data.workspace[key].organization_id === org)) unavailable();
        return reply({ ...data, ...envelope });
      }
      if (body.operation === 'save') {
        if (!validInstallation(data, org)) unavailable();
        return reply({ ...envelope, installation: data });
      }
      if (!validInstallation(data.installation, org) || data.installation.id !== body.installation_id || data.installation.revision !== body.expected_revision
        || !validWorkflow(data.workflow, org) || data.workflow.request_key !== body.request_key
        || data.provenance?.organization_id !== org || data.provenance?.installation_id !== body.installation_id || data.provenance?.installation_revision !== body.expected_revision
        || data.provenance?.workflow_id !== data.workflow.id || data.provenance?.request_key !== body.request_key || data.provenance?.started_by !== session.user.id || typeof data.replayed !== 'boolean') unavailable();
      return reply({ ...data, ...envelope });
    } catch (error) {
      return reply({ ok: false, error: error instanceof InstallationError ? error.code : 'workflow_installations_unavailable', write_outcome: error instanceof InstallationError ? error.writeOutcome : 'unknown' }, error instanceof InstallationError ? error.status : 503);
    }
  };
}
