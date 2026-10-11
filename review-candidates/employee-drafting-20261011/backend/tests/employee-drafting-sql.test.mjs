import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {employeeFixture,installed,prepare,org,other,owner,admin,member,viewer,outsider,connection,key,config,context,intake,draft,rpc,root,load,saveContext,approveActivation,fingerprint,account,hashInput,knowledge,archiveKnowledge} from './fixtures/employee-drafting-fixture.mjs';
const boundInput=(d,p,actor=member,k=key(2))=>rpc(d,'customer_workflow_draft_input',[org,actor,p.w.id,p.w.revision,p.cfg.id,k]);
async function admitted(d,p,actor=member,k=key(2)){
 const input=await boundInput(d,p,actor,k),hash=hashInput(p.cfg.id,input);
 const run=(await rpc(d,'ai_inference_reserve',[org,actor,p.cfg.id,k,hash,10000,account,fingerprint])).run;
 return {run,hash,input};
}
const dispatch=(d,p,a,actor=member)=>rpc(d,'ai_inference_dispatch',[org,actor,p.cfg.id,key(2),a.run.id,a.hash,account,fingerprint]);
const finish=(d,a,actor=member,status='awaiting_review')=>rpc(d,'ai_draft_finish',[org,actor,a.run.id,{status,draft:status==='awaiting_review'?draft:null,usage:{input_tokens:3,output_tokens:4},failure_code:status==='unknown'?'synthetic_uncertain':null}]);

test('assigned employee receives exact authority, prepares empty sources, and reaches human review under independently approved activation',async()=>{
 const d=await employeeFixture();try{
  const p=await installed(d);const v=(await load(d,member)).workflows[0].draft_authority;
  assert.deepEqual(v,{contract_version:1,organization_id:org,workflow_id:p.w.id,workflow_revision:p.w.revision,actor_id:member,installation_id:p.installation.id,installation_revision:1,can_generate:true,reason:null});
  assert.equal((await load(d,admin)).workflows[0].draft_authority.reason,'reviewer_conflict');
  assert.equal((await load(d,viewer)).workflows[0].draft_authority.can_generate,false);
  p.w=await prepare(d,p);assert.equal(p.w.draft_authority.workflow_revision,p.w.revision);
  const input=await boundInput(d,p);assert.equal(input.sources,undefined);assert(!input.context.includes(intake.customer_email));
  await approveActivation(d,p.cfg.id);
  const readiness=await rpc(d,'customer_workflow_ai_readiness',[org,member,p.w.id,p.w.revision,p.cfg.id,key(2),account,fingerprint]);assert.equal(readiness.account_binding_verified,true);
  const a=await admitted(d,p);assert.equal(a.run.requested_by,member);assert.equal(a.run.knowledge_bound,false);
  assert.equal((await admitted(d,p)).run.id,a.run.id);
  await rpc(d,'customer_workflow_draft_dispatch',[org,member,p.w.id,p.w.revision,p.cfg.id,key(2),a.run.id,a.hash]);await dispatch(d,p,a);await finish(d,a);
  assert.equal((await rpc(d,'customer_workflow_visible_run',[org,member,a.run.id])).status,'awaiting_review');
  await assert.rejects(()=>rpc(d,'ai_draft_review',[org,member,a.run.id,'accepted']),/access denied/);
  const reviewed=await rpc(d,'ai_draft_review',[org,admin,a.run.id,'accepted']);assert.equal(reviewed.reviewed_by,admin);
  assert.equal((await d.query('select count(*) from action_requests')).rows[0].count,0);
  const queued=await rpc(d,'customer_workflow_queue',[org,member,p.w.id,p.w.revision]);assert.equal(queued.action_request.status,'Pending');
  await assert.rejects(()=>d.query("update action_requests set status='Approved',approved_by=$2,approved_at=now() where id=$1",[queued.action_request.id,member]),/approv|reviewer|access/i);
  await d.query("update action_requests set status='Approved',approved_by=$2,approved_at=now() where id=$1",[queued.action_request.id,admin]);
  await rpc(d,'claim_microsoft_action',[queued.action_request.id,admin]);await rpc(d,'record_microsoft_attempt',[queued.action_request.id,admin,'Dispatching',null]);
  assert.equal((await d.query('select count(*) from action_execution_receipts')).rows[0].count,1);
 }finally{await d.close()}
});

test('one member assignee plus one manager reviewer is sufficient without a second draft manager',async()=>{
 const d=await employeeFixture();try{
  const p=await installed(d);await root(d,"update organization_members set role='owner' where organization_id=$1 and user_id=$2",[org,admin]);await root(d,'delete from organization_members where organization_id=$1 and user_id=$2',[org,owner]);
  const ready=(await rpc(d,'workflow_installations_load',[org,member])).installations[0].readiness;assert.equal(ready.configured,true);assert.equal(ready.can_start,true);
  p.w=await prepare(d,p);assert.equal(p.w.draft_authority.can_generate,true);
 }finally{await d.close()}
});

test('member cannot use manager AI administration, uninstalled drafting, arbitrary readiness, reserve, or foreign workflow',async()=>{
 const d=await employeeFixture();try{
  const p=await installed(d);const legacy=await rpc(d,'customer_workflow_intake',[org,member,key(201),intake]);
  assert.equal(Object.hasOwn((await load(d,member)).workflows.find(w=>w.id===legacy.id),'draft_authority'),false);
  for(const call of [()=>rpc(d,'ai_draft_authorize',[org,member]),()=>rpc(d,'ai_draft_save',[org,member,1,config]),()=>rpc(d,'ai_inference_readiness',[org,member,p.cfg.id,account,fingerprint]),()=>rpc(d,'customer_workflow_prepare_draft',[org,member,legacy.id,legacy.revision,p.cfg.id,key(3)]),()=>rpc(d,'ai_inference_reserve',[org,member,p.cfg.id,key(999),'a'.repeat(64),1000,account,fingerprint]),()=>rpc(d,'customer_workflow_knowledge_search',[org,member,'policy'])])await assert.rejects(call,/access denied|authorization required/);
  for(const actor of [viewer,outsider])await assert.rejects(()=>prepare(d,p,actor),/access denied/);
  await root(d,"insert into organization_members values($1,$2,'member')",[org,outsider]);await assert.rejects(()=>prepare(d,p,outsider),/access denied/);
  await assert.rejects(()=>rpc(d,'customer_workflow_prepare_draft',[other,member,p.w.id,p.w.revision,p.cfg.id,key(3)]),/access denied/);
  assert.equal((await d.query('select count(*) from ai_draft_runs')).rows[0].count,0);
 }finally{await d.close()}
});

test('member source selection stays empty at preparation, seal and bound input; manager knowledge remains available',async()=>{
 const d=await employeeFixture();try{
  const p=await installed(d),k=await knowledge(d);
  for(const sources of [[k.ref],null,{}])await assert.rejects(()=>rpc(d,'customer_workflow_prepare_sources',[org,member,p.w.id,p.w.revision,p.cfg.id,key(2),sources]),/Manager authorization/);
  await assert.rejects(()=>d.query('select private.customer_knowledge_seal($1,$2,$3,$4,$5)',[org,member,p.w.id,key(2),[k.ref]]),/Manager authorization/);
  p.w=await rpc(d,'customer_workflow_prepare_sources',[org,owner,p.w.id,p.w.revision,p.cfg.id,key(2),[k.ref]]);
  const input=await boundInput(d,p,owner);assert.equal(input.sources.length,1);
  await assert.rejects(()=>boundInput(d,p,member),/binding changed/);
  await archiveKnowledge(d,k);await assert.rejects(()=>boundInput(d,p,owner),/changed|unavailable/);
 }finally{await d.close()}
});

test('all bound identities and revisions fail closed before admission',async()=>{
 const d=await employeeFixture();try{
  const p=await installed(d);p.w=await prepare(d,p);const good=[org,member,p.w.id,p.w.revision,p.cfg.id,key(2)];
  for(const [index,value] of [[0,other],[1,outsider],[2,key(888)],[3,p.w.revision-1],[4,key(889)],[5,key(890)]]){const args=[...good];args[index]=value;await assert.rejects(()=>rpc(d,'customer_workflow_draft_input',args),/access denied|binding changed/);}
  await approveActivation(d,p.cfg.id);const input=await boundInput(d,p);
  await assert.rejects(()=>rpc(d,'ai_inference_reserve',[org,member,p.cfg.id,key(2),'a'.repeat(64),1000,account,fingerprint]),/hash/);
  await assert.rejects(()=>rpc(d,'ai_inference_reserve',[org,member,p.cfg.id,key(2),hashInput(p.cfg.id,input),1000,'wrong-account',fingerprint]),/account_mismatch/);
  assert.equal((await d.query('select count(*) from ai_draft_runs')).rows[0].count,0);
 }finally{await d.close()}
});

for(const change of ['installation','context','configuration','connection','assignee','reviewer'])test(`${change} change blocks bound admission and dispatch, preserving uncertain result recording`,async()=>{
 const d=await employeeFixture();try{
  const p=await installed(d);p.w=await prepare(d,p);await approveActivation(d,p.cfg.id);const a=await admitted(d,p);
  if(change==='installation')await rpc(d,'workflow_installations_save',[org,owner,p.installation.id,1,key(101),p.spec]);
  if(change==='context')await saveContext(d,1,{...context,reply_guidance:'Current guidance now differs from the installed source.'});
  if(change==='configuration')await rpc(d,'ai_draft_save',[org,owner,1,{...config,instructions:'Replacement instructions require a new installation binding.'}]);
  if(change==='connection')await root(d,'update oauth_connections set oauth_revision=gen_random_uuid() where id=$1',[connection]);
  if(change==='assignee')await root(d,"update organization_members set role='viewer' where organization_id=$1 and user_id=$2",[org,member]);
  if(change==='reviewer')await root(d,'delete from organization_members where organization_id=$1 and user_id=$2',[org,admin]);
  const row=(await load(d,owner)).workflows[0];assert.equal(row.draft_authority.can_generate,false);
  await assert.rejects(()=>admitted(d,p),/changed|unavailable|access denied/);await assert.rejects(()=>dispatch(d,p,a),/changed|unavailable|access denied/);
  await assert.rejects(()=>d.query('update ai_draft_runs set activation_dispatch_started_at=clock_timestamp() where id=$1',[a.run.id]),/changed|unavailable|access denied/);
  const ended=await finish(d,a,member,'unknown');assert.equal(ended.status,'unknown');assert.equal(ended.reserved_microusd,10000);assert.deepEqual(ended.usage,{input_tokens:3,output_tokens:4});
 }finally{await d.close()}
});

test('direct inserts cannot turn members into unbound inference callers; legacy reserve stays revoked',async()=>{
 const d=await employeeFixture();try{
  const p=await installed(d);await approveActivation(d,p.cfg.id);
  await assert.rejects(()=>d.query('insert into ai_draft_runs(organization_id,configuration_id,request_key,request_hash,requested_by,reserved_microusd) values($1,$2,$3,$4,$5,1000)',[org,p.cfg.id,key(2),'a'.repeat(64),member]),/access denied/);
  await assert.rejects(()=>rpc(d,'ai_draft_reserve',[org,member,p.cfg.id,key(2),'a'.repeat(64),1000]),/permission denied/);
 }finally{await d.close()}
});

test('installed requester self-review denied for both decisions, including promotion and service direct update',async()=>{
 const d=await employeeFixture();try{
  const p=await installed(d);p.w=await prepare(d,p);await approveActivation(d,p.cfg.id);const a=await admitted(d,p);await dispatch(d,p,a);await finish(d,a);
  await root(d,"update organization_members set role='admin' where organization_id=$1 and user_id=$2",[org,member]);
  for(const decision of ['accepted','rejected']){
   await assert.rejects(()=>rpc(d,'ai_draft_review',[org,member,a.run.id,decision]),/Independent draft reviewer/);
   await assert.rejects(()=>d.query('update ai_draft_runs set status=$2,reviewed_by=$3,reviewed_at=now() where id=$1',[a.run.id,decision,member]),/Independent draft reviewer/);
  }
  assert.equal((await rpc(d,'ai_draft_review',[org,admin,a.run.id,'accepted'])).status,'accepted');
  await assert.rejects(()=>d.query('update ai_draft_runs set reviewed_by=$2 where id=$1',[a.run.id,member]),/Independent draft reviewer/);
 }finally{await d.close()}
});

test('revoked assignment cannot read returned run, while manager read and durable completion still work',async()=>{
 const d=await employeeFixture();try{
  const p=await installed(d);p.w=await prepare(d,p);await approveActivation(d,p.cfg.id);const a=await admitted(d,p);await dispatch(d,p,a);
  await root(d,'delete from organization_members where organization_id=$1 and user_id=$2',[org,member]);await finish(d,a,member,'unknown');
  await assert.rejects(()=>rpc(d,'customer_workflow_visible_run',[org,member,a.run.id]),/access denied/);
  assert.equal((await rpc(d,'customer_workflow_visible_run',[org,owner,a.run.id])).status,'unknown');
 }finally{await d.close()}
});

test('new/replaced functions stay service-only and existing manager gate plus finish are byte-for-byte unchanged',async()=>{
 const d=await employeeFixture();try{
  const sql=await fs.readFile(new URL('../candidate/sql/employee-drafting-contract.sql',import.meta.url),'utf8');
  assert(!/CREATE OR REPLACE FUNCTION public\.(ai_draft_authorize|ai_draft_finish|ai_inference_readiness|ai_draft_review)\(/.test(sql));
  const signatures=[...sql.matchAll(/^ '((?:private|public)\.[^']+)'/gm)].map(m=>m[1]);assert.equal(signatures.length,16);
  for(const signature of signatures){const rights=(await d.query("select has_function_privilege('service_role',$1,'EXECUTE') as service,has_function_privilege('authenticated',$1,'EXECUTE') as authenticated,has_function_privilege('anon',$1,'EXECUTE') as anon",[signature])).rows[0];assert.deepEqual(rights,{service:true,authenticated:false,anon:false});}
  assert.equal((await d.query("select has_table_privilege('service_role','private.ai_inference_activations','INSERT') value")).rows[0].value,false);
  assert.equal((await d.query("select has_table_privilege('authenticated','public.ai_draft_runs','SELECT') value")).rows[0].value,false);
 }finally{await d.close()}
});
