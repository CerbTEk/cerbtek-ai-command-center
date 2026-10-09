import test from 'node:test';
import assert from 'node:assert/strict';
import {createBillingWebhookHandler} from '../candidate/edge/billing/transport.mjs';
import {binding,now,signed} from './fixtures/billing-fixtures.mjs';
const request=(s,extra={})=>new Request('https://synthetic.example/webhooks/stripe',{method:'POST',headers:{'content-type':'application/json','stripe-signature':s.signature},body:s.raw,...extra});
test('inactive transport returns unavailable without touching storage',async()=>{
 const result=await createBillingWebhookHandler() (new Request('https://synthetic.example'));assert.equal(result.status,503);assert.equal((await result.json()).code,'billing_inactive');
});
test('Fetch transport passes exact raw bytes and waits for durable store result',async()=>{
 const s=signed();let called=0;const handler=createBillingWebhookHandler({enabled:true,signingSecret:s.secret,binding,clock:()=>now,store:{recordReceipt:async receipt=>{called++;assert.equal(receipt.event_id,'evt_SYNTHETIC');return {status:200,code:'recorded'}}}});
 const result=await handler(request(s));assert.equal(result.status,200);assert.equal(called,1);assert.equal(result.headers.get('cache-control'),'no-store');
});
test('method, MIME, declared oversize and actual oversize are rejected',async()=>{
 const s=signed();const handler=createBillingWebhookHandler({enabled:true,signingSecret:s.secret,binding,clock:()=>now});
 assert.equal((await handler(new Request('https://synthetic.example'))).status,405);
 assert.equal((await handler(request(s,{headers:{'content-type':'text/plain'}}))).status,415);
 assert.equal((await handler(request(s,{headers:{'content-type':'application/json','content-length':'262145'}}))).status,413);
 assert.equal((await handler(request(s,{body:new Uint8Array(262145)}))).status,413);
});
test('invalid signature never reaches store; store exception returns only generic retryable error',async()=>{
 const s=signed();let calls=0;const handler=createBillingWebhookHandler({enabled:true,signingSecret:s.secret,binding,clock:()=>now,store:{recordReceipt(){calls++;throw Error('private SQL details')}}});
 assert.equal((await handler(request(s,{body:Buffer.from('{}')}))).status,400);assert.equal(calls,0);
 const result=await handler(request(s));assert.equal(result.status,503);assert.deepEqual(await result.json(),{code:'billing_store_unavailable'});
});
test('body read timeout cancels stalled stream',async()=>{
 const s=signed();let cancelled=false;
 const stream=new ReadableStream({pull(){return new Promise(()=>{})},cancel(){cancelled=true}});
 const handler=createBillingWebhookHandler({enabled:true,bodyTimeoutMs:10});
 const result=await handler(request(s,{body:stream,duplex:'half'}));assert.equal(result.status,408);assert.equal(cancelled,true);
});

 test('slow stream cancellation cannot extend the body deadline',async()=>{
 const s=signed();const stream=new ReadableStream({pull(){return new Promise(()=>{})},cancel(){return new Promise(()=>{})}});
 const handler=createBillingWebhookHandler({enabled:true,bodyTimeoutMs:10});
 const result=await handler(request(s,{body:stream,duplex:'half'}));assert.equal(result.status,408);
 });
