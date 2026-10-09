import React,{useEffect,useRef,useState} from 'react'
import './ai-setup.css'
const supportedProviders=[{id:'openai',label:'OpenAI',console:'https://platform.openai.com/api-keys'},{id:'anthropic',label:'Anthropic Claude',console:'https://platform.claude.com/settings/keys'},{id:'gemini',label:'Google Gemini',console:'https://aistudio.google.com/api-keys'}]
const validModels=(items,provider)=>(Array.isArray(items)?items:[]).filter(x=>x.provider===provider&&x.available!==false&&x.structured_outputs!==false&&typeof x.model==='string')
const modelMessages={not_connected:'No account models are available yet. Ask your Kairo deployment administrator to add this provider’s API key securely on the server and approve supported models, then refresh this list.',no_compatible_models:'No approved draft-capable models are available for this connection. An administrator needs to approve model compatibility and pricing.',discovery_failed:'Models could not be verified. Refresh models to try again; no model has been made available.'}
const initial={schema_version:1,provider:'openai',model:'',task:'customer_reply',instructions:'Use the supplied facts to prepare a concise, professional draft. Flag missing information.',source:'manual_context',max_input_bytes:6000,max_output_tokens:1000,max_daily_runs:10,daily_budget_microusd:1000000,human_review:true}
const messages={model_unavailable:'This model is no longer available or its output limit is too low. Refresh models and choose a supported model.',unsupported_provider:'Choose one of the supported AI providers.',provider_auth_failed:'The provider rejected the organization connection. Ask an administrator to check its credential, then refresh models.',provider_rate_limited:'The provider is rate-limiting requests. Wait before refreshing models.',provider_failed:'The provider could not complete the request.',provider_discovery_timeout:'Model discovery timed out. Refresh models to try again.',provider_discovery_failed:'Available models could not be verified. Refresh models to try again.',invalid_model_catalog:'The provider returned an invalid model list. No models have been approved from it.',provider_connection_unavailable:'The organization connection could not be checked. Ask an administrator to verify the secure setup.',invalid_request_reference:'Enter one valid request ID or request key.',storage_unavailable:'Saved request records could not be loaded. No outcome has been confirmed.',provider_unconfigured:'The selected provider is not connected to this organization.',live_inference_disabled:'Live model execution is disabled for this workspace.',model_not_configured:'The selected model needs an approved server-side model and pricing configuration.',configuration_or_run_conflict:'Configuration or run state changed, or the daily allowance is exhausted. Reload before retrying.',organization_access_denied:'An organization owner, admin, or consultant must manage AI setup.',provider_timeout_unknown:'The provider timed out. It may have processed the request. The allowance stays reserved.',provider_transport_unknown:'The provider result is unknown. The allowance stays reserved.',invalid_configuration:'Check the model, instructions and limits.',request_budget_exceeded:'The conservative request allowance exceeds the budget. Reduce context/output limits or revise the budget.',invalid_context:'Enter context within the configured UTF-8 byte limit.'}
export default function AIDraftSetup({organizationId,client}){
 const [config,setConfig]=useState(initial),[saved,setSaved]=useState(null),[catalog,setCatalog]=useState([]),[readiness,setReadiness]=useState(null),[runs,setRuns]=useState([])
 const [providers,setProviders]=useState(supportedProviders),[modelStatus,setModelStatus]=useState('not_connected'),[modelLoading,setModelLoading]=useState(false),[showConnectionHelp,setShowConnectionHelp]=useState(false)
 const [context,setContext]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState(''),[dirty,setDirty]=useState(false),[uncertain,setUncertain]=useState(false)
 const [unresolved,setUnresolved]=useState(0),[unresolvedRuns,setUnresolvedRuns]=useState([])
 const [lookupType,setLookupType]=useState('run_id'),[reference,setReference]=useState(''),[inspection,setInspection]=useState(null),[lookupNotice,setLookupNotice]=useState('')
 const epoch=useRef(0),modelEpoch=useRef(0),lock=useRef(false),attempt=useRef(null)
 const invoke=async payload=>{const {data,error}=await client.functions.invoke('ai-draft',{body:{organization_id:organizationId,...payload}});let code=data?.error;if(error?.context instanceof Response){try{const body=await error.context.json();if(typeof body.error==='string'&&/^[a-z_]+$/.test(body.error))code=body.error}catch{}}if(error||code)throw new Error(code||'AI service is unavailable. No success has been confirmed.');return data}
 useEffect(()=>{let cancelled=false;const generation=++epoch.current;setLoading(true);setError('');setNotice('');setSaved(null);setRuns([]);setReadiness(null);setCatalog([]);setProviders(supportedProviders);setModelStatus('not_connected');setModelLoading(false);setShowConnectionHelp(false);modelEpoch.current++;setConfig(initial);setContext('');setDirty(false);setUncertain(false);setUnresolved(0);setUnresolvedRuns([]);setReference('');setLookupType('run_id');setInspection(null);setLookupNotice('');attempt.current=null;lock.current=false;setBusy(false)
 invoke({operation:'load'}).then(data=>{if(cancelled||generation!==epoch.current)return;setSaved(data.configuration);setConfig(data.configuration?.configuration||initial);setCatalog(validModels(data.catalog,data.configuration?.configuration?.provider||initial.provider));setProviders(data.providers||supportedProviders);setModelStatus(data.model_status||(data.catalog?.length?'ready':'not_connected'));setRuns(data.runs);setUnresolved(Math.max(data.unresolved_count||0,data.unresolved_runs?.length||0));setUnresolvedRuns(data.unresolved_runs||[]);setReadiness(data.readiness)}).catch(e=>{if(!cancelled){setError(messages[e.message]||e.message);setModelStatus('discovery_failed');setProviders(supportedProviders.map(x=>({...x,credential_configured:false,connection_status:'unavailable'})))}}).finally(()=>{if(!cancelled)setLoading(false)})
 return()=>{cancelled=true;epoch.current++;modelEpoch.current++}
 },[organizationId,client])
 const work=async fn=>{if(lock.current)return;lock.current=true;setBusy(true);setError('');setNotice('');const generation=epoch.current;try{await fn(()=>generation===epoch.current)}catch(e){if(generation===epoch.current)setError(messages[e.message]||e.message)}finally{if(generation===epoch.current){lock.current=false;setBusy(false)}}}
 const change=(key,value)=>{setConfig(c=>({...c,[key]:value}));setDirty(true);setNotice('')}
 const refreshModels=async provider=>{
  const generation=epoch.current,request=++modelEpoch.current;setModelLoading(true);setCatalog([]);setModelStatus('loading');
  try{const d=await invoke({operation:'models',provider});if(generation!==epoch.current||request!==modelEpoch.current)return;
   if(d.provider!==provider)throw new Error('discovery_failed');
   setCatalog(validModels(d.catalog,provider));setModelStatus(d.model_status||'discovery_failed');
   setProviders(xs=>xs.map(x=>x.id===provider?{...x,credential_configured:d.credential_configured===true,connection_status:d.model_error==='provider_connection_unavailable'?'unavailable':d.credential_configured?'configured':'not_connected'}:x));
  }catch{if(generation===epoch.current&&request===modelEpoch.current){setCatalog([]);setModelStatus('discovery_failed')}}
  finally{if(generation===epoch.current&&request===modelEpoch.current)setModelLoading(false)}
 }
 const changeProvider=provider=>{setConfig(c=>({...c,provider,model:''}));setDirty(true);setNotice('');setShowConnectionHelp(false);refreshModels(provider)}
 const chooseModel=model=>{const selected=catalog.find(x=>x.model===model&&x.provider===config.provider);const limit=Math.min(4000,selected?.max_output_tokens||4000);setConfig(c=>({...c,model,max_output_tokens:Math.min(c.max_output_tokens,limit)}));setDirty(true);setNotice(config.max_output_tokens>limit?`Output limit reduced to ${limit} tokens for this model.`:'')}
 const save=e=>{e.preventDefault();if(modelLoading||!catalog.some(x=>x.provider===config.provider&&x.model===config.model)||config.max_output_tokens>outputLimit)return;work(async current=>{const d=await invoke({operation:'save',expected_version:saved?.version||0,configuration:config});if(!current())return;setSaved(d.configuration);setDirty(false);setNotice(`Configuration version ${d.configuration.version} saved. This does not enable live inference.`)})}
 const run=()=>work(async current=>{
  attempt.current ||= {key:crypto.randomUUID(),configuration_id:saved.id,input:{context}}
  let d;try{d=await invoke({operation:'run',configuration_id:attempt.current.configuration_id,request_key:attempt.current.key,input:attempt.current.input})}catch(e){if(current()){const safe=['model_unavailable','unsupported_provider','provider_auth_failed','provider_rate_limited','provider_failed','provider_discovery_timeout','provider_discovery_failed','invalid_model_catalog','provider_connection_unavailable','invalid_configuration','invalid_context','live_inference_disabled','provider_unconfigured','model_not_configured','request_budget_exceeded','sign_in_required','organization_access_denied','configuration_not_found','invalid_operation','request_too_large','origin_not_allowed'].includes(e.message);setUncertain(!safe);if(safe)attempt.current=null}throw e}
  if(!current())return;setRuns(xs=>[d.run,...xs.filter(x=>x.id!==d.run.id)]);setUncertain(['reserved','unknown'].includes(d.run.status));setUnresolved(['reserved','unknown'].includes(d.run.status)?1:0);if(!['reserved','unknown'].includes(d.run.status))attempt.current=null
  setNotice(d.run.status==='awaiting_review'?'Model draft ready for human review.':`Run status: ${d.run.status}. No external action was taken.`)
 })
 const reconcile=()=>work(async current=>{const d=await invoke({operation:'load'});if(!current())return;setRuns(d.runs);setUnresolved(Math.max(d.unresolved_count||0,d.unresolved_runs?.length||0));setUnresolvedRuns(d.unresolved_runs||[]);const found=d.runs.find(r=>r.request_key===attempt.current?.key);if(found&&!['reserved','unknown'].includes(found.status)){attempt.current=null;setUncertain(false)}setNotice(found?`Recorded run status: ${found.status}.`:'No matching recorded result in recent runs. Inspect an unresolved request below or search by its ID or key. Keep this request pending; do not start a replacement.')})
 const inspect=target=>work(async current=>{setInspection(null);setLookupNotice('');const d=await invoke({operation:'lookup',...target});if(!current())return;setInspection(d.run||null);setLookupNotice(d.run?'Showing the saved record. Inspection does not reconcile its outcome.':'No matching request is visible in this organization. A missing record does not prove the provider did not process a request.');if(d.run&&['reserved','unknown'].includes(d.run.status))setUnresolved(n=>Math.max(n,1))})
 const lookup=e=>{e.preventDefault();inspect({[lookupType]:reference.trim()})}
 const review=(id,decision)=>work(async current=>{const d=await invoke({operation:'review',run_id:id,decision});if(current())setRuns(xs=>xs.map(r=>r.id===id?d.run:r))})
 const provider=supportedProviders.find(x=>x.id===config.provider)||{id:config.provider,label:config.provider}
 const providerConnection=providers.find(x=>x.id===config.provider)
 const connected=providerConnection?.credential_configured??Boolean(config.provider===(saved?.configuration?.provider||'openai')&&readiness?.credential_configured)
 const selectedModel=catalog.find(x=>x.provider===config.provider&&x.model===config.model)
 const outputLimit=Math.min(4000,selectedModel?.max_output_tokens||4000)
 const outputLimitExceeded=config.max_output_tokens>outputLimit
 const configured=readiness?.live_enabled&&connected&&!!selectedModel&&!modelLoading&&!outputLimitExceeded
 return <section aria-label="AI setup and drafts" className="panel">
  <h2>AI setup → reviewed draft</h2><p>Configure one real model task. Versioned setup, bounded context, reserved usage allowance, and human review are required. This capability only creates drafts.</p>
  {loading&&<p role="status">Loading AI configuration…</p>}
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {readiness&&!readiness.live_enabled&&<p className="ai-execution-note">Live model execution is disabled for this workspace. Choosing a provider or saving a configuration does not turn it on.</p>}
  <form onSubmit={save}><fieldset disabled={busy||loading||uncertain}><legend>Versioned AI configuration{saved?` · version ${saved.version}`:''}</legend>
   <div className="ai-provider-panel">
    <label>AI provider<select value={config.provider} onChange={e=>changeProvider(e.target.value)}>{supportedProviders.map(x=><option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
    <p role="status" className="ai-connection-status"><span className={connected?'ai-status-dot connected':'ai-status-dot'}/>{provider.label}: {loading||modelLoading?'Checking connection…':providerConnection?.connection_status==='unavailable'?'Connection status unavailable':modelStatus==='discovery_failed'?'Connection could not be verified':connected?'Organization connection configured':'Not connected'}</p>
    <p className="ai-provider-note">Choose an AI provider, then select an approved model available through your organization’s connection. Other providers and custom endpoints are not supported yet.</p>
    <div className="ai-provider-actions"><button type="button" aria-expanded={showConnectionHelp} aria-controls="ai-connection-help" onClick={()=>setShowConnectionHelp(x=>!x)}>{showConnectionHelp?'Hide connection instructions':'How to connect'}</button><button type="button" disabled={modelLoading} onClick={()=>refreshModels(config.provider)}>Refresh models</button></div>
    {showConnectionHelp&&<section id="ai-connection-help" aria-label="Secure AI connection instructions" className="ai-connection-help"><h3>Connect {provider.label} securely</h3><ol><li>An authorized organization administrator approves the provider account and the business data that may be sent to it.</li><li>The Kairo deployment administrator uses the <a href={provider.console} target="_blank" rel="noopener noreferrer">{provider.label} API-key console</a> and stores this organization’s key in Kairo’s server-side secret configuration. This page never collects or displays API keys.</li><li>Approved model compatibility and pricing must be configured. Then refresh models and choose a model below.</li></ol><p>Connections are managed separately for each organization. Saving this task does not create a connection or grant access to another account. Live execution requires a separate approved enablement.</p></section>}
    <label>Model<select required value={config.model} disabled={modelLoading||catalog.length===0} onChange={e=>chooseModel(e.target.value)} aria-describedby="ai-model-help"><option value="">{modelLoading?'Loading available models…':catalog.length?'Choose a model':connected?'No approved models available':'Connect a provider to see models'}</option>{config.model&&!selectedModel&&<option value={config.model} disabled>{config.model} · saved model unavailable</option>}{catalog.map(x=><option key={`${x.provider}:${x.model}`} value={x.model}>{x.label||x.model}</option>)}</select></label>
    <p id="ai-model-help" role="status">{modelLoading?'Checking models available through this organization’s connection…':modelMessages[modelStatus]||(catalog.length?'Only models verified for this connection, structured draft output, and approved pricing appear here.':'No models are available.')}</p>
    {config.model&&!selectedModel&&!modelLoading&&<p className="ai-model-warning">The saved model is unavailable. Choose an available model before saving a new version or generating a draft.</p>}
    {selectedModel?.max_output_tokens&&<p>This model supports up to {outputLimit} output tokens for this task.</p>}
    {outputLimitExceeded&&<p role="alert">Reduce maximum output tokens to {outputLimit} or less before saving or generating.</p>}
   </div>
   <label>Task<select value={config.task} onChange={e=>change('task',e.target.value)}><option value="customer_reply">Customer reply draft</option><option value="internal_summary">Internal summary</option></select></label>
   <label>Task instructions<textarea required minLength={10} maxLength={2000} value={config.instructions} onChange={e=>change('instructions',e.target.value)}/></label>
   <p>Supported source: manually supplied business context. Automatic CRM, inbox and document retrieval are not connected to this draft capability.</p>
   {[['max_input_bytes','Maximum context bytes',1,12000],['max_output_tokens','Maximum output tokens',128,4000],['max_daily_runs','Daily run limit',1,100]].map(([key,label,min,max])=><label key={key}>{label}<input type="number" min={min} max={key==='max_output_tokens'?outputLimit:max} step="1" required value={config[key]} onChange={e=>change(key,Number(e.target.value))}/></label>)}
   <label>Daily reserved allowance (USD)<input type="number" min="0.01" max="100" step="0.01" required value={config.daily_budget_microusd/1000000} onChange={e=>change('daily_budget_microusd',Math.round(Number(e.target.value)*1000000))}/></label>
   <p>Human review is mandatory. The allowance is a conservative admission limit, not an invoice. Unknown or failed calls retain their reservation; limits apply across configuration versions.</p>
   <button type="submit" disabled={modelLoading||!selectedModel||outputLimitExceeded}>Save configuration version</button>
  </fieldset></form>
  <h3>Generate a draft</h3><p>When live execution is enabled, this context is sent to {provider.label}. Use only data approved for that provider. Do not paste credentials or sensitive customer information.</p>
  <label>Business context<textarea value={context} disabled={busy||uncertain} onChange={e=>setContext(e.target.value)} maxLength={12000}/></label>
  <p>{new TextEncoder().encode(context).length} / {config.max_input_bytes} bytes · Output: title, draft body, source references, warnings</p>
  <button disabled={busy||loading||!saved||dirty||!configured||!context.trim()||uncertain||unresolved>0||runs.some(r=>['reserved','unknown'].includes(r.status))||new TextEncoder().encode(context).length>config.max_input_bytes} onClick={run}>Generate review-only draft</button>
  {dirty&&<p>Save the edited configuration before generating.</p>}
  {(uncertain||unresolved>0)&&<><p role="alert">A request is unresolved. Do not generate a replacement. An operator must reconcile pending or unknown provider outcomes before new runs.</p><button disabled={busy} onClick={reconcile}>Check recorded outcome</button>{attempt.current&&<><p>Pending request key: {attempt.current.key}</p><button disabled={busy} onClick={()=>inspect({request_key:attempt.current.key})}>Inspect pending request</button></>}</>}
  {(unresolved>0||unresolvedRuns.length>0)&&<section aria-label="Unresolved AI requests"><h3>Unresolved requests</h3>
   <p>Showing {unresolvedRuns.length} of {unresolved} unresolved requests, oldest first. Recent draft activity is limited to 20 records.</p>
   {unresolvedRuns.length===0&&<p>Refresh the recorded outcome or search by request ID or key to inspect an earlier request.</p>}
   <ul>{unresolvedRuns.map(r=><li key={r.id}><span>Request {r.id} · {r.status}{r.created_at?` · ${new Date(r.created_at).toLocaleString()}`:''}</span><button disabled={busy} aria-label={`Inspect unresolved request ${r.id}`} onClick={()=>inspect({run_id:r.id})}>Inspect request</button></li>)}</ul>
  </section>}
  <section aria-label="Read-only AI request lookup"><h3>Find an earlier request</h3>
   <p>Lookup reads saved records only. It does not resend a request, refund its allowance, or resolve an unknown outcome.</p>
   <form onSubmit={lookup}><fieldset disabled={busy||loading}><legend>Request reference</legend>
    <label>Reference type<select value={lookupType} onChange={e=>setLookupType(e.target.value)}><option value="run_id">Request ID</option><option value="request_key">Request key</option></select></label>
    <label>Request reference<input required maxLength={36} pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}" value={reference} onChange={e=>setReference(e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"/></label>
    <button type="submit">Look up request</button>
   </fieldset></form>
   {lookupNotice&&<p role="status">{lookupNotice}</p>}
   {inspection&&<article aria-label="Inspected AI request"><h4>Saved request details</h4>
    <p>Request ID: {inspection.id}</p><p>Request key: {inspection.request_key}</p><p>Recorded status: {inspection.status}</p>
    {inspection.created_at&&<p>Created: {new Date(inspection.created_at).toLocaleString()}</p>}
    <p>Reserved allowance: ${(inspection.reserved_microusd/1000000).toFixed(4)}</p>
    {['reserved','unknown'].includes(inspection.status)&&<p>This outcome still needs operator investigation. Keep the reservation and do not generate a replacement.</p>}
    {inspection.failure_code&&<p>{messages[inspection.failure_code]||inspection.failure_code}</p>}
    {inspection.usage&&<p>Observed tokens: {inspection.usage.input_tokens} input / {inspection.usage.output_tokens} output</p>}
    {inspection.draft&&<p style={{whiteSpace:'pre-wrap'}}>{inspection.draft.body}</p>}
    <button disabled={busy} onClick={()=>{setInspection(null);setLookupNotice('')}}>Close request details</button>
   </article>}
  </section>
  <h3>Draft activity</h3>{runs.length===0&&<p>No recorded model runs.</p>}
  {runs.map(r=><article key={r.id}><h4>{r.draft?.title||'AI draft request'}</h4><p>Status: {r.status} · Reserved allowance: ${(r.reserved_microusd/1000000).toFixed(4)}</p>
   {r.status==='reserved'&&<p>Dispatch is pending or interrupted. Do not assume it failed or start a replacement.</p>}
   {r.failure_code&&<p>{messages[r.failure_code]||r.failure_code}</p>}
   {r.usage&&<p>Observed tokens: {r.usage.input_tokens} input / {r.usage.output_tokens} output</p>}
   {r.draft&&<><p style={{whiteSpace:'pre-wrap'}}>{r.draft.body}</p><p>Sources: {r.draft.source_ids.join(', ')||'No source cited'}</p>{r.draft.warnings.map((w,i)=><p key={i}>Warning: {w}</p>)}</>}
   {r.status==='awaiting_review'&&<><p>Verify facts and suitability. Accepting records your review; it does not send or execute the draft.</p><button disabled={busy} onClick={()=>review(r.id,'accepted')}>Accept draft for use</button><button disabled={busy} onClick={()=>review(r.id,'rejected')}>Reject draft</button></>}
  </article>)}
 </section>
}
