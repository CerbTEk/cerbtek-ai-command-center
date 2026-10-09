import { BillingError,validateBinding,collectUsage,evaluateEntitlement } from './core.mjs';
import { createBillingDatabase } from './database.mjs';
import { BillingStore } from './store.mjs';
import { createStripeProviderReader } from './provider.mjs';
import { createBillingWebhookHandler } from './transport.mjs';
import { BillingWorkerStore } from './worker-store.mjs';
import { runOnce } from './worker.mjs';

// Separately verified isolated Kairo sandbox, not the live/shared-test account.
// This release intentionally has no live-mode runtime composition.
export const KAIRO_SANDBOX_ACCOUNT='acct_1UOjWDK7Ysc7KMp1';
const inactive=()=>({status:503,code:'billing_inactive'});
const fail=()=>{throw new BillingError('billing_runtime_configuration_invalid',503)};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Trusted host integration only: creates no listener, timer/schedule, credentials,
// grants, account binding, product or policy. Construct the official Stripe client
// and bounded TLS pool outside this module after the separate security approval.
export function createBillingRuntime({enabled=false,binding,pool,stripeClient,signingSecret,
 clock=()=>Math.floor(Date.now()/1000),refreshAfterSeconds=null,maxJobs=10}={}) {
 if(enabled!==true)return Object.freeze({
  webhook:async()=>new Response(JSON.stringify({code:'billing_inactive'}),{status:503,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}}),
  reconcileOnce:async()=>inactive(),collectStoredUsage:async()=>inactive(),
  previewEntitlement:async()=>({execution_authorized:false,evaluation:{allowed:false,reason:'billing_inactive'}}),
  diagnostics:()=>({data_pipeline_enabled:false,commercial_actions_enabled:false,live_mode_supported:false}),
 });
 try { validateBinding(binding) } catch { fail() }
 if(binding.account_id!==KAIRO_SANDBOX_ACCOUNT||binding.livemode!==false||binding.account_kind!=='platform'
  ||!['2026-08-26.dahlia','2026-09-30.endive'].includes(binding.api_version)
  ||typeof pool?.connect!=='function'||!stripeClient||typeof signingSecret!=='string'||signingSecret.length<16
  ||typeof clock!=='function'||!Number.isSafeInteger(refreshAfterSeconds)||refreshAfterSeconds<1
  ||!Number.isSafeInteger(maxJobs)||maxJobs<1||maxJobs>100)fail();
 const bound=Object.freeze({id:binding.id,account_id:binding.account_id,account_kind:binding.account_kind,livemode:false,api_version:binding.api_version});
 const db=createBillingDatabase({pool,enabled:true});
 const store=new BillingStore(db),workerStore=new BillingWorkerStore(db);
 const provider=createStripeProviderReader({client:stripeClient,binding:bound,enabled:true,clock});
 const webhook=createBillingWebhookHandler({store,binding:bound,signingSecret,enabled:true,clock});
 // Provider binding rows are immutable. Fence every host operation before any
 // queue/usage mutation or provider read, including a misconfigured pool target.
 async function verifyStoredBinding(){
  const row=(await db.query('SELECT id,account_id,account_kind,livemode,api_version FROM kairo_billing.provider_bindings WHERE id=$1',[bound.id])).rows[0];
  if(!row||Object.keys(bound).some(key=>row[key]!==bound[key]))throw new BillingError('provider_binding_conflict',409);
 }
 return Object.freeze({
  webhook,
  reconcileOnce:async()=>{await verifyStoredBinding();return runOnce({enabled:true,store:workerStore,provider,clock,bindingId:bound.id,refreshAfterSeconds,maxJobs})},
  // Explicit trusted invocation for one persisted source. No client-provided
  // quantity, browser route, collection sweep or automatic provider call.
  collectStoredUsage:async({organization_id,source_kind,source_id}={})=>{
   if(typeof organization_id!=='string'||!UUID.test(organization_id)||typeof source_id!=='string'||!UUID.test(source_id))fail();
   organization_id=organization_id.toLowerCase();source_id=source_id.toLowerCase();
   await verifyStoredBinding();
   const match=await db.query('SELECT 1 FROM kairo_billing.customer_bindings WHERE binding_id=$1 AND organization_id=$2',[bound.id,organization_id]);
   if(match.rows.length!==1)throw new BillingError('provider_binding_conflict',409);
   return collectUsage({store,organization_id,source_kind,source_id});
  },
  // Commercial-policy preview only. Existing tenant permissions, provider-spend
  // reservations and OFF-only AI/phone activation remain independent and required.
  previewEntitlement:async({organization_id,subscription_id,policy_id,policy_version,feature}={})=>{
   if(typeof organization_id!=='string'||!UUID.test(organization_id)||typeof subscription_id!=='string'||!/^sub_[A-Za-z0-9]+$/.test(subscription_id)
    ||typeof policy_id!=='string'||policy_id.length<1||policy_id.length>160||!Number.isSafeInteger(policy_version)||policy_version<1||typeof feature!=='string')fail();
   organization_id=organization_id.toLowerCase();
   await verifyStoredBinding();
   const policy=await store.loadPolicy(policy_id,policy_version);
   if(!policy||policy.binding_id!==bound.id)return {execution_authorized:false,evaluation:{allowed:false,reason:'policy_unconfigured'}};
   const context=await store.entitlementContext(organization_id,bound.id,subscription_id);
   return {execution_authorized:false,evaluation:evaluateEntitlement({organization_id,feature,policy,now:clock(),enabled:true,...context})};
  },
  diagnostics:()=>({data_pipeline_enabled:true,commercial_actions_enabled:false,live_mode_supported:false,binding_id:bound.id,account_id:bound.account_id,livemode:false,
   credential_state:'not_verified',webhook_delivery:'not_verified'}),
 });
}
