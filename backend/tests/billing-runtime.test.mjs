import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createBillingRuntime,KAIRO_SANDBOX_ACCOUNT} from '../candidate/edge/billing/runtime.mjs';
import {stripeFixture} from './fixtures/billing-provider-fixtures.mjs';
import {binding as originalBinding,event,signed,now,org,other,run,policy} from './fixtures/billing-fixtures.mjs';
import {BillingStore} from '../candidate/edge/billing/store.mjs';
const binding={...originalBinding,id:'kairo-sandbox',account_id:KAIRO_SANDBOX_ACCOUNT};
const poolStub={connect:async()=>{throw Error('must not connect')}};
const config={enabled:true,binding,pool:poolStub,stripeClient:{},signingSecret:'synthetic-signature-only',refreshAfterSeconds:300,clock:()=>now};
test('runtime stays inactive before touching injected dependencies, requests or clocks',async()=>{
const bomb=new Proxy({},{get(){throw Error('must not inspect')}});const r=createBillingRuntime({binding:bomb,pool:bomb,stripeClient:bomb,clock:()=>{throw Error('clock touched')}});
assert.equal((await r.webhook(bomb)).status,503);assert.equal((await r.reconcileOnce()).code,'billing_inactive');assert.equal((await r.collectStoredUsage(bomb)).code,'billing_inactive');assert.equal((await r.previewEntitlement(bomb)).execution_authorized,false);assert.deepEqual(r.diagnostics(),{data_pipeline_enabled:false,commercial_actions_enabled:false,live_mode_supported:false});
});
test('runtime refuses live/shared-test/wrong accounts and incomplete runtime setup without I/O',()=>{
for(const changed of [{binding:{...binding,livemode:true}},{binding:{...binding,account_id:'acct_1UOjVrKBTeWGfa1w'}},{binding:{...binding,account_kind:'connected'}},{binding:{...binding,api_version:'2020-01-01'}},{refreshAfterSeconds:null},{signingSecret:''},{pool:{}},{stripeClient:null},{maxJobs:0}])assert.throws(()=>createBillingRuntime({...config,...changed}),e=>e.code==='billing_runtime_configuration_invalid');
const r=createBillingRuntime(config);assert.equal(r.diagnostics().commercial_actions_enabled,false);assert.equal(r.diagnostics().credential_state,'not_verified');
});
async function scenario(fn,storedBinding=binding){const db=new PGlite();try{
await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
CREATE TABLE public.organizations(id uuid PRIMARY KEY);
CREATE TABLE public.ai_draft_runs(id uuid PRIMARY KEY,organization_id uuid,status text,usage jsonb,created_at timestamptz DEFAULT to_timestamp(1999990000));`);
for(const name of ['billing-foundation-contract.sql','billing-worker-contract.sql'])await db.exec(await fs.readFile(new URL('../candidate/sql/'+name,import.meta.url),'utf8'));
await db.query('INSERT INTO organizations VALUES($1),($2)',[org,other]);await db.query('INSERT INTO kairo_billing.provider_bindings(id,account_id,livemode,account_kind,api_version) VALUES($1,$2,false,$3,$4)',[storedBinding.id,storedBinding.account_id,storedBinding.account_kind,storedBinding.api_version]);await db.query('INSERT INTO kairo_billing.customer_bindings(binding_id,customer_id,organization_id) VALUES($1,$2,$3)',[binding.id,'cus_SYNTHETIC',org]);await db.query("INSERT INTO ai_draft_runs(id,organization_id,status,usage) VALUES($1,$2,'awaiting_review',$3)",[run,org,JSON.stringify({input_tokens:10,output_tokens:20})]);
const sql=[];const pool={connect:async()=>({query:async(q,args)=>{sql.push(q);const result=await db.query(q,args);return {...result,command:q.startsWith('COMMIT')?'COMMIT':q.startsWith('ROLLBACK')?'ROLLBACK':q.startsWith('BEGIN')?'BEGIN':result.command}},release(){},on(){},removeListener(){}})};
const fixture=stripeFixture({modeBinding:binding,modify:d=>{d.account.id=KAIRO_SANDBOX_ACCOUNT}});
const e=event({api_version:binding.api_version});const s=signed(e);const runtime=createBillingRuntime({...config,pool,stripeClient:fixture.client,signingSecret:s.secret});
await fn({db,runtime,s,fixture,sql});
}finally{await db.close()}}
test('composed runtime signed intake, pinned database adapter, durable SDK reconciliation and policy preview work together',()=>scenario(async({db,runtime,s,fixture,sql})=>{
const request=()=>new Request('https://synthetic.test/stripe',{method:'POST',headers:{'content-type':'application/json','stripe-signature':s.signature},body:s.raw});
assert.equal((await runtime.webhook(request())).status,200);const report=await runtime.reconcileOnce();assert.equal(report.completed,1);assert.equal((await runtime.webhook(request())).status,200);assert.equal((await runtime.reconcileOnce()).claimed,0);
await new BillingStore(db).recordPolicy(policy({binding_id:binding.id}));const preview=await runtime.previewEntitlement({organization_id:org,subscription_id:'sub_SYNTHETIC',policy_id:'synthetic-policy',policy_version:1,feature:'ai_draft'});assert.equal(preview.execution_authorized,false);assert.equal(preview.evaluation.allowed,true);
assert(sql.some(q=>q==='BEGIN ISOLATION LEVEL READ COMMITTED'));assert(sql.includes('COMMIT'));assert(fixture.requests.length>0);assert(fixture.requests.every(x=>x.method==='GET'));
}));
test('composed runtime collects persisted usage once, rejects unmapped tenant and never makes a provider request for usage',()=>scenario(async({db,runtime,fixture})=>{
const input={organization_id:org,source_kind:'ai_draft_run',source_id:run};await runtime.collectStoredUsage(input);await runtime.collectStoredUsage(input);assert.equal((await db.query('SELECT count(*)::int n FROM kairo_billing.usage_events')).rows[0].n,2);assert.equal(fixture.requests.length,0);
await assert.rejects(()=>runtime.collectStoredUsage({...input,organization_id:other}),e=>e.code==='provider_binding_conflict');await assert.rejects(()=>runtime.collectStoredUsage({...input,source_kind:'user_amount'}));assert.equal(runtime.diagnostics().commercial_actions_enabled,false);
}));
test('composed preview denies absent policies and foreign-company projections',()=>scenario(async({db,runtime})=>{
const input={organization_id:org,subscription_id:'sub_SYNTHETIC',policy_id:'synthetic-policy',policy_version:1,feature:'ai_draft'};assert.equal((await runtime.previewEntitlement(input)).evaluation.reason,'policy_unconfigured');await new BillingStore(db).recordPolicy(policy({binding_id:binding.id}));const result=await runtime.previewEntitlement({...input,organization_id:other});assert.equal(result.evaluation.allowed,false);assert.equal(result.execution_authorized,false);
}));

test('runtime fences wrong stored account before usage/queue writes or Stripe requests',()=>scenario(async({db,runtime,fixture})=>{
await assert.rejects(()=>runtime.reconcileOnce(),e=>e.code==='provider_binding_conflict');
await assert.rejects(()=>runtime.collectStoredUsage({organization_id:org,source_kind:'ai_draft_run',source_id:run}),e=>e.code==='provider_binding_conflict');
await assert.rejects(()=>runtime.previewEntitlement({organization_id:org,subscription_id:'sub_SYNTHETIC',policy_id:'synthetic-policy',policy_version:1,feature:'ai_draft'}),e=>e.code==='provider_binding_conflict');
assert.equal((await db.query('SELECT count(*)::int n FROM kairo_billing.usage_events')).rows[0].n,0);assert.equal((await db.query('SELECT count(*)::int n FROM kairo_billing.reconciliation_jobs')).rows[0].n,0);assert.equal(fixture.requests.length,0);
},{...binding,account_id:'acct_WRONG'}));

test('runtime canonicalizes uppercase company/source UUIDs before persisted-source verification',()=>scenario(async({db,runtime})=>{
const company='a0000000-0000-4000-8000-000000000001',source='b0000000-0000-4000-8000-000000000001';await db.query('INSERT INTO organizations VALUES($1)',[company]);await db.query('INSERT INTO kairo_billing.customer_bindings(binding_id,customer_id,organization_id) VALUES($1,$2,$3)',[binding.id,'cus_UPPERCASE',company]);await db.query("INSERT INTO ai_draft_runs(id,organization_id,status,usage) VALUES($1,$2,'awaiting_review',$3)",[source,company,JSON.stringify({input_tokens:3,output_tokens:4})]);await runtime.collectStoredUsage({organization_id:company.toUpperCase(),source_kind:'ai_draft_run',source_id:source.toUpperCase()});assert.equal((await db.query('SELECT count(*)::int n FROM kairo_billing.usage_events WHERE organization_id=$1',[company])).rows[0].n,2);
}));
