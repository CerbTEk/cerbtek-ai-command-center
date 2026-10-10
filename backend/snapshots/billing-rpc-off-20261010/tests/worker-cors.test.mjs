import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSandboxRpcWorkerEntrypoint, PROJECT_URL, SANDBOX_OPERATOR, SANDBOX_BINDING } from '../backend/billing-worker/billing/rpc-edge-host.mjs';

const origin='https://www.cerbtek.com';
const endpoint=`${PROJECT_URL}/functions/v1/billing-worker`;
function harness({enabled=true,user={id:SANDBOX_OPERATOR,is_anonymous:false},rpcFailure=false}={}) {
 const calls={env:[],users:[],rpc:[],service:0,stripe:0};
 const env={SUPABASE_URL:PROJECT_URL,KAIRO_BILLING_WORKER_ENABLED:String(enabled),KAIRO_BILLING_STRIPE_READ_KEY:'rk_test_SYNTHETICONLYNOTREAL'};
 const options={getEnv:key=>(calls.env.push(key),env[key]),getUser:async jwt=>(calls.users.push(jwt),user),clock:()=>1791672300,
  makeServiceClient:async()=>{calls.service++;return {rpc:(name,args)=>{calls.rpc.push({name,args});return {abortSignal:async()=>({data:rpcFailure?null:({verify_binding:true,discover:0,claim:null})[args.p_operation],error:rpcFailure?{code:'XX000',message:'PRIVATE_ERROR_MUST_NOT_ESCAPE'}:null})}}}},
  makeStripeClient:async()=>{calls.stripe++;return {}},
 };
 return {handle:createSandboxRpcWorkerEntrypoint(options),calls,options};
}
const request=(method='POST',headers={},body)=>new Request(endpoint,{method,headers:{Origin:origin,...headers},...(body===undefined?{}:{body})});
const auth={Authorization:'Bearer SYNTHETIC_NOT_A_REAL_TOKEN'};
const noCors=r=>assert.equal(r.headers.get('Access-Control-Allow-Origin'),null);
const cors=r=>{assert.equal(r.headers.get('Access-Control-Allow-Origin'),origin);assert.equal(r.headers.get('Vary'),'Origin');assert.equal(r.headers.get('Access-Control-Allow-Credentials'),null);assert.equal(r.headers.get('Cache-Control'),'no-store')};

test('exact-origin preflight succeeds while hard OFF without configuration, auth or clients',async()=>{
 const h=harness({enabled:false});const r=await h.handle(request('OPTIONS',{'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization, apikey, content-type, x-client-info'}));
 assert.equal(r.status,204);assert.equal(await r.text(),'');cors(r);assert.equal(r.headers.get('Access-Control-Allow-Methods'),'POST');assert.deepEqual(h.calls,{env:[],users:[],rpc:[],service:0,stripe:0});
});
test('preflight accepts only inspected header names, case-insensitively',async()=>{
 const h=harness();const r=await h.handle(request('OPTIONS',{'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':' Authorization , X-Client-Info '}));assert.equal(r.status,204);cors(r);
});
for(const requestedOrigin of ['https://cerbtek.com','http://www.cerbtek.com','https://www.cerbtek.com.evil.invalid','https://preview.cerbtek.com','null']){
 test(`rejects unapproved origin ${requestedOrigin} before auth or RPC`,async()=>{
  const h=harness();for(const method of ['POST','OPTIONS']){const r=await h.handle(request(method,{...auth,Origin:requestedOrigin,'Access-Control-Request-Method':'POST'}));assert.equal(r.status,403);noCors(r);assert.equal((await r.json()).code,'origin_not_allowed')}
  assert.deepEqual(h.calls,{env:[],users:[],rpc:[],service:0,stripe:0});
 });
}
test('OPTIONS without Origin is rejected without auth or clients',async()=>{
 const h=harness();const r=await h.handle(new Request(endpoint,{method:'OPTIONS',headers:{'Access-Control-Request-Method':'POST'}}));assert.equal(r.status,403);noCors(r);assert.equal(h.calls.service,0);
});
for(const headers of [{'Access-Control-Request-Method':'GET'},{'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,x-admin'},{'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,'},{}]){
 test(`rejects invalid preflight ${JSON.stringify(headers)}`,async()=>{const h=harness();const r=await h.handle(request('OPTIONS',headers));assert.equal(r.status,403);cors(r);assert.equal(h.calls.service,0);assert.equal(h.calls.users.length,0)});
}
test('actual POST remains OFF and sends readable inactive status to approved origin',async()=>{
 const h=harness({enabled:false});const r=await h.handle(request('POST',auth));assert.equal(r.status,503);assert.deepEqual(await r.json(),{code:'billing_inactive'});cors(r);assert.equal(h.calls.users.length,0);assert.equal(h.calls.service,0);assert.equal(h.calls.stripe,0);
});
test('preflight does not authorize a POST without Bearer authentication',async()=>{
 const h=harness();await h.handle(request('OPTIONS',{'Access-Control-Request-Method':'POST'}));const r=await h.handle(request());assert.equal(r.status,401);assert.equal((await r.json()).code,'authentication_required');cors(r);assert.equal(h.calls.service,0);
});
for(const user of [null,{id:'different-user',is_anonymous:false},{id:SANDBOX_OPERATOR,is_anonymous:true}]){
 test(`actual POST rejects unverified or wrong owner ${JSON.stringify(user)}`,async()=>{const h=harness({user});const r=await h.handle(request('POST',auth));assert.equal(r.status,403);assert.equal((await r.json()).code,'operator_required');cors(r);assert.equal(h.calls.users.length,1);assert.equal(h.calls.service,0)});
}
test('nonempty POST is still rejected before Auth, provider or RPC',async()=>{
 const h=harness();const r=await h.handle(request('POST',{...auth,'Content-Type':'application/json'},'{}'));assert.equal(r.status,400);assert.equal((await r.json()).code,'empty_body_required');cors(r);assert.equal(h.calls.users.length,0);assert.equal(h.calls.service,0);
});
test('GET remains rejected while enabled',async()=>{const h=harness();const r=await h.handle(request('GET',auth));assert.equal(r.status,405);cors(r);assert.equal(h.calls.users.length,0);assert.equal(h.calls.service,0)});
test('verified exact owner uses only fixed binding, one-job discover and 60-second claim',async()=>{
 const h=harness();const r=await h.handle(request('POST',auth));assert.equal(r.status,200);cors(r);assert.deepEqual(await r.json(),{code:'billing_worker_run',discovered:0,claimed:0,completed:0,superseded:0,retried:0,lease_lost:0,errors:[]});
 assert.deepEqual(h.calls.rpc.map(x=>x.args.p_operation),['verify_binding','discover','claim']);assert.ok(h.calls.rpc.every(x=>x.name==='kairo_billing_sandbox_worker'));
 assert.deepEqual(h.calls.rpc[0].args.p_args,{binding:SANDBOX_BINDING});assert.equal(h.calls.rpc[1].args.p_args.limit,1);assert.equal(h.calls.rpc[1].args.p_args.refreshAfterSeconds,null);assert.equal(h.calls.rpc[2].args.p_args.leaseSeconds,60);assert.equal(h.calls.rpc[2].args.p_args.bindingId,SANDBOX_BINDING.id);assert.deepEqual(h.calls.rpc[2].args.p_args.excludeJobIds,[]);
});
test('owner Auth is freshly verified on each POST despite cached runtime',async()=>{
 const h=harness();await h.handle(request('POST',auth));await h.handle(request('POST',auth));assert.equal(h.calls.users.length,2);assert.equal(h.calls.service,1);
});
test('no-Origin server request retains original fresh-owner authentication',async()=>{
 const h=harness();const r=await h.handle(new Request(endpoint,{method:'POST',headers:auth}));assert.equal(r.status,200);noCors(r);assert.equal(h.calls.users.length,1);
});
test('internal errors remain sanitized while browser can read failure status',async()=>{
 const h=harness({rpcFailure:true});const r=await h.handle(request('POST',auth));assert.equal(r.status,503);cors(r);assert.deepEqual(await r.json(),{code:'billing_host_unavailable'});
});
test('deployed candidate wrapper still hard-codes both enabled lookups OFF',async()=>{
 const source=await readFile(new URL('../backend/billing-worker/billing-worker/index.ts',import.meta.url),'utf8');assert.match(source,/key\.endsWith\('_ENABLED'\)\?'false':Deno\.env\.get\(key\)/);assert.match(source,/getUser:createSandboxOperatorVerifier/);
});
