import { randomBytes, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { BillingStore } from '../../candidate/edge/billing/store.mjs';
export const org = '10000000-0000-4000-8000-000000000001';
export const other = '10000000-0000-4000-8000-000000000002';
export const run = '20000000-0000-4000-8000-000000000001';
export const otherRun = '20000000-0000-4000-8000-000000000002';
export const now = 2000000000;
export const binding = { id:'synthetic-binding',account_id:'acct_SYNTHETIC',account_kind:'platform',livemode:false,api_version:'2026-08-26.dahlia' };
export const snapshot = extra => ({object:'subscription',id:'sub_SYNTHETIC',customer:'cus_SYNTHETIC',livemode:false,status:'active',cancel_at_period_end:false,cancel_at:null,ended_at:null,trial_end:null,items:{has_more:false,data:[{id:'si_SYNTHETIC',price:{id:'price_SYNTHETIC',product:'prod_SYNTHETIC'},quantity:1,current_period_start:now-100,current_period_end:now+1000}]},...extra});
export const event = extra => ({object:'event',id:'evt_SYNTHETIC',type:'customer.subscription.created',created:now-10,livemode:false,api_version:binding.api_version,data:{object:snapshot()},...extra});
export const policy = extra => ({id:'synthetic-policy',version:1,approved:true,binding_id:binding.id,price_id:'price_SYNTHETIC',product_id:'prod_SYNTHETIC',quantity:1,valid_from:now-100,valid_until:now+10000,max_snapshot_age_seconds:1000,features:['ai_draft','phone_intake'],allowed_statuses:['active'],require_paid_invoice:true,refund_access:'suspend_any',grace_seconds:0,meters:{ai_input_tokens:{mode:'limited',allowance:200,overage:'block'}},provider_spend_owner:'cerbtek',...extra});
export const evidenceSubject = {binding_id:binding.id,account_id:binding.account_id,livemode:binding.livemode,customer_id:'cus_SYNTHETIC',subscription_id:'sub_SYNTHETIC'};
export const payment = {...evidenceSubject,state:'paid',invoice_id:'in_SYNTHETIC',period_start:now-100,period_end:now+1000};
export const reconcileInput = extra => ({expected_revision:1,fetch_started_at:now,fetched_at:now,object:snapshot(),binding,payment,refunds:[],refund_graph_complete:true,...extra});
export function signed(e=event(), timestamp=now) {
 const secret=randomBytes(32).toString('hex'), raw=Buffer.from(JSON.stringify(e));
 const sign=bytes=>`t=${timestamp},v1=${createHmac('sha256',secret).update(`${timestamp}.`).update(bytes).digest('hex')}`;
 return {raw,secret,signature:sign(raw),sign};
}
export async function database() {
 const db=new PGlite();
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
 CREATE TABLE public.organizations(id uuid PRIMARY KEY);
 CREATE TABLE public.ai_draft_runs(id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations(id),status text,usage jsonb,created_at timestamptz DEFAULT to_timestamp(1999990000));
 CREATE TABLE public.workflow_runs(id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations(id),started_at timestamptz DEFAULT to_timestamp(1999990000));
 CREATE SCHEMA kairo_phone_intake;CREATE TABLE kairo_phone_intake.calls(id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations(id),state jsonb,admitted_at timestamptz DEFAULT to_timestamp(1999990000));`);
 await db.exec(await readFile(new URL('../../candidate/sql/billing-foundation-contract.sql',import.meta.url),'utf8'));
 await db.query('INSERT INTO organizations VALUES($1),($2)',[org,other]);
 await db.query('INSERT INTO kairo_billing.provider_bindings(id,account_id,livemode,account_kind,api_version) VALUES($1,$2,$3,$4,$5)',[binding.id,binding.account_id,binding.livemode,binding.account_kind,binding.api_version]);
 await db.query('INSERT INTO kairo_billing.customer_bindings(binding_id,customer_id,organization_id) VALUES($1,$2,$3)',[binding.id,'cus_SYNTHETIC',org]);
 await db.query("INSERT INTO ai_draft_runs(id,organization_id,status,usage) VALUES($1,$2,'awaiting_review',$3),($4,$5,'unknown',NULL)",[run,org,JSON.stringify({input_tokens:10,output_tokens:20}),otherRun,other]);
 await db.query('INSERT INTO workflow_runs(id,organization_id) VALUES($1,$2)',[run,org]);
 await db.query('INSERT INTO kairo_phone_intake.calls(id,organization_id,state) VALUES($1,$2,$3)',[run,org,JSON.stringify({terminal:'completed'})]);
 return {db,store:new BillingStore(db)};
}
