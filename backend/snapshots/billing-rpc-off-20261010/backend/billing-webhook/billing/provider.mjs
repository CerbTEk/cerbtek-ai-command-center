import { BillingError, canonical, fingerprint, normalizeSubscriptionSnapshot, validateBinding } from './core.mjs';
const fail = (code, status=503) => { throw new BillingError(code,status); };
const integer=(n,min=0)=>Number.isSafeInteger(n)&&n>=min;
const ref=value=>typeof value==='string'?value:value?.id;
const valid=(value,prefix)=>typeof value==='string'&&new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(value);
const need=(condition,code='provider_response_invalid')=>{if(!condition)fail(code)};
const supported=new Set(['2026-08-26.dahlia','2026-09-30.endive']);
const subject=(binding,customer_id,subscription_id)=>({binding_id:binding.id,account_id:binding.account_id,livemode:binding.livemode,customer_id,subscription_id});
const sorted=items=>items.toSorted((a,b)=>a.id.localeCompare(b.id));

// Inject an instantiated official stripe-node client. Only documented read methods are reachable.
// No key lookup, account selection, listener, interval or SDK client is created by this module.
export function createStripeProviderReader({client,binding,enabled=false,clock=()=>Math.floor(Date.now()/1000),
  maxPages=10,maxRequests=500,requestTimeoutMs=5000,operationTimeoutMs=30000}={}) {
  function session() {
    if(enabled!==true)fail('provider_inactive');
    validateBinding(binding);need(supported.has(binding.api_version),'provider_version_unsupported');
    need(integer(maxPages,1)&&maxPages<=100&&integer(maxRequests,1)&&maxRequests<=2000
      &&integer(requestTimeoutMs,1)&&requestTimeoutMs<=30000&&integer(operationTimeoutMs,1)&&operationTimeoutMs<=120000);
    const started=clock();need(integer(started));const deadline=Date.now()+operationTimeoutMs;let requests=0;
    const options={apiVersion:binding.api_version,maxNetworkRetries:0,timeout:requestTimeoutMs,
      ...(binding.account_kind==='connected'?{stripeContext:binding.account_id}:{})};
    async function call(resource,method,args) {
      // Fixed callers below use only GET-backed methods verified against stripe-node 23.0.0.
      need(['accounts.retrieve','customers.retrieve','subscriptions.retrieve','subscriptionItems.list','invoices.retrieve','invoices.list','invoices.listLineItems','invoicePayments.list','paymentIntents.retrieve','charges.retrieve','charges.list','refunds.retrieve','refunds.list'].includes(`${resource}.${method}`),'provider_graph_unsupported');
      if(++requests>maxRequests)fail('provider_request_limit');
      const remaining=deadline-Date.now();if(remaining<=0)fail('provider_timeout');
      need(typeof client?.[resource]?.[method]==='function','provider_graph_unsupported');
      let timer;
      try {
        const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new BillingError('provider_timeout',503)),Math.min(remaining,requestTimeoutMs));});
        const result=await Promise.race([Promise.resolve().then(()=>client[resource][method](...args,{...options,timeout:Math.min(remaining,requestTimeoutMs)})),timeout]);
        // SDK response metadata, when present, must agree with the pinned requested version.
        if(result?.lastResponse?.apiVersion)need(result.lastResponse.apiVersion===binding.api_version,'provider_binding_mismatch');
        return result;
      } catch(error) {
        if(error instanceof BillingError)throw error;
        if(error?.statusCode===429)fail('provider_rate_limited');
        if(error?.statusCode===404)fail('provider_not_found');
        if(error?.type==='StripeConnectionError'||error?.code==='ETIMEDOUT')fail('provider_timeout');
        fail('provider_unavailable');
      } finally {clearTimeout(timer)}
    }
    async function list(resource,method,params={},prefix=[]) {
      const result=[],seen=new Set();let after;
      for(let page=0;page<maxPages;page++) {
        const p=await call(resource,method,[...prefix,{...params,limit:100,...(after?{starting_after:after}:{})}]);
        need(p?.object==='list'&&Array.isArray(p.data)&&typeof p.has_more==='boolean'&&p.data.length<=100,'provider_pagination_incomplete');
        for(const row of p.data){need(typeof row?.id==='string'&&!seen.has(row.id),'provider_pagination_incomplete');seen.add(row.id);result.push(row)}
        if(!p.has_more)return result;
        need(p.data.length>0,'provider_pagination_incomplete');after=p.data.at(-1).id;
      }
      fail('provider_page_limit');
    }
    function object(value,type,id) {
      need(value&&value.object===type&&value.id===id&&!value.deleted,'provider_identity_mismatch');
      if(type!=='account'&&type!=='refund')need(value.livemode===binding.livemode,'provider_binding_mismatch');
      if(type==='refund'&&'livemode'in value)need(value.livemode===binding.livemode,'provider_binding_mismatch');
      return value;
    }
    async function verifyAccount(){object(await call('accounts','retrieve',[null,{}]),'account',binding.account_id)}
    async function customer(id){need(valid(id,'cus'),'provider_identity_mismatch');return object(await call('customers','retrieve',[id,{}]),'customer',id)}
    function invoice(value,customer_id,subscription_id=undefined) {
      object(value,'invoice',value?.id);need(valid(value.id,'in')&&ref(value.customer)===customer_id,'provider_identity_mismatch');
      need(['draft','open','paid','uncollectible','void'].includes(value.status),'provider_response_invalid');
      let sid=null;
      if(value.parent!==null){need(value.parent?.type==='subscription_details'&&valid(ref(value.parent?.subscription_details?.subscription),'sub'),'provider_graph_unsupported');sid=ref(value.parent.subscription_details.subscription)}
      if(subscription_id!==undefined)need(sid===subscription_id,'provider_identity_mismatch');
      return sid;
    }
    function paymentLink(value,invoice_id) {
      object(value,'invoice_payment',value?.id);need(ref(value.invoice)===invoice_id&&['open','paid','canceled'].includes(value.status),'provider_identity_mismatch');
      need(value.status==='paid'?integer(value.amount_paid):(value.amount_paid===null||integer(value.amount_paid)),'provider_payment_evidence_unavailable');
      need(['charge','payment_intent'].includes(value.payment?.type),'provider_graph_unsupported');return value.payment;
    }
    function charge(value,id,customer_id) {
      object(value,'charge',id);need(valid(value.id,'ch')&&ref(value.customer)===customer_id&&integer(value.amount,1)&&integer(value.amount_refunded)&&value.amount_refunded<=value.amount&&/^[a-z]{3}$/.test(value.currency),'provider_identity_mismatch');
      // A dispute needs an explicit access policy. Never silently treat it as no refund/risk.
      need(value.disputed===false,'provider_graph_unsupported');return value;
    }
    async function chargeGraph(c) {
      const customer_id=ref(c.customer);need(valid(customer_id,'cus'),'provider_identity_mismatch');
      charge(c,c.id,customer_id);
      const invoices=new Map();const pi=ref(c.payment_intent);
      if(pi!==null&&pi!==undefined){
        need(valid(pi,'pi'),'provider_identity_mismatch');
        const intent=object(await call('paymentIntents','retrieve',[pi,{}]),'payment_intent',pi);need(ref(intent.customer)===customer_id,'provider_identity_mismatch');
        const links=await list('invoicePayments','list',{payment:{type:'payment_intent',payment_intent:pi}});
        for(const link of links){const iid=ref(link.invoice);need(valid(iid,'in'),'provider_identity_mismatch');const p=paymentLink(link,iid);need(p.type==='payment_intent'&&ref(p.payment_intent)===pi,'provider_identity_mismatch');
          if(!invoices.has(iid)){const inv=await call('invoices','retrieve',[iid,{}]);need(inv?.id===iid,'provider_identity_mismatch');invoice(inv,customer_id);invoices.set(iid,inv)}
        }
      }else{
        // Legacy direct Charges have no invoice backlink in current API versions. Scan bounded
        // first-class InvoicePayment links; never use a charge's metadata or a guessed invoice.
        const candidates=await list('invoices','list',{customer:customer_id});
        for(const inv of candidates){invoice(inv,customer_id);for(const link of await list('invoicePayments','list',{invoice:inv.id})){
          const p=paymentLink(link,inv.id);if(p.type==='charge'&&ref(p.charge)===c.id)invoices.set(inv.id,inv);
        }}
      }
      const subscriptions=new Set([...invoices.values()].map(i=>invoice(i,customer_id)));
      need(subscriptions.size<=1,'provider_graph_ambiguous');
      return {customer_id,subscription_id:subscriptions.size?[...subscriptions][0]:null,
        invoice_ids:[...invoices.keys()].sort(),charge_id:c.id,payment_intent:pi??null};
    }
    return {started,call,list,object,verifyAccount,customer,invoice,paymentLink,charge,chargeGraph};
  }
  async function readSubscription(projection) {
    const s=session();need(projection&&projection.binding_id===binding.id&&valid(projection.customer_id,'cus')&&valid(projection.subscription_id,'sub')&&integer(projection.revision,1),'provider_identity_mismatch');
    await s.verifyAccount();await s.customer(projection.customer_id);
    async function readGraph() {
      const raw=await s.call('subscriptions','retrieve',[projection.subscription_id,{}]);s.object(raw,'subscription',projection.subscription_id);
      need(ref(raw.customer)===projection.customer_id,'provider_identity_mismatch');
      // Fetch the complete first-class item list, never trust an expanded first page.
      const items=await s.list('subscriptionItems','list',{subscription:raw.id});
      for(const item of items)need(item.object==='subscription_item'&&item.subscription===raw.id&&item.price?.livemode===binding.livemode,'provider_identity_mismatch');
      const object={object:'subscription',id:raw.id,customer:projection.customer_id,livemode:raw.livemode,status:raw.status,
        cancel_at_period_end:raw.cancel_at_period_end,cancel_at:raw.cancel_at??null,ended_at:raw.ended_at??null,trial_end:raw.trial_end??null,
        items:{has_more:false,data:items.map(i=>({id:i.id,price:{id:i.price.id,product:ref(i.price.product)},quantity:i.quantity,current_period_start:i.current_period_start,current_period_end:i.current_period_end}))}};
      const normalized=normalizeSubscriptionSnapshot(object,{binding,customer_id:projection.customer_id,subscription_id:projection.subscription_id});
      const invoices=await s.list('invoices','list',{customer:projection.customer_id,subscription:projection.subscription_id});
      for(const inv of invoices)s.invoice(inv,projection.customer_id,projection.subscription_id);
      const latest=ref(raw.latest_invoice);if(latest!=null)need(valid(latest,'in')&&invoices.some(i=>i.id===latest),'provider_pagination_incomplete');
      let payment={state:'unknown'};const refunds=new Map(),charges=new Map(),paymentFacts=[];
      for(const inv of invoices){
        if(inv.id===latest){
          const lines=await s.list('invoices','listLineItems',{},[inv.id]);
          let matches=false;
          for(const line of lines){
            s.object(line,'line_item',line.id);need(line.invoice===inv.id,'provider_identity_mismatch');
            const parent=line.parent?.subscription_item_details;
            if(line.parent?.type==='subscription_item_details'&&ref(parent?.subscription)===raw.id&&parent.subscription_item===items[0]?.id&&parent.proration===false
              &&ref(line.pricing?.price_details?.price)===normalized.price_id&&ref(line.pricing?.price_details?.product)===normalized.product_id
              &&line.quantity===normalized.quantity&&line.period?.start===normalized.period_start&&line.period?.end===normalized.period_end)matches=true;
          }
          if(inv.status==='paid'&&matches&&integer(inv.amount_remaining)&&inv.amount_remaining===0)payment={...subject(binding,projection.customer_id,raw.id),state:'paid',invoice_id:inv.id,period_start:normalized.period_start,period_end:normalized.period_end};
          else if(inv.status!=='paid')payment={state:'unpaid'};
        }
        for(const link of await s.list('invoicePayments','list',{invoice:inv.id})){
          const p=s.paymentLink(link,inv.id);paymentFacts.push({id:link.id,invoice_id:inv.id,type:p.type,reference:ref(p[p.type]),status:link.status,amount_paid:link.amount_paid});
          let candidates;
          if(p.type==='charge'){
            const cid=ref(p.charge);need(valid(cid,'ch'),'provider_identity_mismatch');candidates=[s.object(await s.call('charges','retrieve',[cid,{}]),'charge',cid)];
          }else{
            const pi=ref(p.payment_intent);need(valid(pi,'pi'),'provider_identity_mismatch');
            const intent=s.object(await s.call('paymentIntents','retrieve',[pi,{}]),'payment_intent',pi);need(ref(intent.customer)===projection.customer_id,'provider_identity_mismatch');
            candidates=await s.list('charges','list',{payment_intent:pi});
            for(const c of candidates)need(ref(c.payment_intent)===pi,'provider_identity_mismatch');
            if(intent.latest_charge!=null)need(candidates.some(c=>c.id===ref(intent.latest_charge)),'provider_payment_evidence_unavailable');
            if(link.status==='paid'&&link.amount_paid>0)need(candidates.length>0,'provider_payment_evidence_unavailable');
          }
          for(const candidate of candidates){
            const c=s.charge(candidate,candidate.id,projection.customer_id);if(charges.has(c.id))continue;
            const graph=await s.chargeGraph(c);need(graph.subscription_id===raw.id,'provider_graph_ambiguous');
            charges.set(c.id,{id:c.id,amount:c.amount,amount_refunded:c.amount_refunded,currency:c.currency,payment_intent:ref(c.payment_intent)??null,invoice_ids:graph.invoice_ids});
            let total=0;
            for(const r of await s.list('refunds','list',{charge:c.id})){
              s.object(r,'refund',r.id);need(valid(r.id,'re')&&ref(r.charge)===c.id&&integer(r.amount,1)&&r.amount<=c.amount&&r.currency===c.currency
                &&(r.customer==null||ref(r.customer)===projection.customer_id)&&['pending','requires_action','succeeded','failed','canceled'].includes(r.status),'provider_refund_evidence_incomplete');
              if(r.payment_intent!=null)need(ref(r.payment_intent)===ref(c.payment_intent),'provider_identity_mismatch');
              need(!refunds.has(r.id),'provider_pagination_incomplete');
              if(['succeeded','pending','requires_action'].includes(r.status))total+=r.amount;
              refunds.set(r.id,{...subject(binding,projection.customer_id,raw.id),id:r.id,charge_id:c.id,amount:r.amount,charge_amount:c.amount,currency:r.currency,status:r.status});
            }
            need(Number.isSafeInteger(total)&&total>=c.amount_refunded&&total<=c.amount,'provider_refund_evidence_incomplete');
          }
        }
      }
      return {object,payment,refunds:sorted([...refunds.values()]),audit:{latest_invoice:latest??null,
        invoices:sorted(invoices.map(i=>({id:i.id,status:i.status,amount_remaining:i.amount_remaining}))),payments:sorted(paymentFacts),charges:sorted([...charges.values()])}};
    }
    // Two bounded full reads detect observed graph churn. This is not an atomic Stripe transaction;
    // durable receipt revision fencing and configured freshness remain independently necessary.
    const first=await readGraph(),second=await readGraph();need(canonical(first)===canonical(second),'provider_snapshot_changed');
    const fetched_at=clock();need(integer(fetched_at)&&fetched_at>=s.started,'provider_response_invalid');
    return {expected_revision:projection.revision,fetch_started_at:s.started,fetched_at,object:second.object,binding:structuredClone(binding),payment:second.payment,refunds:second.refunds,refund_graph_complete:true};
  }
  async function resolveReceipt(receipt) {
    const s=session();need(receipt?.binding_id===binding.id&&valid(receipt.event_id,'evt'),'provider_identity_mismatch');await s.verifyAccount();
    async function resolveOnce(){
    let customer_id,subscription_id,graph;
    if(receipt.event_type.startsWith('customer.subscription.')){
      need(valid(receipt.object_id,'sub'),'provider_identity_mismatch');const sub=s.object(await s.call('subscriptions','retrieve',[receipt.object_id,{}]),'subscription',receipt.object_id);
      customer_id=ref(sub.customer);subscription_id=sub.id;graph={subscription_id,customer_id};
    }else if(receipt.event_type.startsWith('invoice.')){
      need(valid(receipt.object_id,'in'),'provider_identity_mismatch');const inv=await s.call('invoices','retrieve',[receipt.object_id,{}]);need(inv?.id===receipt.object_id,'provider_identity_mismatch');customer_id=ref(inv.customer);subscription_id=s.invoice(inv,customer_id);graph={invoice_id:inv.id,customer_id,subscription_id};
    }else if(receipt.event_type.startsWith('refund.')||receipt.event_type==='charge.refunded'){
      let cid=receipt.object_id;
      if(receipt.event_type.startsWith('refund.')){need(valid(cid,'re'),'provider_identity_mismatch');const refund=s.object(await s.call('refunds','retrieve',[cid,{}]),'refund',cid);cid=ref(refund.charge)}
      need(valid(cid,'ch'),'provider_identity_mismatch');const c=s.object(await s.call('charges','retrieve',[cid,{}]),'charge',cid);graph=await s.chargeGraph(c);({customer_id,subscription_id}=graph);
    }else fail('provider_graph_unsupported');
    await s.customer(customer_id);
    if(receipt.customer_id!=null)need(receipt.customer_id===customer_id,'provider_identity_mismatch');
    if(receipt.subscription_id!=null)need(receipt.subscription_id===subscription_id,'provider_identity_mismatch');
    const evidence_sha256=await fingerprint({binding_id:binding.id,account_id:binding.account_id,livemode:binding.livemode,event_id:receipt.event_id,payload_sha256:receipt.payload_sha256,graph});
    return subscription_id===null?{disposition:'not_subscription',customer_id,evidence_sha256}:{customer_id,subscription_id,evidence_sha256};
    }
    const first=await resolveOnce(),second=await resolveOnce();need(canonical(first)===canonical(second),'provider_snapshot_changed');return second;
  }
  return Object.freeze({readSubscription,resolveReceipt});
}

// Explicitly provisioned readers only. No fallback account/client is ever selected.
export function createStripeProviderRouter({ readers = new Map(), enabled = false } = {}) {
  function select(input) {
    if(enabled!==true)fail('provider_inactive');
    const reader=readers instanceof Map?readers.get(input?.binding_id):null;
    need(reader&&typeof reader.readSubscription==='function'&&typeof reader.resolveReceipt==='function','provider_binding_mismatch');
    return reader;
  }
  return Object.freeze({readSubscription:input=>select(input).readSubscription(input),resolveReceipt:input=>select(input).resolveReceipt(input)});
}
