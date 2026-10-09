import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { database,binding,event,org,other,run,otherRun,now } from './fixtures/billing-fixtures.mjs';
import {collectUsage,normalizeStripeEvent} from '../candidate/edge/billing/core.mjs';
import {createBillingStatusHandler} from '../candidate/edge/billing-status/handler.mjs';
const owner='30000000-0000-4000-8000-000000000001', admin='30000000-0000-4000-8000-000000000002', member='30000000-0000-4000-8000-000000000003', outsider='30000000-0000-4000-8000-000000000004';
const contract=await fs.readFile(new URL('../candidate/sql/billing-status-contract.sql',import.meta.url),'utf8');
async function setup(){const {db,store}=await database();await db.exec(`CREATE SCHEMA auth;CREATE SCHEMA private;
CREATE TABLE auth.users(id uuid PRIMARY KEY,is_anonymous boolean NOT NULL DEFAULT false);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE TABLE public.organization_members(organization_id uuid,user_id uuid,role text,PRIMARY KEY(organization_id,user_id));
CREATE TABLE public.staff_accounts(user_id uuid,role text,active boolean);
GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;`);
await db.query('INSERT INTO auth.users(id) VALUES($1),($2),($3),($4)',[owner,admin,member,outsider]);await db.query("INSERT INTO organization_members VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'member'),($5,$6,'owner')",[org,owner,admin,member,other,outsider]);await db.query("INSERT INTO staff_accounts VALUES($1,'platform_admin',true)",[outsider]);await db.exec(contract);return {db,store}}
async function as(db,id=owner,role='authenticated'){await db.exec('RESET ROLE');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[id||'']);await db.exec(`SET ROLE ${role}`)}
async function status(db,id=org){return(await db.query('SELECT public.kairo_billing_status($1) AS result',[id])).rows[0].result}
async function seeded(fn){const x=await setup();try{return await fn(x)}finally{await x.db.close()}}
const denied=fn=>assert.rejects(fn,e=>e.code==='42501');
test('status is fresh owner/admin-only, with no staff or foreign-company bypass',()=>seeded(async({db})=>{
for(const id of [owner,admin]){await as(db,id);const s=await status(db);assert.equal(s.actor_id,id);assert.equal(s.authorized,true);assert.equal(s.commercial_actions_enabled,false);assert.equal(s.credential_state,'not_verified');assert.equal(s.provider.account_id,binding.account_id);assert.equal(s.integration_state,'bound_inactive');assert.equal(s.customer_charge,null);assert.equal(JSON.stringify(s).includes('cus_SYNTHETIC'),false)}
for(const id of [member,outsider,null]){await as(db,id);await denied(()=>status(db))}
await as(db,owner);await denied(()=>status(db,other));await as(db,outsider);const s=await status(db,other);assert.equal(s.provider,null);assert.equal(s.customer_bound,false);assert.equal(s.integration_state,'not_configured');
}));
test('revoked, demoted, deleted and anonymous actors are denied despite a valid old subject',()=>seeded(async({db})=>{
await as(db,admin);await status(db);await db.exec('RESET ROLE');await db.query("UPDATE organization_members SET role='viewer' WHERE user_id=$1",[admin]);await as(db,admin);await denied(()=>status(db));
await db.exec('RESET ROLE');await db.query('DELETE FROM organization_members WHERE user_id=$1',[owner]);await as(db,owner);await denied(()=>status(db));
await db.exec('RESET ROLE');await db.query('UPDATE auth.users SET is_anonymous=true WHERE id=$1',[outsider]);await as(db,outsider);await denied(()=>status(db,other));
await db.exec('RESET ROLE');await db.query('DELETE FROM auth.users WHERE id=$1',[admin]);await as(db,admin);await denied(()=>status(db));
}));
test('no direct ledger access or service/anonymous RPC execution is added',()=>seeded(async({db})=>{
for(const role of ['anon','authenticated','service_role']){await as(db,owner,role);for(const query of ['SELECT * FROM kairo_billing.usage_events','DELETE FROM kairo_billing.provider_receipts','TRUNCATE kairo_billing.policy_versions'])await denied(()=>db.query(query));if(role!=='authenticated')await denied(()=>status(db))}
}));
test('status usage deduplicates unknown-to-measured facts, remains lifetime/unpriced, and isolates tenants',()=>seeded(async({db,store})=>{
await collectUsage({store,organization_id:org,source_kind:'ai_draft_run',source_id:run});await collectUsage({store,organization_id:other,source_kind:'ai_draft_run',source_id:otherRun});
await as(db,owner);let s=await status(db);assert.equal(s.usage_scope,'lifetime_observations_only');assert.deepEqual(s.usage,[{metric:'ai_input_tokens',unit:'token',measured_units:'10',unresolved_sources:0},{metric:'ai_output_tokens',unit:'token',measured_units:'20',unresolved_sources:0}]);assert.equal(s.provider_spend,null);
await as(db,outsider);s=await status(db,other);assert.equal(s.usage[0].unresolved_sources,1);assert.equal(s.usage[0].measured_units,'0');
await db.exec('RESET ROLE');await db.query('UPDATE ai_draft_runs SET usage=$2 WHERE id=$1',[otherRun,JSON.stringify({input_tokens:7,output_tokens:8})]);await collectUsage({store,organization_id:other,source_kind:'ai_draft_run',source_id:otherRun});await as(db,outsider);s=await status(db,other);assert.equal(s.usage[0].measured_units,'7');assert.equal(s.usage[0].unresolved_sources,0);
}));
test('status counts only scoped subscriptions and unresolved receipts and never returns payloads',()=>seeded(async({db,store})=>{
await store.recordReceipt(normalizeStripeEvent(event(),binding,'a'.repeat(64),now));
for(const [id,customer] of [['evt_GLOBAL',undefined],['evt_OWN','cus_SYNTHETIC'],['evt_FOREIGN','cus_OTHER']])await store.recordReceipt(normalizeStripeEvent(event({id,type:'refund.created',data:{object:{id:`re_${id}`,object:'refund',customer}}}),binding,'b'.repeat(64),now));
await as(db,owner);const s=await status(db);assert.equal(s.subscription_count,1);assert.equal(s.unresolved_receipts,1);assert.equal(JSON.stringify(s).includes('evt_'),false);assert.equal(JSON.stringify(s).includes('sub_'),false);
}));
test('multiple explicitly bound providers never silently choose an account',()=>seeded(async({db})=>{
await db.query("INSERT INTO kairo_billing.provider_bindings VALUES('second','acct_SECOND',false,'platform','2026-09-30.endive',now())");await db.query("INSERT INTO kairo_billing.customer_bindings(binding_id,customer_id,organization_id) VALUES('second','cus_SECOND',$1)",[org]);await as(db);const s=await status(db);assert.equal(s.binding_count,2);assert.equal(s.provider,null);assert.equal(s.commercial_actions_enabled,false);
}));
const good={contract:'billing_status_v1',authorized:true,organization_id:org,actor_id:owner,actor_role:'owner',commercial_actions_enabled:false};
function host({data=good,error=null,user={id:owner},authError=null,throws=false}={}){const calls=[];return {calls,handle:createBillingStatusHandler({allowedOrigins:['https://www.cerbtek.com'],makeUserClient:token=>{calls.push(['token',token]);if(throws)throw new Error('secret database address');return {auth:{getUser:async token=>{calls.push(['auth',token]);return {data:{user},error:authError}}},rpc:async(name,args)=>{calls.push(['rpc',name,args]);return {data,error}}}}})}}
function req({body={organization_id:org},method='POST',headers={}}={}){return new Request('https://synthetic.test/billing-status',{method,headers:{authorization:'Bearer synthetic-session','content-type':'application/json',origin:'https://www.cerbtek.com',...headers},...(method==='POST'?{body:typeof body==='string'?body:JSON.stringify(body)}:{})})}
test('Edge forwards verified user JWT to narrow RPC and validates account/company identity',async()=>{
const {handle,calls}=host();const r=await handle(req());assert.equal(r.status,200);assert.deepEqual(await r.json(),good);assert.deepEqual(calls.at(-1),['rpc','kairo_billing_status',{p_organization_id:org}]);assert.equal(r.headers.get('cache-control'),'no-store');
for(const data of [{...good,actor_id:outsider},{...good,organization_id:other},{...good,actor_role:'member'},{...good,commercial_actions_enabled:true},{...good,contract:'old'}])assert.equal((await host({data}).handle(req())).status,503);
});
test('Edge denies bad origins/methods/auth and never trusts browser actor fields',async()=>{
for(const [input,code] of [[{headers:{origin:'https://evil.test'}},403],[{method:'GET'},405],[{headers:{authorization:''}},401],[{headers:{'content-type':'text/plain'}},415],[{body:{organization_id:org,actor_id:owner}},400],[{body:{organization_id:'bad'}},400],[{body:{organization_id:[org]}},400],[{body:'no-json'},400],[{body:'x'.repeat(1025)},413]]){const h=host();assert.equal((await h.handle(req(input))).status,code);assert.equal(h.calls.length,0)}
for(const opts of [{user:null},{user:{id:owner,is_anonymous:true}},{authError:new Error('private')}]){const h=host(opts);assert.equal((await h.handle(req())).status,401);assert.equal(h.calls.some(x=>x[0]==='rpc'),false)}
assert.equal((await host().handle(req({method:'OPTIONS'}))).status,204);
});
test('Edge sanitizes RPC/transport exceptions without database or credential details',async()=>{
for(const [opts,code] of [[{error:{code:'42501',message:'secret'}},403],[{error:{code:'XX000',message:'secret'}},503],[{throws:true},503]]){const r=await host(opts).handle(req());assert.equal(r.status,code);assert.equal((await r.text()).includes('secret'),false)}
});

test('Edge canonicalizes uppercase UUIDs before the scoped RPC',async()=>{const lower='a0000000-0000-4000-8000-000000000001';const h=host({data:{...good,organization_id:lower}});const r=await h.handle(req({body:{organization_id:lower.toUpperCase()}}));assert.equal(r.status,200);assert.equal(h.calls.at(-1)[2].p_organization_id,lower)});
