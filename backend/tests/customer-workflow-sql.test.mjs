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
 for(const file of ['ai-draft-contract.sql','guard-contract.sql','reconciliation-contract.sql','customer-workflow-contract.sql'])await d.exec(await fs.readFile(new URL('../candidate/sql/'+file,import.meta.url),'utf8'));
 await d.exec('set role service_role');return d;
}
const saveContext=(d,version=0,value=context)=>rpc(d,'customer_workflow_save_context',[org,owner,version,value]);
const makeIntake=(d,n=1,actor=member,data=intake)=>rpc(d,'customer_workflow_intake',[org,actor,key(n),data]);
async function prepared(d,{source=context,inquiry=intake,requester=member,assignee=null}={}){
 const c=await saveContext(d,0,source);const cfg=await rpc(d,'ai_draft_save',[org,owner,0,config]);let w=await makeIntake(d,1,requester,inquiry);
 if(assignee)w=await rpc(d,'customer_workflow_assign',[org,owner,w.id,w.revision,assignee]);
 const p=await rpc(d,'customer_workflow_prepare_draft',[org,owner,w.id,w.revision,cfg.id,key(2)]);
 return {c,cfg,w:p};
}
async function run(d,p,status='accepted',text=draft){
 const input=await rpc(d,'customer_workflow_draft_input',[org,owner,p.w.id,p.w.revision,p.cfg.id,key(2)]);
 const hash=createHash('sha256').update(JSON.stringify({configuration_id:p.cfg.id,input})).digest('hex');
 const a=(await rpc(d,'ai_draft_reserve',[org,owner,p.cfg.id,key(2),hash,10000])).run;
 await rpc(d,'ai_draft_finish',[org,owner,a.id,{status:status==='unknown'?'unknown':status==='failed'?'failed':'awaiting_review',draft:text,usage:{input_tokens:10,output_tokens:10}}]);
 if(['accepted','rejected'].includes(status))await rpc(d,'ai_draft_review',[org,owner,a.id,status]);
 return a;
}
async function queued(d){const p=await prepared(d);const a=await run(d,p);const w=await rpc(d,'customer_workflow_queue',[org,member,p.w.id,p.w.revision]);return {...p,w,a,action:w.action_request}}
const approve=(d,a,actor=admin)=>d.query("update action_requests set status='Approved',approved_by=$2,approved_at=now() where id=$1 returning *",[a.id,actor]);
const load=(d,actor=owner,tenant=org)=>rpc(d,'customer_workflow_load',[tenant,actor]);

test('context is explicit, immutable, versioned, and manager-only; browser privileges deny',async()=>{
 const d=await fixture();try{
  const c=await saveContext(d);assert.equal(c.version,1);assert.equal(c.source_kind,'manual_company_guidance');
  await assert.rejects(()=>saveContext(d),/changed/);
  await assert.rejects(()=>rpc(d,'customer_workflow_save_context',[org,member,1,context]),/Manager/);
  await assert.rejects(()=>saveContext(d,1,{...context,secret:'not allowed'}),/Invalid company context/);
  await assert.rejects(()=>root(d,"update customer_reply_context_versions set version=99"),/immutable/);
  for(const role of ['authenticated','anon']){await d.exec(`reset role;set role ${role}`);await assert.rejects(()=>load(d),/permission denied/);await assert.rejects(()=>d.query('select * from customer_reply_workflows'),/permission denied/)}
 }finally{await d.close()}
});
test('intake is idempotent, exact-payload bound, member-own scoped, and immutable',async()=>{
 const d=await fixture();try{
  const w=await makeIntake(d);assert.equal(w.assigned_to,member);assert.equal((await makeIntake(d)).id,w.id);
  await assert.rejects(()=>makeIntake(d,1,member,{...intake,message:'Changed'}),/Idempotency/);
  await assert.rejects(()=>makeIntake(d,2,viewer),/Contributor/);
  await assert.rejects(()=>load(d,owner,other),/access denied/);
  await assert.rejects(()=>root(d,'update customer_reply_workflows set message=$1',['Tamper']),/immutable/);
  const mine=await load(d,member);assert.equal(mine.workflows.length,1);assert.equal(mine.workflows[0].id,w.id);
  await root(d,'insert into organization_members values($1,$2,$3)',[org,outsider,'member']);assert.equal((await load(d,outsider)).workflows.length,0);
  await assert.rejects(()=>rpc(d,'customer_workflow_cancel',[org,outsider,w.id,1]),/access denied/);
 }finally{await d.close()}
});
test('assignment uses current revisions and current same-tenant contributors',async()=>{
 const d=await fixture();try{
  const w=await makeIntake(d);await assert.rejects(()=>rpc(d,'customer_workflow_assign',[org,member,w.id,1,owner]),/Manager/);
  await assert.rejects(()=>rpc(d,'customer_workflow_assign',[org,owner,w.id,1,outsider]),/Assignee/);
  const moved=await rpc(d,'customer_workflow_assign',[org,owner,w.id,1,admin]);assert.equal(moved.revision,2);assert.equal(moved.assigned_to,admin);
  await assert.rejects(()=>rpc(d,'customer_workflow_assign',[org,owner,w.id,1,member]),/revision/);
  assert.equal((await load(d,member)).workflows.length,0);
  const audit=await d.query('select actor_user_id from audit_events where entity_id=$1 order by id',[w.id]);assert(audit.rows.some(r=>r.actor_user_id===owner));
 }finally{await d.close()}
});
test('prepared draft derives only frozen explicit source and hashes JS Unicode/escaping identically',async()=>{
 const d=await fixture();try{
  const p=await prepared(d,{source:{company_name:'Example "Company" \\ café 🌱',reply_guidance:'Line one\nLine two\twith quote " and slash \\ é 雪.'},inquiry:{...intake,message:'Question?\n雪 \\ "'}});
  const input=await rpc(d,'customer_workflow_draft_input',[org,owner,p.w.id,p.w.revision,p.cfg.id,key(2)]);const parsed=JSON.parse(input.context);
  assert.equal(parsed.company_context_version,1);assert(!input.context.includes(intake.customer_email));assert(!('budget' in parsed));
  const a=await run(d,p);assert.equal(a.request_key,key(2));
  assert.equal((await load(d)).workflows[0].status,'draft_accepted');
  await assert.rejects(()=>rpc(d,'customer_workflow_draft_input',[org,member,p.w.id,p.w.revision,p.cfg.id,key(2)]),/access denied/);
  await assert.rejects(()=>rpc(d,'customer_workflow_draft_input',[org,owner,p.w.id,1,p.cfg.id,key(2)]),/changed/);
 }finally{await d.close()}
});
test('manual AI request cannot hijack bound key; changed context blocks admission after input read',async()=>{
 const d=await fixture();try{
  const p=await prepared(d);const input=await rpc(d,'customer_workflow_draft_input',[org,owner,p.w.id,p.w.revision,p.cfg.id,key(2)]);
  await assert.rejects(()=>rpc(d,'ai_draft_reserve',[org,owner,p.cfg.id,key(2),'a'.repeat(64),10000]),/source hash/);
  await saveContext(d,1,{...context,reply_guidance:'New guidance invalidates the previous source.'});
  const hash=createHash('sha256').update(JSON.stringify({configuration_id:p.cfg.id,input})).digest('hex');
  await assert.rejects(()=>rpc(d,'ai_draft_reserve',[org,owner,p.cfg.id,key(2),hash,10000]),/context changed/);
 }finally{await d.close()}
});
test('queue is exact and idempotent, needs accepted draft and never approves itself',async()=>{
 const d=await fixture();try{
  const p=await prepared(d);const a=await run(d,p,'awaiting_review');
  await assert.rejects(()=>rpc(d,'customer_workflow_queue',[org,member,p.w.id,p.w.revision]),/Accepted/);
  await rpc(d,'ai_draft_review',[org,owner,a.id,'accepted']);
  const w=await rpc(d,'customer_workflow_queue',[org,member,p.w.id,p.w.revision]);assert.equal(w.action_request.status,'Pending');
  assert.deepEqual(w.action_request.payload,{to:intake.customer_email,subject:draft.title,message:draft.body});assert.equal(w.action_request.requested_by,member);
  assert.equal((await rpc(d,'customer_workflow_queue',[org,member,p.w.id,p.w.revision])).action_request_id,w.action_request_id);
  assert.equal((await d.query('select count(*)::int n from action_requests')).rows[0].n,1);
  await assert.rejects(()=>approve(d,w.action_request,owner),/Distinct authorized/);
  await approve(d,w.action_request);assert.equal((await load(d)).workflows[0].action_request.approval_guard_version,1);
  await assert.rejects(()=>d.query('update action_requests set payload=$1 where id=$2',[{to:'changed@example.test'},w.action_request_id]),/immutable/);
 }finally{await d.close()}
});
test('existing Microsoft claim/dispatch/receipt/complete records authoritative outcome without second execution',async()=>{
 const d=await fixture();try{
  const p=await queued(d);await approve(d,p.action);
  const claim=await rpc(d,'claim_microsoft_action',[p.action.id,admin]);assert.equal(claim.status,'Executing');
  await assert.rejects(()=>rpc(d,'claim_microsoft_action',[p.action.id,admin]),/already claimed/);
  await rpc(d,'record_microsoft_attempt',[p.action.id,admin,'Dispatching',null]);
  await assert.rejects(()=>rpc(d,'customer_workflow_cancel',[org,member,p.w.id,p.w.revision]),/Dispatch started/);
  await rpc(d,'record_microsoft_attempt',[p.action.id,admin,'ProviderAccepted','synthetic-receipt']);
  await d.query("update action_requests set status='Executed',executed_at=now() where id=$1",[p.action.id]);
  const row=(await load(d)).workflows[0];assert.equal(row.action_request.status,'Executed');assert.equal(row.receipt.phase,'ProviderAccepted');
  await assert.rejects(()=>rpc(d,'customer_workflow_prepare_draft',[org,owner,row.id,row.revision,p.cfg.id,key(3)]),/closed/);
 }finally{await d.close()}
});
test('saved context changes block both approval and pre-dispatch stale authorization',async()=>{
 const d=await fixture();try{
  const p=await queued(d);await approve(d,p.action);await rpc(d,'claim_microsoft_action',[p.action.id,admin]);
  await saveContext(d,1,{...context,reply_guidance:'This is materially changed approved company guidance.'});
  await assert.rejects(()=>rpc(d,'record_microsoft_attempt',[p.action.id,admin,'Dispatching',null]),/stale/);
  assert.equal((await load(d)).workflows[0].context_stale,true);
  assert.equal((await d.query('select count(*)::int n from action_execution_receipts')).rows[0].n,0);
 }finally{await d.close()}
});
test('cancellation fences pending approval and claim/dispatch without resetting a claimed action',async()=>{
 const d=await fixture();try{
  const p=await queued(d);await approve(d,p.action);await rpc(d,'claim_microsoft_action',[p.action.id,admin]);
  const cancelled=await rpc(d,'customer_workflow_cancel',[org,member,p.w.id,p.w.revision]);assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.action_request.status,'Executing');
  await assert.rejects(()=>rpc(d,'record_microsoft_attempt',[p.action.id,admin,'Dispatching',null]),/cancelled/);
  assert.equal((await rpc(d,'customer_workflow_cancel',[org,member,p.w.id,p.w.revision])).status,'cancelled');
  await assert.rejects(()=>rpc(d,'customer_workflow_queue',[org,member,p.w.id,cancelled.revision]),/cancelled/);
 }finally{await d.close()}
});
test('unknown AI outcomes never authorize a fresh request; failed requests may explicitly regenerate',async()=>{
 for(const state of ['unknown','failed']){
  const d=await fixture();try{
   const p=await prepared(d);await run(d,p,state);
   const next=()=>rpc(d,'customer_workflow_prepare_draft',[org,owner,p.w.id,p.w.revision,p.cfg.id,key(3)]);
   if(state==='unknown')await assert.rejects(next,/Unresolved/);else assert.equal((await next()).ai_request_key,key(3));
  }finally{await d.close()}
 }
});
test('revoked assignee, draft author and approver authority fence existing proposal',async()=>{
 for(const revoked of [member,owner,admin]){
  const d=await fixture();try{
   const p=await queued(d);await approve(d,p.action);await root(d,'delete from organization_members where user_id=$1',[revoked]);
   await assert.rejects(()=>rpc(d,'claim_microsoft_action',[p.action.id,admin]),/revoked|authorized/);
  }finally{await d.close()}
 }
});

test('AI configuration revision invalidates an accepted proposal before approval',async()=>{
 const d=await fixture();try{
  const p=await queued(d);await rpc(d,'ai_draft_save',[org,owner,1,{...config,instructions:'Use the new explicitly approved wording rules.'}]);
  assert.equal((await load(d)).workflows[0].configuration_stale,true);
  await assert.rejects(()=>approve(d,p.action),/configuration changed/);
 }finally{await d.close()}
});
test('dispatch requires current company employee authorization even when executor has a platform role',async()=>{
 const d=await fixture();try{
  const p=await queued(d);await approve(d,p.action);
  await root(d,'insert into organization_members values($1,$2,$3)',[org,outsider,'consultant']);
  await root(d,'insert into staff_accounts values($1,true,$2)',[outsider,'platform_admin']);
  await rpc(d,'claim_microsoft_action',[p.action.id,outsider]);
  await root(d,'delete from organization_members where organization_id=$1 and user_id=$2',[org,outsider]);
  await assert.rejects(()=>rpc(d,'record_microsoft_attempt',[p.action.id,outsider,'Dispatching',null]),/Employee executor authorization/);
  assert.equal((await d.query('select count(*)::int n from action_execution_receipts')).rows[0].n,0);
 }finally{await d.close()}
});
test('load reports exact verified Microsoft account and connection ID without credentials',async()=>{
 const d=await fixture();try{
  const result=await load(d);assert.equal(result.readiness.microsoft_ready,true);assert.equal(result.readiness.microsoft_account,'fictional-account');assert.equal(result.readiness.microsoft_connection_id,connection);
  assert.equal(result.readiness.configuration_ready,false);assert(!JSON.stringify(result).includes('access_secret'));
 }finally{await d.close()}
});

test('legacy action readers retain manual rows while linked rows respect company assignment',async()=>{
 const d=await fixture();try{
  const p=await queued(d);
  await root(d,'insert into organization_members values($1,$2,$3)',[org,outsider,'member']);
  await root(d,'grant select on action_requests to authenticated');
  await root(d,'create policy legacy_fixture_read on action_requests for select to authenticated using(true)');
  await d.query("insert into action_requests(organization_id,status,title) values($1,'Pending','Manual fixture')",[org]);
  async function visible(actor){await d.exec('reset role');await d.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);await d.exec('set role authenticated');try{return (await d.query('select id,customer_workflow_id from action_requests')).rows}finally{await d.exec('reset role;set role service_role')}}
  assert.equal((await visible(member)).length,2);assert.equal((await visible(admin)).length,2);
  const rows=await visible(outsider);assert.equal(rows.length,1);assert.equal(rows[0].customer_workflow_id,null);
  await d.exec('reset role');await d.query("select set_config('request.jwt.claim.sub',$1,false)",[member]);await d.exec('set role authenticated');
  assert.equal((await d.query('select private.customer_action_readable($1,$2,$3) as allowed',[other,p.action.id,p.w.id])).rows[0].allowed,false);
  await assert.rejects(()=>d.query('select * from customer_reply_workflows'),/permission denied/);
 }finally{await d.close()}
});


test('original intake requester remains excluded from approval after reassignment',async()=>{
 const d=await fixture();try{
  const p=await prepared(d,{requester:admin,assignee:member});await run(d,p);
  const w=await rpc(d,'customer_workflow_queue',[org,member,p.w.id,p.w.revision]);
  assert.equal(w.requested_by,admin);assert.equal(w.assigned_to,member);assert.equal(w.draft_requested_by,owner);
  await assert.rejects(()=>approve(d,w.action_request,admin),/Distinct authorized employee approval/);
  await root(d,'insert into organization_members values($1,$2,$3)',[org,outsider,'consultant']);
  await approve(d,w.action_request,outsider);
  assert.equal((await load(d)).workflows[0].action_request.approved_by,outsider);
 }finally{await d.close()}
});
