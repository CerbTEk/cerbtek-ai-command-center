import test from 'node:test';
import assert from 'node:assert/strict';
import { collectUsage, evaluateEntitlement, normalizeStripeEvent, receiveStripeWebhook } from '../candidate/edge/billing/core.mjs';
import { database,binding,event,snapshot,org,other,run,otherRun,now,policy,reconcileInput,signed } from './fixtures/billing-fixtures.mjs';
const hash='a'.repeat(64);
const receipt=extra=>normalizeStripeEvent(event(extra),binding,hash,now);
const rows=async(db,sql,params=[]) => (await db.query(sql,params)).rows;
async function seeded(fn){const {db,store}=await database();try{return await fn(db,store)}finally{await db.close()}}
const denial=code=>e=>e.code===code;

test('verified webhook receipt commits once; replay never repeats projection mutation',()=>seeded(async(db,store)=>{
 const s=signed();const args={...s,binding,now,store,enabled:true};assert.equal((await receiveStripeWebhook(args)).code,'recorded');assert.equal((await receiveStripeWebhook(args)).code,'duplicate');
 assert.equal((await rows(db,'SELECT * FROM kairo_billing.provider_receipts')).length,1);
 assert.equal((await rows(db,'SELECT * FROM kairo_billing.projection_history')).length,1);
 const ready=await store.reconcile(binding.id,'sub_SYNTHETIC',reconcileInput());assert.equal(ready.state,'reconciled');
 assert.equal((await receiveStripeWebhook(args)).code,'duplicate');assert.equal((await rows(db,'SELECT * FROM kairo_billing.projection_history')).length,2);
}));
test('event ID payload conflict and bound-mode mismatch leave original history unchanged',()=>seeded(async(db,store)=>{
 await store.recordReceipt(receipt());await assert.rejects(()=>store.recordReceipt({...receipt(),payload_sha256:'b'.repeat(64)}),denial('event_id_payload_conflict'));
 await assert.rejects(()=>store.recordReceipt({...receipt({id:'evt_OTHER'}),livemode:true}),denial('provider_binding_conflict'));
 assert.equal((await rows(db,'SELECT * FROM kairo_billing.provider_receipts')).length,1);
}));
test('projection error rolls entire receipt/link transaction back',()=>seeded(async(db,store)=>{
 await store.recordReceipt(receipt());
 await db.query('INSERT INTO kairo_billing.customer_bindings(binding_id,customer_id,organization_id) VALUES($1,$2,$3)',[binding.id,'cus_OTHER',other]);
 const bad=receipt({id:'evt_CONFLICT',data:{object:snapshot({customer:'cus_OTHER'})}});
 await assert.rejects(()=>store.recordReceipt(bad),denial('projection_binding_conflict'));
 assert.equal((await rows(db,'SELECT * FROM kairo_billing.provider_receipts')).length,1);assert.equal((await rows(db,'SELECT * FROM kairo_billing.receipt_links')).length,1);
}));
test('older event invalidates current snapshot and stale reconciliation CAS cannot overwrite it',()=>seeded(async(db,store)=>{
 await store.recordReceipt(receipt());await store.reconcile(binding.id,'sub_SYNTHETIC',reconcileInput());
 await store.recordReceipt(receipt({id:'evt_OLD',created:now-100}));await assert.rejects(()=>store.reconcile(binding.id,'sub_SYNTHETIC',reconcileInput({expected_revision:2})),denial('reconciliation_revision_conflict'));
 const c=await store.entitlementContext(org,binding.id,'sub_SYNTHETIC');assert.equal(c.projection.state,'needs_reconciliation');
 assert.equal(evaluateEntitlement({organization_id:org,feature:'ai_draft',policy:policy(),now,enabled:true,...c}).allowed,false);
}));
test('same binding ID with different provider account or mode cannot reconcile',()=>seeded(async(db,store)=>{
 await store.recordReceipt(receipt());
 for(const b of [{...binding,account_id:'acct_WRONG'},{...binding,livemode:true},{...binding,account_kind:'connected'}])await assert.rejects(()=>store.reconcile(binding.id,'sub_SYNTHETIC',reconcileInput({binding:b})),denial('provider_binding_conflict'));
}));
test('unresolved refund holds access, explicit graph link invalidates, then reconciliation restores only configured result',()=>seeded(async(db,store)=>{
 await store.recordReceipt(receipt());await store.reconcile(binding.id,'sub_SYNTHETIC',reconcileInput());
 await store.recordReceipt(receipt({id:'evt_REFUND',type:'refund.created',data:{object:{object:'refund',id:'re_ONE'}}}));
 assert.equal((await store.entitlementContext(org,binding.id,'sub_SYNTHETIC')).customer_hold,true);
 const resolution={binding_id:binding.id,event_id:'evt_REFUND',customer_id:'cus_SYNTHETIC',subscription_id:'sub_SYNTHETIC',evidence_sha256:hash};
 assert.equal((await store.resolveReceipt(resolution)).replayed,false);assert.equal((await store.resolveReceipt(resolution)).replayed,true);
 await assert.rejects(()=>store.resolveReceipt({...resolution,subscription_id:'sub_WRONG'}),denial('resolution_replay_conflict'));
 const c=await store.entitlementContext(org,binding.id,'sub_SYNTHETIC');assert.equal(c.customer_hold,false);assert.equal(c.projection.state,'needs_reconciliation');
}));
test('standalone invoice is harmless; missing invoice lineage remains held for review',()=>seeded(async(db,store)=>{
 await store.recordReceipt(receipt());await store.reconcile(binding.id,'sub_SYNTHETIC',reconcileInput());
 const o={object:'invoice',id:'in_OTHER',customer:'cus_SYNTHETIC',parent:null};await store.recordReceipt(receipt({id:'evt_ONEOFF',type:'invoice.paid',data:{object:o}}));
 assert.equal((await store.entitlementContext(org,binding.id,'sub_SYNTHETIC')).customer_hold,false);
 delete o.parent;await store.recordReceipt(receipt({id:'evt_INCOMPLETE',type:'invoice.paid',data:{object:o}}));assert.equal((await store.entitlementContext(org,binding.id,'sub_SYNTHETIC')).customer_hold,true);
}));
test('unknown customer cannot auto-bind from event metadata and cross-tenant contexts are empty',()=>seeded(async(db,store)=>{
 const r=await store.recordReceipt(receipt({data:{object:snapshot({customer:'cus_UNKNOWN',metadata:{organization_id:org}})}}));assert.equal(r.code,'needs_lineage_resolution');
 assert.equal((await rows(db,'SELECT * FROM kairo_billing.subscription_projections')).length,0);
 await store.recordReceipt(receipt({id:'evt_VALID'}));assert.equal((await store.entitlementContext(other,binding.id,'sub_SYNTHETIC')).projection,null);
}));
test('replay and new delivery IDs never count usage twice',()=>seeded(async(db,store)=>{
 const input={store,organization_id:org,source_kind:'ai_draft_run',source_id:run};const a=await collectUsage(input),b=await collectUsage(input);assert.equal(a.length,2);assert(a.every(x=>!x.replayed));assert(b.every(x=>x.replayed));assert.equal(a[0].id,b[0].id);
 assert.deepEqual(await store.usageTotals(org,'ai_input_tokens'),{scope:'lifetime_observations_only',measured_units:'10',unresolved_sources:0,customer_charge:null,provider_spend:null});
 await assert.rejects(()=>collectUsage({...input,source_id:otherRun}),denial('usage_source_unverified'));
}));
test('unknown usage appends a later known observation without overwriting history',()=>seeded(async(db,store)=>{
 const input={store,organization_id:other,source_kind:'ai_draft_run',source_id:otherRun};await collectUsage(input);assert.equal((await store.usageTotals(other,'ai_input_tokens')).unresolved_sources,1);
 await db.query("UPDATE ai_draft_runs SET status='failed',usage=$2 WHERE id=$1",[otherRun,JSON.stringify({input_tokens:0,output_tokens:4})]);await collectUsage(input);
 assert.equal((await rows(db,'SELECT * FROM kairo_billing.usage_events')).length,4);assert.equal((await store.usageTotals(other,'ai_input_tokens')).unresolved_sources,0);assert.equal((await store.usageTotals(other,'ai_input_tokens')).measured_units,'0');
}));
test('changed known usage raises conflict rather than silently rewriting or double billing',()=>seeded(async(db,store)=>{
 const input={store,organization_id:org,source_kind:'ai_draft_run',source_id:run};await collectUsage(input);await db.query('UPDATE ai_draft_runs SET usage=$2 WHERE id=$1',[run,JSON.stringify({input_tokens:100,output_tokens:20})]);
 await assert.rejects(()=>collectUsage(input),denial('usage_observation_conflict'));assert.equal((await store.usageTotals(org,'ai_input_tokens')).measured_units,'10');
}));
test('phone legs and workflow use canonical persisted call/run IDs and no fabricated price',()=>seeded(async(db,store)=>{
 await db.query('UPDATE kairo_phone_intake.calls SET state=$2 WHERE id=$1',[run,JSON.stringify({parent:{status:'completed',duration:50},child:{status:'completed',duration:30},dialResult:{status:'completed',duration:null}})]);
 await collectUsage({store,organization_id:org,source_kind:'phone_call',source_id:run});await collectUsage({store,organization_id:org,source_kind:'workflow_run',source_id:run});
 assert.equal((await store.usageTotals(org,'phone_parent_reported_seconds')).measured_units,'50');assert.equal((await store.usageTotals(org,'phone_child_reported_seconds')).measured_units,'30');assert.equal((await store.usageTotals(org,'phone_dialResult_reported_seconds')).unresolved_sources,1);
 assert.equal((await store.usageTotals(org,'workflow_runs')).measured_units,'1');
}));
test('all data roles denied schema/table operations including TRUNCATE',()=>seeded(async(db)=>{
 const tables=['provider_bindings','customer_bindings','provider_receipts','receipt_links','subscription_projections','projection_history','policy_versions','usage_events'];
 for(const role of ['anon','authenticated','service_role']){
 await db.exec(`SET ROLE ${role}`);for(const t of tables)for(const op of [`SELECT * FROM kairo_billing.${t}`,`DELETE FROM kairo_billing.${t}`,`TRUNCATE kairo_billing.${t}`])await assert.rejects(()=>db.exec(op),e=>e.code==='42501');await db.exec('RESET ROLE');
 }
 assert((await rows(db,"SELECT relrowsecurity FROM pg_class WHERE relnamespace='kairo_billing'::regnamespace AND relkind='r'")).every(r=>r.relrowsecurity));
}));
test('history immutability also rejects owner UPDATE DELETE and TRUNCATE',()=>seeded(async(db,store)=>{
 await store.recordReceipt(receipt());await collectUsage({store,organization_id:org,source_kind:'ai_draft_run',source_id:run});
 for(const sql of ['UPDATE kairo_billing.provider_receipts SET event_type=event_type','DELETE FROM kairo_billing.provider_receipts','TRUNCATE kairo_billing.usage_events','DELETE FROM kairo_billing.subscription_projections','UPDATE kairo_billing.customer_bindings SET customer_id=customer_id'])await assert.rejects(()=>db.exec(sql),e=>e.code==='42501');
}));
test('SQL source identity and quantity guard rejects forged observations and measured NULL',()=>seeded(async(db)=>{
 const sql='INSERT INTO kairo_billing.usage_events(id,organization_id,source_kind,source_id,metric,unit,state,quantity,evidence_ref,observation_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)';
 const p=[crypto.randomUUID(),org,'ai_draft_run',run,'ai_input_tokens','token','measured',10,run,hash];
 for(const changes of [{7:null},{7:100},{1:other},{4:'fake_metric'},{5:'dollar'},{3:'20000000-0000-4000-8000-000000000099'}]){
 const q=[...p];for(const [i,v] of Object.entries(changes))q[Number(i)]=v;await assert.rejects(()=>db.query(sql,q));
 }
 assert.equal((await rows(db,'SELECT * FROM kairo_billing.usage_events')).length,0);
}));

 test('provider binding kind cannot be silently switched during ingestion',()=>seeded(async(db,store)=>{
 await assert.rejects(()=>store.recordReceipt({...receipt(),account_kind:'connected'}),denial('provider_binding_conflict'));
 assert.equal((await rows(db,'SELECT * FROM kairo_billing.provider_receipts')).length,0);
 }));

 test('approved policy versions are immutable, hashed, idempotent and explicitly read',()=>seeded(async(db,store)=>{
 const p=policy();assert.equal((await store.recordPolicy(p)).replayed,false);assert.equal((await store.recordPolicy(p)).replayed,true);
 await assert.rejects(()=>store.recordPolicy({...p,grace_seconds:4}),denial('policy_version_conflict'));
 assert.deepEqual(await store.loadPolicy(p.id,p.version),p);assert.equal(await store.loadPolicy('unknown',1),null);
 await assert.rejects(()=>store.recordPolicy(policy({approved:false})),denial('policy_unconfigured'));
 }));

 test('source event time survives late collection and is not replaced with ledger write time',()=>seeded(async(db,store)=>{
 await collectUsage({store,organization_id:org,source_kind:'ai_draft_run',source_id:run});
 const [e]=await rows(db,'SELECT source_started_at,created_at FROM kairo_billing.usage_events LIMIT 1');
 assert.equal(new Date(e.source_started_at).getTime(),1999990000000);assert.notEqual(new Date(e.created_at).getTime(),1999990000000);
 }));

 test('Postgres microsecond source times normalize explicitly to milliseconds',()=>seeded(async(db,store)=>{
 await db.query("UPDATE ai_draft_runs SET created_at='2026-10-09T16:00:00.123456Z' WHERE id=$1",[run]);
 await collectUsage({store,organization_id:org,source_kind:'ai_draft_run',source_id:run});
 const [e]=await rows(db,'SELECT source_started_at FROM kairo_billing.usage_events LIMIT 1');assert.equal(new Date(e.source_started_at).toISOString(),'2026-10-09T16:00:00.123Z');
 }));

test('proved standalone disposition clears only its receipt hold and cannot be remapped',()=>seeded(async(db,store)=>{
 await store.recordReceipt(receipt());await store.reconcile(binding.id,'sub_SYNTHETIC',reconcileInput());
 await store.recordReceipt(receipt({id:'evt_STANDALONE',type:'refund.created',data:{object:{object:'refund',id:'re_ONE'}}}));
 assert.equal((await store.entitlementContext(org,binding.id,'sub_SYNTHETIC')).customer_hold,true);
 const input={binding_id:binding.id,event_id:'evt_STANDALONE',customer_id:'cus_OTHERUNBOUND',evidence_sha256:hash};
 assert.equal((await store.resolveNonSubscriptionReceipt(input)).replayed,false);assert.equal((await store.resolveNonSubscriptionReceipt(input)).replayed,true);
 assert.equal((await store.entitlementContext(org,binding.id,'sub_SYNTHETIC')).customer_hold,false);
 await assert.rejects(()=>store.resolveReceipt({...input,customer_id:'cus_SYNTHETIC',subscription_id:'sub_SYNTHETIC'}),denial('resolution_lineage_conflict'));
 await assert.rejects(()=>store.resolveNonSubscriptionReceipt({...input,customer_id:'cus_CHANGED'}),denial('resolution_replay_conflict'));
 await assert.rejects(()=>db.exec('DELETE FROM kairo_billing.receipt_dispositions'),e=>e.code==='42501');
}));
test('linked lifecycle receipt cannot be disposed as unrelated',()=>seeded(async(db,store)=>{
 await store.recordReceipt(receipt());await assert.rejects(()=>store.resolveNonSubscriptionReceipt({binding_id:binding.id,event_id:'evt_SYNTHETIC',customer_id:'cus_SYNTHETIC',evidence_sha256:hash}),denial('resolution_lineage_conflict'));
}));
