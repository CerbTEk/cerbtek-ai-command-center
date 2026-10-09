import { KnowledgeError, readBoundedJson, validateRequest } from './core.mjs';
// User JWT throughout. SQL authorizes membership and audience after the same
// company lock used by team revocation. Never accept actor IDs or fetch sources.
export function createHandler({ makeUserClient, allowedOrigins = [] }) {
  return async function handle(req) {
    const origin = req.headers.get('Origin');
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Vary': 'Origin',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      ...(origin && allowedOrigins.includes(origin) ? { 'Access-Control-Allow-Origin': origin } : {}),
    };
    const respond = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
    if (origin && !allowedOrigins.includes(origin)) return respond({ error: 'Origin not allowed', code: 'origin_denied' }, 403);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') return respond({ error: 'Method not allowed', code: 'method_not_allowed' }, 405);
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get('Content-Type') || '')) return respond({ error: 'JSON is required', code: '22023' }, 415);
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get('Authorization') || '')?.[1];
    if (!token) return respond({ error: 'Sign in to Company Knowledge', code: '42501' }, 401);
    try {
      const body = validateRequest(await readBoundedJson(req));
      const client = makeUserClient(token);
      const { data: auth, error: authError } = await client.auth.getUser(token);
      if (authError || !auth?.user?.id || auth.user.is_anonymous) return respond({ error: 'Sign in to Company Knowledge', code: '42501' }, 401);
      const { data, error } = await client.rpc('kairo_company_knowledge', { p_organization_id: body.organization_id, p_operation: body.operation, p_payload: body.payload });
      if (error) {
        const status = { '42501': 403, '40001': 409, 'P0002': 404, '22023': 400, '22P02': 400, '23505': 409 }[error.code] || 500;
        return respond({ code: status === 500 ? 'unavailable' : error.code, error: status === 500 ? 'Company Knowledge is unavailable' : error.message }, status);
      }
      if (!data || data.ok !== true || data.schema_version !== 1 || data.organization_id !== body.organization_id || data.actor_user_id !== auth.user.id) throw new Error('Invalid response');
      return respond(data);
    } catch (error) {
      if (error instanceof KnowledgeError) return respond({ error: error.message, code: error.code }, error.status);
      return respond({ error: 'Company Knowledge is unavailable', code: 'unavailable' }, 500);
    }
  };
}
