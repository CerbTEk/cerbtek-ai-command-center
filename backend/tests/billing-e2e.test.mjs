import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createStripeProviderReader} from '../candidate/edge/billing/provider.mjs';
import {createBillingWebhookHandler} from '../candidate/edge/billing/transport.mjs';
import {BillingWorkerStore} from '../candidate/edge/billing/worker-store.mjs';
import {runOnce} from '../candidate/edge/billing/worker.mjs';
import {evaluateEntitlement} from '../candidate/edge/billing/core.mjs';
import {database,binding,event,signed,now,org,policy} from './fixtures/billing-fixtures.mjs';
import {stripeFixture} from './fixtures/billing-provider-fixtures.mjs';
async function scenario(fn){
 const {db,store}=await database();
 try{
  await db.exec(await readFile(new URL('../candidate/sql/billing-worker-contract.sql',import.meta.url),'utf8'));
  const fixture=stripeFixture({modeBinding:binding});
  const provider=createStripeProviderReader({enabled:true,client:fixture.client,binding,clock:()=>now});
  const worker=new BillingWorkerStore(db);
  const run=()=>runOnce({enabled:true,bindingId:binding.id,store:worker,provider,clock:()=>now,maxJobs:10,refreshAfterSeconds:300});
  const deliver=async e=>{const s=signed(e);const handler=createBillingWebhookHandler({enabled:true,store,binding,signingSecret:s.secret,clock:()=>now});return handler(new Request('https://synthetic.example/stripe',{method:'POST',headers:{'content-type':'application/json','stripe-signature':s.signature},body:s.raw}))};
  const entitlement=async()=>evaluateEntitlement({organization_id:org,feature:'ai_draft',policy:policy(),now,enabled:true,...await store.entitlementContext(org,binding.id,'sub_SYNTHETIC')});
  return await fn({db,store,fixture,run,deliver,entitlement});
 }finally{await db.close()}
}
test('signed webhook → durable job → official SDK graph → fenced projection → explicit entitlement',()=>scenario(async({db,fixture,run,deliver,entitlement})=>{
 assert.equal((await deliver(event())).status,200);assert.equal((await entitlement()).allowed,false);
 const report=await run();assert.equal(report.completed,1);assert.equal((await entitlement()).allowed,true);
 assert(fixture.requests.length>0&&fixture.requests.every(r=>r.method==='GET'));
 assert.equal((await deliver(event())).status,200);assert.equal((await run()).claimed,0);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM kairo_billing.provider_receipts')).rows[0].n,1);
}));
test('refund webhook holds immediately; graph resolution and refreshed policy preserve history',()=>scenario(async({db,fixture,run,deliver,entitlement})=>{
 await deliver(event());await run();assert.equal((await entitlement()).allowed,true);
 fixture.data.refunds.push({object:'refund',id:'re_FULL',charge:'ch_SYNTHETIC',payment_intent:'pi_SYNTHETIC',amount:100,currency:'usd',status:'succeeded'});fixture.data.charges[0].amount_refunded=100;
 await deliver(event({id:'evt_REFUND',type:'refund.created',data:{object:fixture.data.refunds[0]}}));assert.equal((await entitlement()).reason,'unresolved_customer_event');
 assert.equal((await run()).completed,1);assert.equal((await entitlement()).reason,'subscription_unverified');
 assert.equal((await run()).completed,1);assert.equal((await entitlement()).reason,'refund_policy_denied');
 assert.equal((await db.query('SELECT count(*)::int AS n FROM kairo_billing.provider_receipts')).rows[0].n,2);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM kairo_billing.projection_history')).rows[0].n,4);
}));
test('unbound standalone refund can be proved irrelevant without creating a Kairo customer binding',()=>scenario(async({db,fixture,run,deliver,entitlement})=>{
 await deliver(event());await run();
 fixture.data.customers.push({id:'cus_UNBOUND',object:'customer',livemode:false});
 fixture.data.invoices.push({...fixture.data.invoices[0],id:'in_STANDALONE',customer:'cus_UNBOUND',parent:null});
 fixture.data.payments.push({...fixture.data.payments[0],id:'inpay_STANDALONE',invoice:'in_STANDALONE',payment:{type:'payment_intent',payment_intent:'pi_STANDALONE'}});
 fixture.data.intents.push({...fixture.data.intents[0],id:'pi_STANDALONE',customer:'cus_UNBOUND',latest_charge:'ch_STANDALONE'});
 fixture.data.charges.push({...fixture.data.charges[0],id:'ch_STANDALONE',customer:'cus_UNBOUND',payment_intent:'pi_STANDALONE',amount_refunded:100});
 const r={object:'refund',id:'re_STANDALONE',charge:'ch_STANDALONE',payment_intent:'pi_STANDALONE',amount:100,currency:'usd',status:'succeeded'};fixture.data.refunds.push(r);
 await deliver(event({id:'evt_STANDALONE',type:'refund.created',data:{object:r}}));assert.equal((await entitlement()).allowed,false);
 assert.equal((await run()).completed,1);assert.equal((await entitlement()).allowed,true);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM kairo_billing.customer_bindings')).rows[0].n,1);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM kairo_billing.receipt_dispositions')).rows[0].n,1);
}));
