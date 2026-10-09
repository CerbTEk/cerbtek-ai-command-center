import { PROVIDER_HELP_ARTICLES } from './kairo-provider-guides'
import { TECHNICAL_HELP_ARTICLES } from './kairo-technical-guides'
import { BUSINESS_HELP_ARTICLES } from './kairo-business-guides'
import { AI_TECHNICAL_HELP_ARTICLES } from './kairo-ai-technical-guides'
import { HELP_QUESTIONS } from './kairo-help-questions'

// Curated product guidance, reviewed against application revision e9e1c66.
// This is local documentation, not generated advice or an execution policy.
export const HELP_VERSION = '2026-10-08.safety1'
export const HELP_REVIEWED_AT = '2026-10-03'
export const HELP_CATEGORIES = Object.freeze(['Getting started','Integrations and cloud providers','Workflows and approvals','Microsoft 365','Access and governance','Everyday AI reference','AI implementation reference','Telephony reference'])
export const HELP_SECTIONS = Object.freeze(['Overview','Team Access','Onboarding','AI Readiness','Systems','Workflows','Opportunities','Integrations','Agents','AI Ops','Governance','Blueprints','Audit'])

const PRODUCT_HELP_ARTICLES = [
  {
    id:'getting-started', title:'Find your next setup step', section:'Overview',
    keywords:['start','setup','next','begin','onboarding','progress','help'],
    summary:'Follow the saved setup progress for this company.',
    prerequisites:['A business owner, one repeated task, and a clear description of what a better result would look like.'],
    steps:['Choose a small, reversible pilot: for example, preparing a draft for human review. Avoid starting with an irreversible action or a decision about someone’s eligibility.','Complete the company profile, then answer and complete the readiness assessment using evidence of how your team works today.','Map the systems and one repeatable workflow. Record its owner, current effort, known errors and the point where a person must review the result.','Create a business case using your own benefit and cost assumptions. Set a quality target and a stop condition before testing.','Check the supported-capability guide. For an external AI task, use an approved tool and safe sample data; Kairo does not run a general-purpose AI model.','Review a small pilot with the task owner before expanding it. For a supported Kairo automation, review integration access and the proposed action before a real run.'],
    troubleshooting:['If the goal is simply “use AI,” narrow it to one task and a measurable outcome.','If the proposed action is absent from Kairo’s builder, record the requirement rather than assuming an inventory entry enables it.'],
    successChecks:['You have one named pilot, an owner, a baseline, a human review point and a clear continue-or-stop decision.'],
    note:'The next-step guide points to existing screens. It does not connect services, run workflows, or send messages.',
    related:['company-profile','readiness','workflow-basics']
  },
  {
    id:'company-profile', title:'Complete your company profile', section:'Onboarding',
    keywords:['company','profile','onboarding','business','goals','industry'],
    summary:'Record the business context used during setup.',
    prerequisites:[],
    steps:['Open Onboarding and complete the company information and business context.','Save your progress if you need to return later.','Complete the profile before moving to AI Readiness.'],
    note:'A saved draft and a completed profile are different states. Check the saved status before continuing.',
    related:['readiness','getting-started']
  },
  {
    id:'readiness', title:'Save and complete the readiness assessment', section:'AI Readiness',
    keywords:['assessment','readiness','score','rating','questions','draft','complete','saved'],
    summary:'Answer 18 questions about your current ways of working.',
    prerequisites:['Complete the company profile first.'],
    steps:['Rate each statement from 1 (not established) to 5 (operationalized and consistently used).','Use Save draft to keep unfinished answers.','Answer all 18 questions, then choose Complete assessment.','Check the saved confirmation, then continue to map your systems.'],
    note:'Scores are calculated from your ratings. They are not an independent AI evaluation. Category previews may change before the saved overall score is updated.',
    related:['company-profile','systems','save-trouble']
  },
  {
    id:'systems', title:'Map the software your team uses', section:'Systems',
    keywords:['system','systems','software','inventory','application','apps','tools','map'],
    summary:'Record the software involved in your business workflows.',
    prerequisites:['Know which software the task uses and what kind of data it holds.'],
    steps:['Add a system with its name and relevant details.','Review its data classification.','Map a business workflow that uses those systems.'],
    note:'Adding an inventory record does not connect a service or give Kairo access to it.',
    related:['workflow-basics','provider-setup']
  },
  {
    id:'workflow-basics', title:'Map a task before automating it', section:'Workflows',
    keywords:['workflow','task','process','map','inventory','department','repeatable'],
    summary:'Describe a repeatable business task and who owns it.',
    prerequisites:['Identify a task, its owner, the systems it depends on, and the cost of a wrong result.'],
    steps:['List the task’s inputs, steps, outputs and exceptions before deciding which part to automate. Favor repeated steps with clear evidence and an easy way to check the result.','Separate draft or recommendation work from actions that send, publish, delete, spend money or change access. Keep human judgment for ambiguous, sensitive or consequential cases.','Use the workflow inventory to record the task and its department. Describe the reviewer, approval point, exception path and rollback or manual fallback in your process notes.','Create a linked business case in Opportunities using measured baseline effort and your own assumptions. Include review and correction time.','Try approved sample cases, including an exception, outside live operations. If the reviewer cannot reliably detect a mistake, narrow the task before proceeding.','Use Workflow builder separately when ready to configure one of Kairo’s supported actions. Mapping the process does not implement its review or exception controls.'],
    troubleshooting:['If exceptions dominate, assist the person with preparation rather than attempting end-to-end automation.','If a written review step is bypassed in a test, stop the pilot and have the implementation owner enforce the gate.'],
    successChecks:['The owner can identify what is automated, what requires judgment, and what happens when the task cannot safely continue.'],
    note:'A mapped business workflow is an inventory record. It is not an executable automation.',
    related:['business-case','automation','systems']
  },
  {
    id:'business-case', title:'Estimate an opportunity’s value and risk', section:'Opportunities',
    keywords:['opportunity','opportunities','business case','roi','return','cost','benefit','payback','savings','risk','value','money'],
    summary:'Compare potential benefits with implementation and recurring costs.',
    prerequisites:['Choose a mapped workflow, if one is relevant.','Prepare your own assumptions for hours saved and costs.'],
    steps:['Before a pilot, measure representative tasks using the current process: total human time, accepted output, error rate and rework. Keep the sample and task mix comparable.','Repeat the measurement for the pilot, including prompting, review, correction and failed attempts. Calculate net time saved per accepted result, not only generation speed.','Record license or provider charges, implementation, training and maintenance costs in an approved pilot worksheet. Avoid counting the same saved time as both labor savings and another benefit.','Replace Kairo’s example starting values with your own estimates. Enter business value, AI suitability and risk on the 0–100 scales.','Estimate annual hours saved, hourly cost, other annual benefits, one-time implementation cost and annual recurring cost. Use conservative volume assumptions and compare a lower-benefit scenario.','Create the business case and review its calculated score, return and payback. Keep the observed pilot evidence separately and revisit estimates when real usage changes.'],
    troubleshooting:['If the result looks too good, check annual versus monthly units, failed attempts, reviewer time and double-counted benefits.','A high usage count is not proof of better quality or realized savings. Compare accepted outcomes against the baseline.'],
    successChecks:['The task owner can reproduce the assumptions from a dated pilot record and see whether quality held while net effort or cost improved.'],
    note:'These are calculations from your assumptions, not measured results or AI forecasts. Higher risk means greater risk.',
    related:['workflow-basics','blueprints']
  },
  {
    id:'microsoft-setup', title:'Prepare a Microsoft 365 connection', section:'Integrations',
    keywords:['microsoft','365','outlook','connection','connect','integration','permissions','access','calendar','mail','administrator','oauth'],
    summary:'Ask your Microsoft 365 administrator to review and prepare the connection.',
    prerequisites:['An approved Microsoft application registration.','An administrator who can review the requested access.'],
    steps:['Open Integrations and review the Microsoft 365 setup requirements with your administrator.','Use the dedicated connection form for approved registration details. Keep credentials out of help searches.','Review the permissions required by the intended action.','Check the connection status before attempting a workflow.'],
    note:'Profile/health, inbox status, calendar reads, and email sending require different Microsoft permissions. A system inventory record is not a connected account.',
    related:['automation','email-approval','run-status']
  },
  {
    id:'automation', title:'Create and review an automation', section:'Workflows',
    keywords:['automation','builder','run','activate','draft','execute','schedule','supported','steps'],
    summary:'Configure a supported Microsoft action, then review it before a real run.',
    prerequisites:['A connected Microsoft account with the required permissions.','A clear understanding of the intended action.'],
    steps:['In Workflow builder, select a supported action: connection health, profile, inbox status, upcoming calendar events, or an email approval request.','Save the automation as a draft.','Review the action and access, then activate it when ready. Activation alone does not run or schedule it.','Use Run only when you intend to use the real connected account. Review the result before adding a schedule.'],
    note:'An email step queues a request for review. Approving that request and sending the email are separate actions.',
    related:['microsoft-setup','email-approval','run-status']
  },
  {
    id:'email-approval', title:'Review an email approval request', section:'Integrations',
    keywords:['approval','approve','reject','email','send','pending','waiting','approved','message','recipient'],
    summary:'Check the exact recipient, subject, and message before approving or sending.',
    prerequisites:['A verified Microsoft account with Mail.Send permission to approve or send.','A different authorized person must approve the requester’s email.'],
    steps:['Open the pending request in Integrations and review its full contents.','Approve or reject the request as appropriate.','For an approved request, choose Send approved email only when you intend to send it.','Review the recorded result and the linked workflow status.'],
    note:'An Executing or unknown outcome needs review. Do not resend or recreate it to clear the status. Check the saved request and Microsoft account. Microsoft acceptance does not confirm delivery; a later workflow error does not undo an accepted email.',
    related:['automation','run-status','team-access']
  },
  {
    id:'agent-controls', title:'Understand agent workflow controls', section:'Agents',
    keywords:['agent','agents','ai','confidence','threshold','human','control','autonomous','propose'],
    summary:'Configure agent records and explicitly assigned workflows.',
    prerequisites:['A reviewed, active workflow to assign.','The appropriate management role.'],
    steps:['Create the agent record and describe its purpose and intended boundaries.','Assign a reviewed workflow using Workflow permissions. Every run requires human approval.','Request a plan. A different authorized person must review its immutable saved steps, policy, integration bindings and context before approving.','Execute the approved plan once. A linked workflow or unknown outcome must not be executed again.','Read request status and workflow status separately. Only Executed completes the agent request; Waiting Approval still requires separate email review in Integrations.'],
    note:'This screen configures workflow controls. It does not connect a language model or interpret arbitrary instructions. User-entered confidence cannot authorize execution or bypass human review.',
    related:['automation','email-approval','run-status']
  },
  {
    id:'run-status', title:'Check a run, failure, or waiting approval', section:'AI Ops',
    keywords:['status','error','failed','failure','waiting','run','monitor','health','alert','stuck','troubleshoot'],
    summary:'Use recorded statuses to decide what to review next.',
    prerequisites:[],
    steps:['Review workflow run history and the relevant integration status.','If the workflow is Waiting Approval, inspect its linked email request in Integrations.','If a run reports an error, read the details and check the connection before retrying.','Review pending approvals and operational alerts in AI Ops.'],
    note:'A dispatched agent request does not establish that every downstream workflow step completed. Check the linked workflow and any email request separately.',
    related:['email-approval','automation','microsoft-setup']
  },
  {
    id:'governance', title:'Record governance expectations', section:'Governance',
    keywords:['governance','policy','policies','retention','data','export','security','rules'],
    summary:'Document policies and review the tenant’s available data controls.',
    prerequisites:['An agreed policy and the appropriate permission to change it.'],
    steps:['Create a policy record for the relevant topic.','Review tenant retention and export settings with an authorized administrator.','Review the actual integration and execution controls before relying on a policy record.'],
    note:'A written policy record alone is not proof that every expectation is automatically enforced.',
    related:['team-access','agent-controls','audit']
  },
  {
    id:'blueprints', title:'Generate and review a blueprint draft', section:'Blueprints',
    keywords:['blueprint','report','pdf','print','roadmap','plan','summary','recommendation'],
    summary:'Create a draft from the company’s saved assessment and business cases.',
    prerequisites:['Review saved assessment results and opportunity assumptions.'],
    steps:['Choose Generate draft in Blueprints.','Use the draft’s Print / Save PDF button to open the detailed report. If a print dialog opens, cancel it when you only want to review the report.','Review the saved score, priority opportunities, business-case figures, and standard 30/60/90-day roadmap.','Print or save the report as a PDF when ready; adapt your implementation plan to your company’s needs.'],
    note:'The draft uses saved data and a standard roadmap template. It is not a custom AI-written strategy.',
    related:['readiness','business-case']
  },
  {
    id:'team-access', title:'Set employee roles and invite a teammate', section:'Team Access',
    keywords:['team','employee','invite','invitation','member','role','access','admin','owner','consultant','teammate'],
    summary:'Use the correct company and role when managing team access.',
    prerequisites:['A company Owner or Admin role for managing employee access.'],
    steps:['Open Team & Roles and confirm the selected company.','Find an employee and review the descriptions of each available role. Employee is the display name for the existing Member role.','Choose a role, review the unsaved change, and select Save role. Wait for the saved confirmation.','Owners manage elevated roles; Admins can only switch Employee and Viewer access. Your own role is protected.','To add someone new, create an invitation for their email address and share the secure link only with that person. Kairo does not email the link.','If a change cannot be confirmed, refresh the team and check the saved role before retrying.'],
    note:'Company roles do not grant CerbTEK staff or Funding access. Workflow approval policies still apply. Role changes are recorded in Audit.',
    related:['email-approval','governance']
  },
  {
    id:'audit', title:'Review recorded changes', section:'Audit',
    keywords:['audit','history','changes','events','log','who'],
    summary:'Inspect the audit events visible for the selected company.',
    prerequisites:[],
    steps:['Open Audit and review the event summary, type, and timestamp.','Use the relevant workflow or integration history for the execution result.'],
    note:'An audit event records a platform change. Use the corresponding run or action status to understand its outcome.',
    related:['run-status','governance']
  },
  {
    id:'save-trouble', title:'What to do when a save is not confirmed', section:'AI Readiness',
    keywords:['save','saved','saving','draft','failed','error','refresh','lost','connection'],
    summary:'Check the confirmation and current company before repeating a change.',
    prerequisites:[],
    steps:['Read the displayed error or confirmation.','Check that you are still in the intended company and account.','Keep a copy of unsaved work before refreshing.','If workspace information is unavailable, use its refresh option and verify the saved record.'],
    note:'Do not assume a button click means a save, run, or send succeeded.',
    related:['readiness','run-status']
  }
]

const categoryFor = section => ['Workflows','Agents','AI Ops'].includes(section) ? 'Workflows and approvals'
  : section === 'Integrations' ? 'Microsoft 365'
  : ['Team Access','Governance','Audit'].includes(section) ? 'Access and governance' : 'Getting started'

export const HELP_ARTICLES = Object.freeze([...PRODUCT_HELP_ARTICLES,...PROVIDER_HELP_ARTICLES,...TECHNICAL_HELP_ARTICLES,...BUSINESS_HELP_ARTICLES,...AI_TECHNICAL_HELP_ARTICLES].map(article => Object.freeze({
  kind:'platform', category:categoryFor(article.section), reviewedAt:HELP_REVIEWED_AT,
  sources:[{label:'Kairo interface reviewed at revision e9e1c66'}], troubleshooting:[], successChecks:[], externalSteps:[], ...article,
  questions:HELP_QUESTIONS.filter(question=>question.articleId===article.id)
})))

// Only curated documentation links are navigable. Never derive a URL from a query,
// record, remote response, or company context; opening a source is a user action.
export function helpSourceUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && ['developers.google.com','docs.aws.amazon.com','aws.amazon.com','learn.microsoft.com','support.microsoft.com','www.twilio.com','airc.nist.gov','nvlpubs.nist.gov','docs.langchain.com','docs.livekit.io','cheatsheetseries.owasp.org'].includes(url.hostname)
      && !url.username && !url.password && !url.port ? url.href : null
  } catch { return null }
}

export function getHelpArticle(id) {
  return HELP_ARTICLES.find(article => article.id === id) || null
}

export function helpDestination(section) {
  return HELP_SECTIONS.includes(section) ? section : null
}
