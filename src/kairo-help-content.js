// Curated product guidance, reviewed against application revision 77328d0.
// This is local documentation, not generated advice or an execution policy.
export const HELP_VERSION = '2026-10-03.1'
export const HELP_SECTIONS = Object.freeze(['Overview','Team Access','Onboarding','AI Readiness','Systems','Workflows','Opportunities','Integrations','Agents','AI Ops','Governance','Blueprints','Audit'])

export const HELP_ARTICLES = Object.freeze([
  {
    id:'getting-started', title:'Find your next setup step', section:'Overview',
    keywords:['start','setup','next','begin','onboarding','progress','help'],
    summary:'Follow the saved setup progress for this company.',
    prerequisites:[],
    steps:['Complete the company profile, then answer and complete the readiness assessment.','Map your systems and a repeatable business workflow.','Create a business case using your own benefit and cost assumptions.','Review integration access before creating and running an automation.'],
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
    related:['workflow-basics','microsoft-setup']
  },
  {
    id:'workflow-basics', title:'Map a task before automating it', section:'Workflows',
    keywords:['workflow','task','process','map','inventory','department','repeatable'],
    summary:'Describe a repeatable business task and who owns it.',
    prerequisites:['Identify a task and the systems it depends on.'],
    steps:['Use the workflow inventory to record the task and its department.','Describe the process you want to improve.','Create a linked business case in Opportunities.','Use Workflow builder separately when you are ready to configure a supported automation.'],
    note:'A mapped business workflow is an inventory record. It is not an executable automation.',
    related:['business-case','automation','systems']
  },
  {
    id:'business-case', title:'Estimate an opportunity’s value and risk', section:'Opportunities',
    keywords:['opportunity','opportunities','business case','roi','return','cost','benefit','payback','savings','risk','value','money'],
    summary:'Compare potential benefits with implementation and recurring costs.',
    prerequisites:['Choose a mapped workflow, if one is relevant.','Prepare your own assumptions for hours saved and costs.'],
    steps:['Replace the example starting values with your own estimates.','Enter business value, AI suitability, and risk on the 0–100 scales.','Estimate annual hours saved, hourly cost, other annual benefits, one-time implementation cost, and annual recurring cost.','Create the business case and review its calculated score, return, and payback.'],
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
    prerequisites:['A connected Microsoft account with Mail.Send permission.','An authorized approver role.'],
    steps:['Open the pending request in Integrations and review its full contents.','Approve or reject the request as appropriate.','For an approved request, choose Send approved email only when you intend to send it.','Review the recorded result and the linked workflow status.'],
    note:'If an error appears after sending, check Microsoft sent items before retrying. A later workflow error can occur after an email has already been sent.',
    related:['automation','run-status','team-access']
  },
  {
    id:'agent-controls', title:'Understand agent workflow controls', section:'Agents',
    keywords:['agent','agents','ai','confidence','threshold','human','control','autonomous','propose'],
    summary:'Configure agent records and explicitly assigned workflows.',
    prerequisites:['A reviewed, active workflow to assign.','The appropriate management role.'],
    steps:['Create the agent record and describe its purpose and intended boundaries.','Assign a workflow using Workflow permissions.','Review the control mode and execution mode carefully before activating the record.','Review the agent request status in Agents. Open Workflows and check Workflow run history for the execution result; review any linked email request separately in Integrations.'],
    note:'This screen configures workflow controls. It does not connect a language model or interpret arbitrary instructions. The execution-confidence field is entered manually; it is not a measured AI certainty score.',
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
    id:'team-access', title:'Review access and invite a teammate', section:'Team Access',
    keywords:['team','invite','invitation','member','role','access','admin','owner','consultant','teammate'],
    summary:'Use the correct company and role when managing team access.',
    prerequisites:['An authorized role for managing team access.'],
    steps:['Confirm the selected company before changing access.','Review existing members and roles.','Create an invitation for the intended teammate and use the provided invitation link.','Share the link only with its intended recipient.'],
    note:'A role determines available actions. Contact an authorized administrator if your access is insufficient.',
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
])

export function getHelpArticle(id) {
  return HELP_ARTICLES.find(article => article.id === id) || null
}

export function helpDestination(section) {
  return HELP_SECTIONS.includes(section) ? section : null
}
