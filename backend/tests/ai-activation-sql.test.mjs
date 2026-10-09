import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
const org='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
const owner='10000000-0000-4000-8000-000000000001',admin='10000000-0000-4000-8000-000000000002',member='10000000-0000-4000-8000-000000000003',viewer='10000000-0000-4000-8000-000000000004',outsider='10000000-0000-4000-8000-000000000005';
const integration='50000000-0000-4000-8000-000000000001',connection='50000000-0000-4000-8000-000000000002';
const key=n=>`20000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const context={company_name:'Fictional Example LLC',reply_guidance:'Reply using these saved facts only. Support hours are 09:00–17:00 UTC.'};
const intake={customer_email:'customer@example.test',customer_name:'Synthetic Customer',subject:'Support hours',message:'When is support available?'};
const config={schema_version:1,provider:'openai',model:'fixture-model',task:'customer_reply',instructions:'Use only supplied business facts.',source:'manual_context',max_input_bytes:12000,max_output_tokens:1000,max_daily_runs:100,daily_budget_microusd:100000000,human_review:true};
const draft={title:'Support hours',body:'Our support hours are 09:00–17:00 UTC.',source_ids:['manual-1'],warnings:[]};
const rpc=async(d,name,args)=>(await d.query(`select to_jsonb(public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')})) as result`,args)).rows[0].result;
const root=async(d,sql,args=[])=>{await d.exec('reset role');try{return await d.query(sql,args)}finally{await d.exec('set role service_role')}};
async function fixture(){
 const d=new PGlite();
 await d.exec(`create schema auth;create schema private;create role anon;create role authenticated;create role service_role bypassrls;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table auth.users(id uuid primary key);create table organizations(id uuid primary key,name text);
 create table organization_members(organization_id uuid,user_id uuid,role text,primary key(organization_id,user_id));
 create table staff_accounts(user_id uuid,active boolean,role text);
 create table integrations(id uuid primary key,organization_id uuid,provider text,integration_type text,status text,oauth_revision uuid);
 create table oauth_connections(id uuid primary key,organization_id uuid,integration_id uuid,provider text,status text,oauth_verified_version integer,external_account_id text,scopes text[],oauth_revision uuid);
 create table action_requests(id uuid primary key default gen_random_uuid(),organization_id uuid not null,integration_id uuid,connection_id uuid,provider text,action_type text,status text,title text,summary text,payload jsonb,requested_by uuid,approved_by uuid,approved_at timestamptz,rejected_by uuid,rejected_at timestamptz,executed_at timestamptz,error_message text,workflow_run_id uuid,created_at timestamptz default now(),updated_at timestamptz default now());
 alter table action_requests enable row level security;
 create table agent_run_requests(like action_requests including defaults);
 create table workflow_runs(id uuid primary key,organization_id uuid,status text,context jsonb);
 create table audit_events(id uuid primary key default gen_random_uuid(),organization_id uuid,actor_user_id uuid,event_type text,entity_type text,entity_id uuid,summary text,metadata jsonb);
 create function private.assert_workflow_action_approval(uuid,uuid,uuid,text) returns void language sql as $$select$$;
 create function public.assert_agent_workflow_lineage(uuid,uuid) returns jsonb language sql as $$select null::jsonb$$;
 create function private.microsoft_connection_binding(c public.oauth_connections,i public.integrations) returns jsonb language sql as $$select jsonb_build_object('connection_id',c.id,'integration_id',i.id,'account',c.external_account_id,'scopes',c.scopes,'revision',c.oauth_revision)$$;
 insert into auth.users values('${owner}'),('${admin}'),('${member}'),('${viewer}'),('${outsider}');
 insert into organizations values('${org}','Fixture Company'),('${other}','Other Fixture Company');
 insert into organization_members values('${org}','${owner}','owner'),('${org}','${admin}','admin'),('${org}','${member}','member'),('${org}','${viewer}','viewer'),('${other}','${outsider}','owner');
 insert into integrations values('${integration}','${org}','Microsoft','OAuth','Connected',gen_random_uuid());
 insert into oauth_connections values('${connection}','${org}','${integration}','microsoft','Connected',1,'fictional-account',array['Mail.Send'],gen_random_uuid());
 grant usage on schema public,private,auth to service_role,authenticated,anon;
 grant select,insert,update on all tables in schema public to service_role;`);
 for(const file of ['ai-draft-contract.sql','guard-contract.sql','reconciliation-contract.sql','customer-workflow-contract.sql','company-knowledge-contract.sql','knowledge-draft-contract.sql','ai-inference-activation-contract.sql'])await d.exec(await fs.readFile(new URL('../candidate/sql/'+file,import.meta.url),'utf8'));
 await d.exec('set role service_role');return d;
}
const fingerprint='a'.repeat(64),account='synthetic-provider-account';
const save=d=>rpc(d,'ai_draft_save',[org,owner,0,config]);
const status=(d,cfg,tenant=org,actor=owner,acct=account,fp=fingerprint)=>rpc(d,'ai_inference_readiness',[tenant,actor,cfg,acct,fp]);
const reserve=(d,cfg,n=1,cost=10000,acct=account,fp=fingerprint)=>rpc(d,'ai_inference_reserve',[org,owner,cfg,key(n),'b'.repeat(64),cost,acct,fp]);
const dispatch=(d,r,acct=account,fp=fingerprint)=>rpc(d,'ai_inference_dispatch',[org,owner,r.configuration_id,r.request_key,r.id,r.request_hash,acct,fp]);
const finish=(d,r,state='failed')=>rpc(d,'ai_draft_finish',[org,owner,r.id,{status:state,failure_code:'synthetic_no_provider',draft:null,usage:null}]);
async function approveActivation(d,cfg,patch={}){
 const value={organization_id:org,version:1,enabled:true,configuration_id:cfg,provider:config.provider,model:config.model,account_reference:account,credential_sha256:fingerprint,approved_by:owner,approval_reference:'Synthetic bounded approval fixture only',approved_at:new Date(Date.now()-10000).toISOString(),expires_at:new Date(Date.now()+3600000).toISOString(),request_microusd:100000,daily_microusd:200000,total_microusd:300000,daily_runs:10,total_runs:20,...patch};
 const keys=Object.keys(value);return (await root(d,`insert into private.ai_inference_activations(${keys.join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')}) returning *`,Object.values(value))).rows[0];
}
test('installation has no approval rows and both read surfaces derive OFF from same source',async()=>{
 const d=await fixture();try{
  const cfg=await save(d);const a=await status(d,cfg.id);assert.equal(a.status,'activation_missing');assert.equal(a.enabled,false);
  const w=await rpc(d,'customer_workflow_load',[org,owner]);assert.deepEqual(w.readiness.activation,{...a,account_binding_verified:false});assert.equal(w.readiness.live_inference_enabled,false);assert.equal(w.knowledge_contract_version,1);
  await assert.rejects(()=>reserve(d,cfg.id),/activation_missing/);
  assert.equal((await d.query('select count(*)::int n from ai_draft_runs')).rows[0].n,0);
  const text=JSON.stringify(a);assert(!text.includes(fingerprint));assert(!text.includes(account));
 }finally{await d.close()}
});
test('browser cannot read or change activation and runtime cannot enable, mutate, delete or truncate it',async()=>{
 const d=await fixture();try{
  const cfg=await save(d);await approveActivation(d,cfg.id);
  const grants=(await root(d,`select has_table_privilege('service_role','private.ai_inference_activations','select') r,has_table_privilege('service_role','private.ai_inference_activations','insert') i,has_table_privilege('service_role','private.ai_inference_activations','update') u,has_table_privilege('service_role','private.ai_inference_activations','delete') d,has_table_privilege('service_role','private.ai_inference_activations','truncate') t,has_function_privilege('service_role','public.ai_draft_reserve(uuid,uuid,uuid,uuid,text,bigint)','execute') old`)).rows[0];assert.deepEqual(grants,{r:true,i:false,u:false,d:false,t:false,old:false});
  for(const role of ['service_role','authenticated','anon']){
   await d.exec(`reset role;set role ${role}`);
   for(const sql of ['insert into private.ai_inference_activations(organization_id,version) values($1,2)','update private.ai_inference_activations set enabled=false','delete from private.ai_inference_activations','truncate private.ai_inference_activations'])await assert.rejects(()=>d.query(sql,sql.includes('$1')?[org]:[]),/permission denied/);
   if(role!=='service_role'){await assert.rejects(()=>d.query('select * from private.ai_inference_activations'),/permission denied/);await assert.rejects(()=>status(d,cfg.id),/permission denied/);await assert.rejects(()=>reserve(d,cfg.id),/permission denied/)}
  }
  await d.exec('reset role');for(const sql of ['update private.ai_inference_activations set enabled=false','delete from private.ai_inference_activations','truncate private.ai_inference_activations cascade'])await assert.rejects(()=>d.query(sql),/append-only/);
 }finally{await d.close()}
});
test('account, fingerprint, organization, provider, model and exact configuration are fail closed',async()=>{
 const d=await fixture();try{
  const cfg=await save(d);await approveActivation(d,cfg.id);assert.equal((await status(d,cfg.id)).enabled,true);
  for(const [a,f] of [['wrong-account',fingerprint],[account,'b'.repeat(64)],[null,fingerprint],[account,null]]){assert.equal((await status(d,cfg.id,org,owner,a,f)).status,'activation_account_mismatch');await assert.rejects(()=>reserve(d,cfg.id,1,10000,a,f),/activation_account_mismatch/)}
  assert.equal((await status(d,key(77))).status,'activation_configuration_changed');await assert.rejects(()=>status(d,cfg.id,other),/access denied/);
  for(const patch of [{version:2,provider:'anthropic'},{version:3,model:'different-model'}]){await approveActivation(d,cfg.id,patch);assert.equal((await status(d,cfg.id)).status,'activation_configuration_changed')}
  assert.equal((await d.query('select count(*)::int n from ai_draft_runs')).rows[0].n,0);
 }finally{await d.close()}
});
test('missing fields and invalid budget/expiry cannot create enabled approvals; explicit OFF overrides older ON',async()=>{
 const d=await fixture();try{
  const cfg=await save(d);
  for(const patch of [{account_reference:null},{credential_sha256:null},{approved_by:null},{daily_microusd:null},{expires_at:null},{expires_at:'infinity'},{request_microusd:0},{total_microusd:1},{daily_runs:0}])await assert.rejects(()=>approveActivation(d,cfg.id,patch),/check constraint/);
  await approveActivation(d,cfg.id);await root(d,'insert into private.ai_inference_activations(organization_id,version) values($1,2)',[org]);assert.equal((await status(d,cfg.id)).status,'activation_disabled');await assert.rejects(()=>reserve(d,cfg.id),/activation_disabled/);
 }finally{await d.close()}
});
test('expired and future approvals deny; losing approving owner role invalidates the record',async()=>{
 const d=await fixture();try{
  const cfg=await save(d);await approveActivation(d,cfg.id,{approved_at:'2000-01-01Z',expires_at:'2000-01-02Z'});assert.equal((await status(d,cfg.id)).status,'activation_expired');
  await approveActivation(d,cfg.id,{version:2,approved_at:'2099-01-01Z',expires_at:'2099-01-02Z'});assert.equal((await status(d,cfg.id)).status,'activation_invalid');
  await approveActivation(d,cfg.id,{version:3});await root(d,"update organization_members set role='admin' where organization_id=$1 and user_id=$2",[org,owner]);assert.equal((await status(d,cfg.id)).status,'activation_invalid');
 }finally{await d.close()}
});
test('admission binds activation revision, dispatch claims once, replay survives OFF without new reservation',async()=>{
 const d=await fixture();try{
  const cfg=await save(d),a=await approveActivation(d,cfg.id);const first=await reserve(d,cfg.id);assert.equal(first.run.activation_id,a.id);assert.equal(await dispatch(d,first.run),true);await assert.rejects(()=>dispatch(d,first.run),/binding changed/);
  const stored=(await d.query('select activation_dispatch_started_at from ai_draft_runs where id=$1',[first.run.id])).rows[0];assert(stored.activation_dispatch_started_at);
  await finish(d,first.run);await root(d,'insert into private.ai_inference_activations(organization_id,version) values($1,2)',[org]);
  const replay=await reserve(d,cfg.id,1,10000,null,null);assert.equal(replay.created,false);assert.equal(replay.run.id,first.run.id);await assert.rejects(()=>reserve(d,cfg.id,2),/activation_disabled/);
  await assert.rejects(()=>rpc(d,'ai_inference_reserve',[org,owner,cfg.id,key(1),'c'.repeat(64),10000,account,fingerprint]),/Idempotency/);
  await assert.rejects(()=>d.query('update ai_draft_runs set activation_id=null where id=$1',[first.run.id]),/immutable/);
 }finally{await d.close()}
});
test('revocation or replacement after reserve cannot authorize dispatch or revive the old reservation',async()=>{
 for(const change of ['off','new-approval','new-config','actor-revoked','account-changed']){
  const d=await fixture();try{
   const cfg=await save(d);await approveActivation(d,cfg.id);const r=(await reserve(d,cfg.id)).run;
   if(change==='off')await root(d,'insert into private.ai_inference_activations(organization_id,version) values($1,2)',[org]);
   if(change==='new-approval')await approveActivation(d,cfg.id,{version:2});
   if(change==='new-config')await rpc(d,'ai_draft_save',[org,owner,1,{...config,instructions:'Changed saved instructions require new authorization.'}]);
   if(change==='actor-revoked')await root(d,'delete from organization_members where organization_id=$1 and user_id=$2',[org,owner]);
   await assert.rejects(()=>dispatch(d,r,change==='account-changed'?'wrong':account),/activation_|access denied/);
   assert.equal((await d.query('select activation_dispatch_started_at from ai_draft_runs where id=$1',[r.id])).rows[0].activation_dispatch_started_at,null);
  }finally{await d.close()}
 }
});
test('request, daily and total budgets and run caps include failed reservations at exact bounds',async()=>{
 for(const limits of [{request_microusd:10000,daily_microusd:20000,total_microusd:20000},{request_microusd:10000,daily_microusd:20000,total_microusd:30000,daily_runs:2,total_runs:2}]){
  const d=await fixture();try{
   const cfg=await save(d);await approveActivation(d,cfg.id,limits);await assert.rejects(()=>reserve(d,cfg.id,1,10001),/activation_budget_exhausted/);
   for(let n=1;n<=2;n++){const r=(await reserve(d,cfg.id,n,10000)).run;assert.equal(await dispatch(d,r),true);await finish(d,r)}
   assert.equal((await status(d,cfg.id)).enabled,false);await assert.rejects(()=>reserve(d,cfg.id,3,1),/activation_budget_exhausted|activation_run_limit/);
   assert.equal((await d.query('select sum(reserved_microusd)::int n from ai_draft_runs')).rows[0].n,20000);
  }finally{await d.close()}
 }
});
test('unknown outcomes retain reservations and block a fresh request; new revisions do not reset same-day spend',async()=>{
 const d=await fixture();try{
  const cfg=await save(d);await approveActivation(d,cfg.id,{request_microusd:10000,daily_microusd:10000,total_microusd:10000});const r=(await reserve(d,cfg.id)).run;await finish(d,r,'unknown');
  await approveActivation(d,cfg.id,{version:2,request_microusd:10000,daily_microusd:10000,total_microusd:10000});await assert.rejects(()=>reserve(d,cfg.id,2,1),/activation_budget_exhausted/);assert.equal((await reserve(d,cfg.id)).run.status,'unknown');
 }finally{await d.close()}
});
test('installation replay fails atomically, never overwrites existing approvals or re-enables anything',async()=>{
 const d=await fixture();try{
  const cfg=await save(d);await root(d,'insert into private.ai_inference_activations(organization_id,version) values($1,1)',[org]);const before=await status(d,cfg.id);
  await d.exec('reset role');await assert.rejects(()=>d.exec(awaitSql),/already exists/);await d.exec('rollback;set role service_role');assert.deepEqual(await status(d,cfg.id),before);
 }finally{await d.close()}
});
const awaitSql=await fs.readFile(new URL('../candidate/sql/ai-inference-activation-contract.sql',import.meta.url),'utf8');
test('dispatch/admission lock ordering and final clock snapshots are explicit without claiming hosted concurrency proof',async()=>{
 const d=await fixture();try{
  for(const name of ['ai_inference_reserve','ai_inference_dispatch']){
   const source=(await d.query("select prosrc from pg_proc where proname=$1",[name])).rows[0].prosrc;
   assert(source.indexOf('WHERE id=p_org FOR UPDATE')<source.indexOf('PERFORM public.ai_draft_authorize'));
   if(name==='ai_inference_dispatch'){
    assert(source.indexOf('WHERE id=p_run AND organization_id=p_org FOR UPDATE')<source.indexOf('dispatch_at:=clock_timestamp()'));
    assert.equal(source.match(/clock_timestamp\(\)/g).length,1);assert(source.includes('true,0,p_run,dispatch_at'));assert(source.includes('activation_dispatch_started_at=dispatch_at'));
   }
  }
  const guard=(await d.query("select prosrc from pg_proc where proname='ai_inference_run_guard'")).rows[0].prosrc;
  assert(guard.indexOf('WHERE id=NEW.organization_id FOR UPDATE')<guard.indexOf('admission_at:=clock_timestamp()'));assert(guard.includes('NULL,admission_at'));assert(guard.includes('NEW.reservation_day:=(admission_at'));
 }finally{await d.close()}
});
test('total caps persist across UTC days and partial allowances allow only their exact remainder',async()=>{
 for(const mode of ['budget','runs']){
  const d=await fixture();try{
   const cfg=await save(d);await approveActivation(d,cfg.id,{request_microusd:10000,daily_microusd:mode==='budget'?15000:100000,total_microusd:mode==='budget'?15000:100000,daily_runs:mode==='runs'?2:10,total_runs:mode==='runs'?2:10,expires_at:new Date(Date.now()+3*86400000).toISOString()});
   const first=(await reserve(d,cfg.id,1,10000)).run;await finish(d,first);
   if(mode==='budget')await assert.rejects(()=>reserve(d,cfg.id,2,5001),/activation_budget_exhausted/);
   const second=(await reserve(d,cfg.id,2,mode==='budget'?5000:1)).run;await finish(d,second);
   const tomorrow=new Date(Date.now()+86400000).toISOString();
   const value=(await d.query('select private.ai_inference_status($1,$2,$3,$4,true,0,null,$5) value',[org,cfg.id,account,fingerprint,tomorrow])).rows[0].value;
   assert.equal(value.status,mode==='budget'?'activation_budget_exhausted':'activation_run_limit');
  }finally{await d.close()}
 }
});
test('new bound reserve keeps unresolved safety even when approval budget still has room',async()=>{
 const d=await fixture();try{
  const cfg=await save(d);await approveActivation(d,cfg.id);const r=(await reserve(d,cfg.id)).run;await finish(d,r,'unknown');
  assert.equal((await status(d,cfg.id)).enabled,true);await assert.rejects(()=>reserve(d,cfg.id,2),/Unresolved/);assert.equal((await reserve(d,cfg.id)).run.status,'unknown');
 }finally{await d.close()}
});
