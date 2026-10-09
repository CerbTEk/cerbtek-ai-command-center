import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../candidate/edge/ai-draft/handler.mjs';
import {activationVerdict} from '../candidate/edge/ai-draft/activation.mjs';
import {fixture,org,owner,config,key,rpc,root,save,approveActivation,fingerprint,account} from './fixtures/activation-fixture.mjs';
async function setup(){
 const d=await fixture(),saved=await save(d);let providerCalls=0,discoveries=0,resolutions=0,beforeDispatch=null;
 const calls=[];
 const supabase={auth:{getUser:async()=>({data:{user:{id:owner}}})},rpc:async(name,args)=>{
  calls.push(name);if(name==='ai_inference_dispatch'&&beforeDispatch)await beforeDispatch();
  try{return {data:(await d.query(`select public.${name}(${Object.keys(args).map((k,i)=>`${k}=>$${i+1}`).join(',')}) value`,Object.values(args))).rows[0].value}}catch(error){return {error:{message:error.message}}}
 },from:table=>{
  let columns='*',params=[],where=[],single=false;const q={select(cols){columns=cols;return q},eq(k,v){params.push(v);where.push(`${k}=$${params.length}`);return q},maybeSingle(){single=true;return q},single(){single=true;return q},then(resolve){return d.query(`select row_to_json(result) value from (select ${columns} from public.${table} where ${where.join(' and ')}) result`,params).then(r=>resolve({data:single?r.rows[0]?.value??null:r.rows.map(row=>row.value)}))}};return q;
 }};
 const handler=createHandler({supabase,catalog:[{provider:'openai',model:config.model,input_microusd_per_token:1,output_microusd_per_token:1,structured_outputs:true}],resolveCredential:async({organizationId,provider})=>{resolutions++;return {organizationId,provider,apiKey:'synthetic-not-a-secret',accountReference:account,credentialFingerprint:fingerprint}},discover:async()=>{discoveries++;return [{provider:'openai',model:config.model,available:true,structured_outputs:true}]},invoke:async()=>{providerCalls++;return {draft:{title:'Synthetic',body:'Synthetic fixture draft only.',source_ids:['manual-1'],warnings:[]},usage:{input_tokens:1,output_tokens:1}}}});
 const request=async(patch={})=>{const response=await handler(new Request('https://fixture.invalid/ai-draft',{method:'POST',headers:{authorization:'Bearer synthetic'},body:JSON.stringify({operation:'run',organization_id:org,configuration_id:saved.id,request_key:key(1),input:{context:'Synthetic supplied company guidance.'},...patch})}));return {status:response.status,body:await response.json()}};
 return {d,saved,calls,request,count:()=>({providerCalls,discoveries,resolutions}),revokeAtDispatch:fn=>{beforeDispatch=fn}};
}
test('real activation SQL + handler: OFF denies before discovery/reservation/dispatch and creates no run',async()=>{
 const x=await setup();try{assert.deepEqual(await x.request(),{status:409,body:{error:'activation_missing'}});assert.deepEqual(x.calls,['ai_inference_readiness']);assert.equal(x.count().discoveries,0);assert.equal(x.count().providerCalls,0);assert.equal((await x.d.query('select count(*)::int n from ai_draft_runs')).rows[0].n,0)}finally{await x.d.close()}
});
test('real activation SQL + handler: exact bound synthetic authorization, single dispatch, OFF replay recovery',async()=>{
 const x=await setup();try{
  const a=await approveActivation(x.d,x.saved.id);const first=await x.request();assert.equal(first.status,200);assert.equal(first.body.run.status,'awaiting_review');assert.equal(first.body.run.activation_id,a.id);assert(first.body.run.activation_dispatch_started_at);
  assert.deepEqual(x.calls,['ai_inference_readiness','ai_inference_reserve','ai_inference_dispatch','ai_draft_finish']);assert.equal(x.count().providerCalls,1);
  await root(x.d,'insert into private.ai_inference_activations(organization_id,version) values($1,2)',[org]);const before=x.count(),calls=[...x.calls];const replay=await x.request();assert.deepEqual(replay,first);assert.deepEqual(x.count(),before);assert.deepEqual(x.calls,calls);
  assert.equal((await x.request({input:{context:'Changed payload is not a replay.'}})).body.error,'configuration_or_run_conflict');assert.equal(x.count().providerCalls,1);
 }finally{await x.d.close()}
});
test('real activation SQL + handler: revocation between reserve and mandatory dispatch fails durably with no invocation',async()=>{
 const x=await setup();try{
  await approveActivation(x.d,x.saved.id);x.revokeAtDispatch(()=>root(x.d,'insert into private.ai_inference_activations(organization_id,version) values($1,2)',[org]));const result=await x.request();assert.equal(result.status,200);assert.equal(result.body.run.status,'failed');assert.equal(x.count().providerCalls,0);assert.equal(result.body.run.activation_dispatch_started_at,null);assert(result.body.run.reserved_microusd>0);
  assert.equal((await x.request()).body.run.id,result.body.run.id);assert.equal(x.count().providerCalls,0);
 }finally{await x.d.close()}
});
test('real activation SQL + handler: configuration changes invalidate approval before creating a fresh paid reservation',async()=>{
 const x=await setup();try{
  await approveActivation(x.d,x.saved.id);const next=await rpc(x.d,'ai_draft_save',[org,owner,1,{...config,instructions:'Different instructions must have a new exact approval.'}]);assert.equal((await x.request({configuration_id:next.id})).body.error,'activation_configuration_changed');assert.equal(x.count().providerCalls,0);assert.equal(x.count().discoveries,0);
 }finally{await x.d.close()}
});
test('backend projection rejects malformed authority and never passes unexpected fields',()=>{
 const base={contract_version:1,organization_id:org,configuration_id:key(1),enabled:true,status:'activation_authorized',activation_id:key(2),expires_at:'2099-01-01T00:00:00Z',account_binding_verified:true,limits:{request_microusd:100,daily_microusd:100,total_microusd:100,daily_runs:1,total_runs:1}};
 const parse=x=>activationVerdict(x,{organizationId:org,configurationId:key(1)});
 for(const patch of [{enabled:'true'},{account_binding_verified:'true'},{organization_id:key(99)},{configuration_id:key(99)},{activation_id:null},{status:'unknown'},{expires_at:'2000-01-01Z'},{limits:{...base.limits,total_runs:0}},{limits:{...base.limits,daily_microusd:99}},{limits:{...base.limits,credential_sha256:'not-forwarded'}}])assert.equal(parse({...base,...patch}).enabled,false);
 assert.equal(parse(base).enabled,true);assert.equal(parse({...base,credential_sha256:'do-not-forward'}).credential_sha256,undefined);assert.equal(parse(null).enabled,false);
});
test('real connected manual workflow keeps saved-source dispatch check before final one-use activation gate',async()=>{
 const x=await setup();try{
  await approveActivation(x.d,x.saved.id);
  await rpc(x.d,'customer_workflow_save_context',[org,owner,0,{company_name:'Synthetic Company',reply_guidance:'Use only these fictional support hours: weekdays from 09:00 to 17:00 UTC.'}]);
  const intake=await rpc(x.d,'customer_workflow_intake',[org,owner,key(2),{customer_email:'customer@example.test',customer_name:'Synthetic Customer',subject:'Hours',message:'When is support available?'}]);
  const workflow=await rpc(x.d,'customer_workflow_prepare_draft',[org,owner,intake.id,intake.revision,x.saved.id,key(3)]);
  const result=await x.request({request_key:key(3),input:undefined,customer_workflow_id:workflow.id,expected_revision:workflow.revision});
  assert.equal(result.status,200);assert.equal(result.body.run.status,'awaiting_review');assert.equal(x.count().providerCalls,1);
  assert.deepEqual(x.calls,['customer_workflow_draft_input','ai_inference_readiness','ai_inference_reserve','customer_workflow_draft_dispatch','ai_inference_dispatch','ai_draft_finish']);
 }finally{await x.d.close()}
});
