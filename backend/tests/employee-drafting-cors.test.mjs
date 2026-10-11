import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHandler as aiHandler} from '../candidate/edge/ai-draft/handler.mjs';
import {createHandler as workflowHandler} from '../candidate/edge/customer-workflow/handler.mjs';
const legacy='https://cerbtek-ai-command-center.webflow.io',canonical='https://www.cerbtek.com';
for(const [name,make] of [['ai-draft',aiHandler],['customer-workflow',workflowHandler]]){
 test(`${name} deployed index allows exactly canonical and retained legacy origins; preflight performs no auth or runtime work`,async()=>{
  const source=await fs.readFile(new URL(`../candidate/edge/${name}/index.ts`,import.meta.url),'utf8');const match=source.match(/allowedOrigins:\s*(\[[^\]]*\])/);assert(match);
  const origins=JSON.parse(match[1].replaceAll("'",'"'));assert.deepEqual(origins,[legacy,canonical]);
  let authCalls=0;const deny=()=>{throw Error('Unexpected storage, credential, discovery or provider work')};
  const handler=make({supabase:{auth:{getUser:async()=>{authCalls++;return {data:{user:null},error:{message:'unauthenticated'}}}},rpc:deny,from:deny},allowedOrigins:origins,resolveCredential:deny,discover:deny,invoke:deny});
  for(const origin of origins){
   const r=await handler(new Request('https://fixture.invalid/'+name,{method:'OPTIONS',headers:{origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,apikey,content-type,x-client-info'}}));
   assert.equal(r.status,204);assert.equal(r.headers.get('Access-Control-Allow-Origin'),origin);assert.equal(r.headers.get('Access-Control-Allow-Methods'),'POST, OPTIONS');assert.equal(r.headers.get('Vary'),'Origin');
  }
  assert.equal(authCalls,0);
  for(const origin of ['https://untrusted.example','https://www.cerbtek.com.evil.example','http://www.cerbtek.com','https://cerbtek.com']){
   const r=await handler(new Request('https://fixture.invalid/'+name,{method:'OPTIONS',headers:{origin}}));assert.equal(r.status,403);assert.equal(r.headers.get('Access-Control-Allow-Origin'),null);assert.equal((await r.json()).error,'origin_not_allowed');
  }
  const missing=await handler(new Request('https://fixture.invalid/'+name,{method:'POST',headers:{origin:canonical},body:'{}'}));assert.equal(missing.status,401);assert.equal(missing.headers.get('Access-Control-Allow-Origin'),canonical);assert.equal(authCalls,0);
  const invalid=await handler(new Request('https://fixture.invalid/'+name,{method:'POST',headers:{origin:canonical,authorization:'Bearer synthetic-invalid'},body:'{}'}));assert.equal(invalid.status,401);assert.equal(authCalls,1);
 });
}
