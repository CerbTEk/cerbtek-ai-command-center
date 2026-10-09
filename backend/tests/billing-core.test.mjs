import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyStripeSignature,normalizeStripeEvent,invalidateProjection,reconcileProjection,evaluateEntitlement,evaluateMeter,receiveStripeWebhook,usageFromSource,validatePolicy} from '../candidate/edge/billing/core.mjs';
import {binding,event,snapshot,policy,now,org,run,payment,evidenceSubject,reconcileInput,signed} from './fixtures/billing-fixtures.mjs';
const hash='a'.repeat(64);
const receipt=extra=>normalizeStripeEvent(event(extra),binding,hash,now);
const projected=()=>invalidateProjection(null,receipt(),org);
const ready=extra=>reconcileProjection(projected(),reconcileInput(extra));
const entitlement=extra=>evaluateEntitlement({organization_id:org,feature:'ai_draft',projection:ready(),policy:policy(),now,enabled:true,customer_hold:false,...extra});
const error=code=>e=>e.code===code;

test('inactive webhook never calls storage or verifier',async()=>{
 assert.deepEqual(await receiveStripeWebhook({store:{recordReceipt(){throw Error('must not run')}}}),{status:503,code:'billing_inactive'});
});
test('raw UTF-8 bytes and rotating v1 signatures verify',async()=>{
 const s=signed(event({note:'🧭'}));const verified=await verifyStripeSignature(s.raw,`v1=${'0'.repeat(64)},${s.signature},v0=ignored`,s.secret,{now});
 assert.equal(verified.event.note,'🧭');assert.equal(verified.payload_sha256.length,64);
});
test('mutated body, wrong secret, object input and v0-only signatures are denied',async()=>{
 const s=signed();
 for(const [raw,sig,secret] of [[Buffer.concat([s.raw,Buffer.from(' ')]),s.signature,s.secret],[s.raw,s.signature,'x'.repeat(32)],[event(),s.signature,s.secret],[s.raw,s.signature.replace('v1=','v0='),s.secret]]) await assert.rejects(()=>verifyStripeSignature(raw,sig,secret,{now}));
});
test('stale/future timestamps, duplicate timestamp and oversize bodies denied',async()=>{
 for(const t of [now-301,now+301]){const s=signed(event(),t);await assert.rejects(()=>verifyStripeSignature(s.raw,s.signature,s.secret,{now}),error('signature_expired'))}
 const s=signed();await assert.rejects(()=>verifyStripeSignature(s.raw,`${s.signature},t=${now}`,s.secret,{now}));await assert.rejects(()=>verifyStripeSignature(s.raw,s.signature,s.secret,{now,maxBytes:10}));
 await assert.rejects(()=>verifyStripeSignature(s.raw,s.signature,s.secret,{now,toleranceSeconds:0}));
});
test('valid signature over malformed UTF-8 or JSON fails after verification',async()=>{
 const s=signed();for(const raw of [Buffer.from([255]),Buffer.from('{')])await assert.rejects(()=>verifyStripeSignature(raw,s.sign(raw),s.secret,{now}),error('invalid_json'));
});
test('exact account, mode, API version and object mode binding required',()=>{
 for(const e of [event({account:'acct_OTHER'}),event({livemode:true}),event({api_version:'2024-01-01'}),event({data:{object:snapshot({livemode:true})}})])assert.throws(()=>normalizeStripeEvent(e,binding,hash,now));
 const connected={...binding,account_kind:'connected'};assert.throws(()=>normalizeStripeEvent(event(),connected,hash,now));assert.equal(normalizeStripeEvent(event({account:binding.account_id}),connected,hash,now).kind,'subscription');
});
test('metadata never grants tenant or subscription identity; normalized receipts omit personal data',()=>{
 const r=normalizeStripeEvent(event({data:{object:snapshot({metadata:{organization_id:'forged'},description:'private',customer:{id:'cus_SYNTHETIC',email:'private@example.test'}})}}),binding,hash,now);
 assert.equal(r.customer_id,'cus_SYNTHETIC');assert(!JSON.stringify(r).includes('private'));assert(!('organization_id' in r));
});
test('Dahlia invoice lineage resolves; one-off invoice remains unresolved',()=>{
 const base={object:'invoice',id:'in_SYNTHETIC',customer:'cus_SYNTHETIC'};
 assert.equal(receipt({type:'invoice.paid',data:{object:base}}).kind,'unresolved');
 assert.equal(receipt({type:'invoice.payment_failed',data:{object:{...base,parent:{subscription_details:{subscription:'sub_SYNTHETIC'}}}}}).subscription_id,'sub_SYNTHETIC');
});
test('refund graph awaits authorized resolution; irrelevant event is ignored',()=>{
 assert.equal(receipt({type:'refund.created',data:{object:{object:'refund',id:'re_SYNTHETIC',charge:'ch_SYNTHETIC',metadata:{subscription_id:'forged'}}}}).subscription_id,null);
 assert.equal(receipt({type:'product.created',data:{object:{object:'product',id:'prod_SYNTHETIC'}}}).kind,'ignored');
});
test('webhook snapshots do not grant access; duplicate subscription state invalidates only',()=>{
 assert.equal(entitlement({projection:projected()}).reason,'subscription_unverified');
 const older=invalidateProjection(ready(),receipt({id:'evt_OLDER',created:now-99}),org);assert.equal(older.state,'needs_reconciliation');assert.equal(older.max_event_created_at,now-10);
});
test('same-second/out-of-order and cancellation tombstones cannot reactivate',()=>{
 const cancelled=invalidateProjection(ready(),receipt({type:'customer.subscription.deleted',created:now-20}),org);
 const reordered=invalidateProjection(cancelled,receipt({id:'evt_LATE',created:now-100}),org);assert.equal(reordered.terminal,true);
 assert.throws(()=>reconcileProjection(reordered,reconcileInput({expected_revision:reordered.revision})),error('terminal_subscription_cannot_reactivate'));
 assert.equal(entitlement({projection:reordered}).allowed,false);
});
test('reconciliation CAS and fetch timing reject new receipts during fetch',()=>{
 assert.throws(()=>ready({expected_revision:2}),error('reconciliation_revision_conflict'));
 assert.throws(()=>ready({fetch_started_at:now-1}),error('stale_reconciliation'));
 assert.throws(()=>ready({fetched_at:now-1}),error('stale_reconciliation'));
 assert.throws(()=>ready({refund_graph_complete:false}),error('refund_reconciliation_incomplete'));
});
test('snapshot customer/mode/subscription and truncated or multi-item data denied',()=>{
 for(const object of [snapshot({customer:'cus_OTHER'}),snapshot({id:'sub_OTHER'}),snapshot({livemode:true}),snapshot({items:{has_more:true,data:[]}}),snapshot({items:{has_more:false,data:[...snapshot().items.data,...snapshot().items.data]}})])assert.throws(()=>ready({object}));
});
test('unknown or incomplete policy fails closed with billing-neutral history reads',()=>{
 for(const p of [null,{},policy({approved:false}),policy({refund_access:null}),policy({grace_seconds:null})]){
 const result=entitlement({policy:p});assert.equal(result.allowed,false);assert.equal(result.history_read_allowed_by_billing,true);
 }
 assert.equal(entitlement({enabled:false}).reason,'billing_inactive');
});
test('only explicitly mapped product/price/quantity/features grant a verified current plan',()=>{
 assert.equal(entitlement().allowed,true);
 for(const p of [policy({price_id:'price_OTHER'}),policy({product_id:'prod_OTHER'}),policy({quantity:2}),policy({features:[]})])assert.equal(entitlement({policy:p}).allowed,false);
 assert.equal(entitlement({organization_id:'10000000-0000-4000-8000-000000000003'}).allowed,false);
});
test('expiration exact boundary and scheduled cancellation deny without erasing history',()=>{
 assert.equal(entitlement({now:now+1000}).reason,'subscription_expired');
 assert.equal(entitlement({projection:ready({object:snapshot({cancel_at:now})})}).reason,'subscription_expired');
 assert.equal(entitlement({projection:ready({object:snapshot({ended_at:now})})}).reason,'subscription_ended');
});
test('unpaid, paused, incomplete, canceled, unknown and stale subscriptions denied',()=>{
 for(const status of ['incomplete','incomplete_expired','canceled','unpaid','paused'])assert.equal(entitlement({projection:ready({object:snapshot({status})})}).allowed,false);
 assert.equal(entitlement({projection:ready({payment:{state:'unknown'}})}).reason,'payment_unverified');
 assert.equal(entitlement({now:now+1001,policy:policy({max_snapshot_age_seconds:100})}).reason,'snapshot_stale');
 assert.equal(entitlement({customer_hold:true}).reason,'unresolved_customer_event');
});
test('trial/grace must be explicit and never extend cancellation',()=>{
 const trial=ready({object:snapshot({status:'trialing',trial_end:now+1}),payment:{state:'unpaid'}});
 assert.equal(entitlement({projection:trial}).allowed,false);
 const tp=policy({allowed_statuses:['trialing'],require_paid_invoice:false});assert.equal(entitlement({projection:trial,policy:tp}).allowed,true);assert.equal(entitlement({projection:trial,policy:tp,now:now+1}).allowed,false);
 const gp=policy({allowed_statuses:['past_due'],require_paid_invoice:false,grace_seconds:100,max_snapshot_age_seconds:5000});
 assert.equal(entitlement({projection:ready({object:snapshot({status:'past_due'})}),policy:gp,now:now+1050}).allowed,true);
 assert.equal(entitlement({projection:ready({object:snapshot({status:'past_due',cancel_at_period_end:true})}),policy:gp,now:now+1050}).allowed,false);
});
test('pending/succeeded/failed refunds honor explicit policy, split partials sum per charge',()=>{
 const refund={...evidenceSubject,id:'re_ONE',charge_id:'ch_SYNTHETIC',amount:50,charge_amount:100,currency:'usd',subscription_id:'sub_SYNTHETIC',status:'succeeded'};
 assert.equal(entitlement({projection:ready({refunds:[refund]})}).reason,'refund_policy_denied');
 const fullPolicy=policy({refund_access:'suspend_full'});
 assert.equal(entitlement({projection:ready({refunds:[refund]}),policy:fullPolicy}).allowed,true);
 assert.equal(entitlement({projection:ready({refunds:[refund,{...refund,id:'re_TWO'}]}),policy:fullPolicy}).allowed,false);
 assert.equal(entitlement({projection:ready({refunds:[{...refund,status:'pending'}]}),policy:policy({refund_access:'no_access_change'})}).allowed,false);
 assert.equal(entitlement({projection:ready({refunds:[{...refund,status:'failed'}]})}).allowed,true);
});
test('refund duplicate IDs and wrong subscription are not accepted as evidence',()=>{
 const r={...evidenceSubject,charge_id:'ch_SYNTHETIC',id:'re_ONE',amount:10,charge_amount:100,currency:'usd',subscription_id:'sub_OTHER',status:'succeeded'};
 assert.throws(()=>ready({refunds:[r]}));assert.throws(()=>ready({refunds:[{...r,subscription_id:'sub_SYNTHETIC'},{...r,subscription_id:'sub_SYNTHETIC'}]}));
});
test('usage meters need explicit allowances and never manufacture charges',()=>{
 assert.equal(evaluateMeter({policy:policy(),meter:'other',used:0,requested:1}).allowed,false);
 assert.equal(evaluateMeter({policy:policy(),meter:'ai_input_tokens',used:200,requested:1}).allowed,false);
 const p=policy({meters:{ai_input_tokens:{mode:'limited',allowance:200,overage:'record_unpriced'}}});
 assert.deepEqual(evaluateMeter({policy:p,meter:'ai_input_tokens',used:199,requested:3}),{allowed:true,reason:'overage_policy',overage_units:2,charge:null});
 assert.equal(evaluateMeter({policy:p,meter:'ai_input_tokens',used:Number.MAX_SAFE_INTEGER,requested:1}).allowed,false);
});
test('usage facts bind persisted run/call IDs; unknown token/duration is not free or zero',()=>{
 const source={id:run,organization_id:org,status:'unknown',usage:null};assert(usageFromSource(source,'ai_draft_run').every(x=>x.quantity===null&&x.state==='unknown'));
 assert.equal(usageFromSource({...source,status:'completed',duration:100,price:5},'phone_call')[0].quantity,null);
 assert.throws(()=>usageFromSource({...source,status:'reserved'},'ai_draft_run'));
});

 test('authoritative canceled snapshot latches terminal even without deletion webhook',()=>{
 const canceled=ready({object:snapshot({status:'canceled'})});assert.equal(canceled.terminal,true);
 assert.throws(()=>reconcileProjection(canceled,reconcileInput({expected_revision:canceled.revision})),error('terminal_subscription_cannot_reactivate'));
 });
 test('standalone invoice parent null does not block subscription access',()=>{
 assert.equal(receipt({type:'invoice.paid',data:{object:{object:'invoice',id:'in_STANDALONE',customer:'cus_SYNTHETIC',parent:null}}}).kind,'ignored');
 });
 test('paid evidence must match provider, mode, customer and subscription',()=>{
 for(const key of ['binding_id','account_id','customer_id','subscription_id'])assert.throws(()=>ready({payment:{...payment,[key]:'wrong'}}),error('invalid_payment_evidence'));
 assert.throws(()=>ready({payment:{...payment,livemode:true}}),error('invalid_payment_evidence'));
 });
 test('phone reported seconds stay separate by leg and unknown is preserved',()=>{
 const values=usageFromSource({id:run,organization_id:org,state:{parent:{status:'completed',duration:40},child:{status:'completed',duration:20},dialResult:{status:'completed',duration:null}}},'phone_call');
 assert.deepEqual(values.map(v=>v.quantity),[40,20,null]);assert(values.every(v=>v.unit==='second'));assert.equal(new Set(values.map(v=>v.metric)).size,3);
 });

 test('unconfigured spend ownership cannot activate execution features',()=>{
 assert.equal(entitlement({policy:policy({provider_spend_owner:'unconfigured'})}).reason,'provider_spend_owner_unconfigured');
 });

 test('omitting unresolved-event hold evidence fails closed',()=>{
 assert.equal(evaluateEntitlement({organization_id:org,feature:'ai_draft',projection:ready(),policy:policy(),now,enabled:true}).reason,'unresolved_customer_event');
 });
