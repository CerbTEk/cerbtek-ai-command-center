export const MONITOR_LIMITS = Object.freeze({overview:500, detail:200, requests:500, approvalsPerBatch:500, batchSize:40})
export function monitorWindow(days, now=Date.now()) {
  if(![7,30,90].includes(days)) throw new Error('Choose a supported reporting period.')
  const end=new Date(now), start=new Date(end)
  if(!Number.isFinite(end.getTime())) throw new Error('Reporting time is unavailable.')
  start.setUTCHours(0,0,0,0);start.setUTCDate(start.getUTCDate()-days+1)
  return {start:start.toISOString(),end:end.toISOString(),days}
}
const RUN_FIELDS='id,organization_id,workflow_id,status,current_step,started_at,completed_at,summary,error_message,created_at'
const REQUEST_FIELDS='id,organization_id,workflow_id,workflow_run_id,agent_id,status,created_at,approved_at,executed_at,error_message'
const ACTION_FIELDS='id,organization_id,workflow_run_id,status,action_type,title,summary,created_at,approved_at,rejected_at,executed_at,error_message'
async function read(query,signal) {
  try {
    if(signal&&typeof query.abortSignal==='function') query=query.abortSignal(signal)
    const result=await query
    if(result.error||!Array.isArray(result.data)) return {rows:undefined,error:true}
    return {rows:result.data,error:false}
  } catch {return {rows:undefined,error:true}}
}
export async function loadWorkflowTelemetry({client,organizationId,workflowId=null,days=30,now=Date.now(),signal}) {
  if(!organizationId) throw new Error('Choose a company to view workflow activity.')
  const window=monitorWindow(days,now),limit=workflowId?MONITOR_LIMITS.detail:MONITOR_LIMITS.overview
  let runsQuery=client.from('workflow_runs').select(RUN_FIELDS).eq('organization_id',organizationId).gte('created_at',window.start).lte('created_at',window.end).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(limit+1)
  let requestsQuery=client.from('agent_run_requests').select(REQUEST_FIELDS).eq('organization_id',organizationId).gte('created_at',window.start).lte('created_at',window.end).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(MONITOR_LIMITS.requests+1)
  if(workflowId) {runsQuery=runsQuery.eq('workflow_id',workflowId);requestsQuery=requestsQuery.eq('workflow_id',workflowId)}
  const [runResult,requestResult]=await Promise.all([read(runsQuery,signal),read(requestsQuery,signal)])
  const runs=runResult.rows?.slice(0,limit)
  let agentRequests=requestResult.rows?.slice(0,MONITOR_LIMITS.requests)
  const ids=(runs||[]).filter(r=>r.organization_id===organizationId&&(!workflowId||r.workflow_id===workflowId)).map(r=>r.id)
  const batches=[]
  for(let i=0;i<ids.length;i+=MONITOR_LIMITS.batchSize) batches.push(ids.slice(i,i+MONITOR_LIMITS.batchSize))
  const linkedRequestResults=[]
  if(workflowId&&!runResult.error) {
    for(let i=0;i<batches.length;i+=3) {
      if(signal?.aborted) break
      linkedRequestResults.push(...await Promise.all(batches.slice(i,i+3).map(batch=>read(client.from('agent_run_requests').select(REQUEST_FIELDS).eq('organization_id',organizationId).is('workflow_id',null).in('workflow_run_id',batch).gte('created_at',window.start).lte('created_at',window.end).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(MONITOR_LIMITS.requests+1),signal))))
    }
  }
  const requestsUnavailable=requestResult.error||linkedRequestResults.some(r=>r.error)||!!signal?.aborted
  const mergedRequests=requestsUnavailable?[]:[...new Map([...(requestResult.rows||[]),...linkedRequestResults.flatMap(r=>r.rows)].map(r=>[r.id,r])).values()].sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))||String(b.id).localeCompare(String(a.id)))
  agentRequests=requestsUnavailable?undefined:mergedRequests.slice(0,MONITOR_LIMITS.requests)
  const actionResults=[]
  // Small batches keep URL length and concurrent reads bounded.
  for(let i=0;i<batches.length;i+=3) {
    if(signal?.aborted) break
    actionResults.push(...await Promise.all(batches.slice(i,i+3).map(batch=>read(client.from('action_requests').select(ACTION_FIELDS).eq('organization_id',organizationId).in('workflow_run_id',batch).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(MONITOR_LIMITS.approvalsPerBatch+1),signal))))
  }
  const actionsUnavailable=runResult.error||actionResults.some(r=>r.error)||signal?.aborted
  const actions=actionsUnavailable?undefined:actionResults.flatMap(r=>r.rows.slice(0,MONITOR_LIMITS.approvalsPerBatch))
  return {runs,agentRequests,actions,window,refreshedAt:new Date().toISOString(),coverage:{runLimit:limit,runsTruncated:(runResult.rows?.length||0)>limit,requestsTruncated:mergedRequests.length>MONITOR_LIMITS.requests||linkedRequestResults.some(r=>(r.rows?.length||0)>MONITOR_LIMITS.requests),actionsTruncated:actionResults.some(r=>(r.rows?.length||0)>MONITOR_LIMITS.approvalsPerBatch),runsUnavailable:runResult.error,requestsUnavailable,actionsUnavailable:!!actionsUnavailable}}
}
