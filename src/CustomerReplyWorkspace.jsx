import React, { useEffect, useRef, useState } from 'react'
import { useExecutionAttempts, useSafeOperation, acceptedEmail, reviewEmailMessage } from './use-safe-operation'
import { CUSTOMER_WORKFLOW_CONTRACT, REVIEW_ROLES, verifyWorkspace, validWorkflow, validContext, validDraft, validEmail, emailMatchesDraft, workflowState, workflowStep, filterWorkflows, employeeName, formatTime, customerReplyError, draftPath, canCancelWorkflow, independentReviewer, microsoftBindingMatches, sourceMatchesWorkflow, eligibleReviewers } from './customer-reply-model'
import './customer-reply.css'

const emptyIntake = { customer_name: '', customer_email: '', subject: '', message: '' }
const stepLabels = ['Request', 'Company context', 'AI draft', 'Exact email review', 'Result']
const rolesCanWork = ['owner', 'admin', 'consultant', 'member']

function SetupLink({ section, children, onGo }) {
  return <a href={`#${encodeURIComponent(section)}`} onClick={onGo ? event => { event.preventDefault(); onGo(section) } : undefined}>{children}</a>
}

function Readiness({ data, onGo, onEditContext, disabled }) {
  const readiness = data?.readiness, config = data?.configuration?.configuration
  const items = [
    { title: 'Company reply context', ready: readiness?.context_ready === true && validContext(data?.context), detail: validContext(data?.context) ? `Saved version ${data.context.version}` : 'Save the facts and reply guidance employees should use.', section: 'Onboarding', link: 'Company profile' },
    { title: 'Saved AI setup', ready: readiness?.configuration_ready === true, detail: config ? `${config.provider} · ${config.model}. Verify account and model availability in AI setup.` : 'Choose an approved account model in AI setup.', section: 'AI Setup', link: 'Verify AI account and model' },
    { title: 'Live AI generation', ready: readiness?.live_inference_enabled === true, detail: !data ? 'Not verified' : readiness?.live_inference_enabled === true ? 'Enabled by deployment configuration' : 'Disabled. Saved setup does not enable paid inference.', section: 'AI Setup', link: 'Generation settings' },
    { title: 'Microsoft email', ready: readiness?.microsoft_ready === true, detail: readiness?.microsoft_ready === true ? `Verified Mail.Send${readiness.microsoft_account ? ` · ${readiness.microsoft_account}` : ''}` : 'A verified Microsoft connection with Mail.Send is required.', section: 'Integrations', link: 'Microsoft connection' },
    { title: 'Separate reviewer', ready: readiness?.distinct_reviewer_available === true, detail: readiness?.distinct_reviewer_available === true ? 'An authorized company reviewer is available.' : 'A different owner, admin, or consultant must approve the email.', section: 'Team Access', link: 'Team & roles' },
  ]
  return <section className="panel cr-readiness" aria-labelledby="cr-readiness-heading">
    <div className="cr-section-heading"><div><h2 id="cr-readiness-heading">Before your first reply</h2><p>Save the request now. Each next step checks its own requirements.</p></div>{data && REVIEW_ROLES.includes(data.actor.role) && <button className="secondary" type="button" disabled={disabled} onClick={onEditContext}>{data.context ? 'Edit reply context' : 'Save reply context'}</button>}</div>
    <ol className="cr-checklist">{items.map(item => <li key={item.title}><span className={`cr-check ${!data ? '' : item.ready ? 'cr-check-ready' : 'cr-check-needed'}`} aria-label={!data ? 'Unverified' : item.ready ? 'Ready' : 'Setup needed'}>{!data ? '?' : item.ready ? '✓' : '!'}</span><div><h3>{item.title}</h3><p>{item.detail}</p><SetupLink section={item.section} onGo={onGo}>{item.link}</SetupLink></div></li>)}</ol>
  </section>
}

function ExactEmail({ workflow, account }) {
  const draft = workflow.ai_run?.draft, action = workflow.action_request
  const payload = action?.payload || (validDraft(draft) ? { to: workflow.customer_email, subject: draft.title, message: draft.body } : null)
  if (!payload) return <p role="alert">The exact saved email is unavailable. Refresh before continuing.</p>
  const binding = action?.approved_connection_binding
  return <section className="cr-email-preview" aria-label="Exact email preview">
    <h3>Exact email preview</h3>
    <dl><div><dt>Account identity</dt><dd>{binding?.external_account_id || account || 'Verified Microsoft account must be checked before sending'}</dd></div>{action?.connection_id && <div><dt>Connection</dt><dd>{action.connection_id}</dd></div>}<div><dt>To</dt><dd>{payload.to}</dd></div><div><dt>Subject</dt><dd>{payload.subject}</dd></div></dl>
    <p className="cr-muted">The Microsoft account identifier above is not a verified From email address.</p>
    <h4>Message</h4><p className="cr-preserve">{payload.message}</p>
    <p className="cr-muted">Plain text email. No attachments, CC, or BCC. The saved recipient, subject, and message cannot be edited in this workflow.</p>
  </section>
}

function RequestDetail({ workflow, data, actorId, disabled, draftAttempt, emailAttempt, onCommand, onBack, onGo }) {
  const [checked, setChecked] = useState(false), [assignee, setAssignee] = useState(workflow.assigned_to || '')
  const state = workflowState(workflow), action = workflow.action_request, run = workflow.ai_run, source = workflow.context_version
  const manager = REVIEW_ROLES.includes(data.actor.role), employee = rolesCanWork.includes(data.actor.role)
  const ownsWork = employee && (manager || workflow.assigned_to === actorId)
  const draftReady = validDraft(run?.draft), exact = emailMatchesDraft(workflow), accountMatches = microsoftBindingMatches(workflow, data.readiness)
  const generationPath = draftPath(workflow, draftAttempt)
  const reviewers = eligibleReviewers(workflow, data.people, action ? null : actorId)
  const canGenerate = manager && ownsWork && generationPath && (generationPath !== 'resume' || workflow.draft_requested_by === actorId) && validContext(data.context) && data.readiness?.configuration_ready === true && data.readiness?.live_inference_enabled === true && Boolean(data.configuration?.id)
  const canReviewDraft = manager && ownsWork && workflow.status === 'draft_ready' && run?.status === 'awaiting_review' && sourceMatchesWorkflow(workflow) && draftReady && !workflow.context_stale && !workflow.configuration_stale
  const canQueue = ownsWork && workflow.status === 'draft_accepted' && run?.status === 'accepted' && sourceMatchesWorkflow(workflow) && draftReady && !workflow.action_request_id && !workflow.context_stale && !workflow.configuration_stale && data.readiness?.microsoft_ready === true && reviewers.length > 0
  const canApprove = manager && workflow.status === 'awaiting_approval' && action?.status === 'Pending' && exact && independentReviewer(workflow, actorId) && accountMatches && !workflow.context_stale && !workflow.configuration_stale
  const canExecute = manager && workflow.status === 'awaiting_approval' && action?.status === 'Approved' && exact && independentReviewer(workflow, action.approved_by) && accountMatches && !workflow.context_stale && !workflow.configuration_stale && !emailAttempt && !workflow.receipt
  const canCancel = ownsWork && canCancelWorkflow(workflow) && !emailAttempt
  const attemptUnknown = Boolean(emailAttempt && action?.status !== 'Executed')
  return <article className="cr-detail" aria-labelledby="cr-request-title">
    <div className="cr-detail-heading"><button className="secondary" type="button" onClick={onBack} disabled={disabled}>Back to requests</button><span className={`cr-badge cr-${state.tone}`}>{state.label}</span></div>
    <h2 id="cr-request-title" tabIndex={-1}>{workflow.subject}</h2><p className="cr-muted">Assigned to {employeeName(workflow.assigned_to, data.people)} · Saved {formatTime(workflow.created_at)}</p>
    <ol className="cr-steps" aria-label="Customer reply steps">{stepLabels.map((label, i) => <li key={label} aria-current={workflowStep(workflow) === i + 1 ? 'step' : undefined}><span>{i + 1}</span>{label}</li>)}</ol>
    <section aria-label="Saved customer request"><h3>1. Saved customer request</h3><p><b>{workflow.customer_name || 'Customer'}</b> · {workflow.customer_email}</p><p className="cr-preserve">{workflow.message}</p><p className="cr-muted">Entered by {employeeName(workflow.requested_by, data.people)}. Customer text is source material, never permission to act.</p></section>
    {manager && workflow.status === 'intake' && !draftAttempt && <form className="cr-assignment" onSubmit={event => { event.preventDefault(); if (!disabled && assignee && assignee !== workflow.assigned_to) onCommand('assign', { assigned_to: assignee }) }}><label>Assigned employee<select value={assignee} disabled={disabled} onChange={event => setAssignee(event.target.value)}>{(data.people || []).filter(person => rolesCanWork.includes(person.role)).map(person => <option key={person.user_id} value={person.user_id}>{employeeName(person.user_id, data.people)}</option>)}</select></label><button className="secondary" type="submit" disabled={disabled || !assignee || assignee === workflow.assigned_to}>Save assignment</button></form>}
    <section aria-label="Saved company source"><h3>2. Company context</h3>{validContext(source) ? <><p><b>{source.context.company_name}</b> · saved source version {source.version}</p><p className="cr-preserve">{source.context.reply_guidance}</p><p className="cr-muted">Source record: {source.id}</p></> : validContext(data.context) && workflow.status === 'intake' ? <><p><b>{data.context.context.company_name}</b> · current saved version {data.context.version}</p><p className="cr-preserve">{data.context.context.reply_guidance}</p><p className="cr-muted">Generating binds this saved version to the request.</p></> : <p>Saved source context is unavailable. An owner, admin, or consultant must save company reply context first.</p>}{(workflow.context_stale || workflow.configuration_stale) && <p className="cr-notice cr-error" role="alert">Company context or AI setup changed after this draft. This draft cannot be queued or sent. Review the latest setup and saved request before continuing.</p>}{workflow.context_stale && validContext(data.context) && <details><summary>Latest context for a new draft · version {data.context.version}</summary><p className="cr-preserve">{data.context.context.reply_guidance}</p></details>}</section>
    <section aria-label="AI draft"><h3>3. AI draft</h3>{run ? <><p className="cr-muted">AI request {run.id} · {run.status}{workflow.configuration?.configuration?.model ? ` · ${workflow.configuration.configuration.provider} / ${workflow.configuration.configuration.model}` : ''}</p>{draftReady ? <><h4>{run.draft.title}</h4><p className="cr-preserve">{run.draft.body}</p><p>Sources: {run.draft.source_ids.length ? run.draft.source_ids.join(', ') : 'No source cited. Verify every factual claim.'}</p>{run.draft.warnings.length > 0 && <div className="cr-notice"><h4>Check these warnings</h4><ul>{run.draft.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></div>}</> : <p>No complete, validated draft is available.</p>}{run.failure_code && <p className="cr-muted">Recorded error: {run.failure_code}</p>}</> : <p>Generate from the saved customer request and company context. There is no automatic inbox or document retrieval.</p>}
      {(generationPath || workflow.status === 'intake') && <><p className="cr-muted">Generation sends these saved facts to {data.configuration?.configuration?.provider || 'the configured provider'}. Use only business data approved for that provider. Credentials and sensitive customer information do not belong here.</p><button className="primary" type="button" disabled={disabled || !canGenerate} onClick={() => { if (canGenerate) onCommand('generate') }}>{generationPath === 'resume' ? 'Resume saved AI request' : workflow.ai_run ? 'Generate a new draft' : 'Generate AI draft'}</button>{generationPath === 'resume' && <p className="cr-muted">Uses the existing pinned request key and source. It never creates a replacement for an unresolved request.</p>}{!manager && <p>An owner, admin, or consultant must generate and review the AI draft.</p>}{!data.readiness?.live_inference_enabled && <p>Live AI generation is disabled. The request can stay saved while setup is completed.</p>}</>}
      {(draftAttempt && !run || ['drafting', 'ai_unknown'].includes(workflow.status)) && <p className="cr-notice cr-error" role="alert">The AI outcome is pending or unknown. Check recorded results. Do not generate a replacement.</p>}
      {canReviewDraft && <><label className="cr-checkbox"><input type="checkbox" checked={checked} disabled={disabled} onChange={event => setChecked(event.target.checked)}/>I checked the draft, source context, and warnings.</label><div className="cr-actions"><button className="primary" type="button" disabled={disabled || !checked} onClick={() => { if (checked) onCommand('accept_draft') }}>Accept draft for use</button><button className="secondary" type="button" disabled={disabled} onClick={() => onCommand('reject_draft')}>Reject AI draft</button></div><p className="cr-muted">This records a draft review. It does not approve or send an email.</p></>}
    </section>
    {(draftReady || action) && <section aria-label="Email approval"><h3>4. Exact email review</h3><ExactEmail workflow={workflow} account={data.readiness?.microsoft_account}/>
      {workflow.status !== 'cancelled' && !reviewers.length && <p className="cr-notice" role="status">This reply needs another authorized owner, admin, or consultant who was not its requester, draft author, or assigned employee. Add or reassign a reviewer in <SetupLink section="Team Access" onGo={onGo}>Team & Roles</SetupLink>.</p>}
      {!action && <><p>A separate authorized person reviews the exact saved email after you queue it. Queuing does not send it.</p>{workflow.status === 'draft_accepted' && <><label className="cr-checkbox"><input type="checkbox" checked={checked} disabled={disabled} onChange={event => setChecked(event.target.checked)}/>I checked this recipient, subject, and message.</label><button type="button" className="primary" disabled={disabled || !canQueue || !checked} onClick={() => { if (canQueue && checked) onCommand('queue') }}>Queue exact email for approval</button></>}{workflow.status === 'draft_ready' && <p>Accept the AI draft above before queuing this exact email.</p>}</>}
      {action && <>{workflow.status !== 'cancelled' && !accountMatches && ['Pending', 'Approved'].includes(action.status) && <p role="alert" className="cr-notice cr-error">The saved Microsoft account binding does not match the verified current connection. Approval and sending are blocked.</p>}<p className="cr-muted">Saved email request: {action.id} · Requested by {employeeName(action.requested_by, data.people)}{action.approved_by ? ` · Approved by ${employeeName(action.approved_by, data.people)}` : ''}</p>{!exact && <p role="alert" className="cr-notice cr-error">The saved email does not match the request and AI draft. Approval and sending are blocked.</p>}{workflow.status !== 'cancelled' && action.status === 'Pending' && <><p>{action.requested_by === actorId ? 'A different authorized person must approve your email.' : 'Read the exact email and saved sources before deciding.'}</p>{manager && <><label className="cr-checkbox"><input type="checkbox" checked={checked} disabled={disabled || !canApprove} onChange={event => setChecked(event.target.checked)}/>I reviewed the exact email and its sources.</label><div className="cr-actions"><button className="primary" type="button" disabled={disabled || !canApprove || !checked} onClick={() => { if (canApprove && checked) onCommand('approve') }}>Approve exact email</button><button className="secondary" type="button" disabled={disabled} onClick={() => onCommand('reject')}>Reject email</button></div><p className="cr-muted">Approval is recorded separately. It does not send the email.</p></>}</>}{workflow.status !== 'cancelled' && action.status === 'Approved' && <><p>The saved email is approved. The authorized sender must choose to send it.</p>{manager && <><label className="cr-checkbox"><input type="checkbox" checked={checked} disabled={disabled || !canExecute} onChange={event => setChecked(event.target.checked)}/>I checked the approved email and Microsoft account.</label><button className="primary" type="button" disabled={disabled || !canExecute || !checked} onClick={() => { if (canExecute && checked) onCommand('execute') }}>Send approved email</button></>}</>}</>}
    </section>}
    <section className="cr-result" aria-label="Recorded result"><h3>5. Recorded result</h3><p>{attemptUnknown ? 'The email outcome needs review. Do not resend. Check the saved request and Microsoft account.' : state.detail}</p>{workflow.receipt?.phase && <p>Recorded Microsoft attempt: {workflow.receipt.phase}</p>}{action?.error_message && <p className="cr-muted">{action.error_message}</p>}{action?.status === 'Executed' && <p className="cr-muted">Customer receipt, reading, and resolution have not been confirmed by this workflow.</p>}</section>
    {canCancel && <details><summary>Cancel this saved request</summary><p>Cancel this request before Microsoft dispatch starts. It remains in saved history. Cancellation does not undo an AI request already sent to its provider.</p><button type="button" className="secondary" disabled={disabled} onClick={() => onCommand('cancel')}>Cancel request</button></details>}
  </article>
}

function BoundWorkspace({ org, session, client, members = [], onGo, onDirtyChange, onBusyChange }) {
  const actorId = session.user.id, scope = `${actorId}:${org.id}`
  const [data, setData] = useState(null), [loading, setLoading] = useState(true), [feedback, setFeedback] = useState(null), [needsRefresh, setNeedsRefresh] = useState(false)
  const [selected, setSelected] = useState(null), [panel, setPanel] = useState('list'), [filter, setFilter] = useState('open'), [intake, setIntake] = useState(emptyIntake)
  const [editingContext, setEditingContext] = useState(false), [contextForm, setContextForm] = useState({ company_name: org.name || '', reply_guidance: '' })
  const [checkedData, setCheckedData] = useState(false)
  const mounted = useRef(true), readEpoch = useRef(0), intakeKey = useRef(null), currentData = useRef(null), detailPanel = useRef(null)
  currentData.current = data
  const { busy, run } = useSafeOperation(scope)
  const draftAttempts = useExecutionAttempts(`${scope}:customer-draft`), emailAttempts = useExecutionAttempts(scope), intakeAttempts = useExecutionAttempts(`${scope}:customer-intake`)
  const dirty = panel === 'intake' && Object.values(intake).some(Boolean) || editingContext && (contextForm.company_name !== (data?.context?.context.company_name || org.name || '') || contextForm.reply_guidance !== (data?.context?.context.reply_guidance || ''))
  const blocked = busy || loading || needsRefresh || !data
  useEffect(() => { onDirtyChange?.(Boolean(dirty)); return () => onDirtyChange?.(false) }, [dirty, onDirtyChange])
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false) }, [busy, onBusyChange])
  useEffect(() => { const protect = event => { if (dirty || busy) { event.preventDefault(); event.returnValue = '' } }; window.addEventListener('beforeunload', protect); return () => window.removeEventListener('beforeunload', protect) }, [dirty, busy])
  useEffect(() => {
    if (loading || panel === 'list') return
    const heading = detailPanel.current?.querySelector('h2')
    heading?.focus({ preventScroll: true }); heading?.scrollIntoView?.({ block: 'start', behavior: 'instant' })
  }, [panel, selected, loading])

  async function invoke(endpoint, body, { envelope = false } = {}) {
    const result = await client.functions.invoke(endpoint, { body })
    let code = result.data?.error
    if (result.error?.context instanceof Response) { try { const payload = await result.error.context.json(); if (typeof payload.error === 'string') code = payload.error } catch { /* A malformed acknowledgement remains unconfirmed. */ } }
    if (result.error || result.data?.ok === false || code) throw new Error(code || 'workspace_unavailable')
    const value = result.data
    if (envelope && (value?.ok !== true || value.contract_version !== CUSTOMER_WORKFLOW_CONTRACT || value.organization_id !== org.id)) throw new Error('workspace_unverified')
    return value
  }
  const workflowCall = payload => invoke('customer-workflow', { organization_id: org.id, ...payload }, { envelope: true })
  async function load() {
    const epoch = ++readEpoch.current
    setLoading(true)
    try {
      const next = verifyWorkspace(await workflowCall({ operation: 'load' }), org.id, actorId)
      if (!mounted.current || epoch !== readEpoch.current) return false
      setData(next); setNeedsRefresh(false)
      for (const item of next.workflows) {
        const key = draftAttempts.get(item.id)
        if (key && item.ai_request_key === key && item.ai_run?.request_key === key && ['awaiting_review', 'accepted', 'rejected', 'failed'].includes(item.ai_run.status)) draftAttempts.clear(item.id)
      }
      const pendingKey = intakeAttempts.get('pending')
      if (pendingKey && next.workflows.some(item => item.request_key === pendingKey)) { intakeAttempts.clear('pending'); intakeKey.current = null }
      return true
    } catch (error) {
      if (mounted.current && epoch === readEpoch.current) { setData(null); setNeedsRefresh(true); setFeedback({ error: true, text: customerReplyError(error) }) }
      return false
    } finally { if (mounted.current && epoch === readEpoch.current) setLoading(false) }
  }
  useEffect(() => { mounted.current = true; load(); return () => { mounted.current = false; readEpoch.current++ } }, [org.id, actorId, client])
  const mayLeave = () => !busy && (!dirty || window.confirm('Discard unsaved text in customer reply?'))
  function navigate(nextPanel, id = null) { if (!mayLeave()) return; setPanel(nextPanel); setSelected(id); setIntake(emptyIntake); setCheckedData(false); setEditingContext(false); setFeedback(null) }
  function go(section) { if (!mayLeave()) return; if (onGo) onGo(section); else window.location.hash = encodeURIComponent(section) }
  const refresh = () => { if (busy || !mayLeave()) return; setEditingContext(false); setIntake(emptyIntake); setCheckedData(false); setFeedback(null); run(async () => { await load() }) }
  function verifyMutation(value, id) { if (!validWorkflow(value?.workflow, org.id) || id && value.workflow.id !== id) throw new Error('workspace_unverified'); return value.workflow }
  const failure = error => { setNeedsRefresh(true); setFeedback({ error: true, text: customerReplyError(error) }) }

  function saveContext(event) {
    event.preventDefault()
    if (blocked || !REVIEW_ROLES.includes(data.actor.role) || !contextForm.company_name.trim() || contextForm.company_name.trim().length > 200 || contextForm.reply_guidance.trim().length < 10 || contextForm.reply_guidance.trim().length > 5000) return
    run(async current => {
      const result = await workflowCall({ operation: 'save_context', expected_version: data.context?.version || 0, context: { company_name: contextForm.company_name.trim(), reply_guidance: contextForm.reply_guidance.trim() } })
      if (!current()) return
      if (!validContext(result.context) || result.context.organization_id !== org.id) throw new Error('workspace_unverified')
      setEditingContext(false); setFeedback({ text: `Company reply context version ${result.context.version} saved. Existing drafts keep their original source version.` }); await load()
    }, failure)
  }
  function createIntake(event) {
    event.preventDefault()
    if (blocked || !rolesCanWork.includes(data.actor.role) || !checkedData || intakeAttempts.get('pending') || !validEmail(intake.customer_email.trim()) || !intake.customer_name.trim() || intake.customer_name.trim().length > 200 || !intake.subject.trim() || intake.subject.trim().length > 200 || /[\r\n]/.test(intake.subject) || !intake.message.trim() || intake.message.trim().length > 6000) return
    run(async current => {
      intakeKey.current ||= crypto.randomUUID(); intakeAttempts.mark('pending', intakeKey.current)
      const result = await workflowCall({ operation: 'intake', request_key: intakeKey.current, ...Object.fromEntries(Object.entries(intake).map(([key, value]) => [key, value.trim()])) })
      if (!current()) return
      const workflow = verifyMutation(result)
      if (workflow.request_key !== intakeKey.current || workflow.customer_email !== intake.customer_email.trim() || workflow.subject !== intake.subject.trim() || workflow.message !== intake.message.trim()) throw new Error('workspace_unverified')
      intakeAttempts.clear('pending'); intakeKey.current = null; setIntake(emptyIntake); setCheckedData(false); setPanel('detail'); setSelected(workflow.id); setFeedback({ text: 'Customer request saved. No AI request or email has been sent.' }); await load()
    }, failure)
  }

  function command(operation, extra = {}) {
    const workflow = currentData.current?.workflows.find(item => item.id === selected)
    if (blocked || !workflow) return
    const manager = REVIEW_ROLES.includes(data.actor.role), ownsWork = rolesCanWork.includes(data.actor.role) && (manager || workflow.assigned_to === actorId)
    const action = workflow.action_request, exact = emailMatchesDraft(workflow), accountMatches = microsoftBindingMatches(workflow, data.readiness)
    // Every handler rechecks authority and state; disabled controls are not locks.
    if (['assign', 'generate', 'accept_draft', 'reject_draft', 'queue', 'cancel'].includes(operation) && !ownsWork) return
    if (operation === 'assign' && (!manager || workflow.status !== 'intake' || !data.people?.some(person => person.user_id === extra.assigned_to && rolesCanWork.includes(person.role)))) return
    if (operation === 'generate' && (!manager || !draftPath(workflow, draftAttempts.get(workflow.id)) || draftPath(workflow, draftAttempts.get(workflow.id)) === 'resume' && workflow.draft_requested_by !== actorId || !validContext(data.context) || !data.configuration?.id || data.readiness?.configuration_ready !== true || data.readiness?.live_inference_enabled !== true)) return
    if (['accept_draft', 'reject_draft'].includes(operation) && (!manager || workflow.status !== 'draft_ready' || workflow.ai_run?.status !== 'awaiting_review' || !sourceMatchesWorkflow(workflow) || !validDraft(workflow.ai_run.draft) || workflow.context_stale || workflow.configuration_stale)) return
    if (operation === 'queue' && (workflow.status !== 'draft_accepted' || workflow.ai_run?.status !== 'accepted' || !sourceMatchesWorkflow(workflow) || !validDraft(workflow.ai_run.draft) || workflow.action_request_id || workflow.context_stale || workflow.configuration_stale || data.readiness?.microsoft_ready !== true || !eligibleReviewers(workflow, data.people, actorId).length)) return
    if (operation === 'cancel' && (!canCancelWorkflow(workflow) || emailAttempts.get(workflow.action_request_id))) return
    if (['approve', 'reject', 'execute'].includes(operation) && (!manager || !action)) return
    if (operation === 'approve' && (workflow.status !== 'awaiting_approval' || action.status !== 'Pending' || !exact || !independentReviewer(workflow, actorId) || workflow.context_stale || workflow.configuration_stale || !accountMatches)) return
    if (operation === 'reject' && (workflow.status !== 'awaiting_approval' || action.status !== 'Pending')) return
    if (operation === 'execute' && (workflow.status !== 'awaiting_approval' || action.status !== 'Approved' || !exact || !independentReviewer(workflow, action.approved_by) || emailAttempts.get(action.id) || workflow.context_stale || workflow.configuration_stale || !accountMatches || workflow.receipt)) return
    run(async current => {
      setFeedback(null)
      if (operation === 'generate') {
        const resume = draftPath(workflow, draftAttempts.get(workflow.id)) === 'resume'
        const requestKey = resume ? workflow.ai_request_key : crypto.randomUUID()
        const configurationId = resume ? workflow.configuration_id : data.configuration.id
        draftAttempts.mark(workflow.id, requestKey)
        const prepared = resume ? { workflow } : await workflowCall({ operation: 'prepare_draft', workflow_id: workflow.id, expected_revision: workflow.revision, configuration_id: configurationId, request_key: requestKey })
        if (!current()) return
        const saved = verifyMutation(prepared, workflow.id)
        if (saved.ai_request_key !== requestKey || saved.status !== 'drafting' || !resume && saved.revision <= workflow.revision) throw new Error('workspace_unverified')
        const result = await invoke('ai-draft', { operation: 'run', organization_id: org.id, customer_workflow_id: workflow.id, expected_revision: saved.revision, configuration_id: configurationId, request_key: requestKey })
        if (!current()) return
        if (!result?.run?.id || result.run.organization_id !== org.id || result.run.requested_by !== actorId || result.run.configuration_id !== configurationId || result.run.request_key !== requestKey) throw new Error('workspace_unverified')
        setFeedback({ text: result.run.status === 'awaiting_review' ? 'AI draft saved for review. No email has been queued or sent.' : 'AI request recorded. Check its saved outcome before continuing.' })
      } else if (['accept_draft', 'reject_draft'].includes(operation)) {
        const decision = operation === 'accept_draft' ? 'accepted' : 'rejected'
        const result = await invoke('ai-draft', { operation: 'review', organization_id: org.id, run_id: workflow.ai_run.id, decision })
        if (!current()) return
        if (result?.run?.id !== workflow.ai_run.id || result.run.organization_id !== org.id || result.run.status !== decision) throw new Error('workspace_unverified')
        setFeedback({ text: decision === 'accepted' ? 'AI draft review saved. Queue the exact email for separate approval when ready.' : 'AI draft rejected. No email has been queued.' })
      } else if (['approve', 'reject', 'execute'].includes(operation)) {
        if (operation === 'execute') emailAttempts.mark(action.id)
        // Use the existing guarded Microsoft action path, never a second sender.
        const result = await client.functions.invoke('microsoft-action', { body: { op: operation, request_id: action.id } })
        if (!current()) return
        if (operation === 'execute') {
          if (!result.error && acceptedEmail(result.data) && result.data.request_id === action.id) { emailAttempts.mark(action.id, 'accepted'); setFeedback({ text: 'Microsoft accepted the approved email. Delivery is not confirmed.' }) }
          else { setFeedback({ error: true, text: reviewEmailMessage(result.data) }); setNeedsRefresh(true) }
        } else {
          const reviewed = result.data?.request
          if (result.error || result.data?.ok !== true || reviewed?.id !== action.id || reviewed.organization_id !== org.id || reviewed.status !== (operation === 'approve' ? 'Approved' : 'Rejected') || operation === 'approve' && (reviewed.approved_by !== actorId || !emailMatchesDraft({ ...workflow, action_request: reviewed }))) throw new Error('workspace_unverified')
          setFeedback({ text: operation === 'approve' ? 'Exact email approved. It has not been sent.' : 'Email request rejected.' })
        }
      } else {
        const result = await workflowCall({ operation, workflow_id: workflow.id, expected_revision: workflow.revision, ...extra })
        if (!current()) return
        const saved = verifyMutation(result, workflow.id)
        if (saved.revision <= workflow.revision || operation === 'queue' && (!saved.action_request_id || saved.status !== 'awaiting_approval' || saved.action_request?.status !== 'Pending' || !emailMatchesDraft(saved)) || operation === 'cancel' && saved.status !== 'cancelled' || operation === 'assign' && saved.assigned_to !== extra.assigned_to) throw new Error('workspace_unverified')
        setFeedback({ text: operation === 'queue' ? 'Exact email queued for a different authorized reviewer. It has not been sent.' : operation === 'cancel' ? 'Request cancelled and retained in saved history.' : 'Assignment saved.' })
      }
      if (current()) await load()
    }, error => {
      if (operation === 'execute') { setNeedsRefresh(true); setFeedback({ error: true, text: reviewEmailMessage() }) }
      else failure(error)
    })
  }

  const workflows = data?.workflows || [], items = filterWorkflows(workflows, filter, actorId), workflow = workflows.find(item => item.id === selected)
  // Roster metadata improves labels only. Roles and eligible people continue to
  // come exclusively from the verified customer-workflow response.
  const visiblePeople = (data?.people || []).map(person => {
    const member = members.find(item => item.user_id === person.user_id && (!item.organization_id || item.organization_id === org.id))
    return { ...person, ...(member ? { email: member.email, name: member.name } : {}) }
  })
  const visibleData = data ? { ...data, people: visiblePeople } : null
  return <section className="customer-reply-workspace" aria-label="Customer reply workspace">
    <div className="cr-heading"><div><p className="eyebrow">EMPLOYEE WORKSPACE</p><h1>Customer reply</h1><p>Move a customer request from saved context to a reviewed Microsoft email.</p></div><button type="button" className="secondary" disabled={busy || loading} onClick={refresh}>Refresh saved results</button></div>
    <Readiness data={data} onGo={go} disabled={blocked} onEditContext={() => { if (!mayLeave()) return; setContextForm(data?.context?.context || { company_name: org.name || '', reply_guidance: '' }); setEditingContext(true) }}/>
    {loading && <p role="status" className="cr-notice">Checking saved requests and setup…</p>}
    {feedback && <p className={`cr-notice ${feedback.error ? 'cr-error' : ''}`} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
    {needsRefresh && <p className="cr-muted">Refresh saved results to recheck access and recorded state before taking another action.</p>}
    {intakeAttempts.get('pending') && <p className="cr-notice cr-error" role="alert">An intake save is unconfirmed. Request key: {intakeAttempts.get('pending')}. Refresh the records and ask an operator to reconcile it before creating another request.</p>}
    {editingContext && <section className="panel" aria-label="Edit company reply context"><h2>Company reply context</h2><p>Save approved facts and reply guidance used by this workflow. This is separate from the broader company profile.</p><form onSubmit={saveContext}><fieldset disabled={blocked}><legend>Versioned reply source</legend><label>Company name<input required maxLength={200} value={contextForm.company_name} onChange={event => setContextForm(value => ({ ...value, company_name: event.target.value }))}/></label><label>Reply guidance and confirmed facts<textarea required minLength={10} maxLength={5000} value={contextForm.reply_guidance} onChange={event => setContextForm(value => ({ ...value, reply_guidance: event.target.value }))}/></label><p>Do not store passwords, payment details, sensitive customer information, or unsupported promises.</p><div className="cr-actions"><button className="primary" type="submit">Save context version</button></div></fieldset><button className="secondary" type="button" disabled={busy} onClick={() => setEditingContext(false)}>Cancel context edit</button></form></section>}
    <div className="cr-overview" aria-label="Request counts">{[['pending', 'Pending work'], ['review', 'Awaiting review'], ['approved', 'Approved · not sent'], ['accepted', 'Microsoft accepted'], ['exception', 'Needs attention']].map(([key, label]) => <div key={key}><strong>{data ? workflows.filter(item => workflowState(item).key === key).length : '—'}</strong><span>{label}</span></div>)}</div>
    <p className="cr-muted">Counts cover the latest {data?.limit || 100} requests visible to your company role. Microsoft acceptance is separate from delivery and customer resolution.</p>
    <div className="cr-workspace-grid"><aside className="panel cr-queue" aria-label="Daily requests"><div className="cr-section-heading"><h2>Daily requests</h2><button className="primary" type="button" disabled={blocked || !rolesCanWork.includes(data?.actor.role) || Boolean(intakeAttempts.get('pending'))} onClick={() => navigate('intake')}>New request</button></div><label>View requests<select value={filter} disabled={busy} onChange={event => setFilter(event.target.value)}><option value="open">Open requests</option><option value="mine">Assigned to me</option><option value="review">Awaiting review</option><option value="approved">Approved · not sent</option><option value="accepted">Microsoft accepted</option><option value="exception">Needs attention</option><option value="all">All saved requests</option></select></label><nav aria-label="Saved customer requests">{items.map(item => <button type="button" key={item.id} className={`cr-request-row ${selected === item.id && panel === 'detail' ? 'cr-selected' : ''}`} aria-pressed={selected === item.id && panel === 'detail'} disabled={busy || loading} onClick={() => navigate('detail', item.id)}><strong>{item.subject}</strong><span>{workflowState(item).label}</span><small>{employeeName(item.assigned_to, visiblePeople)}</small><small>{formatTime(item.created_at)}</small></button>)}</nav>{data && !items.length && <p className="cr-muted">No saved requests in this view.</p>}{!data && !loading && <p className="cr-muted">Requests are unavailable until the workspace is verified.</p>}</aside>
      <div className="panel cr-detail-panel" ref={detailPanel} aria-busy={busy || loading}>{panel === 'intake' ? <form onSubmit={createIntake} aria-label="New customer request"><h2 tabIndex={-1}>Save a customer request</h2><p>Capture a request received by your team. Saving it does not call an AI provider or send an email.</p><fieldset disabled={blocked || Boolean(intakeAttempts.get('pending'))}><legend>Customer intake</legend><label>Customer name<input required maxLength={200} value={intake.customer_name} onChange={event => setIntake(value => ({ ...value, customer_name: event.target.value }))}/></label><label>Customer email<input type="email" required maxLength={320} value={intake.customer_email} onChange={event => setIntake(value => ({ ...value, customer_email: event.target.value }))}/></label><label>Request subject<input required maxLength={200} value={intake.subject} onChange={event => setIntake(value => ({ ...value, subject: event.target.value }))}/></label><label>Customer request and confirmed facts<textarea required maxLength={6000} value={intake.message} onChange={event => setIntake(value => ({ ...value, message: event.target.value }))}/></label><label className="cr-checkbox"><input type="checkbox" checked={checkedData} onChange={event => setCheckedData(event.target.checked)}/>This is business information approved for this company workspace.</label><div className="cr-actions"><button className="primary" type="submit" disabled={!checkedData}>Save request</button></div></fieldset><button className="secondary" type="button" disabled={busy} onClick={() => navigate('list')}>Cancel new request</button></form> : panel === 'detail' && workflow ? <RequestDetail key={`${workflow.id}:${workflow.revision}:${workflow.ai_run?.status}:${workflow.action_request?.status}`} workflow={workflow} data={visibleData} actorId={actorId} disabled={blocked} draftAttempt={draftAttempts.get(workflow.id)} emailAttempt={emailAttempts.get(workflow.action_request_id)} onCommand={command} onBack={() => navigate('list')} onGo={go}/> : <div className="cr-empty"><h2>Your next customer reply</h2><p>Select a saved request to see its owner, sources, review, and result, or start with a new request.</p><ol><li>Save the customer request</li><li>Use versioned company reply context</li><li>Generate and review the AI draft when enabled</li><li>Get independent approval of the exact email</li><li>Send once and check the recorded result</li></ol>{data?.actor.role === 'viewer' && <p>Your Viewer role can read available requests. An authorized employee handles changes.</p>}</div>}</div>
    </div>
  </section>
}

export default function CustomerReplyWorkspace(props) {
  if (!props.org?.id || !props.session?.user?.id || !props.client?.functions?.invoke) return <section className="panel" aria-label="Customer reply workspace"><h2>Customer reply</h2><p role="status">Choose an authenticated company to open its customer requests.</p></section>
  return <BoundWorkspace key={`${props.session.user.id}:${props.org.id}`} {...props}/>
}
