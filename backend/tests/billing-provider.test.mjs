import test from 'node:test';
import assert from 'node:assert/strict';
import {createStripeProviderReader} from '../candidate/edge/billing/provider.mjs';
import {reconcileProjection,evaluateEntitlement} from '../candidate/edge/billing/core.mjs';
import {now,org,policy} from './fixtures/billing-fixtures.mjs';
import {binding,projection,stripeFixture} from './fixtures/billing-provider-fixtures.mjs';
const make=(fixture={},config={})=>{const f=stripeFixture(fixture);return {...f,provider:createStripeProviderReader({enabled:true,client:f.client,binding,clock:()=>now,...config})}};
const code=value=>error=>error.code===value;
const refund=(extra={})=>({object:'refund',id:'re_SYNTHETIC',charge:'ch_SYNTHETIC',payment_intent:'pi_SYNTHETIC',amount:20,currency:'usd',status:'succeeded',...extra});
const receipt=extra=>({binding_id:binding.id,event_id:'evt_REFUND',event_type:'refund.created',object_id:'re_SYNTHETIC',payload_sha256:'a'.repeat(64),customer_id:null,subscription_id:null,...extra});

test('reader is inactive before client, binding or clock use',async()=>{
 let calls=0;const reader=createStripeProviderReader({client:new Proxy({},{get(){calls++;throw Error('blocked')}}),clock(){throw Error('clock')}});
 await assert.rejects(()=>reader.readSubscription(projection),code('provider_inactive'));await assert.rejects(()=>reader.resolveReceipt(receipt()),code('provider_inactive'));assert.equal(calls,0);
});
test('official SDK synthetic HTTP graph produces subject-bound paid evidence without any mutation',async()=>{
 const {provider,requests}=make();const result=await provider.readSubscription(projection);
 assert.equal(result.payment.state,'paid');assert.equal(result.payment.subscription_id,projection.subscription_id);assert.equal(result.refund_graph_complete,true);assert.deepEqual(result.refunds,[]);
 assert(requests.length>10);assert(requests.every(r=>r.method==='GET'&&r.version===binding.api_version));assert(requests.every(r=>r.context===null));
 const ready=reconcileProjection({...projection,state:'needs_reconciliation',terminal:false},result);
 assert.equal(evaluateEntitlement({organization_id:org,feature:'ai_draft',projection:ready,policy:policy(),now,enabled:true,customer_hold:false}).allowed,true);
});
test('connected account context is explicit on every SDK request',async()=>{
 const b={...binding,account_kind:'connected'};const {provider,requests}=make({modeBinding:b},{binding:b});await provider.readSubscription(projection);assert(requests.every(r=>r.context===b.account_id));
});
test('account mismatch fails before customer/subscription data reads',async()=>{
 const {provider,requests}=make({modify:d=>{d.account.id='acct_OTHER'}});await assert.rejects(()=>provider.readSubscription(projection),code('provider_identity_mismatch'));assert.equal(requests.length,1);
});
test('wrong customer or mode cannot become payment evidence',async()=>{
 for(const modify of [d=>{d.customers[0].livemode=true},d=>{d.subscriptions[0].customer='cus_OTHER'},d=>{d.invoices[0].livemode=true},d=>{d.charges[0].customer='cus_OTHER'}]){
 const {provider}=make({modify});await assert.rejects(()=>provider.readSubscription(projection));
 }
});
test('unsupported API version fails before any transport request',async()=>{
 const {provider,requests}=make({}, {binding:{...binding,api_version:'2025-01-01.unknown'}});await assert.rejects(()=>provider.readSubscription(projection),code('provider_version_unsupported'));assert.equal(requests.length,0);
});
test('all refund pages are read and split partial refunds keep charge identity',async()=>{
 const {provider,requests}=make({pageSize:1,modify:d=>{d.refunds=[refund(),refund({id:'re_SECOND',amount:30})];d.charges[0].amount_refunded=50}});
 const result=await provider.readSubscription(projection);assert.equal(result.refunds.length,2);assert(result.refunds.every(r=>r.charge_id==='ch_SYNTHETIC'));assert(requests.some(r=>r.path==='/v1/refunds'&&r.query.starting_after==='re_SYNTHETIC'));
});
test('pagination limit, repeated cursor and malformed has_more never claim completeness',async()=>{
 const p=make({pageSize:1,modify:d=>{d.refunds=[refund(),refund({id:'re_SECOND'})]}},{maxPages:1});await assert.rejects(()=>p.provider.readSubscription(projection),code('provider_page_limit'));
 const q=make({transform:({path,result})=>path==='/v1/refunds'?{object:'list',data:[refund()],has_more:true}:result});await assert.rejects(()=>q.provider.readSubscription(projection),code('provider_pagination_incomplete'));
 const r=make({transform:({path,result})=>path==='/v1/invoices'?{...result,has_more:null}:result});await assert.rejects(()=>r.provider.readSubscription(projection),code('provider_pagination_incomplete'));
});
test('refund charge/currency/status/customer and missing inventory fail closed',async()=>{
 for(const change of [{charge:'ch_WRONG'},{currency:'eur'},{status:'mystery'},{customer:'cus_WRONG'}]){
 const {provider}=make({modify:d=>{d.refunds=[refund(change)];d.charges[0].amount_refunded=20}});await assert.rejects(()=>provider.readSubscription(projection));
 }
 const {provider}=make({modify:d=>{d.charges[0].amount_refunded=20}});await assert.rejects(()=>provider.readSubscription(projection),code('provider_refund_evidence_incomplete'));
});
test('current invoice must prove the exact recurring item and period; proration is never invented',async()=>{
 for(const modify of [d=>{d.lines[0].period.end++},d=>{d.lines[0].pricing.price_details.price='price_OTHER'},d=>{d.lines[0].parent.subscription_item_details.proration=true}]){
 const {provider}=make({modify});assert.equal((await provider.readSubscription(projection)).payment.state,'unknown');
 }
 const {provider}=make({modify:d=>{d.invoices[0].status='open';d.invoices[0].amount_remaining=100}});assert.equal((await provider.readSubscription(projection)).payment.state,'unpaid');
});
test('missing latest invoice, extra subscription items and unsupported payment records fail closed',async()=>{
 for(const modify of [d=>{d.subscriptions[0].latest_invoice='in_MISSING'},d=>{d.items.push({...d.items[0],id:'si_SECOND'})},d=>{d.payments[0].payment={type:'payment_record',payment_record:'pyr_SYNTHETIC'}}]){
 const {provider}=make({modify});await assert.rejects(()=>provider.readSubscription(projection));
 }
});
test('changing graph between two full reads does not produce reconciled evidence',async()=>{
 let reads=0;const {provider}=make({transform:({path,result})=>{if(path==='/v1/subscriptions/sub_SYNTHETIC'&&++reads===2)return {...result,cancel_at_period_end:true};return result}});await assert.rejects(()=>provider.readSubscription(projection),code('provider_snapshot_changed'));
});
test('charge shared across subscriptions is ambiguous rather than attributed by metadata',async()=>{
 const {provider}=make({modify:d=>{d.invoices.push({...d.invoices[0],id:'in_OTHER',parent:{type:'subscription_details',subscription_details:{subscription:'sub_OTHER'}}});d.payments.push({...d.payments[0],id:'inpay_OTHER',invoice:'in_OTHER'})}});await assert.rejects(()=>provider.readSubscription(projection),code('provider_graph_ambiguous'));
});
test('refund graph resolves through PaymentIntent and InvoicePayments with no metadata authority',async()=>{
 const {provider}=make({modify:d=>{d.refunds=[refund({metadata:{organization_id:'forged'}})]}});
 const result=await provider.resolveReceipt(receipt());assert.equal(result.customer_id,'cus_SYNTHETIC');assert.equal(result.subscription_id,'sub_SYNTHETIC');assert.equal(result.evidence_sha256.length,64);
});
test('legacy direct Charge invoice link is resolved by exhaustive InvoicePayments scan',async()=>{
 const {provider}=make({modify:d=>{d.charges[0].payment_intent=null;d.payments[0].payment={type:'charge',charge:'ch_SYNTHETIC'};d.refunds=[refund({payment_intent:null})]}});
 const result=await provider.resolveReceipt(receipt());assert.equal(result.subscription_id,'sub_SYNTHETIC');assert.equal((await provider.readSubscription(projection)).refunds.length,1);
});
test('proved standalone refund yields explicit non-subscription disposition',async()=>{
 const {provider}=make({modify:d=>{d.invoices[0].parent=null;d.refunds=[refund()]}});const result=await provider.resolveReceipt(receipt());assert.equal(result.disposition,'not_subscription');assert.equal(result.customer_id,'cus_SYNTHETIC');assert(!('subscription_id'in result));
});
test('direct subscription/invoice receipt uses actual first-class identity',async()=>{
 const {provider}=make();for(const [event_type,object_id]of [['customer.subscription.created','sub_SYNTHETIC'],['invoice.paid','in_SYNTHETIC']]){
 const result=await provider.resolveReceipt(receipt({event_type,object_id}));assert.equal(result.subscription_id,'sub_SYNTHETIC');
 }
 await assert.rejects(()=>provider.resolveReceipt(receipt({event_type:'invoice.paid',object_id:'in_SYNTHETIC',customer_id:'cus_WRONG'})),code('provider_identity_mismatch'));
});
test('timeouts, rate limits, missing objects and other SDK errors are sanitized',async()=>{
 for(const [status,expected]of [[429,'provider_rate_limited'],[404,'provider_not_found'],[500,'provider_unavailable']]){
 const {provider}=make({transform:()=>new Response(JSON.stringify({error:{type:'api_error',message:'sensitive provider payload'}}),{status,headers:{'content-type':'application/json'}})});
 await assert.rejects(()=>provider.readSubscription(projection),e=>e.code===expected&&!e.message.includes('sensitive'));
 }
 const {provider}=make({transform:()=>new Promise(()=>{})},{requestTimeoutMs:10});await assert.rejects(()=>provider.readSubscription(projection),code('provider_timeout'));
});
test('bounded request budget prevents unbounded historical traversal',async()=>{
 const {provider}=make({}, {maxRequests:2});await assert.rejects(()=>provider.readSubscription(projection),code('provider_request_limit'));
});
test('disputed charge remains blocked pending explicitly reviewed risk policy',async()=>{
 const {provider}=make({modify:d=>{d.charges[0].disputed=true}});await assert.rejects(()=>provider.readSubscription(projection),code('provider_graph_unsupported'));
});

test('retrieval response IDs cannot redirect refund or invoice graph resolution',async()=>{
 for(const [path,change] of [['/v1/charges/ch_SYNTHETIC',{id:'ch_OTHER'}],['/v1/invoices/in_SYNTHETIC',{id:'in_OTHER'}]]){
 const {provider}=make({modify:d=>{d.refunds=[refund()]},transform:({path:p,result})=>p===path?{...result,...change}:result});
 await assert.rejects(()=>provider.resolveReceipt(receipt()),code('provider_identity_mismatch'));
 }
});
test('paid PaymentIntent with missing charge inventory is never declared complete',async()=>{
 const {provider}=make({modify:d=>{d.charges=[]}});await assert.rejects(()=>provider.readSubscription(projection),code('provider_payment_evidence_unavailable'));
});
test('receipt graph churn between reads prevents an irreversible disposition',async()=>{
 let reads=0;const {provider}=make({modify:d=>{d.refunds=[refund()]},transform:({path,result})=>{
 if(path==='/v1/invoices/in_SYNTHETIC'&&++reads===2)return {...result,parent:null};return result;
 }});await assert.rejects(()=>provider.resolveReceipt(receipt()),code('provider_snapshot_changed'));
});
test('retained Dahlia API uses exact bound version on the current SDK',async()=>{
 const b={...binding,api_version:'2026-08-26.dahlia'};const {provider,requests}=make({modeBinding:b},{binding:b});await provider.readSubscription(projection);assert(requests.every(r=>r.version===b.api_version));
});
test('multi-binding provider router has no default-account fallback',async()=>{
 const {createStripeProviderRouter}=await import('../candidate/edge/billing/provider.mjs');let count=0;
 const reader={readSubscription:async()=>{count++;return 'ok'},resolveReceipt:async()=>{count++;return 'ok'}};
 const disabled=createStripeProviderRouter({readers:new Map([[binding.id,reader]])});assert.throws(()=>disabled.readSubscription(projection),code('provider_inactive'));
 const router=createStripeProviderRouter({enabled:true,readers:new Map([[binding.id,reader]])});assert.equal(await router.readSubscription(projection),'ok');assert.throws(()=>router.readSubscription({...projection,binding_id:'wrong'}),code('provider_binding_mismatch'));assert.equal(count,1);
});

 test('direct-charge retrieval cannot substitute an unrefunded charge with another ID',async()=>{
 const {provider}=make({modify:d=>{
 d.charges[0].payment_intent=null;d.charges[0].amount_refunded=100;d.refunds=[refund({amount:100,payment_intent:null})];
 d.charges.push({...d.charges[0],id:'ch_OTHER',amount_refunded:0});
 d.payments[0].payment={type:'charge',charge:'ch_SYNTHETIC'};d.payments.push({...d.payments[0],id:'inpay_OTHER',payment:{type:'charge',charge:'ch_OTHER'}});
 },transform:({path,result,data})=>path==='/v1/charges/ch_SYNTHETIC'?data.charges[1]:result});
 await assert.rejects(()=>provider.readSubscription(projection),code('provider_identity_mismatch'));
 });

 test('paid InvoicePayment requires a valid nonnegative observed paid amount',async()=>{
 for(const amount of [null,-1,'100']){const {provider}=make({modify:d=>{d.payments[0].amount_paid=amount}});await assert.rejects(()=>provider.readSubscription(projection),code('provider_payment_evidence_unavailable'));}
 });
