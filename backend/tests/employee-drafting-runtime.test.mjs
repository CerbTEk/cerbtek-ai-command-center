import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../candidate/edge/ai-draft/handler.mjs';
import {createHandler as createWorkflowHandler} from '../candidate/edge/customer-workflow/handler.mjs';
import {employeeFixture,installed,org,owner,admin,member,viewer,outsider,key,config,draft,rpc,root,approveActivation,fingerprint,account,context,saveContext,connection} from './fixtures/employee-drafting-fixture.mjs';
async function setup({activate=true,prepare=true}={}){
 const d=await employeeFixture(),p=await installed(d);let providerCalls=0,discoveries=0,resolutions=0,beforeRpc=null,duringInvoke=null,overrideRpc=null;const calls=[];
 const supabase={auth:{getUser:async token=>({data:{user:{id:token}}})},rpc:async(name,args)=>{
  calls.push({name,args});if(beforeRpc)await beforeRpc(name,args);if(overrideRpc){const result=await overrideRpc(name,args);if(result)return result;}
  try{return {data:(await d.query(`select public.${name}(${Object.keys(args).map((k,i)=>`${k}=>$${i+1}`).join(',')}) value`,Object.values(args))).rows[0].value}}catch(error){return {error:{code:error.code,message:error.message}}}
 },from:table=>{
  let columns='*',params=[],where=[],single=false;const q={select(cols){columns=cols;return q},eq(k,v){params.push(v);where.push(`${k}=$${params.length}`);return q},maybeSingle(){single=true;return q},single(){single=true;return q},then(resolve){return d.query(`select row_to_json(result) value from (select ${columns} from public.${table} where ${where.join(' and ')}) result`,params).then(r=>resolve({data:single?r.rows[0]?.value??null:r.rows.map(row=>row.value)}))}};return q;
 }};
 const handler=createHandler({supabase,catalog:[{provider:'openai',model:config.model,input_microusd_per_token:1,output_microusd_per_token:1,structured_outputs:true}],resolveCredential:async({organizationId,provider})=>{resolutions++;return {organizationId,provider,apiKey:'synthetic-not-a-secret',accountReference:account,credentialFingerprint:fingerprint}},discover:async()=>{discoveries++;return [{provider:'openai',model:config.model,available:true,structured_outputs:true}]},invoke:async()=>{providerCalls++;if(duringInvoke)await duringInvoke();return {draft,usage:{input_tokens:3,output_tokens:4}}}});
 const workflowHandler=createWorkflowHandler({supabase});
 const send=async(h,body,actor=member)=>{const response=await h(new Request('https://fixture.invalid/endpoint',{method:'POST',headers:{authorization:`Bearer ${actor}`},body:JSON.stringify({organization_id:org,...body})}));return {status:response.status,body:await response.json()};};
 const workflow=(body,actor=member)=>send(workflowHandler,body,actor);
 if(prepare){const prepared=await workflow({operation:'prepare_draft',workflow_id:p.w.id,expected_revision:p.w.revision,configuration_id:p.cfg.id,request_key:key(2),knowledge_sources:[]});assert.equal(prepared.status,200);p.w=prepared.body.workflow;}
 if(activate)await approveActivation(d,p.cfg.id);calls.length=0;
 const request=(patch={},actor=member)=>send(handler,{operation:'run',configuration_id:p.cfg.id,request_key:key(2),customer_workflow_id:p.w.id,expected_revision:p.w.revision,...patch},actor);
 return {d,p,calls,request,workflow,count:()=>({providerCalls,discoveries,resolutions}),before:fn=>{beforeRpc=fn},during:fn=>{duringInvoke=fn},override:fn=>{overrideRpc=fn}};
}

test('member HTTP→SQL→mock provider succeeds through exact bound readiness/reserve/dispatch with actor-scoped output',async()=>{
 const x=await setup();try{
  const result=await x.request();assert.equal(result.status,200);assert.equal(result.body.run.status,'awaiting_review');assert.equal(result.body.run.requested_by,member);assert.equal(result.body.run.organization_id,org);assert.deepEqual(result.body.run.knowledge_sources,[]);
  assert.deepEqual(x.calls.map(c=>c.name),['customer_workflow_draft_input','customer_workflow_ai_readiness','ai_inference_reserve','customer_workflow_draft_dispatch','ai_inference_dispatch','ai_draft_finish','customer_workflow_visible_run']);
  const ready=x.calls[1].args;assert.equal(ready.p_workflow,x.p.w.id);assert.equal(ready.p_expected_revision,x.p.w.revision);assert.equal(ready.p_request_key,key(2));
  assert.equal(x.count().providerCalls,1);assert.equal((await x.workflow({operation:'load'})).body.workflows[0].draft_authority.can_generate,true);
  assert.equal((await x.request({operation:'review',run_id:result.body.run.id,decision:'accepted'})).status,403);
 }finally{await x.d.close()}
});

test('member cannot reach load/save/models/review/lookup/manual/forged bound requests or knowledge selection',async()=>{
 const x=await setup({prepare:false});try{
  for(const patch of [{operation:'load'},{operation:'save',configuration:config},{operation:'models',provider:'openai'},{operation:'review',run_id:key(9),decision:'accepted'},{operation:'lookup',run_id:key(9)},{customer_workflow_id:undefined,expected_revision:undefined,input:{context:'replacement'}},{input:{context:'replacement'}},{p_actor:owner},{expected_revision:0},{expected_revision:'1'},{customer_workflow_id:'invalid'}])assert.equal((await x.request(patch)).status,403);
  for(const actor of [viewer,outsider])assert.equal((await x.request({},actor)).status,403);
  assert.equal(x.calls.length,0);assert.deepEqual(x.count(),{providerCalls:0,discoveries:0,resolutions:0});
  assert.equal((await x.workflow({operation:'knowledge_search',query:'policy'})).status,403);
  const forged={document_id:key(700),version_id:key(701),chunk_id:key(702),content_sha256:'a'.repeat(64),version_sha256:'b'.repeat(64)};
  assert.equal((await x.workflow({operation:'prepare_draft',workflow_id:x.p.w.id,expected_revision:x.p.w.revision,configuration_id:x.p.cfg.id,request_key:key(2),knowledge_sources:[forged]})).status,403);
 }finally{await x.d.close()}
});

test('disabled or missing bound-readiness RPC fails closed before discovery or provider invocation',async()=>{
 const x=await setup({activate:false});try{
  assert.deepEqual(await x.request(),{status:409,body:{error:'activation_missing'}});assert.equal(x.count().providerCalls,0);assert.equal(x.count().discoveries,0);
  await approveActivation(x.d,x.p.cfg.id);x.override(name=>name==='customer_workflow_ai_readiness'?{error:{message:'missing RPC'}}:null);
  assert.deepEqual(await x.request(),{status:409,body:{error:'activation_unavailable'}});assert.equal(x.count().providerCalls,0);assert.equal((await x.d.query('select count(*) from ai_draft_runs')).rows[0].count,0);
 }finally{await x.d.close()}
});

test('replay retrieves exact result after activation is OFF without a second provider invocation',async()=>{
 const x=await setup();try{
  const first=await x.request();assert.equal(first.status,200);await root(x.d,'insert into private.ai_inference_activations(organization_id,version) values($1,2)',[org]);const before=x.count();
  const replay=await x.request();assert.deepEqual(replay,first);assert.deepEqual(x.count(),before);
  assert.equal((await x.request({request_key:key(3)})).status,409);assert.equal(x.count().providerCalls,1);
 }finally{await x.d.close()}
});

test('changed pinned context between prepare and run stops before credential resolution',async()=>{
 const x=await setup();try{
  await saveContext(x.d,1,{...context,reply_guidance:'Updated context invalidates this installation before generating.'});
  assert.equal((await x.request()).status,409);assert.deepEqual(x.count(),{providerCalls:0,discoveries:0,resolutions:0});
 }finally{await x.d.close()}
});

test('authority changes at final dispatch are rechecked and failed reservation remains durable without provider call',async()=>{
 const x=await setup();try{
  x.before(async name=>{if(name==='ai_inference_dispatch')await root(x.d,'update oauth_connections set oauth_revision=gen_random_uuid() where id=$1',[connection]);});
  const result=await x.request();assert.equal(result.status,409);assert.equal(x.count().providerCalls,0);
  const row=(await x.d.query('select * from ai_draft_runs')).rows[0];assert.equal(row.status,'failed');assert.equal(row.activation_dispatch_started_at,null);assert(row.reserved_microusd>0);
 }finally{await x.d.close()}
});

test('revocation during mock provider does not discard billed outcome and prevents returning revoked member data',async()=>{
 const x=await setup();try{
  x.during(()=>root(x.d,'delete from organization_members where organization_id=$1 and user_id=$2',[org,member]));
  assert.equal((await x.request()).status,409);assert.equal(x.count().providerCalls,1);
  const row=(await x.d.query('select * from ai_draft_runs')).rows[0];assert.equal(row.status,'awaiting_review');assert.deepEqual(row.usage,{input_tokens:3,output_tokens:4});assert(row.reserved_microusd>0);
 }finally{await x.d.close()}
});

test('uninstalled member binding is rejected even if the Edge initial role check accepts run shape',async()=>{
 const x=await setup({prepare:false});try{
  const w=await rpc(x.d,'customer_workflow_intake',[org,member,key(900),{customer_email:'synthetic@example.test',customer_name:'Synthetic',subject:'Question',message:'Saved inquiry only'}]);
  assert.equal((await x.request({customer_workflow_id:w.id,expected_revision:w.revision})).status,409);assert.equal(x.count().resolutions,0);
 }finally{await x.d.close()}
});
