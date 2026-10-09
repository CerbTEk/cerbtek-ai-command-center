import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const fixture = await fs.readFile(new URL('./fixtures/team-roles-base.sql', import.meta.url), 'utf8');
const contract = await fs.readFile(new URL('../candidate/sql/team-roles-contract.sql', import.meta.url), 'utf8');
const org = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const ids = Object.fromEntries(['owner', 'coowner', 'admin', 'consultant', 'member', 'viewer', 'staff', 'outsider', 'newcomer', 'unverified', 'otherowner'].map((key, i) => [key, `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`]));
const hash = i => i.toString(16).padStart(64, '0');
async function database() {
  const db = new PGlite();
  await db.exec(fixture);
  for (const [name, id] of Object.entries(ids)) await db.query('INSERT INTO auth.users VALUES($1,$2,$3)', [id, `${name}@team.example`, name === 'unverified' ? null : new Date()]);
  await db.query('INSERT INTO organizations VALUES($1,$2,$3),($4,$5,$6)', [org, 'Synthetic One', ids.owner, other, 'Synthetic Two', ids.otherowner]);
  for (const role of ['coowner', 'admin', 'consultant', 'member', 'viewer']) await db.query('INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,$3)', [org, ids[role], role === 'coowner' ? 'owner' : role]);
  await db.query("INSERT INTO staff_accounts VALUES($1,'platform_admin',true)", [ids.staff]);
  await db.exec(contract);
  await as(db, 'owner');
  return db;
}
async function as(db, actor, role = 'authenticated') {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [actor ? ids[actor] : '']);
  await db.exec(`SET ROLE ${role}`);
}
async function rpc(db, name, args) {
  return (await db.query(`SELECT public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) AS result`, args)).rows[0].result;
}
const set = (db, target, next, expected, company = org) => rpc(db, 'kairo_set_member_role', [company, ids[target], next, expected]);
const remove = (db, target, expected, company = org) => rpc(db, 'kairo_remove_member', [company, ids[target], expected]);
const invite = (db, target, role = 'member', n = 1, company = org) => rpc(db, 'kairo_create_invitation', [company, `${target}@team.example`, role, hash(n)]);
const accept = (db, n = 1) => rpc(db, 'kairo_accept_invitation', [hash(n)]);
async function adminQuery(db, sql, args = []) { await db.exec('RESET ROLE'); return (await db.query(sql, args)).rows; }
const rejectsCode = (fn, code, pattern) => assert.rejects(fn, err => err.code === code && (!pattern || pattern.test(err.message)));

// PGlite is single-session. These are transaction/ACL/behavior tests, not a claim
// of multi-connection concurrency coverage. Lock ordering is checked separately.
test('owner assigns all company roles; changes return verified identity and audit in the same transaction', async () => {
  const db = await database();
  try {
    let previous = 'member';
    for (const role of ['viewer', 'consultant', 'admin', 'owner', 'member']) {
      const result = await set(db, 'member', role, previous);
      assert.equal(result.ok, true); assert.equal(result.user_id, ids.member); assert.equal(result.role, role); previous = role;
    }
    const rows = await adminQuery(db, 'SELECT * FROM audit_events ORDER BY created_at');
    assert.equal(rows.length, 5);
    for (const event of rows) { assert.equal(event.actor_user_id, ids.owner); assert.equal(event.organization_id, org); assert.equal(event.entity_id, ids.member); }
  } finally { await db.close(); }
});

test('fresh actor authorization rejects consultant/member/viewer, global staff and out-of-company actors', async () => {
  const db = await database();
  try {
    for (const actor of ['consultant', 'member', 'viewer', 'staff', 'outsider', 'otherowner']) {
      await as(db, actor); await rejectsCode(() => set(db, 'member', 'viewer', 'member'), '42501');
      await rejectsCode(() => remove(db, 'member', 'member'), '42501');
      await rejectsCode(() => invite(db, 'newcomer'), '42501');
    }
    await as(db, 'owner'); await rejectsCode(() => set(db, 'otherowner', 'member', 'owner', other), '42501');
    await rejectsCode(() => set(db, 'otherowner', 'member', 'owner'), 'P0002');
    await as(db, 'consultant'); assert.equal((await db.query('SELECT private.can_manage_org($1) AS allowed', [org])).rows[0].allowed, true);
  } finally { await db.close(); }
});

test('admin only manages lower member/viewer targets and can never grant owner/admin/consultant/platform_admin', async () => {
  const db = await database();
  try {
    await as(db, 'admin'); assert.equal((await set(db, 'member', 'viewer', 'member')).role, 'viewer');
    for (const role of ['owner', 'admin', 'consultant']) await rejectsCode(() => set(db, 'viewer', role, 'viewer'), '42501');
    for (const target of ['owner', 'coowner', 'consultant']) {
      await rejectsCode(() => set(db, target, 'member', target === 'consultant' ? 'consultant' : 'owner'), '42501');
      await rejectsCode(() => remove(db, target, target === 'consultant' ? 'consultant' : 'owner'), '42501');
    }
    for (const role of ['platform_admin', 'employee', 'supervisor', null]) await rejectsCode(() => set(db, 'viewer', role, 'viewer'), '22023');
    assert.equal((await remove(db, 'member', 'viewer')).removed, true);
  } finally { await db.close(); }
});

test('self role changes/removal are denied for owners and admins', async () => {
  const db = await database();
  try { for (const actor of ['owner', 'admin']) {
    await as(db, actor); await rejectsCode(() => set(db, actor, 'member', actor), '42501');
    await rejectsCode(() => remove(db, actor, actor), '42501');
  }} finally { await db.close(); }
});

test('expected role conflicts and null expectations cannot overwrite a newer decision; no-op is not audited', async () => {
  const db = await database();
  try {
    assert.equal((await set(db, 'member', 'member', 'member')).changed, false);
    await set(db, 'member', 'viewer', 'member');
    await rejectsCode(() => set(db, 'member', 'consultant', 'member'), '40001');
    await rejectsCode(() => remove(db, 'member', 'member'), '40001');
    await rejectsCode(() => set(db, 'member', 'member', null), '22023');
    await rejectsCode(() => remove(db, 'member', null), '40001');
    assert.equal((await adminQuery(db, 'SELECT count(*)::int AS n FROM audit_events'))[0].n, 1);
  } finally { await db.close(); }
});

test('revoked actor loses access immediately despite previously authorized session', async () => {
  const db = await database();
  try {
    await set(db, 'admin', 'viewer', 'admin');
    await as(db, 'admin'); await rejectsCode(() => set(db, 'member', 'viewer', 'member'), '42501');
    await as(db, 'owner'); await remove(db, 'admin', 'viewer');
    await as(db, 'admin'); await rejectsCode(() => invite(db, 'newcomer'), '42501');
  } finally { await db.close(); }
});

test('direct browser/service mutations and anonymous RPCs are closed; restored write grants still hit trigger protection', async () => {
  const db = await database();
  try {
    for (const role of ['authenticated', 'service_role', 'anon']) {
      await as(db, 'owner', role);
      for (const sql of ["UPDATE organization_members SET role='viewer'", 'DELETE FROM organization_members', 'TRUNCATE organization_members', 'TRUNCATE organization_invitations', "UPDATE organization_invitations SET status='Revoked'"]) {
        await rejectsCode(() => db.query(sql), '42501');
      }
      if (role !== 'authenticated') await rejectsCode(() => set(db, 'member', 'viewer', 'member'), '42501');
    }
    await as(db, null); await rejectsCode(() => set(db, 'member', 'viewer', 'member'), '42501');
    await db.exec('RESET ROLE; GRANT INSERT,UPDATE,DELETE ON organization_members,organization_invitations TO service_role');
    await as(db, 'owner', 'service_role');
    await rejectsCode(() => db.query("UPDATE organization_members SET role='viewer' WHERE user_id=$1", [ids.owner]), '42501', /RPC/);
    await rejectsCode(() => db.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'viewer') ON CONFLICT(organization_id,user_id) DO UPDATE SET role=excluded.role", [org, ids.owner]), '42501');
    await rejectsCode(() => db.query("INSERT INTO organization_invitations(organization_id,email,role,token_hash,invited_by) VALUES($1,'newcomer@team.example','admin',$2,$3)", [org, hash(88), ids.owner]), '42501');
  } finally { await db.close(); }
});

test('last-owner invariant also covers privileged direct updates, multi-row deletes and auth-user cascades', async () => {
  const db = await database();
  try {
    await set(db, 'coowner', 'admin', 'owner');
    await db.exec('RESET ROLE');
    await rejectsCode(() => db.query("UPDATE organization_members SET role='member' WHERE organization_id=$1 AND user_id=$2", [org, ids.owner]), '23514');
    await rejectsCode(() => db.query('DELETE FROM organization_members WHERE organization_id=$1', [org]), '23514');
    await db.query("UPDATE organization_members SET role='owner' WHERE organization_id=$1 AND user_id=$2", [org, ids.coowner]);
    await db.query("UPDATE organization_members SET role='member' WHERE organization_id=$1 AND user_id=$2", [org, ids.owner]);
    await rejectsCode(() => db.query('DELETE FROM auth.users WHERE id=$1', [ids.coowner]), '23514');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM organization_members WHERE organization_id=$1 AND role='owner'", [org])).rows[0].n, 1);
  } finally { await db.close(); }
});

test('membership identity cannot move across companies; company bootstrap/cascade still work', async () => {
  const db = await database();
  try {
    await db.exec('RESET ROLE');
    await rejectsCode(() => db.query('UPDATE organization_members SET organization_id=$1 WHERE organization_id=$2 AND user_id=$3', [other, org, ids.member]), '22023');
    const fresh = '00000000-0000-4000-8000-000000000003';
    await db.query("INSERT INTO organizations VALUES($1,'Synthetic Three',$2)", [fresh, ids.outsider]);
    assert.equal((await db.query('SELECT role FROM organization_members WHERE organization_id=$1', [fresh])).rows[0].role, 'owner');
    await db.query('DELETE FROM organizations WHERE id=$1', [fresh]);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM organization_members WHERE organization_id=$1', [fresh])).rows[0].n, 0);
  } finally { await db.close(); }
});

test('invitation creation matches owner/admin role matrix; no self/existing-member role update via re-invite', async () => {
  const db = await database();
  try {
    await rejectsCode(() => invite(db, 'owner'), '22023');
    await rejectsCode(() => invite(db, 'member', 'admin'), '22023');
    for (const role of ['owner', 'platform_admin', 'employee', null]) await rejectsCode(() => invite(db, 'newcomer', role), '22023');
    for (const [i, role] of ['admin', 'consultant', 'member', 'viewer'].entries()) assert.equal((await invite(db, 'newcomer', role, 10 + i)).role, role);
    await as(db, 'admin');
    for (const role of ['admin', 'consultant']) await rejectsCode(() => invite(db, 'outsider', role, 20), '42501');
    assert.equal((await invite(db, 'outsider', 'member', 21)).role, 'member');
    assert.equal((await invite(db, 'outsider', 'viewer', 22)).role, 'viewer');
  } finally { await db.close(); }
});

test('admin cannot replace or revoke elevated invitation; revoke is company scoped and conflict checked', async () => {
  const db = await database();
  try {
    const elevated = await invite(db, 'newcomer', 'admin');
    await as(db, 'admin');
    await rejectsCode(() => invite(db, 'newcomer', 'member', 2), '42501');
    await rejectsCode(() => rpc(db, 'kairo_revoke_invitation', [org, elevated.id]), '42501');
    await as(db, 'owner');
    await rejectsCode(() => rpc(db, 'kairo_revoke_invitation', [other, elevated.id]), '42501');
    assert.equal((await rpc(db, 'kairo_revoke_invitation', [org, elevated.id])).ok, true);
    await rejectsCode(() => rpc(db, 'kairo_revoke_invitation', [org, elevated.id]), '40001');
    await as(db, 'newcomer'); await rejectsCode(() => accept(db), 'P0002');
  } finally { await db.close(); }
});

test('invitation acceptance atomically inserts membership, consumes token and audits; replay cannot mutate', async () => {
  const db = await database();
  try {
    await invite(db, 'newcomer', 'consultant');
    await as(db, 'newcomer'); const result = await accept(db);
    assert.equal(result.user_id, ids.newcomer); assert.equal(result.role, 'consultant'); assert.equal(result.existing_member, false);
    await rejectsCode(() => accept(db), 'P0002');
    const events = await adminQuery(db, "SELECT * FROM audit_events WHERE event_type='member_invitation_accepted'");
    assert.equal(events.length, 1); assert.equal(events[0].actor_user_id, ids.newcomer);
  } finally { await db.close(); }
});

test('acceptance uses fresh confirmed auth email, rejects wrong identity, expiry and unverified address', async () => {
  const db = await database();
  try {
    await invite(db, 'newcomer'); await as(db, 'outsider'); await rejectsCode(() => accept(db), '42501');
    await as(db, 'owner'); await invite(db, 'unverified', 'viewer', 2);
    await as(db, 'unverified'); await rejectsCode(() => accept(db, 2), '42501');
    await as(db, 'owner');
    // A synthetic legacy expired invitation is seeded with its original expiry.
    await db.exec('RESET ROLE');
    await db.query("INSERT INTO organization_invitations(organization_id,email,role,token_hash,invited_by,expires_at) VALUES($1,'outsider@team.example','member',$2,$3,now()-interval '1 minute')", [org, hash(3), ids.owner]);
    await as(db, 'outsider'); await rejectsCode(() => accept(db, 3), '22023', /expired/);
    await db.exec('RESET ROLE'); await db.query("UPDATE auth.users SET email='changed@team.example' WHERE id=$1", [ids.newcomer]);
    await as(db, 'newcomer'); await rejectsCode(() => accept(db), '42501');
  } finally { await db.close(); }
});

test('legacy invitation acceptance preserves every existing member role including owners', async () => {
  const db = await database();
  try {
    await db.exec('RESET ROLE');
    for (const [i, target] of ['owner', 'admin', 'member', 'viewer'].entries()) {
      await db.query("INSERT INTO organization_invitations(organization_id,email,role,token_hash,invited_by) VALUES($1,$2,'consultant',$3,$4)", [org, `${target}@team.example`, hash(i + 50), ids.coowner]);
      await as(db, target); const result = await accept(db, i + 50);
      assert.equal(result.role, target); assert.equal(result.existing_member, true);
      await db.exec('RESET ROLE');
    }
  } finally { await db.close(); }
});

test('inviter downgrade/removal invalidates pending authority; later promotion cannot resurrect it', async () => {
  const db = await database();
  try {
    await as(db, 'coowner'); await invite(db, 'newcomer', 'admin');
    await as(db, 'owner'); await set(db, 'coowner', 'admin', 'owner');
    await as(db, 'newcomer'); await rejectsCode(() => accept(db), 'P0002');
    await as(db, 'owner'); await set(db, 'coowner', 'owner', 'admin');
    await as(db, 'newcomer'); await rejectsCode(() => accept(db), 'P0002');
    await as(db, 'admin'); await invite(db, 'outsider', 'member', 2);
    await as(db, 'owner'); await remove(db, 'admin', 'admin');
    await as(db, 'outsider'); await rejectsCode(() => accept(db, 2), 'P0002');
    // Simulate legacy authority drift that did not pass the new RPC.
    await db.exec('RESET ROLE');
    await db.query("INSERT INTO organization_invitations(organization_id,email,role,token_hash,invited_by) VALUES($1,'outsider@team.example','member',$2,$3)", [org, hash(3), ids.consultant]);
    await as(db, 'outsider'); await rejectsCode(() => accept(db, 3), '42501');
  } finally { await db.close(); }
});

test('removing someone also revokes old invitations addressed to them', async () => {
  const db = await database();
  try {
    await db.exec('RESET ROLE');
    await db.query("INSERT INTO organization_invitations(organization_id,email,role,token_hash,invited_by) VALUES($1,'member@team.example','admin',$2,$3)", [org, hash(1), ids.owner]);
    await as(db, 'owner'); await remove(db, 'member', 'member');
    await as(db, 'member'); await rejectsCode(() => accept(db), 'P0002');
  } finally { await db.close(); }
});

test('audit failure rolls back membership changes, invite consumption and invite revocation', async () => {
  const db = await database();
  try {
    await as(db, 'admin'); await invite(db, 'newcomer');
    await db.exec("RESET ROLE; CREATE FUNCTION public.fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit unavailable'; END $$; CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_audit();");
    await as(db, 'owner'); await assert.rejects(() => set(db, 'admin', 'viewer', 'admin'), /synthetic audit/);
    let rows = await adminQuery(db, 'SELECT role FROM organization_members WHERE user_id=$1', [ids.admin]); assert.equal(rows[0].role, 'admin');
    await as(db, 'newcomer'); await assert.rejects(() => accept(db), /synthetic audit/);
    rows = await adminQuery(db, 'SELECT status FROM organization_invitations'); assert.equal(rows[0].status, 'Pending');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM organization_members WHERE user_id=$1', [ids.newcomer])).rows[0].n, 0);
    await as(db, 'owner'); await assert.rejects(() => remove(db, 'admin', 'admin'), /synthetic audit/);
  } finally { await db.close(); }
});

test('private implementations are hardened, public wrappers are invokers, actor IDs absent and contract idempotent', async () => {
  const db = await database();
  try {
    const before = await adminQuery(db, "SELECT pg_get_functiondef('private.can_manage_org(uuid)'::regprocedure) AS definition");
    await db.exec(contract);
    const after = await db.query("SELECT pg_get_functiondef('private.can_manage_org(uuid)'::regprocedure) AS definition");
    assert.deepEqual(after.rows, before);
    const functions = (await db.query("SELECT n.nspname,p.proname,p.prosecdef,p.proconfig,p.proargnames FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proname LIKE 'kairo_%'")).rows;
    for (const fn of functions) {
      assert.ok(fn.proconfig.includes('search_path=pg_catalog'));
      assert.ok(!fn.proargnames?.some(name => /actor/i.test(name)));
      if (fn.nspname === 'public') assert.equal(fn.prosecdef, false);
    }
    await as(db, 'owner'); await rejectsCode(() => db.query('SELECT private.kairo_team_manager($1)', [org]), '42501');
    await db.exec('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await rejectsCode(() => set(db, 'member', 'viewer', 'member'), '25001'); await db.exec('ROLLBACK');
    assert.equal((await set(db, 'member', 'viewer', 'member')).ok, true);
  } finally { await db.close(); }
});

test('all authority paths take the organization mutex before membership/invitation locks and use no spoofable bypass flag', () => {
  assert.match(contract, /FROM public\.organizations WHERE id=p_organization_id FOR UPDATE/);
  for (const name of ['kairo_set_member_role', 'kairo_remove_member', 'kairo_create_invitation', 'kairo_revoke_invitation']) {
    const body = contract.split(`FUNCTION private.${name}(`)[1].split('END $$;')[0];
    assert.ok(body.indexOf('private.kairo_team_manager') < body.indexOf('FROM public.organization_members') || !body.includes('FROM public.organization_members'));
    assert.ok(body.indexOf('private.kairo_team_manager') < body.indexOf('FROM public.organization_invitations') || !body.includes('FROM public.organization_invitations'));
  }
  const acceptBody = contract.split('FUNCTION private.kairo_accept_invitation(')[1].split('END $$;')[0];
  assert.ok(acceptBody.indexOf('private.kairo_lock_team_org') < acceptBody.indexOf('FOR UPDATE'));
  assert.ok(!contract.includes('set_config('));
  assert.ok(!/ON CONFLICT.*DO UPDATE/i.test(contract));
});

test('normal auth-admin user deletion preserves owner invariants and clears accepted_by without corrupting invitation history', async () => {
  const db = await database();
  try {
    await invite(db, 'newcomer'); await as(db, 'newcomer'); await accept(db);
    await db.exec('RESET ROLE; CREATE ROLE supabase_auth_admin; GRANT USAGE ON SCHEMA auth TO supabase_auth_admin; GRANT SELECT,DELETE ON auth.users TO supabase_auth_admin; ALTER TABLE auth.users OWNER TO supabase_auth_admin; SET ROLE supabase_auth_admin');
    await db.query('DELETE FROM auth.users WHERE id=$1', [ids.newcomer]);
    const invites = await adminQuery(db, 'SELECT status,accepted_by,accepted_at FROM organization_invitations');
    assert.equal(invites[0].status, 'Accepted'); assert.equal(invites[0].accepted_by, null); assert.ok(invites[0].accepted_at);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM organization_members WHERE user_id=$1', [ids.newcomer])).rows[0].n, 0);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM organization_members WHERE organization_id=$1 AND role='owner'", [org])).rows[0].n, 2);
  } finally { await db.close(); }
});

test('browser roles cannot truncate audit history while trusted service maintenance is preserved', async () => {
  const db = await database();
  try {
    await set(db, 'member', 'viewer', 'member');
    for (const role of ['authenticated', 'anon']) {
      await as(db, 'owner', role);
      await rejectsCode(() => db.query('TRUNCATE public.audit_events'), '42501');
    }
    const rows = await adminQuery(db, "SELECT count(*)::int AS n FROM audit_events"); assert.equal(rows[0].n, 1);
    assert.equal((await db.query("SELECT has_table_privilege('service_role','public.audit_events','TRUNCATE') AS allowed")).rows[0].allowed, true);
    assert.equal((await db.query("SELECT has_table_privilege('service_role','public.audit_events','INSERT') AS allowed")).rows[0].allowed, true);
  } finally { await db.close(); }
});

test('readiness is exact, company scoped, read-only and verifies fresh owner/admin authority', async () => {
  const db = await database();
  try {
    for (const actor of ['owner', 'admin']) {
      await as(db, actor);
      assert.deepEqual(await rpc(db, 'kairo_team_access_status', [org]), {ok: true, version: 1, organization_id: org, actor_role: actor});
    }
    for (const actor of ['consultant', 'member', 'viewer', 'staff', 'outsider', 'otherowner']) {
      await as(db, actor); await rejectsCode(() => rpc(db, 'kairo_team_access_status', [org]), '42501');
    }
    for (const role of ['anon', 'service_role']) {
      await as(db, 'owner', role); await rejectsCode(() => rpc(db, 'kairo_team_access_status', [org]), '42501');
    }
    await as(db, 'owner'); await rejectsCode(() => rpc(db, 'kairo_team_access_status', [other]), '42501');
    assert.equal((await adminQuery(db, 'SELECT count(*)::int AS n FROM audit_events'))[0].n, 0);
  } finally { await db.close(); }
});

test('authenticated company creation under INSERT-only organization RLS still bootstraps its first owner', async () => {
  const db = await database();
  try {
    await db.exec("RESET ROLE; ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY; GRANT INSERT ON public.organizations TO authenticated; CREATE POLICY own_company_insert ON public.organizations FOR INSERT TO authenticated WITH CHECK(created_by=auth.uid());");
    const fresh = '00000000-0000-4000-8000-000000000003';
    await as(db, 'outsider'); await db.query("INSERT INTO public.organizations VALUES($1,'Synthetic bootstrap',$2)", [fresh, ids.outsider]);
    const membership = await adminQuery(db, 'SELECT role,user_id FROM organization_members WHERE organization_id=$1', [fresh]);
    assert.deepEqual(membership, [{role: 'owner', user_id: ids.outsider}]);
  } finally { await db.close(); }
});
