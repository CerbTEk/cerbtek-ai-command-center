// Offline synthetic Postgres test; no Supabase endpoint or credentials used.
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')
const db = new PGlite()
const ids = { admin:'00000000-0000-4000-8000-000000000001', tenant:'00000000-0000-4000-8000-000000000002', sales:'00000000-0000-4000-8000-000000000003', inactive:'00000000-0000-4000-8000-000000000004', otherTenant:'00000000-0000-4000-8000-000000000005' }
await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth; CREATE SCHEMA private;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE TABLE public.staff_accounts(user_id uuid PRIMARY KEY, role text NOT NULL, active boolean NOT NULL);
CREATE FUNCTION private.is_cerbtek_staff(allowed_roles text[]) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT EXISTS (SELECT 1 FROM public.staff_accounts WHERE user_id=auth.uid() AND active AND role=ANY(allowed_roles)) $$;
REVOKE ALL ON FUNCTION private.is_cerbtek_staff(text[]) FROM PUBLIC; GRANT USAGE ON SCHEMA auth,private TO authenticated; GRANT EXECUTE ON FUNCTION private.is_cerbtek_staff(text[]) TO authenticated;
INSERT INTO auth.users(id) VALUES ${Object.values(ids).map(id=>`('${id}')`).join(',')};
INSERT INTO staff_accounts VALUES ('${ids.admin}','platform_admin',true),('${ids.sales}','sales',true),('${ids.inactive}','platform_admin',false);`)
await db.exec(await readFile(new URL('../docs/funding-schema-draft.sql',import.meta.url),'utf8'))
let count=0
async function test(name, fn) { await db.exec('BEGIN'); try { await fn(); count++;console.log(`PASS ${name}`) } finally { await db.exec('ROLLBACK') } }
async function actor(id,role='authenticated') { await db.exec(`SET LOCAL ROLE ${role}; SELECT set_config('request.jwt.claim.sub','${id||''}',true)`) }
async function deny(sql) { await db.exec('SAVEPOINT denied');let caught;try{await db.exec(sql)}catch(e){caught=e}await db.exec('ROLLBACK TO SAVEPOINT denied; RELEASE SAVEPOINT denied');assert.ok(caught,`Expected deny: ${sql}`) }
const insert=`INSERT INTO public.cerbtek_funding_opportunities(venture,opportunity,provider,category,official_url) VALUES ('CerbTek AI Enablement','Synthetic opportunity','Example provider','Grant','https://example.test/program') RETURNING *`
await db.exec(`SELECT set_config('request.jwt.claim.sub','${ids.admin}',false)`)
const record=(await db.query(insert)).rows[0]
await test('anon has no select, insert, update or delete access',async()=>{await actor(null,'anon');for(const sql of [`SELECT * FROM cerbtek_funding_opportunities`,insert,`UPDATE cerbtek_funding_opportunities SET notes='x'`,`DELETE FROM cerbtek_funding_opportunities`])await deny(sql)})
for(const role of ['tenant','otherTenant','sales','inactive']) await test(`${role} cannot read or mutate private company rows`,async()=>{await actor(ids[role]);assert.equal((await db.query('SELECT * FROM cerbtek_funding_opportunities')).rows.length,0);await deny(insert);assert.equal((await db.query(`UPDATE cerbtek_funding_opportunities SET notes='x' RETURNING id`)).rows.length,0);await deny('DELETE FROM cerbtek_funding_opportunities')})
await test('active platform admin can read, insert, edit and close',async()=>{await actor(ids.admin);assert.equal((await db.query('SELECT * FROM cerbtek_funding_opportunities')).rows.length,1);const r=(await db.query(insert)).rows[0];assert.equal(r.created_by,ids.admin);assert.equal(r.version,1);const updated=(await db.query(`UPDATE cerbtek_funding_opportunities SET status='Closed',notes='private' WHERE id='${r.id}' AND version=1 RETURNING *`)).rows[0];assert.equal(updated.status,'Closed');assert.equal(updated.version,2);assert.equal(updated.updated_by,ids.admin)})
await test('stale edit returns zero rows and cannot overwrite newer version',async()=>{await actor(ids.admin);await db.exec(`UPDATE cerbtek_funding_opportunities SET notes='newer' WHERE id='${record.id}' AND version=1`);assert.equal((await db.query(`UPDATE cerbtek_funding_opportunities SET notes='stale' WHERE id='${record.id}' AND version=1 RETURNING id`)).rows.length,0);assert.equal((await db.query(`SELECT notes FROM cerbtek_funding_opportunities`)).rows[0].notes,'newer')})
await test('admin cannot forge timestamps, actors, versions or delete',async()=>{await actor(ids.admin);for(const field of [`version=99`,`created_by='${ids.tenant}'`,`updated_by='${ids.tenant}'`,`updated_at=now()`,`id=gen_random_uuid()`])await deny(`UPDATE cerbtek_funding_opportunities SET ${field}`);await deny('DELETE FROM cerbtek_funding_opportunities')})
await test('source, status and date constraints reject misleading data',async()=>{await actor(ids.admin);for(const field of [`official_url='javascript:alert(1)'`,`official_url='https://user:pass@example.test/'`,`status='Funded for sure'`,`last_verified=CURRENT_DATE+1`,`deadline_state='Fixed'`,`notes=repeat('x',8001)`])await deny(`UPDATE cerbtek_funding_opportunities SET ${field}`)})
await test('staff revocation immediately removes access',async()=>{await db.exec(`UPDATE staff_accounts SET active=false WHERE user_id='${ids.admin}'`);await actor(ids.admin);assert.equal((await db.query('SELECT * FROM cerbtek_funding_opportunities')).rows.length,0);await deny(insert)})
console.log(`${count} offline RLS tests passed`)
await db.close()
