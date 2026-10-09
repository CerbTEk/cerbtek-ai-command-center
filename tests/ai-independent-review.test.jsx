import React from 'react';
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import AIDraftSetup from '../src/AIDraftSetup';
afterEach(cleanup);
const configuration={id:'config',version:1,configuration:{schema_version:1,provider:'openai',model:'mock-only',task:'customer_reply',instructions:'Draft from supplied context.',source:'manual_context',max_input_bytes:12000,max_output_tokens:128,max_daily_runs:10,daily_budget_microusd:1000000,human_review:true}};
const loaded={configuration,catalog:[{provider:'openai',model:'mock-only'}],runs:[],readiness:{live_enabled:true,credential_configured:true,status:'configured'}};
it('reload with unresolved reservation cannot enable a replacement',async()=>{
 const client={functions:{invoke:vi.fn(async()=>({data:{...loaded,runs:[{id:'run1',request_key:'key',status:'reserved',reserved_microusd:1000}]}}))}};
 render(<AIDraftSetup organizationId="org" client={client}/>);
 await screen.findByText(/Dispatch is pending/);
 fireEvent.change(screen.getByLabelText('Business context'),{target:{value:'Context'}});
 expect(screen.getByText('Generate review-only draft').disabled).toBe(true);
});
it('known pre-admission budget rejection remains actionable instead of uncertain',async()=>{
 const client={functions:{invoke:vi.fn(async(_,{body})=>body.operation==='load'?{data:loaded}:{data:null,error:{context:new Response(JSON.stringify({error:'request_budget_exceeded'}),{status:409})}})}};
 render(<AIDraftSetup organizationId="org" client={client}/>);
 await screen.findByText(/version 1/);
 fireEvent.change(screen.getByLabelText('Business context'),{target:{value:'Context'}});
 fireEvent.click(screen.getByText('Generate review-only draft'));
 await waitFor(()=>expect(screen.queryByText(/The conservative request allowance/)).not.toBeNull());
 expect(screen.queryByText(/A request is unresolved/)).toBeNull();
});

it('all-history unresolved count blocks even when recent activity is empty',async()=>{
 const client={functions:{invoke:vi.fn(async()=>({data:{...loaded,unresolved_count:1}}))}};
 render(<AIDraftSetup organizationId="org" client={client}/>);
 await screen.findByText(/version 1/);
 fireEvent.change(screen.getByLabelText('Business context'),{target:{value:'Context'}});
 expect(screen.getByText('Generate review-only draft').disabled).toBe(true);
});
it('checking a reserved outcome cannot enable replacement',async()=>{
 let key;let loads=0;
 const client={functions:{invoke:vi.fn(async(_,{body})=>{
  if(body.operation==='load'){loads++;return {data:loads===1?loaded:{...loaded,unresolved_count:1,runs:[{id:'pending',request_key:key,status:'reserved',reserved_microusd:1000}]}}}
  key=body.request_key;return {error:new Error('network result lost')};
 })}};
 render(<AIDraftSetup organizationId="org" client={client}/>);
 await screen.findByText(/version 1/);
 fireEvent.change(screen.getByLabelText('Business context'),{target:{value:'Context'}});
 fireEvent.click(screen.getByText('Generate review-only draft'));
 await screen.findByText(/A request is unresolved/);
 fireEvent.click(screen.getByText('Check recorded outcome'));
 await screen.findByText('Recorded run status: reserved.');
 expect(screen.getByText('Generate review-only draft').disabled).toBe(true);
});
