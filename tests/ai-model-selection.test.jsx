import {aiReadinessFixture} from './activation-fixture'
import React from 'react';
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import AIDraftSetup from '../src/AIDraftSetup';
afterEach(cleanup);
const configuration={id:'config',version:1,configuration:{schema_version:1,provider:'openai',model:'fixture-openai',task:'customer_reply',instructions:'Use the supplied context for a draft.',source:'manual_context',max_input_bytes:6000,max_output_tokens:1000,max_daily_runs:10,daily_budget_microusd:1000000,human_review:true}};
const providers=[{id:'openai',label:'OpenAI',credential_configured:true},{id:'anthropic',label:'Anthropic Claude',credential_configured:true},{id:'gemini',label:'Google Gemini',credential_configured:false}];
const loaded={configuration,providers,model_status:'ready',catalog:[{provider:'openai',model:'fixture-openai',label:'Friendly OpenAI model',available:true,structured_outputs:true}],runs:[],readiness:{live_enabled:false,credential_configured:true,status:'live_inference_disabled'}};
const models=(provider,model='fixture-claude')=>({provider,credential_configured:true,model_status:'ready',catalog:[{provider,model,label:'Friendly Claude model',available:true,structured_outputs:true}]});
const clientFor=fn=>({functions:{invoke:vi.fn(async(_,{body})=>({data:await fn(body)}))}});
const ready=async client=>{render(<AIDraftSetup organizationId="org" client={client}/>);await screen.findByText(/version 1/)};
it('uses a labeled dropdown and three explicit supported providers without a raw model ID input',async()=>{
 await ready(clientFor(()=>loaded));
 expect(screen.getByLabelText('Model').tagName).toBe('SELECT');
 expect(screen.getByRole('option',{name:'Friendly OpenAI model'}).value).toBe('fixture-openai');
 expect([...screen.getByLabelText('AI provider').options].map(x=>x.text)).toEqual(['OpenAI','Anthropic Claude','Google Gemini']);
 expect(screen.queryByLabelText('Exact model ID')).toBeNull();
 expect(screen.queryByText(/API key/i,{selector:'input'})).toBeNull();
});
it('provider switch immediately clears model, then uses only models from the chosen provider',async()=>{
 let resolve;const client=clientFor(b=>b.operation==='load'?loaded:new Promise(r=>resolve=r));await ready(client);
 fireEvent.change(screen.getByLabelText('AI provider'),{target:{value:'anthropic'}});
 expect(screen.getByLabelText('Model').value).toBe('');expect(screen.getByText('Save configuration version').disabled).toBe(true);
 expect(screen.queryByRole('option',{name:'Friendly OpenAI model'})).toBeNull();
 resolve({...models('anthropic'),catalog:[...models('anthropic').catalog,{provider:'openai',model:'injected',label:'Wrong provider'}]});
 await screen.findByRole('option',{name:'Friendly Claude model'});
 expect(screen.queryByRole('option',{name:'Wrong provider'})).toBeNull();
 expect(screen.getByLabelText('Model').value).toBe('');
 fireEvent.change(screen.getByLabelText('Model'),{target:{value:'fixture-claude'}});
 expect(screen.getByText('Save configuration version').disabled).toBe(false);
 expect(screen.getByText(/this context is sent to Anthropic Claude/)).not.toBeNull();
});
it('an unconnected provider shows a useful empty state and no invented models',async()=>{
 const client=clientFor(b=>b.operation==='load'?loaded:{provider:'gemini',catalog:[],model_status:'not_connected',credential_configured:false});await ready(client);
 fireEvent.change(screen.getByLabelText('AI provider'),{target:{value:'gemini'}});
 await screen.findByText(/No account models are available yet/);
 expect(screen.getByLabelText('Model').disabled).toBe(true);expect(screen.getByText('Save configuration version').disabled).toBe(true);
 expect(screen.getByText('Generate review-only draft').disabled).toBe(true);
 fireEvent.click(screen.getByText('How to connect'));
 expect(screen.getByRole('region',{name:'Secure AI connection instructions'})).not.toBeNull();
 expect(screen.getByText(/This page never collects or displays API keys/)).not.toBeNull();
 expect(client.functions.invoke.mock.calls.map(x=>x[1].body.operation)).toEqual(['load','models']);
 fireEvent.click(screen.getByText('Hide connection instructions'));
 expect(screen.queryByRole('region',{name:'Secure AI connection instructions'})).toBeNull();
});
it('superseded model discovery cannot replace newer provider models',async()=>{
 let first;const client=clientFor(b=>b.operation==='load'?loaded:b.provider==='anthropic'?new Promise(r=>first=r):models('gemini','fixture-gemini'));await ready(client);
 fireEvent.change(screen.getByLabelText('AI provider'),{target:{value:'anthropic'}});
 fireEvent.change(screen.getByLabelText('AI provider'),{target:{value:'gemini'}});
 await waitFor(()=>expect(screen.getByLabelText('Model').disabled).toBe(false));
 first(models('anthropic'));
 await waitFor(()=>expect([...screen.getByLabelText('Model').options].map(x=>x.value)).toEqual(['','fixture-gemini']));
 expect(screen.getByLabelText('AI provider').value).toBe('gemini');
});
it('organization switch clears model choices and discards late discovery from previous organization',async()=>{
 let resolve;const client=clientFor(b=>b.organization_id==='second'?{...loaded,configuration:{...configuration,version:2},catalog:[],model_status:'not_connected',providers:providers.map(x=>({...x,credential_configured:false}))}:b.operation==='load'?loaded:new Promise(r=>resolve=r));
 const view=render(<AIDraftSetup organizationId="first" client={client}/>);await screen.findByText(/version 1/);
 fireEvent.click(screen.getByText('Refresh models'));
 view.rerender(<AIDraftSetup organizationId="second" client={client}/>);await screen.findByText(/version 2/);
 resolve(models('openai','leaked-model'));await waitFor(()=>expect(screen.queryByRole('option',{name:'Friendly Claude model'})).toBeNull());
 expect(screen.getByLabelText('Model').disabled).toBe(true);
 expect(screen.getByText('Generate review-only draft').disabled).toBe(true);
});
it('a saved but unavailable model remains visible while save and inference stay blocked',async()=>{
 await ready(clientFor(()=>({...loaded,catalog:[],model_status:'no_compatible_models'})));
 expect(screen.getByRole('option',{name:'fixture-openai · saved model unavailable'}).disabled).toBe(true);
 expect(screen.getByText(/The saved model is unavailable/)).not.toBeNull();
 expect(screen.getByText('Save configuration version').disabled).toBe(true);expect(screen.getByText('Generate review-only draft').disabled).toBe(true);
});
it('discovery failure clears choices, does not expose raw errors, and can recover with refresh',async()=>{
 let calls=0;const client=clientFor(b=>{if(b.operation==='load')return loaded;if(++calls===1)throw Error('secret-provider-error');return {...models('openai','fixture-openai'),catalog:loaded.catalog}});await ready(client);
 fireEvent.click(screen.getByText('Refresh models'));await screen.findByText(/Models could not be verified/);
 expect(screen.queryByText(/secret-provider-error/)).toBeNull();expect(screen.getByText('Save configuration version').disabled).toBe(true);
 fireEvent.click(screen.getByText('Refresh models'));await screen.findByRole('option',{name:'Friendly OpenAI model'});
 expect(screen.getByText('Save configuration version').disabled).toBe(false);
});
it('selected provider/model are saved without credential or endpoint payload',async()=>{
 const client=clientFor(b=>b.operation==='load'?loaded:b.operation==='models'?models('anthropic'):{configuration:{...configuration,version:2,configuration:b.configuration}});await ready(client);
 fireEvent.change(screen.getByLabelText('AI provider'),{target:{value:'anthropic'}});await screen.findByRole('option',{name:'Friendly Claude model'});
 fireEvent.change(screen.getByLabelText('Model'),{target:{value:'fixture-claude'}});fireEvent.click(screen.getByText('Save configuration version'));
 await screen.findByText(/Configuration version 2 saved/);
 const payload=client.functions.invoke.mock.calls.at(-1)[1].body;expect(payload.configuration.provider).toBe('anthropic');expect(payload.configuration.model).toBe('fixture-claude');expect(payload.configuration.api_key).toBeUndefined();expect(payload.configuration.endpoint).toBeUndefined();
});
it('uncertain run blocks provider switching and model controls while pending',async()=>{
 const client=clientFor(b=>b.operation==='load'?{...loaded,readiness:aiReadinessFixture('org','config')}:Promise.reject(Error('unknown')));await ready(client);
 fireEvent.change(screen.getByLabelText('Business context'),{target:{value:'Synthetic context'}});fireEvent.click(screen.getByText('Generate review-only draft'));
 await screen.findByText(/A request is unresolved/);
 expect(screen.getByLabelText('AI provider').closest('fieldset').disabled).toBe(true);
 expect(screen.getByText('Generate review-only draft').disabled).toBe(true);
});
it('pre-admission model discovery rejection does not create an uncertain inference request',async()=>{
 const client={functions:{invoke:vi.fn(async(_,{body})=>body.operation==='load'?{data:{...loaded,readiness:aiReadinessFixture('org','config')}}:{data:{error:'model_unavailable'}})}};await ready(client);
 fireEvent.change(screen.getByLabelText('Business context'),{target:{value:'Synthetic context'}});fireEvent.click(screen.getByText('Generate review-only draft'));
 await screen.findByText(/This model is no longer available/);
 expect(screen.queryByText(/A request is unresolved/)).toBeNull();
});
it('unavailable connection lookup is not mislabeled as a confirmed disconnected account',async()=>{
 await ready(clientFor(()=>({...loaded,catalog:[],model_status:'discovery_failed',providers:providers.map(x=>({...x,credential_configured:false,connection_status:'unavailable'}))})));
 expect(screen.getByText('OpenAI: Connection status unavailable')).not.toBeNull();
 expect(screen.queryByText('OpenAI: Not connected')).toBeNull();
});
it('model selection lowers an incompatible output limit and explains the adjustment',async()=>{
 const client=clientFor(b=>b.operation==='load'?loaded:{...models('anthropic'),catalog:[{...models('anthropic').catalog[0],max_output_tokens:512}]});await ready(client);
 fireEvent.change(screen.getByLabelText('AI provider'),{target:{value:'anthropic'}});await screen.findByRole('option',{name:'Friendly Claude model'});
 fireEvent.change(screen.getByLabelText('Model'),{target:{value:'fixture-claude'}});
 expect(screen.getByLabelText('Maximum output tokens').value).toBe('512');expect(screen.getByLabelText('Maximum output tokens').max).toBe('512');
 expect(screen.getByText('Output limit reduced to 512 tokens for this model.')).not.toBeNull();
});
it('a refreshed lower model limit requires correction before save or inference',async()=>{
 await ready(clientFor(()=>({...loaded,catalog:[{...loaded.catalog[0],max_output_tokens:512}]})));
 expect(screen.getByText(/Reduce maximum output tokens to 512/)).not.toBeNull();expect(screen.getByText('Save configuration version').disabled).toBe(true);
 fireEvent.change(screen.getByLabelText('Maximum output tokens'),{target:{value:'512'}});
 expect(screen.getByText('Save configuration version').disabled).toBe(false);
});
it('organization switch clears previous save notices and discards late save completion',async()=>{
 let resolve;let deferred=false;const client=clientFor(b=>b.operation==='load'?loaded:deferred?new Promise(r=>resolve=r):{configuration:{...configuration,version:2,configuration:b.configuration}});
 const view=render(<AIDraftSetup organizationId="first" client={client}/>);await screen.findByText(/version 1/);
 fireEvent.click(screen.getByText('Save configuration version'));await screen.findByText(/Configuration version 2 saved/);
 view.rerender(<AIDraftSetup organizationId="second" client={client}/>);await screen.findByText(/version 1/);expect(screen.queryByText(/Configuration version 2 saved/)).toBeNull();
 deferred=true;fireEvent.click(screen.getByText('Save configuration version'));
 view.rerender(<AIDraftSetup organizationId="third" client={client}/>);await screen.findByText(/version 1/);
 resolve({configuration:{...configuration,version:88}});await waitFor(()=>expect(screen.queryByText(/version 88/)).toBeNull());
 expect(screen.queryByText(/Configuration version 88 saved/)).toBeNull();
});
it('refresh preserves unavailable connection status when the credential resolver is down',async()=>{
 const client=clientFor(b=>b.operation==='load'?loaded:{provider:'openai',catalog:[],credential_configured:false,model_status:'discovery_failed',model_error:'provider_connection_unavailable'});await ready(client);
 fireEvent.click(screen.getByText('Refresh models'));await screen.findByText('OpenAI: Connection status unavailable');
 expect(screen.queryByText('OpenAI: Not connected')).toBeNull();
});
it('failed initial load reports unknown connection status instead of claiming not connected',async()=>{
 const client=clientFor(()=>Promise.reject(Error('offline')));render(<AIDraftSetup organizationId="org" client={client}/>);
 await screen.findByText('OpenAI: Connection status unavailable');expect(screen.queryByText('OpenAI: Not connected')).toBeNull();
 expect(screen.getByText('Save configuration version').disabled).toBe(true);
});
it('models explicitly marked unavailable or incompatible are never offered',async()=>{
 await ready(clientFor(()=>({...loaded,catalog:[...loaded.catalog,{provider:'openai',model:'disabled',label:'Unavailable model',available:false},{provider:'openai',model:'incompatible',label:'No schema model',structured_outputs:false}]})));
 expect(screen.queryByRole('option',{name:'Unavailable model'})).toBeNull();expect(screen.queryByRole('option',{name:'No schema model'})).toBeNull();
});
