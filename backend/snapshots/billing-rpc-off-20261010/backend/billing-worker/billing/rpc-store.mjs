import { BillingError, reconcileProjection } from './core.mjs';
import { safeWorkerErrorCode, workerTime } from './worker.mjs';
import { SANDBOX_BINDING } from './sandbox-scope.mjs';

// Fixed method-level RPCs only. There is no SQL/table/schema/role transport.
// Each mutation is one server transaction. An uncertain reply is never retried here.
const readOperations = new Set(['verify_binding','load']);
const rpcCodes = new Set(['invalid_event','invalid_subscription_event','provider_binding_conflict','event_id_payload_conflict',
 'projection_binding_conflict','unresolved_lineage','worker_configuration_invalid',
 'worker_source_missing','worker_source_conflict','worker_provider_result_invalid',
 'worker_clock_invalid','worker_lease_lost','reconciliation_revision_conflict',
 'stale_reconciliation','terminal_subscription_cannot_reactivate','invalid_receipt',
 'rpc_arguments_invalid','rpc_operation_invalid']);
const fail = (code, status=409) => { throw new BillingError(code,status); };
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const validInteger = (x,min=0) => Number.isSafeInteger(x) && x >= min;
const claimKey = claim => `${claim.id}:${claim.fence}`;
function checkScope(bindingId) { if(bindingId !== SANDBOX_BINDING.id)fail('worker_configuration_invalid'); }
function checkedClaim(job) {
 if(!plain(job)||typeof job.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(job.id)
  ||job.binding_id!==SANDBOX_BINDING.id||job.kind!=='reconcile_subscription'
  ||typeof job.subject_id!=='string'||!/^sub_[A-Za-z0-9]+$/.test(job.subject_id)
  ||!validInteger(job.source_revision,1)||job.source_sha256!==null||job.state!=='leased'
  ||!validInteger(job.fence,1)||!validInteger(job.attempts,1)||!validInteger(job.updated_at)
  ||!validInteger(job.lease_expires_at,1))fail('worker_source_conflict');
 return job;
}
export function createSandboxRpcCaller({client,timeoutMs=10000}={}) {
 if(typeof client?.rpc!=='function'||!validInteger(timeoutMs,1)||timeoutMs>15000)fail('worker_configuration_invalid',503);
 return async (name,args,{readOnly=false}={})=>{
  if(!['kairo_billing_sandbox_receipt','kairo_billing_sandbox_worker'].includes(name))fail('rpc_operation_invalid');
  const controller=new AbortController();let timer;
  const unknown=()=>new BillingError(readOnly?'billing_rpc_unavailable':'billing_rpc_commit_unknown',503);
  try {
   const request=client.rpc(name,args);
   if(typeof request?.abortSignal!=='function')throw unknown();
   const pending=request.abortSignal(controller.signal);
   const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(unknown())},timeoutMs)});
   let result;
   try{result=await Promise.race([pending,timeout])}catch{throw unknown()}
   if(!plain(result)||!Object.hasOwn(result,'data')||!Object.hasOwn(result,'error'))throw unknown();
   if(result.error){
    // Database errors are observable only through this closed code allowlist.
    const message=result.error.message;
    const code=result.error.code==='P0001'&&(rpcCodes.has(message)
     ||safeWorkerErrorCode(new BillingError(message))===message)?message:null;
    if(code)fail(code);
    throw unknown();
   }
   return result.data;
  } catch(error) {
   if(error instanceof BillingError)throw error;
   throw unknown();
  } finally {clearTimeout(timer)}
 };
}
export class BillingRpcReceiptStore {
 constructor(call){this.call=call}
 async recordReceipt(receipt){
  const result=await this.call('kairo_billing_sandbox_receipt',{p_receipt:receipt});
  if(!plain(result)||result.status!==200||!['recorded','duplicate'].includes(result.code)||result.event_id!==receipt.event_id)
   fail('billing_rpc_commit_unknown',503);
  return result;
 }
}
export class BillingRpcWorkerStore {
 constructor(call){this.call=call;this.sources=new Map()}
 async operation(operation,args){return this.call('kairo_billing_sandbox_worker',{p_operation:operation,p_args:args},{readOnly:readOperations.has(operation)})}
 async verifyBinding(){if(await this.operation('verify_binding',{binding:SANDBOX_BINDING})!==true)fail('provider_binding_conflict')}
 async discover(args){
  checkScope(args.bindingId);
  if(args.limit!==1||args.refreshAfterSeconds!==null||!validInteger(args.now))fail('worker_configuration_invalid');
  const result=await this.operation('discover',args);
  if(!validInteger(result)||result>1)fail('billing_rpc_commit_unknown',503);
  return result;
 }
 async claim(args){
  checkScope(args.bindingId);
  if(args.leaseSeconds!==60||!Array.isArray(args.excludeJobIds)||args.excludeJobIds.length!==0||!validInteger(args.now))fail('worker_configuration_invalid');
  const result=await this.operation('claim',args);return result===null?null:checkedClaim(result);
 }
 async load(claim,{now}){
  checkedClaim(claim);
  const source=await this.operation('load',{claim,now});
  if(!plain(source)||(source.superseded!==true&&!plain(source.projection)))fail('worker_source_conflict');
  this.sources.set(claimKey(claim),structuredClone(source));
  return source;
 }
 async complete(claim,result,{clock}){
  checkedClaim(claim);const now=workerTime(clock),source=this.sources.get(claimKey(claim));
  if(!source)fail('worker_source_missing');
  const args={claim,now,expected_projection:null,next_projection:null,fetch_started_at:null,fetched_at:null};
  if(!source.superseded){
   const input=result?.input;
   if(!plain(input)||input.expected_revision!==claim.source_revision
    ||!plain(input.binding)||Object.entries(SANDBOX_BINDING).some(([key,value])=>input.binding[key]!==value))fail('worker_provider_result_invalid');
   if(!validInteger(input.fetch_started_at)||!validInteger(input.fetched_at)
    ||input.fetch_started_at<Math.max(claim.updated_at,source.projection.reconciled_at??0)
    ||input.fetched_at<input.fetch_started_at||input.fetched_at>now)fail('stale_reconciliation');
   args.expected_projection=source.projection;
   args.next_projection=reconcileProjection(source.projection,input);
   args.fetch_started_at=input.fetch_started_at;args.fetched_at=input.fetched_at;
  }
  const outcome=await this.operation('complete',args);
  if(!plain(outcome)||!['completed','superseded'].includes(outcome.state))fail('billing_rpc_commit_unknown',503);
  this.sources.delete(claimKey(claim));return outcome;
 }
 async fail(claim,{now,clock=()=>now,code,delaySeconds}){
  checkedClaim(claim);const current=workerTime(clock);if(current<now)fail('worker_clock_invalid');
  const args={claim,now:current,code:safeWorkerErrorCode(new BillingError(code)),delaySeconds};
  let outcome;
  try{outcome=await this.operation('fail',args)}catch(error){if(error instanceof BillingError&&error.code==='worker_lease_lost')outcome={state:'lease_lost'};else throw error}
  if(!plain(outcome)||!['retried','lease_lost'].includes(outcome.state))fail('billing_rpc_commit_unknown',503);
  this.sources.delete(claimKey(claim));return outcome;
 }
}
