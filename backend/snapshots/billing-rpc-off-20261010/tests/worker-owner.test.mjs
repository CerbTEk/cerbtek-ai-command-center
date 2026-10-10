import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createSandboxOperatorVerifier, createSandboxRpcWorkerEntrypoint, PROJECT_URL, SANDBOX_OPERATOR, SANDBOX_ORGANIZATION } from '../backend/billing-worker/billing/rpc-edge-host.mjs';

const jwt='SYNTHETIC_NOT_A_REAL_TOKEN';
const user={id:SANDBOX_OPERATOR,is_anonymous:false};
const owner={contract:'billing_status_v1',authorized:true,organization_id:SANDBOX_ORGANIZATION,actor_id:SANDBOX_OPERATOR,actor_role:'owner'};
function harness({auth={data:{user},error:null},status={data:owner,error:null},enabled=true}={}) {
 const calls={client:[],auth:[],status:[],service:0,stripe:0,billing:[]};
 let currentAuth=auth,currentStatus=status;
 const verify=createSandboxOperatorVerifier({makeUserClient:async token=>{
  calls.client.push(token);
  return {auth:{getUser:async token=>{calls.auth.push(token);if(currentAuth instanceof Error)throw currentAuth;return currentAuth}},rpc:async(name,args)=>{calls.status.push({name,args});if(currentStatus instanceof Error)throw currentStatus;return currentStatus}};
 }});
 const env={SUPABASE_URL:PROJECT_URL,KAIRO_BILLING_WORKER_ENABLED:String(enabled),KAIRO_BILLING_STRIPE_READ_KEY:'rk_test_SYNTHETICONLYNOTREAL'};
 const handle=createSandboxRpcWorkerEntrypoint({getEnv:key=>env[key],getUser:verify,
  makeServiceClient:async()=>{calls.service++;return {rpc:(name,args)=>{calls.billing.push({name,args});return {abortSignal:async()=>({data:({verify_binding:true,discover:0,claim:null})[args.p_operation],error:null})}}}},
  makeStripeClient:async()=>{calls.stripe++;return {}},
 });
 return {verify,handle,calls,setAuth:value=>{currentAuth=value},setStatus:value=>{currentStatus=value}};
}
const request=(method='POST',body)=>new Request(`${PROJECT_URL}/functions/v1/billing-worker`,{method,headers:{Origin:'https://www.cerbtek.com',Authorization:`Bearer ${jwt}`},...(body===undefined?{}:{body})});

test('fresh Auth identity precedes exact current-owner status query under the same supplied session',async()=>{
 const h=harness();assert.deepEqual(await h.verify(jwt),user);
 assert.deepEqual(h.calls.client,[jwt]);assert.deepEqual(h.calls.auth,[jwt]);assert.deepEqual(h.calls.status,[{name:'kairo_billing_status',args:{p_organization_id:SANDBOX_ORGANIZATION}}]);
 assert.equal(h.calls.service,0);assert.equal(h.calls.stripe,0);
});
for(const auth of [{data:{user:null},error:null},{data:{user},error:{message:'PRIVATE_AUTH_ERROR'}},{data:{user:{id:'other-user'}},error:null},{data:{user:{...user,is_anonymous:true}},error:null},{data:null,error:null}]){
 test(`invalid identity blocks membership and privileged work: ${JSON.stringify(auth)}`,async()=>{
  const h=harness({auth});const r=await h.handle(request());assert.equal(r.status,403);assert.deepEqual(await r.json(),{code:'operator_required'});
  assert.equal(h.calls.status.length,0);assert.equal(h.calls.service,0);assert.equal(h.calls.stripe,0);assert.equal(h.calls.billing.length,0);
 });
}
const badStatuses=[null,[],{},'owner',false,{...owner,contract:'other'},{...owner,authorized:false},{...owner,authorized:'true'},
 {...owner,organization_id:'different-org'},{...owner,actor_id:'different-user'},...['admin','member',null,undefined].map(role=>({...owner,actor_role:role}))];
for(const status of badStatuses){
 test(`invalid or nonowner membership blocks privileged work: ${JSON.stringify(status)}`,async()=>{
  const h=harness({status:{data:status,error:null}});const r=await h.handle(request());assert.equal(r.status,403);assert.deepEqual(await r.json(),{code:'operator_required'});
  assert.equal(h.calls.status.length,1);assert.equal(h.calls.service,0);assert.equal(h.calls.stripe,0);assert.equal(h.calls.billing.length,0);
 });
}
test('RPC error denies even alongside apparently valid owner data without exposing its details',async()=>{
 const h=harness({status:{data:owner,error:{message:'PRIVATE_MEMBERSHIP_ERROR'}}});const r=await h.handle(request());assert.equal(r.status,403);assert.deepEqual(await r.json(),{code:'operator_required'});assert.equal(h.calls.service,0);assert.equal(h.calls.stripe,0);
});
for(const phase of ['auth','status'])test(`${phase} rejection remains sanitized and does not reach privileged clients`,async()=>{
 const h=harness({[phase]:new Error('PRIVATE_TOKEN_OR_ERROR')});const r=await h.handle(request());assert.equal(r.status,503);assert.deepEqual(await r.json(),{code:'billing_host_unavailable'});assert.equal(h.calls.service,0);assert.equal(h.calls.stripe,0);
});
test('owner revocation is rechecked on the next POST despite cached privileged runtime',async()=>{
 const h=harness();const first=await h.handle(request());assert.equal(first.status,200);assert.equal((await first.json()).claimed,0);assert.equal(h.calls.billing.length,3);
 h.setStatus({data:{...owner,actor_role:'admin'},error:null});const second=await h.handle(request());assert.equal(second.status,403);assert.deepEqual(await second.json(),{code:'operator_required'});
 assert.equal(h.calls.auth.length,2);assert.equal(h.calls.status.length,2);assert.equal(h.calls.client.length,2);assert.equal(h.calls.billing.length,3);assert.equal(h.calls.service,1);assert.equal(h.calls.stripe,1);
});
test('hard-OFF rejects before any caller-session verification',async()=>{
 const h=harness({enabled:false});const r=await h.handle(request());assert.equal(r.status,503);assert.deepEqual(await r.json(),{code:'billing_inactive'});assert.equal(h.calls.client.length,0);
});
test('empty-body and fixed method checks still precede membership access',async()=>{
 const h=harness();assert.equal((await h.handle(request('POST','{}'))).status,400);assert.equal((await h.handle(request('GET'))).status,405);assert.equal(h.calls.client.length,0);
});
test('actual entrypoint forwards caller JWT only to its fixed-project user client and stays OFF',async()=>{
 const source=await readFile(new URL('../backend/billing-worker/billing-worker/index.ts',import.meta.url),'utf8');
 assert.match(source,/getUser:createSandboxOperatorVerifier\(\{makeUserClient:async\(jwt:string\)=>/);
 assert.match(source,/createClient\(PROJECT_URL,Deno.env.get\('SUPABASE_ANON_KEY'\)/);
 assert.match(source,/headers:\{Authorization:`Bearer \$\{jwt\}`\}/);
 assert.match(source,/persistSession:false,autoRefreshToken:false/);assert.match(source,/AbortSignal.timeout\(5000\)/);
 assert.match(source,/key\.endsWith\('_ENABLED'\)\?'false':Deno.env.get\(key\)/);
 assert.doesNotMatch(source,/console\.|JSON.stringify\(jwt\)|service_role|SUPABASE_SERVICE_ROLE_KEY/);
});

test('pinned real Supabase SDK sends both Auth and status RPC as caller session, with exact fixed body',async()=>{
 const require=createRequire(new URL('../package.json',import.meta.url));
 const {createClient}=require('@supabase/supabase-js');
 assert.equal(require('@supabase/supabase-js/package.json').version,'2.58.0');
 const calls=[];
 const verify=createSandboxOperatorVerifier({makeUserClient:async token=>createClient(PROJECT_URL,'SYNTHETIC_PUBLIC_KEY',{
  auth:{persistSession:false,autoRefreshToken:false},global:{headers:{Authorization:`Bearer ${token}`},fetch:async(input,init)=>{
   calls.push({url:String(input),method:init.method,headers:new Headers(init.headers),body:init.body});
   return new Response(JSON.stringify(String(input).endsWith('/auth/v1/user')?user:owner),{status:200,headers:{'content-type':'application/json'}});
  }},
 })});
 assert.deepEqual(await verify(jwt),user);
 assert.equal(calls.length,2);assert.equal(calls[0].url,`${PROJECT_URL}/auth/v1/user`);assert.equal(calls[0].method,'GET');
 assert.equal(calls[1].url,`${PROJECT_URL}/rest/v1/rpc/kairo_billing_status`);assert.equal(calls[1].method,'POST');
 assert.deepEqual(JSON.parse(calls[1].body),{p_organization_id:SANDBOX_ORGANIZATION});
 for(const call of calls){assert.equal(call.headers.get('authorization'),`Bearer ${jwt}`);assert.equal(call.headers.get('apikey'),'SYNTHETIC_PUBLIC_KEY')}
});
