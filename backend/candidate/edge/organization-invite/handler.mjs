const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVITE_ROLES = new Set(['admin', 'consultant', 'member', 'viewer']);

export async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// No service-role client, table writes, client actor ID, or caller-provided invite
// origin. SQL rechecks auth.uid(), fresh membership, and recipient email atomically.
export function createHandler({makeUserClient, allowedOrigins, inviteOrigin, tokenFactory = randomToken}) {
  if (!allowedOrigins.includes(inviteOrigin)) throw new Error('Invitation origin must be explicitly allowed');
  return async function handle(req) {
    const origin = req.headers.get('Origin');
    const headers = {
      'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Vary': 'Origin',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      ...(origin && allowedOrigins.includes(origin) ? {'Access-Control-Allow-Origin': origin} : {}),
    };
    const respond = (body, status = 200) => new Response(JSON.stringify(body), {status, headers});
    if (origin && !allowedOrigins.includes(origin)) return respond({error: 'Origin not allowed'}, 403);
    if (req.method === 'OPTIONS') return new Response(null, {status: 204, headers});
    if (req.method !== 'POST') return respond({error: 'Method not allowed'}, 405);
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.get('Authorization') || '');
    if (!match) return respond({error: 'Missing authorization'}, 401);
    try {
      const text = await req.text();
      if (text.length > 16_384) return respond({error: 'Request too large'}, 413);
      let body;
      try { body = JSON.parse(text); } catch { return respond({error: 'Invalid JSON'}, 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || !['create', 'accept'].includes(body.op)) {
        return respond({error: 'Invalid operation'}, 400);
      }
      const client = makeUserClient(match[1]);
      const {data, error: authError} = await client.auth.getUser(match[1]);
      if (authError || !data?.user?.id) return respond({error: 'Invalid session'}, 401);
      let result;
      let rawToken;
      if (body.op === 'create') {
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        const role = body.role ?? 'member';
        if (!UUID.test(body.organization_id || '') || !email || email.length > 254 || !INVITE_ROLES.has(role)) {
          return respond({error: 'Invalid invite request'}, 400);
        }
        rawToken = tokenFactory();
        result = await client.rpc('kairo_create_invitation', {
          p_organization_id: body.organization_id, p_email: email,
          p_role: role, p_token_hash: await hashToken(rawToken),
        });
      } else {
        if (typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.token)) {
          return respond({error: 'Invalid invitation token'}, 400);
        }
        result = await client.rpc('kairo_accept_invitation', {p_token_hash: await hashToken(body.token)});
      }
      if (result.error) {
        const error = result.error;
        const status = {'42501': 403, '40001': 409, 'P0002': 404, '22023': 400, '23505': 409, '23514': 409}[error.code] || 500;
        return respond({error: status === 500 ? 'Team request could not be completed' : error.message}, status);
      }
      if (!result.data) return respond({error: 'Team request could not be completed'}, 500);
      if (body.op === 'create') return respond({
        ok: true, invite: result.data,
        invite_url: `${inviteOrigin}/?invite=${encodeURIComponent(rawToken)}`,
      });
      return respond({ok: true, ...result.data});
    } catch {
      return respond({error: 'Team request could not be completed'}, 500);
    }
  };
}
