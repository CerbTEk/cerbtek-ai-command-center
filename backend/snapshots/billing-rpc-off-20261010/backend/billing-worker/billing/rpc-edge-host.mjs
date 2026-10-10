import { createSandboxRpcCaller, BillingRpcReceiptStore, BillingRpcWorkerStore } from './rpc-store.mjs';
import { createBillingWebhookHandler } from './transport.mjs';
import { createStripeProviderReader } from './provider.mjs';
import { runOnce } from './worker.mjs';

import { PROJECT_REF,PROJECT_URL,SANDBOX_BINDING,SANDBOX_ORGANIZATION,SANDBOX_OPERATOR,SANDBOX_CUSTOMER } from './sandbox-scope.mjs';
export { PROJECT_REF,PROJECT_URL,SANDBOX_BINDING,SANDBOX_ORGANIZATION,SANDBOX_OPERATOR,SANDBOX_CUSTOMER } from './sandbox-scope.mjs';
const reply = (status,code,extra={}) => new Response(JSON.stringify({code,...extra}),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const fail = () => { throw new Error('billing_host_configuration_invalid'); };

// CORS only admits the existing Kairo app origin. It never authorizes a worker
// operation: every actual POST still passes the OFF, fresh-user and scope guards.
const workerOrigin = 'https://www.cerbtek.com';
const workerRequestHeaders = new Set(['authorization','apikey','content-type','x-client-info']);
function workerCors(response) {
 const headers=new Headers(response.headers);
 headers.set('Access-Control-Allow-Origin',workerOrigin);
 headers.set('Vary','Origin');
 return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}
function workerPreflight(request) {
 const requested=request.headers.get('access-control-request-headers')??'';
 if(request.headers.get('access-control-request-method')!=='POST'||requested.length>256
   ||(requested!==''&&requested.split(',').some(value=>!workerRequestHeaders.has(value.trim().toLowerCase()))))
  return workerCors(reply(403,'cors_preflight_rejected'));
 return new Response(null,{status:204,headers:{
  'Access-Control-Allow-Origin':workerOrigin,'Access-Control-Allow-Methods':'POST',
  'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info',
  'Vary':'Origin','Cache-Control':'no-store',
 }});
}

async function emptyBody(request) {
 const length=request.headers.get('content-length');
 if(length!==null&&(!/^[0-9]+$/.test(length)||Number(length)!==0))return false;
 if(request.body===null)return true;
 const reader=request.body.getReader();let timer;
 const timeout=new Promise(resolve=>{timer=setTimeout(()=>resolve({timedOut:true}),2000)});
 try{for(let reads=0;reads<16;reads++){const part=await Promise.race([reader.read(),timeout]);if(part.timedOut)return false;if(part.value?.byteLength>0)return false;if(part.done)return true}return false}catch{return false}
 finally{clearTimeout(timer);void reader.cancel().catch(()=>{});reader.releaseLock()}
}

function get(getEnv,key){const v=getEnv(key);if(typeof v!=='string'||!v)fail();return v}
function configured(getEnv){if(get(getEnv,'SUPABASE_URL')!==PROJECT_URL)fail()}
async function rpcFor(makeServiceClient){
 const client=await makeServiceClient();
 return createSandboxRpcCaller({client});
}
// This client carries the caller's existing JWT, never the service identity.
// The guarded status RPC re-reads membership under the organization mutex.
// It must prove the exact current QA owner before any billing write RPC runs.
export function createSandboxOperatorVerifier({makeUserClient}={}) {
 return async jwt=>{
  const client=await makeUserClient(jwt);
  const {data:auth,error:authError}=await client.auth.getUser(jwt);
  const user=auth?.user;
  if(authError||!user||user.id!==SANDBOX_OPERATOR||user.is_anonymous===true)return null;
  const {data:status,error:statusError}=await client.rpc('kairo_billing_status',{
   p_organization_id:SANDBOX_ORGANIZATION,
  });
  if(statusError||!status||Array.isArray(status)||status.contract!=='billing_status_v1'
   ||status.authorized!==true||status.organization_id!==SANDBOX_ORGANIZATION
   ||status.actor_id!==user.id||status.actor_role!=='owner')return null;
  return user;
 };
}
// The host supplies only Supabase's existing built-in server identity. No database
// password, URL, pg driver, TLS CA, role login, or direct-table client is constructed.
// No Stripe read key is accessed by webhook intake. Stripe's raw-body signature is its auth.
export function createSandboxRpcWebhookEntrypoint({getEnv,makeServiceClient,clock=()=>Math.floor(Date.now()/1000)}={}){
 let handlerPromise;
 return async request=>{
  if(getEnv('KAIRO_BILLING_WEBHOOK_ENABLED')!=='true')return reply(503,'billing_inactive');
  if(request.method!=='POST')return reply(405,'method_not_allowed');
  try{
   configured(getEnv);
   handlerPromise??=(async()=>{
    const secret=get(getEnv,'KAIRO_BILLING_STRIPE_WEBHOOK_SECRET');if(!/^whsec_[A-Za-z0-9]+$/.test(secret))fail();
    return createBillingWebhookHandler({enabled:true,store:{recordReceipt:async receipt=>{
     if(receipt.event_type!=='customer.subscription.created'||receipt.customer_id!==SANDBOX_CUSTOMER)return {status:200,code:'ignored_test_scope'};
     // Obtain the built-in server identity only after signature verification and
     // the fixed sandbox customer/event scope check have both succeeded.
     const call=await rpcFor(makeServiceClient);
     return new BillingRpcReceiptStore(call).recordReceipt(receipt);
    }},binding:SANDBOX_BINDING,signingSecret:secret,clock});
   })();
   return await (await handlerPromise)(request);
  }catch{handlerPromise=undefined;return reply(503,'billing_host_unavailable')}
 };
}
// Manual owner-only route. Fixed maxJobs=1, no refresh sweep, no timers or cron.
// getUser is supplied by the host and must verify against this project's Auth server.
export function createSandboxRpcWorkerEntrypoint({getEnv,makeServiceClient,makeStripeClient,getUser,clock=()=>Math.floor(Date.now()/1000)}={}){
 let runtimePromise;
 const handleRequest=async request=>{
  if(getEnv('KAIRO_BILLING_WORKER_ENABLED')!=='true')return reply(503,'billing_inactive');
  if(request.method!=='POST')return reply(405,'method_not_allowed');
  const header=request.headers.get('authorization');
  if(typeof header!=='string'||header.length>8192||!/^Bearer \S+$/.test(header))return reply(401,'authentication_required');
  // The caller cannot choose account, binding, batch size, tenant, or provider data.
  if(!await emptyBody(request))return reply(400,'empty_body_required');
  try{
   configured(getEnv);
   const operator=SANDBOX_OPERATOR;
   const user=await getUser(header.slice(7));
   if(!user||user.id!==operator||user.is_anonymous===true)return reply(403,'operator_required');
   runtimePromise??=(async()=>{
    const secret=get(getEnv,'KAIRO_BILLING_STRIPE_READ_KEY');if(!/^rk_test_[A-Za-z0-9]+$/.test(secret))fail();
    const call=await rpcFor(makeServiceClient);
    const client=await makeStripeClient(secret,{apiVersion:SANDBOX_BINDING.api_version,maxNetworkRetries:0,timeout:5000,telemetry:false});
    return {store:new BillingRpcWorkerStore(call),provider:createStripeProviderReader({client,binding:SANDBOX_BINDING,enabled:true,clock})};
   })();
   const runtime=await runtimePromise;
   await runtime.store.verifyBinding();
   const result=await runOnce({enabled:true,store:runtime.store,provider:runtime.provider,clock,bindingId:SANDBOX_BINDING.id,maxJobs:1,refreshAfterSeconds:null});
   return reply(result.status,result.code,{discovered:result.discovered,claimed:result.claimed,completed:result.completed,superseded:result.superseded,retried:result.retried,lease_lost:result.lease_lost,errors:result.errors});
  }catch{runtimePromise=undefined;return reply(503,'billing_host_unavailable')}
 };
 return async request=>{
  const origin=request.headers.get('origin');
  if(origin!==null&&origin!==workerOrigin)return reply(403,'origin_not_allowed');
  if(request.method==='OPTIONS'){
   if(origin!==workerOrigin)return reply(403,'cors_preflight_rejected');
   return workerPreflight(request);
  }
  const response=await handleRequest(request);
  return origin===workerOrigin?workerCors(response):response;
 };
}
