import {nextProviderPlan,integrationProvider} from './integration-providers'

export const onboardingComplete = value => ['Ready for Assessment','Complete'].includes(value?.status)
export const assessmentComplete = value => value?.status === 'Complete'

const permissions = {
  'microsoft.health':'User.Read',
  'microsoft.profile':'User.Read',
  'microsoft.inbox-status':'Mail.Read',
  'microsoft.calendar-next':'Calendars.Read',
  'approval.email':'Mail.Send'
}

// A guide to existing screens; this does not execute actions or change policy.
export function deriveNextStep(data) {
  const systems=data.systems||[], workflows=data.workflows||[], opportunities=data.opps||[]
  const steps=[
    {label:'Company profile',complete:onboardingComplete(data.onboarding)},
    {label:'Readiness assessment',complete:assessmentComplete(data.readiness)},
    {label:'Systems mapped',complete:systems.length>0},
    {label:'Business workflow mapped',complete:workflows.length>0},
    {label:'Business case recorded',complete:opportunities.length>0},
  ]
  const result=(id,title,detail,section,action,extra={})=>({id,title,detail,section,action,steps,...extra})
  if(!steps[0].complete) return result('onboarding','Finish your company profile','Complete the business context first. You can save your progress and return to it.','Onboarding','Continue company profile')
  if(!steps[1].complete) return result('assessment','Finish your readiness assessment','Answer all 18 questions, then choose Complete assessment. A saved draft is not a completed assessment.','AI Readiness','Continue readiness assessment')
  if(!systems.length) return result('systems','Map the software your team uses','Your assessment is saved. Next, list the software a business workflow would need to use.','Systems','Next: map your systems')
  if(!workflows.length) return result('business-workflow','Map a task you want to improve','Describe a repeatable task and its department. This records the work; it does not create or run an automation.','Workflows','Next: map a business workflow')
  if(!opportunities.length) return result('business-case','Compare the value and risk','Create a business case linked to your mapped workflow. Benefit and cost figures are your estimates, not proven results.','Opportunities','Next: create a business case')

  const ranked=opportunities.filter(o=>Number.isFinite(o.opportunity_score)).sort((a,b)=>b.opportunity_score-a.opportunity_score)
  const opportunity=ranked[0]||null
  const context={opportunity}
  const providerId=nextProviderPlan(data)
  if(!providerId) return result('provider','Choose the tools this workflow needs','Review Microsoft 365, Google Workspace and AWS, then save a plan for the provider and first use case your team needs. Current connector availability is shown separately.','Integrations','Next: choose an integration path',context)
  if(providerId!=='microsoft') {
    const provider=integrationProvider(providerId)
    return result('provider-planned','Review your '+provider.name+' integration plan',provider.next,'Integrations','Next: review integration plan',{...context,blocked:provider.name+' is planned, but its connector is not available yet. Your plan is saved; no workflow has been run.'})
  }
  const microsoft=(data.oauth||[]).find(c=>c.provider==='microsoft')
  if(microsoft?.status!=='Connected') return result('microsoft','Prepare Microsoft 365 access','Review your business case, then ask your Microsoft 365 administrator for the approved app registration details. The existing setup requires a tenant/domain, application ID, and client secret.','Integrations','Next: Microsoft administrator setup',{...context,blocked:'Microsoft 365 is not connected. No workflow has been run by this guide.'})

  const definitions=(Array.isArray(data.workflowDefinitions)?data.workflowDefinitions:[]).filter(Boolean)
  const active=definitions.find(w=>w.status==='Active')
  const draft=definitions.find(w=>w.status==='Draft')
  if(!active && !draft) return result('draft',definitions.length?'Review your paused automations':'Create a draft automation',definitions.length?'Review the automation and its connection before resuming it. Resuming does not schedule a run.':'In Workflow builder, choose one of the supported Microsoft actions. Saving a draft does not run it.','Workflows',definitions.length?'Next: review paused automations':'Next: create a draft automation',context)
  const workflow=active||draft
  const needed=[...new Set((Array.isArray(workflow.steps)?workflow.steps:[]).map(step=>permissions[step?.type]).filter(Boolean))]
  const missing=needed.filter(scope=>!(microsoft.scopes||[]).includes(scope))
  if(missing.length) return result('permission','Review the Microsoft permissions','This automation needs '+missing.join(', ')+'. Ask your Microsoft 365 administrator to review the connection before running it. This guide does not change permissions.','Integrations','Next: review Microsoft connection',{...context,blocked:'Required permission missing: '+missing.join(', ')})
  if(!active) return result('activate','Review and activate your draft','Review the action and its required access. Activate makes the draft available to run; it does not run or schedule it.','Workflows','Next: review draft automation',context)

  const run=(data.workflowRuns||[]).find(r=>r.workflow_id===active.id)
  if(!run) return result('run','Run once and review the result','Use Run for '+active.name+'. It uses your real connected account, not a sandbox. An email step creates a request for human review before sending.','Workflows','Next: review and run once',context)
  if(run.status==='Waiting Approval') {
    const requestId=run.context?.action_request_id
    const request=(data.actionRequests||[]).find(r=>(run.id&&r.workflow_run_id===run.id)||(requestId&&r.id===requestId))
    if(request?.status==='Pending') return result('approval','Review the pending approval','The linked email is pending review. Read the full email before approving; approval and sending are separate actions.','Integrations','Next: review pending email',context)
    if(request?.status==='Approved') return result('approved-email','Review the approved email','The linked email is approved, but has not been recorded as sent. Review its content before choosing Send approved email.','Integrations','Next: review approved email',context)
    if(request?.status==='Rejected') return result('rejected-email','Review the rejected request','The linked email request was rejected. Review the decision before changing the workflow. This guide will not resend or rerun it.','Integrations','Next: review rejected email',context)
    if(request?.status==='Failed') return result('email-error','Check the email outcome','The linked email request returned an error. Check the error and Microsoft sent items before retrying; a later workflow error may occur after an email was sent.','Integrations','Next: review email outcome',{...context,blocked:request.error_message||'The send outcome needs review.'})
    if(request?.status==='Executed') return result('sent-email','Review the recorded send','The linked email is marked Executed, while the workflow is still waiting. Check the workflow result before starting another run.','Integrations','Next: review sent email',context)
    return result('approval-status','Check the approval status',request?'The linked email request is '+request.status+'. Check its current status before taking another action.':'The workflow is waiting, but the linked email request status is unavailable. Review the current request before approving or sending.','Integrations','Next: check email request status',context)
  }
  if(run.status==='Error') return result('run-error','Review the failed run',run.error_message||run.summary||'Check the run details and connection before deciding whether to try again.','Workflows','Next: review run details',{...context,blocked:'The last recorded run returned an error. This guide will not retry it.'})
  if(run.status==='Success') return result('result','Review your first result','A successful run is recorded for '+active.name+'. Check the run history and result before optionally creating a schedule.','Workflows','Next: review result and schedule',context)
  return result('run-status','Check the current run','The last recorded status for '+active.name+' is '+run.status+'. Review it before starting another run.','Workflows','Next: view run status',context)
}
