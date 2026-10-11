import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../candidate/edge/workflow-installations/handler.mjs';
const org='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
const actor='10000000-0000-4000-8000-000000000001',id='20000000-0000-4000-8000-000000000001',key='30000000-0000-4000-8000-000000000001',workflowId='40000000-0000-4000-8000-000000000001';
const bindings={context_version_id:null,configuration_id:null,microsoft_connection_id:null,assigned_to:null,reviewer_id:null};
const installation={id,installation_id:id,organization_id:org,revision:1,recipe_key:'customer_followup',recipe_version:1,bindings,status:'setup_needed',readiness:{configured:false,can_start:false,reasons:['context_missing'],live_inference_enabled:false,automatic_execution_enabled:false}};
const loadBody={organization_id:org,actor:{id:actor,role:'owner'},recipes:[{recipe_key:'customer_followup',version:1,recipe_version:1,definition:{automatic_execution:false,live_inference_enabled:false}}],installations:[installation],operation_receipts:[],workspace:{actor:{id:actor,role:'owner'},context:null,configuration:null,workflows:[],readiness:{live_inference_enabled:false}}};
const saveBody={operation:'save',organization_id:org,installation_id:null,expected_revision:0,request_key:key,recipe_key:'customer_followup',recipe_version:1,name:'Follow up',outcome:'Provide reviewed customer follow-ups.',bindings,limits:{max_open_requests:10}};
const intake={customer_email:'synthetic@example.test',customer_name:'Synthetic customer',subject:'Question',message:'Please confirm the saved support hours.'};
function fixture({data=loadBody,error=null,authUser={id:actor},authError=null,throwRpc=false}={}){
 const calls=[];const supabase={auth:{getUser:async token=>{calls.push(['auth',token]);return {data:{user:authUser},error:authError}}},rpc:async(name,args)=>{calls.push([name,args]);if(throwRpc)throw new Error('transport failed');return {data:structuredClone(data),error}}};
 return {calls,handle:createHandler({supabase,allowedOrigins:['https://app.example.test']})};
}
const request=(body={operation:'load',organization_id:org},options={})=>new Request('https://edge.example.test/workflow-installations',{method:options.method||'POST',headers:{authorization:'Bearer synthetic-token',origin:'https://app.example.test',...options.headers},...(options.method==='OPTIONS'||options.method==='GET'?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
async function call(f,body,options){const response=await f.handle(request(body,options));return {status:response.status,body:await response.json(),headers:response.headers}}

test('auth token is verified and p_actor is derived exclusively from authenticated user',async()=>{
 const f=fixture();const r=await call(f);assert.equal(r.status,200);assert.equal(r.body.ok,true);assert.deepEqual(f.calls[1],['workflow_installations_load',{p_org:org,p_actor:actor}]);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('access-control-allow-origin'),'https://app.example.test');
 const forged=await call(f,{operation:'load',organization_id:org,p_actor:id});assert.equal(forged.status,400);assert.equal(forged.body.write_outcome,'not_applied');
});
test('missing/anonymous/invalid auth never reaches RPC',async()=>{
 for(const options of [{authUser:null},{authUser:{id:actor,is_anonymous:true}},{authError:{message:'expired'}}]){const f=fixture(options);const r=await call(f);assert.equal(r.status,401);assert.equal(f.calls.length,1)}
 const f=fixture();const r=await call(f,undefined,{headers:{authorization:''}});assert.equal(r.status,401);assert.equal(f.calls.length,0);
});
test('origin/method/preflight/body-size limits run without writes',async()=>{
 const f=fixture();assert.equal((await call(f,undefined,{headers:{origin:'https://evil.example.test'}})).status,403);assert.equal(f.calls.length,0);
 const preflight=await f.handle(request(undefined,{method:'OPTIONS'}));assert.equal(preflight.status,204);assert.equal(f.calls.length,0);
 assert.equal((await call(f,undefined,{method:'GET'})).status,405);assert.equal((await call(f,'bad json')).status,400);assert.equal((await call(f,'x'.repeat(45001))).status,413);assert(!f.calls.some(c=>c[0].startsWith('workflow_')));
});
test('save passes an exact bounded spec, accepts nullable bindings, forbids optimistic readiness/execution',async()=>{
 const f=fixture({data:installation});const r=await call(f,saveBody);assert.equal(r.status,200);assert.equal(r.body.installation.id,id);assert.equal(f.calls[1][0],'workflow_installations_save');assert.equal(f.calls[1][1].p_installation,null);assert.equal(f.calls[1][1].p_spec.recipe_version,1);
 for(const body of [{...saveBody,readiness:{configured:true}},{...saveBody,recipe_version:2},{...saveBody,limits:{max_open_requests:101}},{...saveBody,limits:{max_open_requests:0}},{...saveBody,limits:{max_open_requests:1,automatic_execution:true}},{...saveBody,bindings:{...bindings,secret:'forbidden'}},{...saveBody,bindings:{...bindings,reviewer_id:'bad'}},{...saveBody,expected_revision:1},{...saveBody,installation_id:id,expected_revision:0},{...saveBody,outcome:'short'}]){const invalid=fixture();const result=await call(invalid,body);assert.equal(result.status,400);assert.equal(result.body.write_outcome,'not_applied');assert.equal(invalid.calls.length,1)}
});
test('start requires immutable exact intake and returns verified durable provenance',async()=>{
 const started={installation,workflow:{id:workflowId,organization_id:org,request_key:key},provenance:{organization_id:org,installation_id:id,installation_revision:1,workflow_id:workflowId,request_key:key,started_by:actor},replayed:false};
 const f=fixture({data:started});const body={operation:'start',organization_id:org,installation_id:id,expected_revision:1,request_key:key,intake};const r=await call(f,body);assert.equal(r.status,200);assert.equal(r.body.workflow.id,workflowId);assert.equal(f.calls[1][0],'workflow_installations_start');assert.deepEqual(f.calls[1][1].p_intake,intake);
 assert.equal((await call(f,{...body,intake:{...intake,approved_by:actor}})).status,400);
 for(const mutate of [v=>v.workflow.organization_id=other,v=>v.provenance.started_by=id,v=>v.provenance.installation_revision=2,v=>v.workflow.request_key=id,v=>v.workflow.configuration={organization_id:other},v=>v.installation.readiness.live_inference_enabled=true]){const data=structuredClone(started);mutate(data);const result=await call(fixture({data}),body);assert.equal(result.status,503);assert.equal(result.body.write_outcome,'unknown')}
});
test('load rejects cross-tenant/nested data and falsely active runtime rather than exposing it',async()=>{
 for(const mutate of [v=>v.organization_id=other,v=>v.actor.id=id,v=>v.installations[0].organization_id=other,v=>v.workspace.configuration={organization_id:other},v=>v.workspace.workflows=[{id:workflowId,organization_id:other}],v=>v.installations[0].readiness.automatic_execution_enabled=true,v=>v.installations[0].readiness.reasons=[{}],v=>v.recipes[0].definition.automatic_execution=true]){const data=structuredClone(loadBody);mutate(data);const r=await call(fixture({data}));assert.equal(r.status,503);assert.equal(r.body.error,'installation_storage_unavailable');assert(!JSON.stringify(r.body).includes(other))}
});
test('explicit SQL transaction rejections differ from unknown delivery/storage errors',async()=>{
 for(const [error,status,code] of [[{code:'P0001',message:'reviewer_conflict'},409,'reviewer_conflict'],[{code:'P0001',message:'Idempotency conflict'},409,'idempotency_conflict'],[{code:'P0001',message:'Installation dependencies changed'},409,'installation_changed_or_not_ready'],[{code:'P0001',message:'Organization access denied'},403,'organization_access_denied'],[{code:'42501'},403,'organization_access_denied'],[{code:'42883'},503,'workflow_installations_not_installed'],[{code:'PGRST202'},503,'workflow_installations_not_installed']]){const r=await call(fixture({error}),saveBody);assert.equal(r.status,status);assert.equal(r.body.error,code);assert.equal(r.body.write_outcome,'not_applied')}
 for(const f of [fixture({throwRpc:true}),fixture({error:{message:'fetch failed access denied'}}),fixture({error:{code:'PGRST000',message:'connection failed'}}),fixture({data:null}),fixture({data:{...installation,organization_id:other}})]){const r=await call(f,saveBody);assert.equal(r.status,503);assert.equal(r.body.write_outcome,'unknown')}
});

test('workspace preserves existing independent authorized inference readiness',async()=>{const data=structuredClone(loadBody);data.workspace.readiness.live_inference_enabled=true;const r=await call(fixture({data}));assert.equal(r.status,200);assert.equal(r.body.workspace.readiness.live_inference_enabled,true);assert.equal(r.body.installations[0].readiness.live_inference_enabled,false)});

test('new provider-neutral email binding passes without rewriting legacy or accepting both keys',async()=>{
 const neutral={...bindings,email_connection_id:bindings.microsoft_connection_id};delete neutral.microsoft_connection_id;
 const f=fixture({data:{...installation,bindings:neutral}});const r=await call(f,{...saveBody,bindings:neutral});assert.equal(r.status,200);assert.deepEqual(f.calls[1][1].p_spec.bindings,neutral);
 const ambiguous=fixture();assert.equal((await call(ambiguous,{...saveBody,bindings:{...neutral,microsoft_connection_id:null}})).status,400);assert.equal(ambiguous.calls.length,1);
});
