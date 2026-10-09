import Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import {binding as oldBinding,now,snapshot,org} from './billing-fixtures.mjs';
export const binding={...oldBinding,api_version:'2026-09-30.endive'};
export const projection={binding_id:binding.id,customer_id:'cus_SYNTHETIC',subscription_id:'sub_SYNTHETIC',organization_id:org,revision:1,last_receipt_at:now};
const initial=()=>({
 account:{id:binding.account_id,object:'account'},
 customers:[{id:'cus_SYNTHETIC',object:'customer',livemode:false}],
 subscriptions:[{...snapshot(),latest_invoice:'in_SYNTHETIC'}],
 items:[{id:'si_SYNTHETIC',object:'subscription_item',subscription:'sub_SYNTHETIC',price:{id:'price_SYNTHETIC',product:'prod_SYNTHETIC',livemode:false},quantity:1,current_period_start:now-100,current_period_end:now+1000}],
 invoices:[{id:'in_SYNTHETIC',object:'invoice',customer:'cus_SYNTHETIC',livemode:false,status:'paid',amount_remaining:0,parent:{type:'subscription_details',subscription_details:{subscription:'sub_SYNTHETIC'}}}],
 lines:[{id:'il_SYNTHETIC',object:'line_item',invoice:'in_SYNTHETIC',livemode:false,quantity:1,period:{start:now-100,end:now+1000},parent:{type:'subscription_item_details',subscription_item_details:{subscription:'sub_SYNTHETIC',subscription_item:'si_SYNTHETIC',proration:false}},pricing:{type:'price_details',price_details:{price:'price_SYNTHETIC',product:'prod_SYNTHETIC'}}}],
 payments:[{id:'inpay_SYNTHETIC',object:'invoice_payment',invoice:'in_SYNTHETIC',livemode:false,status:'paid',amount_paid:100,payment:{type:'payment_intent',payment_intent:'pi_SYNTHETIC'}}],
 intents:[{id:'pi_SYNTHETIC',object:'payment_intent',customer:'cus_SYNTHETIC',livemode:false,latest_charge:'ch_SYNTHETIC'}],
 charges:[{id:'ch_SYNTHETIC',object:'charge',customer:'cus_SYNTHETIC',livemode:false,amount:100,amount_refunded:0,currency:'usd',disputed:false,payment_intent:'pi_SYNTHETIC'}],
 refunds:[]
});
export function stripeFixture({modify,transform,pageSize=100,modeBinding=binding}={}){
 const data=initial();modify?.(data);const requests=[];
 const page=(items,url)=>{const start=url.searchParams.get('starting_after'),offset=start?items.findIndex(x=>x.id===start)+1:0;return {object:'list',data:items.slice(offset,offset+pageSize),has_more:offset+pageSize<items.length,url:url.pathname}};
 const transport=async(input,init)=>{
  const url=new URL(input),path=url.pathname,params=url.searchParams,headers=new Headers(init.headers);
  if(url.origin!=='https://api.stripe.com'||init.method!=='GET')throw Error('Synthetic transport forbids external or mutating requests');
  requests.push({path,query:Object.fromEntries(params),method:init.method,version:headers.get('stripe-version'),context:headers.get('stripe-context')});
  let result,status=200;
  const id=path.split('/').at(-1);
  if(path==='/v1/account')result=data.account;
  else if(path.startsWith('/v1/customers/'))result=data.customers.find(x=>x.id===id);
  else if(path.startsWith('/v1/subscriptions/'))result=data.subscriptions.find(x=>x.id===id);
  else if(path==='/v1/subscription_items')result=page(data.items.filter(x=>x.subscription===params.get('subscription')),url);
  else if(/^\/v1\/invoices\/[^/]+\/lines$/.test(path))result=page(data.lines.filter(x=>x.invoice===path.split('/')[3]),url);
  else if(path.startsWith('/v1/invoices/'))result=data.invoices.find(x=>x.id===id);
  else if(path==='/v1/invoices')result=page(data.invoices.filter(x=>(!params.has('customer')||x.customer===params.get('customer'))&&(!params.has('subscription')||x.parent?.subscription_details?.subscription===params.get('subscription'))),url);
  else if(path==='/v1/invoice_payments')result=page(data.payments.filter(x=>(!params.has('invoice')||x.invoice===params.get('invoice'))&&(!params.has('payment[payment_intent]')||x.payment.payment_intent===params.get('payment[payment_intent]'))),url);
  else if(path.startsWith('/v1/payment_intents/'))result=data.intents.find(x=>x.id===id);
  else if(path==='/v1/charges')result=page(data.charges.filter(x=>(!params.has('customer')||x.customer===params.get('customer'))&&(!params.has('payment_intent')||x.payment_intent===params.get('payment_intent'))),url);
  else if(path.startsWith('/v1/charges/'))result=data.charges.find(x=>x.id===id);
  else if(path==='/v1/refunds')result=page(data.refunds.filter(x=>x.charge===params.get('charge')),url);
  else if(path.startsWith('/v1/refunds/'))result=data.refunds.find(x=>x.id===id);
  if(!result){status=404;result={error:{type:'invalid_request_error',message:'Synthetic object absent'}}}
  if(transform){const changed=await transform({path,params,request:requests.length,result:structuredClone(result),data});if(changed instanceof Response)return changed;if(changed!==undefined)result=changed}
  return new Response(JSON.stringify(result),{status,headers:{'content-type':'application/json','stripe-version':modeBinding.api_version,'request-id':'req_SYNTHETIC'}});
 };
 const client=new Stripe(`synthetic-only-${randomUUID()}`,{apiVersion:modeBinding.api_version,telemetry:false,maxNetworkRetries:0,httpClient:Stripe.createFetchHttpClient(transport)});
 return {client,data,requests};
}
