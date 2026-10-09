import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHandler, hashToken, randomToken} from '../candidate/edge/organization-invite/handler.mjs';

const origin = 'https://cerbtek-ai-command-center.webflow.io';
const org = '00000000-0000-4000-8000-000000000001';
const token = 'A'.repeat(43);
function setup({rpcData, rpcError = null, authError = null, throws = false} = {}) {
  const calls = [];
  const handler = createHandler({
    allowedOrigins: [origin], inviteOrigin: origin, tokenFactory: () => token,
    makeUserClient(jwt) {
      calls.push(['client', jwt]);
      return {
        auth: {async getUser(value) { calls.push(['getUser', value]); return {data: {user: authError ? null : {id: 'verified-user'}}, error: authError}; }},
        async rpc(name, args) { calls.push(['rpc', name, args]); if (throws) throw new Error('private runtime details'); return {data: rpcData, error: rpcError}; },
      };
    },
  });
  async function request(body = {op: 'create', organization_id: org, email: 'New@Team.Example', role: 'member'}, overrides = {}) {
    const req = new Request('https://backend.example/functions/v1/organization-invite', {
      method: overrides.method || 'POST', headers: {'Origin': origin, 'Authorization': 'Bearer user-jwt', ...overrides.headers},
      ...(overrides.method === 'OPTIONS' || overrides.method === 'GET' ? {} : {body: typeof body === 'string' ? body : JSON.stringify(body)}),
    });
    const response = await handler(req);
    return {response, body: response.status === 204 ? null : await response.json()};
  }
  return {calls, request};
}

test('create uses validated user JWT and passes only company/email/role/token hash to atomic RPC', async () => {
  const invite = {organization_id: org, id: 'synthetic-id', role: 'member', email: 'new@team.example', status: 'Pending'};
  const {request, calls} = setup({rpcData: invite});
  const result = await request({op: 'create', organization_id: org, email: ' New@Team.Example ', role: 'member', actor_user_id: 'forged-owner', origin: 'https://evil.example'});
  assert.equal(result.response.status, 200); assert.deepEqual(result.body.invite, invite);
  assert.equal(result.body.ok, true); assert.equal(result.body.invite_url, `${origin}/?invite=${token}`);
  assert.deepEqual(calls[0], ['client', 'user-jwt']); assert.deepEqual(calls[1], ['getUser', 'user-jwt']);
  assert.deepEqual(calls[2], ['rpc', 'kairo_create_invitation', {p_organization_id: org, p_email: 'new@team.example', p_role: 'member', p_token_hash: await hashToken(token)}]);
  assert.equal(result.response.headers.get('Cache-Control'), 'no-store');
});

test('accept hashes token and returns canonical persisted company role, never a caller-supplied role/actor', async () => {
  const canonical = {organization_id: org, user_id: 'verified-user', role: 'owner', existing_member: true};
  const {request, calls} = setup({rpcData: canonical});
  const result = await request({op: 'accept', token, role: 'platform_admin', user_id: 'forged-target'});
  assert.equal(result.response.status, 200); assert.deepEqual(result.body, {ok: true, ...canonical});
  assert.deepEqual(calls[2], ['rpc', 'kairo_accept_invitation', {p_token_hash: await hashToken(token)}]);
});

test('invalid session cannot reach any invitation mutation', async () => {
  const {request, calls} = setup({authError: {message: 'expired'}});
  assert.equal((await request()).response.status, 401);
  assert.equal(calls.some(call => call[0] === 'rpc'), false);
  const absent = setup(); assert.equal((await absent.request(undefined, {headers: {Authorization: ''}})).response.status, 401);
  assert.equal(absent.calls.length, 0);
});

test('role escalation, malformed organization/token/body and unsupported operations fail before RPC', async () => {
  for (const body of [
    {op: 'create', organization_id: org, email: 'x@team.example', role: 'owner'},
    {op: 'create', organization_id: org, email: 'x@team.example', role: 'platform_admin'},
    {op: 'create', organization_id: 'bad', email: 'x@team.example', role: 'member'},
    {op: 'accept', token: 'short'}, {op: 'remove'}, null, [], '{bad json',
  ]) {
    const {request, calls} = setup(); assert.equal((await request(body)).response.status, 400);
    assert.equal(calls.some(call => call[0] === 'rpc'), false);
  }
  assert.equal((await setup().request('x'.repeat(17_000))).response.status, 413);
});

test('SQL denial/conflict is not converted to success; private errors remain sanitized', async () => {
  for (const [code, status] of [['42501',403], ['40001',409], ['P0002',404], ['22023',400], ['23514',409]]) {
    const {request} = setup({rpcError: {code, message: 'Safe action error'}});
    const result = await request(); assert.equal(result.response.status, status); assert.equal(result.body.error, 'Safe action error'); assert.equal(result.body.ok, undefined);
  }
  for (const config of [{rpcError: {code: 'XX000', message: 'secret diagnostic'}}, {throws: true}, {rpcData: null}]) {
    const result = await setup(config).request(); assert.equal(result.response.status, 500);
    assert.equal(JSON.stringify(result.body).includes('secret'), false); assert.equal(JSON.stringify(result.body).includes('private'), false);
  }
});

test('origin is exact matched, methods are bounded and preflight does not create a client', async () => {
  const {request, calls} = setup();
  assert.equal((await request(undefined, {headers: {Origin: 'https://cerbtek-ai-command-center.webflow.io.evil.example'}})).response.status, 403);
  assert.equal((await request(undefined, {method: 'GET'})).response.status, 405);
  const preflight = await request(undefined, {method: 'OPTIONS'});
  assert.equal(preflight.response.status, 204); assert.equal(preflight.response.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(calls.length, 0);
});

test('tokens contain 256 random bits; entrypoint pins SDK and never creates service-role credentials', async () => {
  const tokens = new Set(Array.from({length: 50}, randomToken));
  assert.equal(tokens.size, 50); for (const value of tokens) assert.match(value, /^[A-Za-z0-9_-]{43}$/);
  const source = await fs.readFile(new URL('../candidate/edge/organization-invite/index.ts', import.meta.url), 'utf8');
  assert.ok(source.includes('@supabase/supabase-js@2.58.0'));
  assert.ok(source.includes('SUPABASE_ANON_KEY')); assert.ok(!source.includes('SUPABASE_SERVICE_ROLE_KEY'));
  assert.ok(source.includes('Authorization: `Bearer ${jwt}`'));
});
