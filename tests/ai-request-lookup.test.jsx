import React from 'react';
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup,within,act} from '@testing-library/react';
import AIDraftSetup from '../src/AIDraftSetup';
afterEach(cleanup);
const id='20000000-0000-4000-8000-000000000001',key='30000000-0000-4000-8000-000000000001';
const config={schema_version:1,provider:'openai',model:'fixture',task:'customer_reply',instructions:'Use only supplied facts.',source:'manual_context',max_input_bytes:6000,max_output_tokens:1000,max_daily_runs:10,daily_budget_microusd:1000000,human_review:true};
const loaded={configuration:{id:'config',version:1,configuration:config},runs:[],unresolved_count:0,unresolved_runs:[],unresolved_limit:20,catalog:[{provider:'openai',model:'fixture'}],readiness:{live_enabled:true,credential_configured:true,status:'configured'}};
const old={id,request_key:key,status:'unknown',reserved_microusd:1000,created_at:'2026-01-01T12:00:00Z',failure_code:'provider_timeout_unknown'};
const blocked={...loaded,unresolved_count:1,unresolved_runs:[old]};
const make=fn=>({functions:{invoke:vi.fn(async(_,{body})=>({data:await fn(body)}))}});
async function ready(client,organizationId='org'){const view=render(<AIDraftSetup organizationId={organizationId} client={client}/>);await screen.findByText(/version 1/);fireEvent.change(screen.getByLabelText('Business context'),{target:{value:'Synthetic context'}});return view}
function lookup(reference=id,type='run_id'){fireEvent.change(screen.getByLabelText('Reference type'),{target:{value:type}});fireEvent.change(screen.getByLabelText('Request reference'),{target:{value:reference}});fireEvent.click(screen.getByText('Look up request'))}
const generate=()=>screen.getByText('Generate review-only draft');

it('an old unresolved request outside recent20 is inspectable, and closing never unlocks a replacement',async()=>{
 const recent=Array.from({length:20},(_,n)=>({id:`recent-${n}`,status:'failed',reserved_microusd:1000}));
 const client=make(b=>b.operation==='load'?{...blocked,runs:recent}:{run:old});await ready(client);
 expect(generate().disabled).toBe(true);fireEvent.click(screen.getByLabelText(`Inspect unresolved request ${id}`));
 const detail=await screen.findByRole('article',{name:'Inspected AI request'});expect(within(detail).getByText('Recorded status: unknown')).not.toBeNull();
 expect(within(detail).getByText(`Request key: ${key}`)).not.toBeNull();expect(within(detail).getByText(/still needs operator investigation/)).not.toBeNull();
 expect(generate().disabled).toBe(true);fireEvent.click(screen.getByText('Close request details'));expect(generate().disabled).toBe(true);
 expect(client.functions.invoke.mock.calls.map(x=>x[1].body.operation)).toEqual(['load','lookup']);
});
it('manual key lookup can inspect an older draft but never reviews it or clears another unresolved request',async()=>{
 const terminal={...old,status:'awaiting_review',draft:{body:'Earlier saved draft'}};
 const client=make(b=>b.operation==='load'?blocked:{run:terminal});await ready(client);lookup(key,'request_key');
 const detail=await screen.findByRole('article',{name:'Inspected AI request'});expect(within(detail).getByText('Earlier saved draft')).not.toBeNull();expect(within(detail).queryByRole('button',{name:/Accept|Reject/})).toBeNull();
 expect(client.functions.invoke.mock.calls.at(-1)[1].body).toEqual({organization_id:'org',operation:'lookup',request_key:key});expect(generate().disabled).toBe(true);
});
it('missing lookup results do not treat absence as safe to retry',async()=>{
 const client=make(b=>b.operation==='load'?blocked:{run:null});await ready(client);lookup();
 await screen.findByText(/A missing record does not prove/);expect(generate().disabled).toBe(true);expect(screen.queryByRole('article',{name:'Inspected AI request'})).toBeNull();
});
it('an org switch clears inspection state and ignores the earlier org response',async()=>{
 let resolve;const client=make(b=>b.operation==='lookup'?new Promise(r=>{resolve=r}):b.organization_id==='first'?blocked:loaded);
 const view=await ready(client,'first');fireEvent.click(screen.getByLabelText(`Inspect unresolved request ${id}`));
 view.rerender(<AIDraftSetup organizationId="second" client={client}/>);await waitFor(()=>expect(screen.queryByLabelText(`Inspect unresolved request ${id}`)).toBeNull());
 await act(async()=>resolve({run:{...old,draft:{body:'Private first-organization draft'}}}));
 expect(screen.queryByText('Private first-organization draft')).toBeNull();expect(screen.queryByRole('article',{name:'Inspected AI request'})).toBeNull();expect(screen.getByLabelText('Request reference').value).toBe('');
});
it('rapid repeated lookup clicks cause one read',async()=>{
 let resolve;const client=make(b=>b.operation==='load'?loaded:new Promise(r=>{resolve=r}));await ready(client);lookup();fireEvent.click(screen.getByText('Look up request'));
 expect(client.functions.invoke.mock.calls.filter(x=>x[1].body.operation==='lookup')).toHaveLength(1);
 await act(async()=>resolve({run:old}));await screen.findByText('Recorded status: unknown');expect(generate().disabled).toBe(true);
});
it('a newly discovered unresolved record adds a blocker which closing or a later terminal lookup cannot clear',async()=>{
 let count=0;const client=make(b=>b.operation==='load'?loaded:{run:++count===1?old:{...old,status:'failed'}});await ready(client);expect(generate().disabled).toBe(false);lookup();
 await screen.findByText('Recorded status: unknown');fireEvent.click(screen.getByText('Close request details'));expect(generate().disabled).toBe(true);lookup();
 await screen.findByText('Recorded status: failed');expect(generate().disabled).toBe(true);
});
it('read failure shows an error without claiming an absent record or unlocking',async()=>{
 const client={functions:{invoke:vi.fn(async(_,{body})=>body.operation==='load'?{data:blocked}:{error:{context:new Response(JSON.stringify({error:'storage_unavailable'}),{status:503})}})}};
 await ready(client);lookup();await screen.findByText(/Saved request records could not be loaded/);expect(generate().disabled).toBe(true);expect(screen.queryByText(/No matching request is visible/)).toBeNull();
});
it('a lost local response exposes its original request key for read-only inspection without replacement',async()=>{
 const client={functions:{invoke:vi.fn(async(_,{body})=>body.operation==='load'?{data:loaded}:body.operation==='run'?{error:new Error('lost')}:{data:{run:null}})}};
 await ready(client);fireEvent.click(generate());await screen.findByText(/Pending request key:/);const sent=client.functions.invoke.mock.calls.find(x=>x[1].body.operation==='run')[1].body;
 fireEvent.click(screen.getByText('Inspect pending request'));await screen.findByText(/A missing record does not prove/);
 expect(client.functions.invoke.mock.calls.at(-1)[1].body).toEqual({organization_id:'org',operation:'lookup',request_key:sent.request_key});expect(generate().disabled).toBe(true);expect(client.functions.invoke.mock.calls.filter(x=>x[1].body.operation==='run')).toHaveLength(1);
});
