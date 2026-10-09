import React,{useEffect,useRef,useState} from 'react'
const initial={schema_version:1,provider:'openai',model:'',task:'customer_reply',instructions:'Use the supplied facts to prepare a concise, professional draft. Flag missing information.',source:'manual_context',max_input_bytes:6000,max_output_tokens:1000,max_daily_runs:10,daily_budget_microusd:1000000,human_review:true}
const messages={invalid_request_reference:'Enter one valid request ID or request key.',storage_unavailable:'Saved request records could not be loaded. No outcome has been confirmed.',provider_unconfigured:'A server-side OpenAI credential has not been configured.',live_inference_disabled:'Live model execution is disabled for this workspace.',model_not_configured:'The selected model needs an approved server-side model and pricing configuration.',configuration_or_run_conflict:'Configuration or run state changed, or the daily allowance is exhausted. Reload before retrying.',organization_access_denied:'An organization owner, admin, or consultant must manage AI setup.',provider_timeout_unknown:'The provider timed out. It may have processed the request. The allowance stays reserved.',provider_transport_unknown:'The provider result is unknown. The allowance stays reserved.',invalid_configuration:'Check the model, instructions and limits.',request_budget_exceeded:'The conservative request allowance exceeds the budget. Reduce context/output limits or revise the budget.',invalid_context:'Enter context within the configured UTF-8 byte limit.'}
export default function AIDraftSetup({organizationId,client}){
 const [config,setConfig]=useState(initial),[saved,setSaved]=useState(null),[catalog,setCatalog]=useState([]),[readiness,setReadiness]=useState(null),[runs,setRuns]=useState([])
 const [context,setContext]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState(''),[dirty,setDirty]=useState(false),[uncertain,setUncertain]=useState(false)
 const [unresolved,setUnresolved]=useState(0),[unresolvedRuns,setUnresolvedRuns]=useState([])
 const [lookupType,setLookupType]=useState('run_id'),[reference,setReference]=useState(''),[inspection,setInspection]=useState(null),[lookupNotice,setLookupNotice]=useState('')
 const epoch=useRef(0),lock=useRef(false),attempt=useRef(null)
 const invoke=async payload=>{const {data,error}=await client.functions.invoke('ai-draft',{body:{organization_id:organizationId,...payload}});let code=data?.error;if(error?.context instanceof Response){try{const body=await error.context.json();if(typeof body.error==='string'&&/^[a-z_]+$/.test(body.error))code=body.error}catch{}}if(error||code)throw new Error(code||'AI service is unavailable. No success has been confirmed.');return data}
 useEffect(()=>{let cancelled=false;const generation=++epoch.current;setLoading(true);setError('');setSaved(null);setRuns([]);setReadiness(null);setConfig(initial);setContext('');setDirty(false);setUncertain(false);setUnresolved(0);setUnresolvedRuns([]);setReference('');setLookupType('run_id');setInspection(null);setLookupNotice('');attempt.current=null;lock.current=false;setBusy(false)
 invoke({operation:'load'}).then(data=>{if(cancelled||generation!==epoch.current)return;setSaved(data.configuration);setConfig(data.configuration?.configuration||initial);setCatalog(data.catalog);setRuns(data.runs);setUnresolved(Math.max(data.unresolved_count||0,data.unresolved_runs?.length||0));setUnresolvedRuns(data.unresolved_runs||[]);setReadiness(data.readiness)}).catch(e=>{if(!cancelled)setError(messages[e.message]||e.message)}).finally(()=>{if(!cancelled)setLoading(false)})
 return()=>{cancelled=true;epoch.current++}
 },[organizationId,client])
 const work=async fn=>{if(lock.current)return;lock.current=true;setBusy(true);setError('');setNotice('');const generation=epoch.current;try{await fn(()=>generation===epoch.current)}catch(e){if(generation===epoch.current)setError(messages[e.message]||e.message)}finally{if(generation===epoch.current){lock.current=false;setBusy(false)}}}
 const change=(key,value)=>{setConfig(c=>({...c,[key]:value}));setDirty(true);setNotice('')}
 const save=e=>{e.preventDefault();work(async current=>{const d=await invoke({operation:'save',expected_version:saved?.version||0,configuration:config});if(!current())return;setSaved(d.configuration);setDirty(false);setNotice(`Configuration version ${d.configuration.version} saved. This does not enable live inference.`)})}
 const run=()=>work(async current=>{
  attempt.current ||= {key:crypto.randomUUID(),configuration_id:saved.id,input:{context}}
  let d;try{d=await invoke({operation:'run',configuration_id:attempt.current.configuration_id,request_key:attempt.current.key,input:attempt.current.input})}catch(e){if(current()){const safe=['invalid_configuration','invalid_context','live_inference_disabled','provider_unconfigured','model_not_configured','request_budget_exceeded','sign_in_required','organization_access_denied','configuration_not_found','invalid_operation','request_too_large','origin_not_allowed'].includes(e.message);setUncertain(!safe);if(safe)attempt.current=null}throw e}
  if(!current())return;setRuns(xs=>[d.run,...xs.filter(x=>x.id!==d.run.id)]);setUncertain(['reserved','unknown'].includes(d.run.status));setUnresolved(['reserved','unknown'].includes(d.run.status)?1:0);if(!['reserved','unknown'].includes(d.run.status))attempt.current=null
  setNotice(d.run.status==='awaiting_review'?'Model draft ready for human review.':`Run status: ${d.run.status}. No external action was taken.`)
 })
 const reconcile=()=>work(async current=>{const d=await invoke({operation:'load'});if(!current())return;setRuns(d.runs);setUnresolved(Math.max(d.unresolved_count||0,d.unresolved_runs?.length||0));setUnresolvedRuns(d.unresolved_runs||[]);const found=d.runs.find(r=>r.request_key===attempt.current?.key);if(found&&!['reserved','unknown'].includes(found.status)){attempt.current=null;setUncertain(false)}setNotice(found?`Recorded run status: ${found.status}.`:'No matching recorded result in recent runs. Inspect an unresolved request below or search by its ID or key. Keep this request pending; do not start a replacement.')})
 const inspect=target=>work(async current=>{setInspection(null);setLookupNotice('');const d=await invoke({operation:'lookup',...target});if(!current())return;setInspection(d.run||null);setLookupNotice(d.run?'Showing the saved record. Inspection does not reconcile its outcome.':'No matching request is visible in this organization. A missing record does not prove the provider did not process a request.');if(d.run&&['reserved','unknown'].includes(d.run.status))setUnresolved(n=>Math.max(n,1))})
 const lookup=e=>{e.preventDefault();inspect({[lookupType]:reference.trim()})}
 const review=(id,decision)=>work(async current=>{const d=await invoke({operation:'review',run_id:id,decision});if(current())setRuns(xs=>xs.map(r=>r.id===id?d.run:r))})
 const configured=readiness?.live_enabled&&readiness?.credential_configured&&catalog.some(x=>x.provider===config.provider&&x.model===config.model)
 return <section aria-label="AI setup and drafts" className="panel">
  <h2>AI setup → reviewed draft</h2><p>Configure one real model task. Versioned setup, bounded context, reserved usage allowance, and human review are required. This capability only creates drafts.</p>
  {loading&&<p role="status">Loading AI configuration…</p>}
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <p role="status">{readiness?(messages[readiness.status]||'Provider configuration is available. A live acceptance test is still required.'):'Provider status has not been verified.'}</p>
  <form onSubmit={save}><fieldset disabled={busy||loading||uncertain}><legend>Versioned AI configuration{saved?` · version ${saved.version}`:''}</legend>
   <label>Provider<select value={config.provider} onChange={e=>change('provider',e.target.value)}><option value="openai">OpenAI</option></select></label>
   <label>Exact model ID<input required maxLength={100} value={config.model} onChange={e=>change('model',e.target.value)} list="ai-approved-models" placeholder="Choose an approved model ID"/></label>
   <datalist id="ai-approved-models">{catalog.map(x=><option key={x.model} value={x.model}/>)}</datalist>
   <label>Task<select value={config.task} onChange={e=>change('task',e.target.value)}><option value="customer_reply">Customer reply draft</option><option value="internal_summary">Internal summary</option></select></label>
   <label>Task instructions<textarea required minLength={10} maxLength={2000} value={config.instructions} onChange={e=>change('instructions',e.target.value)}/></label>
   <p>Supported source: manually supplied business context. Automatic CRM, inbox and document retrieval are not connected to this draft capability.</p>
   {[['max_input_bytes','Maximum context bytes',1,12000],['max_output_tokens','Maximum output tokens',128,4000],['max_daily_runs','Daily run limit',1,100]].map(([key,label,min,max])=><label key={key}>{label}<input type="number" min={min} max={max} step="1" required value={config[key]} onChange={e=>change(key,Number(e.target.value))}/></label>)}
   <label>Daily reserved allowance (USD)<input type="number" min="0.01" max="100" step="0.01" required value={config.daily_budget_microusd/1000000} onChange={e=>change('daily_budget_microusd',Math.round(Number(e.target.value)*1000000))}/></label>
   <p>Human review is mandatory. The allowance is a conservative admission limit, not an invoice. Unknown or failed calls retain their reservation; limits apply across configuration versions.</p>
   <button type="submit">Save configuration version</button>
  </fieldset></form>
  <h3>Generate a draft</h3><p>When live execution is enabled, this context is sent to OpenAI. Use only data approved for that provider. Do not paste credentials or sensitive customer information.</p>
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
