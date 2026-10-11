import test from 'node:test';
import assert from 'node:assert/strict';
import {createGmailSendProvider,constructMime,encodeGmailRaw,GMAIL_SEND_SCOPE,GmailSendError} from '../candidate/edge/_shared/gmail-send.mjs';
// Strictly synthetic: no credentials, grants, mailbox data, or actual sends.
const own='business@example.test',mailbox='109876543210987654321';
const payload={recipient:'customer@example.test',subject:'Your approved reply ✓',body:'Hello customer.\n\nExact approved text.\r\nRegards, Business'};
const connection={id:'connection-fixture',organization_id:'organization-fixture',integration_id:'integration-fixture',provider:'google',status:'Connected',external_account_id:mailbox,external_account_email:own,oauth_verified_version:1,oauth_revision:'grant-fixture',client_id:'fixture-client',access_secret_id:'access-slot',refresh_secret_id:'refresh-slot',client_secret_id:'client-slot',scopes:['openid','email',GMAIL_SEND_SCOPE]};
const json=(value,options={})=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'},...options});
const code=expected=>error=>error instanceof GmailSendError&&error.code===expected&&error.outcome==='not_attempted';
function fixture({change,profile,sendResponse,dispatchError,token='fixture-token'}={}){
 const state={authority:{connection:structuredClone(connection),mailbox_id:mailbox,account_email:own,approved_binding:{approval_id:'approval-fixture',revision:2},payload:structuredClone(payload)},checks:0,dispatches:0,tokens:0},events=[],requests=[];
 const provider=createGmailSendProvider({authorize:async()=>{events.push('authorize');state.checks++;if(change)await change(state);return structuredClone(state.authority)},getAccessToken:async()=>{events.push('token');state.tokens++;return token},beforeDispatch:async value=>{events.push('dispatch');state.dispatches++;assert.deepEqual(value.payload,payload);if(dispatchError)throw Error('receipt failed')},fetchImpl:async(url,options)=>{
   requests.push({url,options});events.push(options.method);
   if(url==='https://openidconnect.googleapis.com/v1/userinfo'){if(profile instanceof Error)throw profile;return profile instanceof Response?profile:json(profile??{sub:mailbox,email:own,email_verified:true})}
   assert.equal(url,'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');if(sendResponse instanceof Error)throw sendResponse;return sendResponse??json({id:'18af102',threadId:'18af100'});
 }});return {provider,state,events,requests};
}
function decodeMime(mime){const [head,...rest]=mime.split('\r\n\r\n');const folded=head.replace(/\r\n /g,'');const subject=folded.match(/^Subject: (.*)$/m)?.[1].replace(/\r$/,'').replace(/=\?UTF-8\?B\?([^?]+)\?=/g,(_,b64)=>Buffer.from(b64,'base64').toString('utf8'));return {head,subject,body:Buffer.from(rest.join('\r\n\r\n').replace(/\s/g,''),'base64').toString('utf8')}}
test('constructMime preserves the exact approved UTF-8 subject/body with only one recipient',()=>{
 const result=decodeMime(constructMime({from:own,...payload}));assert.equal(result.subject,payload.subject);assert.equal(result.body,payload.body);assert.equal(result.head.split('\r\n').filter(x=>/^To:/.test(x)).length,1);assert(!/^(Cc|Bcc|Reply-To|Content-Disposition):/mi.test(result.head));assert.match(result.head,/^From: business@example.test\r$/m);
 const long={...payload,subject:'UTF-8 🔐 '.repeat(30)};assert.equal(decodeMime(constructMime({from:own,...long})).subject,long.subject);
});
test('MIME is base64url ready and header-like body content cannot add BCC or attachments',()=>{
 const body='Bcc: attacker@example.test\r\nContent-Type: multipart/mixed\r\n\r\n--boundary';const mime=constructMime({from:own,...payload,body});assert.equal(decodeMime(mime).body,body);assert(!/^Bcc:/mi.test(mime));const raw=encodeGmailRaw(mime);assert(/^[A-Za-z0-9_-]+$/.test(raw));assert.equal(Buffer.from(raw,'base64url').toString('utf8'),mime);
});
test('invalid recipient, sender, injected headers, extra fields and oversized data reject',()=>{
 for(const changes of [{recipient:'a@example.test,b@example.test'},{recipient:'a@example.test\r\nBcc:b@example.test'},{from:'Company <business@example.test>'},{subject:'Okay\r\nBcc: bad@example.test'},{subject:'fake\u202e'},{subject:'x'.repeat(999)},{body:'x'.repeat(100001)},{body:'\ud800'},{body:'bad\0data'},{bcc:'bad@example.test'},{attachments:[]}])assert.throws(()=>constructMime({from:own,...payload,...changes}),error=>error instanceof GmailSendError);
});
test('approved sender identity is verified before durable dispatch and one exact send POST',async()=>{
 const f=fixture();assert.equal(f.events.length,0);assert(Object.isFrozen(f.provider));const result=await f.provider.send(payload);assert.deepEqual(result,{outcome:'accepted',provider_message_id:'18af102',provider_thread_id:'18af100'});assert.deepEqual(f.events,['authorize','token','authorize','GET','authorize','dispatch','POST']);assert.equal(f.state.dispatches,1);assert.equal(f.requests.length,2);
 const {url,options}=f.requests[1];assert.equal(new URL(url).origin,'https://gmail.googleapis.com');assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.equal(options.cache,'no-store');assert.equal(options.headers.Authorization,'Bearer fixture-token');assert(options.signal instanceof AbortSignal);const body=JSON.parse(options.body);assert.deepEqual(Object.keys(body),['raw']);const mime=Buffer.from(body.raw,'base64url').toString('utf8');assert.equal(decodeMime(mime).body,payload.body);assert.equal(decodeMime(mime).subject,payload.subject);assert(mime.startsWith(`From: ${own}\r\nTo: ${payload.recipient}\r\n`));
});
test('send-only scope never calls Gmail profile/read, aliases or attachment endpoints',async()=>{const f=fixture();await f.provider.send(payload);assert.deepEqual(f.requests.map(x=>new URL(x.url).pathname),['/v1/userinfo','/gmail/v1/users/me/messages/send'])});
test('missing send scope and wrong/unverified connection abort before any token or provider call',async()=>{
 for(const changes of [{scopes:[]},{scopes:['https://mail.google.com/']},{provider:'microsoft'},{status:'Disconnected'},{oauth_verified_version:0}]){const f=fixture({change:s=>Object.assign(s.authority.connection,changes)});await assert.rejects(()=>f.provider.send(payload),code('google_mailbox_not_authorized'));assert.equal(f.state.tokens,0);assert.equal(f.state.dispatches,0);assert.equal(f.requests.length,0)}
});
test('caller payload must exactly match a nonempty durable approval binding',async()=>{
 for(const changes of [{payload:{...payload,recipient:'attacker@example.test'}},{payload:{...payload,body:'Other text'}},{approved_binding:{}},{approved_binding:null},{mailbox_id:'other'},{account_email:'other@example.test'}]){const f=fixture({change:s=>Object.assign(s.authority,changes)});await assert.rejects(()=>f.provider.send(payload),error=>error instanceof GmailSendError);assert.equal(f.state.tokens,0);assert.equal(f.state.dispatches,0)}
 const f=fixture();await assert.rejects(()=>f.provider.send({...payload,from:'attacker@example.test'}),code('invalid_gmail_send_payload'));assert.equal(f.events.length,0);
});
test('a Google sub/email mismatch, unverified identity or failed identity read never claims dispatch',async()=>{
 for(const profile of [{sub:'other',email:own,email_verified:true},{sub:mailbox,email:'other@example.test',email_verified:true},{sub:mailbox,email:own,email_verified:false},new Error('network secret detail'),json({}, {status:403})]){const f=fixture({profile});await assert.rejects(()=>f.provider.send(payload),error=>error instanceof GmailSendError);assert.equal(f.state.dispatches,0);assert.equal(f.requests.length,1)}
});
test('changes to approval, content, identity, grant or ownership prevent provider POST',async()=>{
 const mutations=[s=>{s.authority.approved_binding.revision++},s=>{s.authority.payload.body='changed'},s=>{s.authority.connection.organization_id='other'},s=>{s.authority.connection.oauth_revision='other'},s=>{s.authority.connection.external_account_email='other@example.test'},s=>{s.authority.connection.access_secret_id='other'}];
 for(const mutation of mutations){const f=fixture({change:s=>{if(s.checks===3)mutation(s)}});await assert.rejects(()=>f.provider.send(payload),error=>error instanceof GmailSendError);assert.equal(f.requests.length,1);assert.equal(f.state.dispatches,0)}
 const refreshed=fixture({change:s=>{s.authority.connection.oauth_refresh_revision=String(s.checks)}});assert.equal((await refreshed.provider.send(payload)).outcome,'accepted');
});
test('failure to durably record dispatch aborts before the send POST',async()=>{const f=fixture({dispatchError:true});await assert.rejects(()=>f.provider.send(payload),code('gmail_dispatch_not_recorded'));assert.equal(f.state.dispatches,1);assert.equal(f.requests.length,1)});
test('every failure after fetch starts is explicit unknown and never retried',async()=>{
 const responses=[new Error('timeout with private detail'),json({error:'rejected'}, {status:400}),json({}, {status:401}),json({}, {status:403}),json({}, {status:429}),json({}, {status:500}),json({id:'ok'}),json({id:'../wrong',threadId:'x'}),new Response('invalid',{headers:{'content-type':'application/json'}}),json({id:'ok',threadId:'ok',extra:'x'.repeat(270000)}),new Response('',{status:302,headers:{location:'https://attacker.invalid'}})];
 for(const sendResponse of responses){const f=fixture({sendResponse});assert.deepEqual(await f.provider.send(payload),{outcome:'unknown',error:'gmail_send_outcome_unknown'});assert.equal(f.state.dispatches,1);assert.equal(f.state.tokens,1);assert.equal(f.requests.length,2);assert.equal(f.events.at(-1),'POST')}
});
test('invalid token is rejected without reading identity or claiming dispatch',async()=>{for(const token of ['', 'x\n', 'x'.repeat(32769)]){const f=fixture({token});await assert.rejects(()=>f.provider.send(payload),code('google_mailbox_credentials_unavailable'));assert.equal(f.requests.length,0);assert.equal(f.state.dispatches,0)}});

test('authority read failures are sanitized typed not-attempted failures before dispatch',async()=>{for(const at of [1,2,3]){const f=fixture({change:s=>{if(s.checks===at)throw Error('sensitive database detail')}});await assert.rejects(()=>f.provider.send(payload),code('gmail_send_authorization_unavailable'));assert.equal(f.state.dispatches,0);assert.equal(f.requests.filter(x=>x.options.method==='POST').length,0)}});
