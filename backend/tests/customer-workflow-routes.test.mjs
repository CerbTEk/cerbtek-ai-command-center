import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../candidate/edge/customer-workflow/handler.mjs';
const org='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002',actor='10000000-0000-4000-8000-000000000001',workflow='20000000-0000-4000-8000-000000000001',config='20000000-0000-4000-8000-000000000002',key='20000000-0000-4000-8000-000000000003';
const origin='https://example.test';
const intake={customer_email:'customer@example.test',customer_name:'Synthetic Customer',subject:'Support question',message:'When is support available?'};
function fixture(){
 const state={calls:[],user:{id:actor},result:{actor:{id:actor,role:'owner'},workflows:[],readiness:{live_inference_enabled:false}},error:null};
 const supabase={auth:{getUser:async token=>{state.token=token;return {data:{user:state.user},error:state.authError}}},rpc:async(name,args)=>{state.calls.push({name,args});return {data:state.result,error:state.error}}};
 state.handler=createHandler({supabase,allowedOrigins:[origin]});return state;
}
const request=(body,options={})=>new Request('https://local.test/customer-workflow',{method:options.method||'POST',headers:{authorization:'Bearer synthetic-jwt',origin,...options.headers},body:options.method&&options.method!=='POST'?undefined:JSON.stringify(body)});
async function invoke(s,body,options){const response=await s.handler(request({organization_id:org,...body},options));return {status:response.status,body:await response.json(),headers:response.headers}}
test('load verifies actor and company; exact-origin CORS and no-store',async()=>{
 const s=fixture();const out=await invoke(s,{operation:'load'});assert.equal(out.status,200);assert.equal(out.body.ok,true);assert.equal(out.body.contract_version,1);assert.equal(out.body.organization_id,org);assert.equal(out.body.readiness.live_inference_enabled,false);assert.equal(out.headers.get('cache-control'),'no-store');assert.equal(out.headers.get('access-control-allow-origin'),origin);
 assert.deepEqual(s.calls,[{name:'customer_workflow_load',args:{p_org:org,p_actor:actor}}]);
});
test('anonymous, absent or failed authentication never reaches service RPC',async()=>{
 for(const user of [null,{id:actor,is_anonymous:true}]){const s=fixture();s.user=user;const out=await invoke(s,{operation:'load'});assert.equal(out.status,401);assert.equal(s.calls.length,0)}
 const s=fixture();const out=await invoke(s,{operation:'load'},{headers:{authorization:''}});assert.equal(out.status,401);assert.equal(s.calls.length,0);
});
test('wrong-origin, method, unknown operation and malformed JSON fail closed',async()=>{
 const s=fixture();assert.equal((await invoke(s,{operation:'load'},{headers:{origin:'https://attacker.test'}})).status,403);assert.equal((await invoke(s,{operation:'load'},{method:'GET'})).status,405);
 assert.equal((await invoke(s,{operation:'execute'})).status,400);assert.equal((await invoke(s,{operation:'__proto__'})).status,400);assert.equal(s.calls.length,0);
 const malformed=await s.handler(new Request('https://local.test/',{method:'POST',headers:{authorization:'Bearer token'},body:'{'}));assert.equal(malformed.status,400);
});
for(const forged of ['actor_id','requested_by','payload','approved_by','status','workflow_run_id','input','connection_id','endpoint'])test(`client-forged ${forged} never reaches RPC`,async()=>{
 const s=fixture();assert.equal((await invoke(s,{operation:'intake',request_key:key,...intake,[forged]:'forged'})).status,400);assert.equal(s.calls.length,0);
});
test('intake derives actor exclusively from verified session',async()=>{
 const s=fixture();s.result={id:workflow,organization_id:org,revision:1};const out=await invoke(s,{operation:'intake',request_key:key,...intake});assert.equal(out.status,200);assert.deepEqual(s.calls[0],{name:'customer_workflow_intake',args:{p_org:org,p_actor:actor,p_request_key:key,p_intake:intake}});assert.equal(out.body.workflow.id,workflow);
});
test('prepare passes only immutable source references; no provider is called',async()=>{
 const s=fixture();s.result={id:workflow,organization_id:org,revision:2};const out=await invoke(s,{operation:'prepare_draft',workflow_id:workflow,expected_revision:1,configuration_id:config,request_key:key});assert.equal(out.status,200);assert.deepEqual(s.calls[0],{name:'customer_workflow_prepare_draft',args:{p_org:org,p_actor:actor,p_workflow:workflow,p_expected_revision:1,p_config:config,p_request_key:key}});
});
test('save context accepts only explicit company guidance and expected version',async()=>{
 const s=fixture();s.result={id:workflow,organization_id:org,version:1};const context={company_name:'Fixture',reply_guidance:'Use only confirmed company facts.'};assert.equal((await invoke(s,{operation:'save_context',expected_version:0,context})).status,200);assert.deepEqual(s.calls[0].args,{p_org:org,p_actor:actor,p_expected_version:0,p_context:context});
 assert.equal((await invoke(s,{operation:'save_context',expected_version:1,context:{...context,documents:[]}})).status,400);
});
test('queue returns exact saved action; caller cannot supply email edit or approval',async()=>{
 const s=fixture();const action={id:key,payload:{to:intake.customer_email,subject:'Draft',message:'Confirmed content'},status:'Pending'};s.result={id:workflow,organization_id:org,revision:3,action_request:action};
 const out=await invoke(s,{operation:'queue',workflow_id:workflow,expected_revision:2});assert.deepEqual(out.body.request,action);assert.deepEqual(s.calls[0].args,{p_org:org,p_actor:actor,p_workflow:workflow,p_expected_revision:2});
});
test('cross-company or actor result is rejected rather than displayed',async()=>{
 const s=fixture();s.result={actor:{id:actor,role:'owner'},workflows:[{organization_id:other}]};assert.equal((await invoke(s,{operation:'load'})).status,503);
 s.result={actor:{id:'wrong',role:'owner'},workflows:[]};assert.equal((await invoke(s,{operation:'load'})).status,503);
 s.result={id:workflow,organization_id:other};assert.equal((await invoke(s,{operation:'cancel',workflow_id:workflow,expected_revision:1})).status,503);
});
test('storage errors are sanitized; missing contract is visibly unavailable',async()=>{
 const s=fixture();s.error={code:'42883',message:'internal database detail'};assert.equal((await invoke(s,{operation:'load'})).body.error,'customer_workflow_not_installed');
 s.error={code:'P0001',message:'Organization access denied'};assert.equal((await invoke(s,{operation:'load'})).status,403);
 s.error={code:'P0001',message:'Saved context is stale, internal relation details'};const out=await invoke(s,{operation:'queue',workflow_id:workflow,expected_revision:1});assert.equal(out.status,409);assert(!JSON.stringify(out.body).includes('internal'));
});
test('size and revision bounds stop before any mutation',async()=>{
 const s=fixture();assert.equal((await invoke(s,{operation:'intake',request_key:key,...intake,message:'a'.repeat(45001)})).status,413);
 for(const expected_revision of [0,-1,1.5,'1',null])assert.equal((await invoke(s,{operation:'cancel',workflow_id:workflow,expected_revision})).status,400);
 assert.equal(s.calls.length,0);
});

const knowledgeRef={document_id:'30000000-0000-4000-8000-000000000001',version_id:'30000000-0000-4000-8000-000000000002',chunk_id:'30000000-0000-4000-8000-000000000003',content_sha256:'a'.repeat(64),version_sha256:'b'.repeat(64)};
test('knowledge selection prepares exact references without browser content or authority',async()=>{
 const s=fixture();s.result={id:workflow,organization_id:org,revision:2,knowledge_sources:[],knowledge_stale:false};
 assert.equal((await invoke(s,{operation:'prepare_draft',workflow_id:workflow,expected_revision:1,configuration_id:config,request_key:key,knowledge_sources:[knowledgeRef]})).status,200);
 assert.deepEqual(s.calls[0],{name:'customer_workflow_prepare_sources',args:{p_org:org,p_actor:actor,p_workflow:workflow,p_expected_revision:1,p_config:config,p_request_key:key,p_sources:[knowledgeRef]}});
 for(const knowledge_sources of [null,[{...knowledgeRef,content_text:'substitute'}],[knowledgeRef,knowledgeRef],Array(6).fill(knowledgeRef),[{...knowledgeRef,chunk_id:'wrong'}]])assert.equal((await invoke(s,{operation:'prepare_draft',workflow_id:workflow,expected_revision:1,configuration_id:config,request_key:key,knowledge_sources})).status,400);
 assert.equal(s.calls.length,1);
});
test('knowledge search and preview preserve verified manager actor and exact reference',async()=>{
 const s=fixture();s.result={organization_id:org,actor:{id:actor,role:'admin'},results:[]};
 assert.equal((await invoke(s,{operation:'knowledge_search',query:'  published policy  '})).status,200);assert.deepEqual(s.calls[0].args,{p_org:org,p_actor:actor,p_query:'published policy'});
 s.result={organization_id:org,actor:{id:actor,role:'admin'},source:{...knowledgeRef}};
 assert.equal((await invoke(s,{operation:'knowledge_source',...knowledgeRef})).status,200);assert.deepEqual(s.calls[1].args.p_reference,knowledgeRef);
 for(const role of ['member','viewer']){s.result.actor.role=role;assert.equal((await invoke(s,{operation:'knowledge_source',...knowledgeRef})).status,503)}
 s.result.actor.role='owner';s.result.organization_id=other;assert.equal((await invoke(s,{operation:'knowledge_source',...knowledgeRef})).status,503);
 for(const query of ['', 'a', 'x'.repeat(201),{},null])assert.equal((await invoke(s,{operation:'knowledge_search',query})).status,400);
});
