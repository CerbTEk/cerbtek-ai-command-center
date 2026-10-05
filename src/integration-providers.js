// Presentation and planning metadata only. This is not an execution or permission registry.
export const INTEGRATION_PROVIDERS = Object.freeze([
  {id:'microsoft', name:'Microsoft 365', auth:'Microsoft Entra OAuth', availability:'Connector implemented',
    summary:'Profile, inbox status and upcoming calendar actions are implemented. A connected account and matching permissions are required.',
    next:'Review the existing Microsoft setup below with your administrator. Saving this plan does not connect an account.',
    cases:[{id:'profile',name:'Verify the connected profile'},{id:'inbox-status',name:'Review inbox status'},{id:'calendar-next',name:'Review upcoming calendar events'}]},
  {id:'google', name:'Google Workspace', auth:'Google user OAuth', availability:'Planned · not available to connect',
    summary:'Planned first actions: profile verification, selected Drive files, Gmail inbox status and upcoming Calendar events.',
    next:'A Google OAuth connector, permission review and end-to-end validation are required before this plan can run. No Google access is requested here.',
    cases:[{id:'profile',name:'Verify a Google Workspace profile'},{id:'drive-selected',name:'Read explicitly selected Drive files'},{id:'inbox-status',name:'Review Gmail inbox status'},{id:'calendar-next',name:'Review upcoming Google Calendar events'}]},
  {id:'aws', name:'AWS', auth:'Customer IAM role and temporary credentials', availability:'Planned · not available to connect',
    summary:'Planned first actions: verify the AWS account and role, read approved S3 locations and inspect CloudWatch metrics or alarms.',
    next:'An administrator-reviewed role trust policy, limited resource permissions and a tested AWS connector are required. Do not enter AWS access keys here.',
    cases:[{id:'identity',name:'Verify the AWS account and role'},{id:'s3-read',name:'Read an approved S3 location'},{id:'cloudwatch-read',name:'Inspect CloudWatch metrics or alarms'}]}
].map(provider=>Object.freeze({...provider,cases:Object.freeze(provider.cases.map(item=>Object.freeze(item)))})))

export const integrationProvider = id => INTEGRATION_PROVIDERS.find(provider=>provider.id===id)||null
const PLAN_KIND='kairo.integration-plan'

export function integrationPlan(row) {
  if(!row || row.status==='Disabled' || typeof row.notes!=='string' || row.notes.length>2000) return null
  try {
    const plan=JSON.parse(row.notes)
    const provider=integrationProvider(plan.provider)
    const useCase=provider?.cases.find(item=>item.id===plan.useCase)
    if(plan.kind!==PLAN_KIND||plan.version!==1||!provider||!useCase||row.provider!==provider.name) return null
    // Never spread stored JSON: only these two allowlisted identifiers leave the parser.
    return {provider:provider.id,useCase:useCase.id}
  } catch { return null }
}

export function integrationPlans(rows) {
  return (Array.isArray(rows)?rows:[]).map(row=>({row,plan:integrationPlan(row)})).filter(item=>item.plan)
}

export function createIntegrationPlan({providerId,useCaseId}) {
  const provider=integrationProvider(providerId)
  const useCase=provider?.cases.find(item=>item.id===useCaseId)
  if(!provider||!useCase) throw new Error('Choose a supported provider and first use case.')
  return {
    name:`${provider.name}: ${useCase.name}`,
    provider:provider.name,
    integration_type:provider.id==='aws'?'API':'OAuth',
    status:'Planned',
    authentication_method:provider.auth,
    data_classification:'Internal',
    notes:JSON.stringify({kind:PLAN_KIND,version:1,provider:provider.id,useCase:useCase.id})
  }
}

export function nextProviderPlan(data={}) {
  const plans=integrationPlans(data.integrations)
  // Keep existing Microsoft workflows and connections on their existing path.
  const hasMicrosoftWorkflow=(Array.isArray(data.workflowDefinitions)?data.workflowDefinitions:[]).some(workflow=>
    ['Active','Draft','Paused'].includes(workflow?.status) && (Array.isArray(workflow.steps)?workflow.steps:[]).some(step=>(typeof step?.type==='string'&&step.type.startsWith('microsoft.'))||step?.type==='approval.email'))
  const microsoftConfigured=(Array.isArray(data.oauth)?data.oauth:[]).some(item=>item?.provider==='microsoft'&&item?.status!=='Disabled')
  const microsoftConnected=(Array.isArray(data.oauth)?data.oauth:[]).some(item=>item?.provider==='microsoft'&&item?.status==='Connected')
  if(hasMicrosoftWorkflow||microsoftConnected||microsoftConfigured) return 'microsoft'
  // The oldest remaining plan is the resumable setup path; all plans stay visible.
  const first=[...plans].sort((a,b)=>String(a.row.created_at||'').localeCompare(String(b.row.created_at||''))||String(a.row.id||'').localeCompare(String(b.row.id||'')))[0]
  return first?.plan.provider||null
}
