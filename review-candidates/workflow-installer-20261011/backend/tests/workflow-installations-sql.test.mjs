import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,org,other,owner,admin,member,viewer,outsider,connection,key,context,intake,config,rpc,root,saveContext,run,approve } from './fixtures/workflow-installation-fixture.mjs';
const emptyBindings={context_version_id:null,configuration_id:null,microsoft_connection_id:null,assigned_to:null,reviewer_id:null};
const spec=(bindings=emptyBindings,limits={max_open_requests:10})=>({recipe_key:'customer_followup',recipe_version:1,name:'Customer follow-up',outcome:'Respond to customer questions with reviewed company guidance.',bindings,limits});
const save=(d,value=spec(),id=null,revision=0,request=key(100),actor=owner,tenant=org)=>rpc(d,'workflow_installations_save',[tenant,actor,id,revision,request,value]);
const load=(d,actor=owner,tenant=org)=>rpc(d,'workflow_installations_load',[tenant,actor]);
const start=(d,i,request=key(200),actor=owner,data=intake)=>rpc(d,'workflow_installations_start',[org,actor,i.id,i.revision,request,data]);
async function configured(d,{limit=10}={}) {
 const c=await saveContext(d);const cfg=await rpc(d,'ai_draft_save',[org,owner,0,config]);
 const value=spec({context_version_id:c.id,configuration_id:cfg.id,microsoft_connection_id:connection,assigned_to:member,reviewer_id:admin},{max_open_requests:limit});
 const i=await save(d,value);return {c,cfg,i,value};
}
async function queued(d){const p=await configured(d);const started=await start(d,p.i);const w=await rpc(d,'customer_workflow_prepare_draft',[org,owner,started.workflow.id,started.workflow.revision,p.cfg.id,key(2)]);await run(d,{...p,w});const q=await rpc(d,'customer_workflow_queue',[org,member,w.id,w.revision]);return {...p,w:q,action:q.action_request};}

test('catalog is immutable; missing bindings persist as setup_needed; all privileges service-only',async()=>{
 const d=await fixture();try{
  const i=await save(d);assert.equal(i.status,'setup_needed');assert.equal(i.readiness.configured,false);assert.equal(i.readiness.live_inference_enabled,false);assert.equal(i.readiness.automatic_execution_enabled,false);assert.equal(i.readiness.reasons.length,5);assert(!('microsoft_binding_sha256' in i));
  const all=await load(d);assert.equal(all.recipes[0].recipe_key,'customer_followup');assert.equal(all.installations[0].id,i.id);assert.equal(all.operation_receipts[0].request_key,key(100));
  await assert.rejects(()=>root(d,"update workflow_recipe_versions set name='Changed'"),/immutable/);
  await assert.rejects(()=>root(d,"delete from workflow_installation_versions"),/immutable/);
  await assert.rejects(()=>start(d,i),/dependencies/);
  for(const role of ['authenticated','anon']){await d.exec('reset role;set role '+role);await assert.rejects(()=>load(d),/permission denied/);await assert.rejects(()=>d.query('select * from workflow_installations'),/permission denied/)}
 }finally{await d.close()}
});
test('save is payload-and-actor idempotent, immutable revisions, current-revision validated',async()=>{
 const d=await fixture();try{
  const {i,value}=await configured(d);assert.equal(i.status,'configured');assert.equal((await save(d,value)).id,i.id);
  await assert.rejects(()=>save(d,{...value,name:'Changed'}),/Idempotency/);
  await assert.rejects(()=>save(d,value,null,0,key(100),admin),/Idempotency/);
  const next=await save(d,{...value,name:'Customer service'},i.id,1,key(101));assert.equal(next.revision,2);
  await assert.rejects(()=>save(d,value,i.id,1,key(102)),/changed/);
  const replay=await save(d,value);assert.equal(replay.revision,1);assert.equal(replay.status,'setup_needed');assert(replay.readiness.reasons.includes('installation_changed'));
  const all=await load(d);assert.equal(all.operation_receipts.length,2);assert.equal(all.installations.length,1);assert.equal(all.installations[0].revision,2);
  assert.equal((await d.query('select count(*) from workflow_installation_versions')).rows[0].count,2);
 }finally{await d.close()}
});
test('save shape, references, recipe version and roles fail closed across tenants',async()=>{
 const d=await fixture();try{
  const {i,value}=await configured(d);
  for(const actor of [member,viewer,outsider])await assert.rejects(()=>save(d,value,i.id,1,key(101),actor),/authorization|access denied/);
  await assert.rejects(()=>save(d,{...value,recipe_version:2},null,0,key(101)),/Invalid/);
  await assert.rejects(()=>save(d,{...value,bindings:{...value.bindings,reviewer_id:outsider}},null,0,key(101)),/unavailable/);
  await assert.rejects(()=>save(d,{...value,bindings:{...value.bindings,context_version_id:key(700)}},null,0,key(101)),/unavailable/);
  await assert.rejects(()=>save(d,{...value,limits:{max_open_requests:1.5}},null,0,key(101)),/Invalid/);
  await assert.rejects(()=>save(d,{...value,automatic_execution:true},null,0,key(101)),/Invalid/);
  await assert.rejects(()=>save(d,value,i.id,1,key(101),outsider,other),/unavailable|access denied/);
  await assert.rejects(()=>load(d,owner,other),/access denied/);
 }finally{await d.close()}
});
test('start calls guarded intake and assignment, stores revision provenance, and is idempotent',async()=>{
 const d=await fixture();try{
  const {i}=await configured(d);const first=await start(d,i);assert.equal(first.workflow.assigned_to,member);assert.equal(first.workflow.status,'intake');assert.equal(first.workflow.revision,2);assert.equal(first.provenance.installation_id,i.id);assert.equal(first.provenance.installation_revision,1);assert.equal(first.replayed,false);
  assert.equal((await start(d,i)).workflow.id,first.workflow.id);assert.equal((await start(d,i)).replayed,true);
  await assert.rejects(()=>start(d,i,key(200),owner,{...intake,message:'Different'}),/Idempotency/);
  await assert.rejects(()=>start(d,i,key(200),member),/Idempotency/);
  assert.equal((await d.query('select count(*) from customer_reply_workflows')).rows[0].count,1);assert.equal((await d.query('select count(*) from ai_draft_runs')).rows[0].count,0);assert.equal((await d.query('select count(*) from action_requests')).rows[0].count,0);
  const all=await load(d);assert(all.operation_receipts.some(r=>r.operation==='start'&&r.workflow_id===first.workflow.id));
  const audit=await d.query("select metadata from audit_events where event_type='workflow_installation_started'");assert.equal(audit.rows[0].metadata.workflow_id,first.workflow.id);
 }finally{await d.close()}
});
test('assigned employee can start; reviewer, other members and viewers cannot; read scope is safe',async()=>{
 const d=await fixture();try{
  const {i}=await configured(d);await root(d,'insert into organization_members values($1,$2,$3)',[org,outsider,'member']);
  const own=await start(d,i,key(201),member);assert.equal(own.workflow.revision,1);assert.equal(own.workflow.assigned_to,member);
  await assert.rejects(()=>start(d,i,key(202),admin),/reviewer_conflict/);
  await assert.rejects(()=>start(d,i,key(203),viewer),/authorization/);
  await assert.rejects(()=>start(d,i,key(204),outsider),/access denied/);
  assert.equal((await load(d,outsider)).installations.length,0);assert.equal((await load(d,member)).installations.length,1);assert.equal((await load(d,viewer)).installations[0].readiness.can_start,false);
  assert.equal((await load(d,admin)).operation_receipts.length,0);assert.equal((await load(d,member)).operation_receipts.length,1);
 }finally{await d.close()}
});
test('max_open_requests is serialized, includes older revisions, and frees only safe terminal state',async()=>{
 const d=await fixture();try{
  const {i,value}=await configured(d,{limit:1});const a=await start(d,i);await assert.rejects(()=>start(d,i,key(201)),/limit/);assert.equal((await start(d,i)).workflow.id,a.workflow.id);
  const next=await save(d,value,i.id,1,key(101));await assert.rejects(()=>start(d,next,key(202)),/limit/);
  await rpc(d,'customer_workflow_cancel',[org,owner,a.workflow.id,a.workflow.revision]);const b=await start(d,next,key(202));assert.notEqual(b.workflow.id,a.workflow.id);
 }finally{await d.close()}
});
test('context/config/reconsent/authority changes fail closed at launch and preparation',async()=>{
 for(const change of ['context','configuration','connection','assignee','reviewer']){
  const d=await fixture();try{
   const p=await configured(d);const started=await start(d,p.i);
   if(change==='context')await saveContext(d,1,{...context,reply_guidance:'Changed current company facts for all new customer replies.'});
   if(change==='configuration')await rpc(d,'ai_draft_save',[org,owner,1,{...config,instructions:'New current drafting instructions only.'}]);
   if(change==='connection')await root(d,'update oauth_connections set oauth_revision=gen_random_uuid() where id=$1',[connection]);
   if(change==='assignee')await root(d,"update organization_members set role='viewer' where organization_id=$1 and user_id=$2",[org,member]);
   if(change==='reviewer')await root(d,"delete from organization_members where organization_id=$1 and user_id=$2",[org,admin]);
   assert.equal((await load(d)).installations[0].status,'setup_needed');await assert.rejects(()=>start(d,p.i,key(201)),/dependencies/);
   await assert.rejects(()=>rpc(d,'customer_workflow_prepare_draft',[org,owner,started.workflow.id,started.workflow.revision,p.cfg.id,key(2)]),/changed|unavailable|configuration/);
   const cancelled=await rpc(d,'customer_workflow_cancel',[org,owner,started.workflow.id,started.workflow.revision]);assert.equal(cancelled.status,'cancelled');
  }finally{await d.close()}
 }
});
test('installation protects downstream assignee, source revision, and reviewer independence',async()=>{
 const d=await fixture();try{
  const p=await configured(d);const started=await start(d,p.i);
  await assert.rejects(()=>rpc(d,'customer_workflow_assign',[org,owner,started.workflow.id,started.workflow.revision,owner]),/binding changed/);
  await assert.rejects(()=>rpc(d,'customer_workflow_prepare_draft',[org,admin,started.workflow.id,started.workflow.revision,p.cfg.id,key(2)]),/reviewer_conflict/);
  const next=await save(d,p.value,p.i.id,1,key(101));assert.equal(next.status,'configured');
  await assert.rejects(()=>rpc(d,'customer_workflow_prepare_draft',[org,owner,started.workflow.id,started.workflow.revision,p.cfg.id,key(2)]),/dependencies changed/);
 }finally{await d.close()}
});
test('only designated reviewer can approve; changing connection blocks dispatch boundary',async()=>{
 const d=await fixture();try{
  const p=await queued(d);await root(d,'insert into organization_members values($1,$2,$3)',[org,outsider,'admin']);
  await assert.rejects(()=>approve(d,p.action,outsider),/Designated/);const accepted=await approve(d,p.action,admin);assert.equal(accepted.rows[0].approved_by,admin);
  await root(d,'update oauth_connections set oauth_revision=gen_random_uuid() where id=$1',[connection]);
  await assert.rejects(()=>d.query("update action_requests set status='Executing' where id=$1",[p.action.id]),/dependencies changed/);
  assert.equal((await d.query('select count(*) from action_execution_receipts')).rows[0].count,0);
 }finally{await d.close()}
});
test('start cannot adopt an existing uninstalled request key or mutate request provenance',async()=>{
 const d=await fixture();try{
  const p=await configured(d);await rpc(d,'customer_workflow_intake',[org,owner,key(200),intake]);await assert.rejects(()=>start(d,p.i),/Idempotency/);
  await start(d,p.i,key(201));await assert.rejects(()=>root(d,'delete from workflow_installation_requests'),/immutable/);
 }finally{await d.close()}
});

test('no independent draft manager yields an actionable configuration blocker',async()=>{
 const d=await fixture();try{
  const p=await configured(d);await root(d,"update organization_members set role='viewer' where organization_id=$1 and user_id=$2",[org,owner]);
  const loaded=await load(d,admin);assert.equal(loaded.installations[0].status,'setup_needed');assert(loaded.installations[0].readiness.reasons.includes('draft_manager_missing'));
  await assert.rejects(()=>start(d,p.i,key(201),member),/dependencies/);
 }finally{await d.close()}
});
test('optional current Company Knowledge works through existing guarded review and becomes stale on archive',async()=>{
 const {knowledge,hashInput,archiveKnowledge}=await import('./fixtures/workflow-installation-fixture.mjs');
 const d=await fixture({knowledge:true});try{
  const p=await configured(d);const k=await knowledge(d);const started=await start(d,p.i);
  const w=await rpc(d,'customer_workflow_prepare_sources',[org,owner,started.workflow.id,started.workflow.revision,p.cfg.id,key(2),[k.ref]]);
  const input=await rpc(d,'customer_workflow_draft_input',[org,owner,w.id,w.revision,p.cfg.id,key(2)]);
  const a=(await rpc(d,'ai_draft_reserve',[org,owner,p.cfg.id,key(2),hashInput(p.cfg.id,input),10000])).run;assert.equal(a.knowledge_bound,true);
  await rpc(d,'ai_draft_finish',[org,owner,a.id,{status:'awaiting_review',draft:{title:'Saved policy',body:'Support replies within one business day.',source_ids:['manual-1',input.sources[0].source_id],warnings:[]},usage:{input_tokens:10,output_tokens:10}}]);
  await rpc(d,'ai_draft_review',[org,owner,a.id,'accepted']);const q=await rpc(d,'customer_workflow_queue',[org,member,w.id,w.revision]);assert.equal(q.action_request.status,'Pending');
  await archiveKnowledge(d,k);await assert.rejects(()=>approve(d,q.action_request,admin),/changed|stale/);
 }finally{await d.close()}
});
test('existing activation remains independent; changed installation fences model dispatch but not outcome recording',async()=>{
 const {approveActivation,account,fingerprint,hashInput}=await import('./fixtures/workflow-installation-fixture.mjs');
 const d=await fixture({activation:true});try{
  const p=await configured(d);await approveActivation(d,p.cfg.id);const loaded=await load(d);assert.equal(loaded.workspace.readiness.live_inference_enabled,true);assert.equal(loaded.installations[0].readiness.live_inference_enabled,false);
  const started=await start(d,p.i);const w=await rpc(d,'customer_workflow_prepare_draft',[org,owner,started.workflow.id,started.workflow.revision,p.cfg.id,key(2)]);
  const input=await rpc(d,'customer_workflow_draft_input',[org,owner,w.id,w.revision,p.cfg.id,key(2)]);const hash=hashInput(p.cfg.id,input);
  const a=(await rpc(d,'ai_inference_reserve',[org,owner,p.cfg.id,key(2),hash,10000,account,fingerprint])).run;
  await save(d,p.value,p.i.id,1,key(101));await assert.rejects(()=>rpc(d,'ai_inference_dispatch',[org,owner,p.cfg.id,key(2),a.id,hash,account,fingerprint]),/dependencies changed/);
  const finished=await rpc(d,'ai_draft_finish',[org,owner,a.id,{status:'failed',draft:null,usage:null,failure_code:'synthetic_no_provider'}]);assert.equal(finished.status,'failed');
 }finally{await d.close()}
});
test('changed installation is fenced at durable Microsoft receipt even after an earlier valid claim',async()=>{
 const d=await fixture();try{
  const p=await queued(d);await approve(d,p.action);await rpc(d,'claim_microsoft_action',[p.action.id,admin]);
  await save(d,p.value,p.i.id,1,key(101));await assert.rejects(()=>rpc(d,'record_microsoft_attempt',[p.action.id,admin,'Dispatching',null]),/dependencies changed/);
  assert.equal((await d.query('select count(*) from action_execution_receipts')).rows[0].count,0);
 }finally{await d.close()}
});
test('uninstalled customer workflow still follows its original guarded manual lifecycle',async()=>{
 const {queued:legacyQueued}=await import('./fixtures/workflow-installation-fixture.mjs');const d=await fixture();try{
  const p=await legacyQueued(d);await approve(d,p.action);await rpc(d,'claim_microsoft_action',[p.action.id,admin]);await rpc(d,'record_microsoft_attempt',[p.action.id,admin,'Dispatching',null]);
  await rpc(d,'record_microsoft_attempt',[p.action.id,admin,'ProviderAccepted','synthetic-receipt']);await d.query("update action_requests set status='Executed',executed_at=now() where id=$1",[p.action.id]);
  assert.equal((await load(d)).workspace.workflows[0].action_request.status,'Executed');assert.equal((await load(d)).installations.length,0);
 }finally{await d.close()}
});
