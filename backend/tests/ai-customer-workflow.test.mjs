import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../candidate/edge/ai-draft/handler.mjs';
const org='00000000-0000-4000-8000-000000000001',actor='10000000-0000-4000-8000-000000000001';
const configId='20000000-0000-4000-8000-000000000001',workflow='30000000-0000-4000-8000-000000000001',key='40000000-0000-4000-8000-000000000001';
const config={schema_version:1,provider:'openai',model:'fixture-model',task:'customer_reply',instructions:'Use only supplied business facts.',source:'manual_context',max_input_bytes:6000,max_output_tokens:1000,max_daily_runs:3,daily_budget_microusd:1000000,human_review:true};
const account='synthetic-account',fingerprint='a'.repeat(64);
const activation=enabled=>({contract_version:1,organization_id:org,configuration_id:configId,enabled,status:enabled?'activation_authorized':'activation_disabled',activation_id:'50000000-0000-4000-8000-000000000001',expires_at:'2099-01-01T00:00:00.000Z',account_binding_verified:enabled,limits:{request_microusd:1000000,daily_microusd:1000000,total_microusd:1000000,daily_runs:3,total_runs:3}});
const context='Saved guidance version 2: Company “Synthetic”\nCustomer inquiry: Please clarify.';
function fixture({role='owner',live=true,inputResult={data:{context}},task='customer_reply'}={}){
 const calls=[];let providerCalls=0;let providerBody;
 const supabase={auth:{getUser:async()=>({data:{user:{id:actor}}})},from(table){const q={select(){return q},eq(){return q},single(){return q},maybeSingle(){return q},then(resolve){return Promise.resolve({data:table==='organization_members'?{role}:table==='ai_draft_runs'?null:{id:configId,configuration:{...config,task}}}).then(resolve)}};return q;},async rpc(name,args){calls.push({name,args});if(name==='ai_inference_readiness'){assert.equal(args.p_account,account);assert.equal(args.p_fingerprint,fingerprint);return {data:activation(live)}}if(name==='ai_inference_dispatch')return {data:true};if(name==='customer_workflow_draft_input')return inputResult;if(name==='customer_workflow_draft_dispatch')return {data:true};if(name==='ai_inference_reserve')return {data:{created:true,run:{id:key,status:'reserved'}}};if(name==='ai_draft_finish')return {data:{id:key,...args.p_result}};throw Error('Unexpected RPC');}};
 const handler=createHandler({supabase,catalog:[{provider:'openai',model:'fixture-model',input_microusd_per_token:1,output_microusd_per_token:2,structured_outputs:true}],resolveCredential:async({organizationId,provider})=>({organizationId,provider,apiKey:'synthetic-fixture',accountReference:account,credentialFingerprint:fingerprint}),discover:async()=>[{provider:'openai',model:'fixture-model',available:true,structured_outputs:true}],invoke:async body=>{providerCalls++;providerBody=body;return {draft:{title:'Synthetic',body:'Reviewed draft.',source_ids:['manual-1'],warnings:[]},usage:{input_tokens:50,output_tokens:20}};}});
 const request=async patch=>{const response=await handler(new Request('https://example.test/ai-draft',{method:'POST',headers:{Authorization:'Bearer synthetic'},body:JSON.stringify({operation:'run',organization_id:org,configuration_id:configId,request_key:key,customer_workflow_id:workflow,expected_revision:2,...patch})}));return {status:response.status,body:await response.json()};};
 return {request,calls,provider:()=>({calls:providerCalls,body:providerBody})};
}
test('connected AI run obtains exact server context and preserves existing reservation/provider pipeline',async()=>{
 const x=fixture();const r=await x.request({});assert.equal(r.status,200);assert.equal(r.body.run.status,'awaiting_review');assert.equal(x.provider().calls,1);
 assert.deepEqual(x.calls.map(c=>c.name),['customer_workflow_draft_input','ai_inference_readiness','ai_inference_reserve','customer_workflow_draft_dispatch','ai_inference_dispatch','ai_draft_finish']);
 assert.deepEqual(x.calls[0],{name:'customer_workflow_draft_input',args:{p_org:org,p_actor:actor,p_workflow:workflow,p_expected_revision:2,p_config:configId,p_request_key:key}});
 const sent=JSON.parse(x.provider().body.input[0].content[0].text);assert.equal(sent.untrusted_context,context);assert.equal(sent.source_id,'manual-1');
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({configuration_id:configId,input:{context}})));
 assert.equal(x.calls.find(c=>c.name==='ai_inference_reserve').args.p_request_hash,Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join(''));
});
test('connected AI rejects forged replacement context, identity, invalid lineage and wrong task before reserve/provider',async()=>{
 for(const patch of [{input:{context:'Injected'}},{p_actor:'forged'},{customer_workflow_id:'bad'},{expected_revision:0},{expected_revision:'2'},{customer_workflow_id:undefined}]){
  const x=fixture();assert.equal((await x.request(patch)).status,400);assert.equal(x.calls.length,0);assert.equal(x.provider().calls,0);
 }
 const x=fixture({task:'internal_summary'});assert.equal((await x.request({})).status,400);assert.equal(x.calls.length,0);
});
test('stale or malformed server snapshot fails closed with sanitized error before model discovery',async()=>{
 for(const inputResult of [{error:{message:'PRIVATE INTERNAL ERROR'}},{data:null},{data:{context,secret:'not permitted'}},{data:{context:123}}]){
  const x=fixture({inputResult});assert.deepEqual(await x.request({}),{status:409,body:{error:'customer_workflow_conflict'}});assert.equal(x.calls.length,1);assert.equal(x.provider().calls,0);
 }
});
test('employee role does not silently gain existing AI execution authority',async()=>{
 for(const role of ['member','viewer','platform_admin']){const x=fixture({role});assert.equal((await x.request({})).status,403);assert.equal(x.calls.length,0);assert.equal(x.provider().calls,0);}
});
test('authoritatively disabled inference still cannot reserve or call provider for a connected inquiry',async()=>{
 const x=fixture({live:false});assert.deepEqual(await x.request({}),{status:409,body:{error:'activation_disabled'}});assert.deepEqual(x.calls.map(c=>c.name),['customer_workflow_draft_input','ai_inference_readiness']);assert.equal(x.provider().calls,0);
});
