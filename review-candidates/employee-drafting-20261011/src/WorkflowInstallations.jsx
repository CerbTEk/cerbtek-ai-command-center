import React, { useEffect, useRef, useState } from 'react'
import { MANAGERS, RECIPE_KEY, RECIPE_VERSION, emptyInstallation, installationForm, validInstallationForm, verifyInstallations, validInstallation, canStartInstallation, installationError } from './workflow-installation-model'
import { validWorkflow, validEmail, employeeName } from './customer-reply-model'
import './workflow-installations.css'
import { useExecutionAttempts } from './use-safe-operation'

function Link({ section, onGo, children }) { return <button type="button" className="secondary" onClick={() => onGo?.(section)}>{children}</button> }
const emptyIntake = () => ({ customer_name: '', customer_email: '', subject: '', message: '' })
export default function WorkflowInstallations(props) {
  if (!props.org?.id || !props.session?.user?.id) return null
  return <Installations key={`${props.org.id}:${props.session.user.id}`} {...props}/>
}
function Installations({ org, session, client, onGo, employee = false, onStarted, onDirtyChange, onBusyChange }) {
  const [data, setData] = useState(null), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [failed, setFailed] = useState(false)
  const [form, setForm] = useState(null), [selected, setSelected] = useState(null), [intake, setIntake] = useState(emptyIntake), [checked, setChecked] = useState(false)
  const lock = useRef(false), epoch = useRef(0), mounted = useRef(true), pending = useRef(null)
  const attempts = useExecutionAttempts(`${session.user.id}:${org.id}:installation`)
  const unresolved = attempts.get('pending')
  const dirty = Boolean(form || selected && Object.values(intake).some(Boolean))
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false) }, [dirty, onDirtyChange])
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false) }, [busy, onBusyChange])
  useEffect(() => { const protect = event => { if (dirty || busy) { event.preventDefault(); event.returnValue = '' } }; window.addEventListener('beforeunload', protect); return () => window.removeEventListener('beforeunload', protect) }, [dirty, busy])
  async function call(body) {
    const result = await client.functions.invoke('workflow-installations', { body: { organization_id: org.id, ...body } })
    if (result.error || result.data?.error || result.data?.ok !== true || result.data.contract_version !== 1 || result.data.organization_id !== org.id) {
      let rejected = result.data
      if (result.error?.context instanceof Response) { try { rejected = await result.error.context.clone().json() } catch { /* Preserve uncertainty if an error response is unreadable. */ } }
      const error = new Error('installation_unavailable')
      error.notApplied = rejected?.ok === false && rejected.write_outcome === 'not_applied'
      throw error
    }
    return result.data
  }
  async function reload() {
    if (lock.current) return
    lock.current = true; const ticket = ++epoch.current; setBusy(true); setFailed(false); setMessage('')
    try {
      const value = verifyInstallations(await call({ operation: 'load' }), org.id, session.user.id)
      if (!mounted.current || ticket !== epoch.current) return
      setData(value)
      if (unresolved) {
        let saved; try { saved = JSON.parse(unresolved) } catch { saved = null }
        if (saved && (value.operation_receipts || []).some(receipt => receipt.request_key === saved.key && receipt.operation === saved.operation)) { attempts.clear('pending'); pending.current = null; setForm(null); setSelected(null); setIntake(emptyIntake()); setChecked(false); setMessage('The earlier saved operation has been reconciled. Check its saved workflow below.') }
      }
    } catch { if (mounted.current && ticket === epoch.current) { setData(null); setFailed(true); setMessage('Workflow installation service is unavailable or its saved records could not be verified. No installation is confirmed. Existing customer requests remain available below.') } }
    finally { if (mounted.current && ticket === epoch.current) { lock.current = false; setBusy(false) } }
  }
  useEffect(() => { mounted.current = true; reload(); return () => { mounted.current = false; epoch.current++ } }, [client])
  function close() { if (!lock.current && (!dirty || window.confirm('Discard unsaved workflow setup or request text?'))) { setForm(null); setSelected(null); setIntake(emptyIntake()); setChecked(false) } }
  function edit(row) { if (lock.current || dirty || unresolved) return; setForm(row ? installationForm(row) : emptyInstallation()); setMessage(''); setFailed(false) }
  function field(name, value) { setForm(previous => ({ ...previous, [name]: value })) }
  function binding(name, value) { setForm(previous => ({ ...previous, bindings: { ...previous.bindings, [name]: value || null } })) }
  async function save(event) {
    event.preventDefault()
    if (lock.current || !data || !MANAGERS.includes(data.actor.role) || !validInstallationForm(form)) return
    const body = { operation: 'save', ...form, name: form.name.trim(), outcome: form.outcome.trim() }
    await mutate(body, value => { if (!validInstallation(value.installation, org.id) || value.installation.revision !== body.expected_revision + 1 || body.installation_id && value.installation.id !== body.installation_id || value.installation.name !== body.name || value.installation.outcome !== body.outcome || Object.keys(body.bindings).some(key => value.installation.bindings[key] !== body.bindings[key]) || value.installation.limits.max_open_requests !== body.limits.max_open_requests) throw new Error('unverified'); setForm(null); setMessage('Workflow setup saved. Review its current bindings below. AI generation, exact-email approval, and sending remain separate actions.') })
  }
  async function start(event) {
    event.preventDefault()
    const record = data?.installations.find(row => row.id === selected)
    if (lock.current || !record || !canStartInstallation(record, data.actor) || !checked || !validEmail(intake.customer_email.trim()) || !intake.customer_name.trim() || !intake.subject.trim() || /[\r\n]/.test(intake.subject) || !intake.message.trim()) return
    await mutate({ operation: 'start', installation_id: record.id, expected_revision: record.revision, intake: Object.fromEntries(Object.entries(intake).map(([key,value]) => [key,value.trim()])) }, async value => {
      if (!validWorkflow(value.workflow, org.id) || value.workflow.request_key !== pending.current?.key || value.workflow.requested_by !== session.user.id || value.workflow.assigned_to !== record.bindings.assigned_to || Object.keys(intake).some(key => value.workflow[key] !== intake[key].trim()) || value.installation?.id !== record.id || value.installation?.revision !== record.revision) throw new Error('unverified')
      setSelected(null); setIntake(emptyIntake()); setChecked(false); setMessage('Customer request saved with this workflow setup. No draft was generated and no email was sent.')
      await onStarted?.(value.workflow.id)
    })
  }
  async function mutate(body, accept) {
    if (unresolved && !pending.current) { setFailed(true); setMessage('An earlier operation is unconfirmed. Refresh saved workflows to reconcile it before creating another.'); return }
    const signature = JSON.stringify(body)
    if (pending.current && pending.current.signature !== signature) { setFailed(true); setMessage('An earlier save has an unconfirmed outcome. Retry the unchanged request first; do not create a replacement.'); return }
    pending.current ||= { signature, key: crypto.randomUUID() }
    attempts.mark('pending', JSON.stringify({ operation: body.operation, key: pending.current.key }))
    lock.current = true; setBusy(true); setFailed(false); setMessage('')
    const ticket = ++epoch.current
    try {
      const value = await call({ ...body, request_key: pending.current.key })
      if (!mounted.current || ticket !== epoch.current) return
      await accept(value); pending.current = null; attempts.clear('pending')
      const refreshed = verifyInstallations(await call({ operation: 'load' }), org.id, session.user.id)
      if (mounted.current && ticket === epoch.current) setData(refreshed)
    } catch (error) { if (mounted.current && ticket === epoch.current) { if (error.notApplied) { pending.current = null; attempts.clear('pending') } setFailed(true); setMessage(installationError() + (pending.current ? ' The outcome is unconfirmed; retry the same unchanged form to safely reconcile its saved request key.' : '')) } }
    finally { if (mounted.current && ticket === epoch.current) { lock.current = false; setBusy(false) } }
  }
  const workspace = data?.workspace, managers = workspace?.people.filter(person => MANAGERS.includes(person.role)) || [], people = workspace?.people.filter(person => [...MANAGERS, 'member'].includes(person.role)) || []
  const manager = MANAGERS.includes(data?.actor.role)
  return <section className="panel wi-panel" aria-label={employee ? 'Configured workflow entry points' : 'Install a reusable workflow'}>
    <p className="eyebrow">{employee ? 'YOUR TEAM’S WORKFLOWS' : 'BUSINESS NEED → WORKFLOW SETUP'}</p>
    <h2>{employee ? 'Start from your saved workflow' : 'Set up customer follow-up'}</h2>
    <p>{employee ? 'Use a saved setup to capture a customer request with the chosen assignment, source, and review path.' : 'Choose the result your business needs, then bind a versioned workflow recipe to your existing company setup.'}</p>
    <p className="wi-note">Customer follow-up · recipe v1. Manual intake → approved company guidance → assigned draft request → authorized draft review → independent exact-email review → separate Microsoft send. Automatic inbox retrieval and unattended execution are unavailable.</p>
    {unresolved && !pending.current && <p role="alert">An earlier setup or request save has an unconfirmed outcome. Refresh workflows to reconcile its saved key. Do not create a replacement; ask a company manager for help if it stays unresolved.</p>}
    {busy && <p role="status">Checking or saving workflow setup…</p>}
    {message && <p role={failed ? 'alert' : 'status'}>{message}</p>}
    {(!form && !selected || unresolved) && <div className="wi-actions"><button type="button" className="secondary" disabled={busy} onClick={reload}>Refresh workflows</button>{data && manager && !employee && !form && !selected && <button type="button" className="primary" disabled={busy || Boolean(unresolved)} onClick={() => edit(null)}>Set up a workflow</button>}</div>}
    {data && !data.installations.length && <p>No saved workflow installations yet. {employee ? 'Ask a company manager to set up customer follow-up in Customer Setup.' : 'Create a setup and save its business outcome and bindings. Missing connections can be completed later.'}</p>}
    {data && !manager && !employee && <p>A company owner, admin, or consultant can change workflow setup. Your current role can inspect the saved configuration.</p>}
    {!form && !selected && data?.installations.map(row => <article className="wi-record" key={row.id}>
      <h3>{row.name}</h3><p>{row.outcome}</p><p><b>{row.status === 'configured' ? 'Configured · manual actions only' : 'Setup needed'}</b> · recipe v{row.recipe_version} · setup revision {row.revision}</p>
      <dl><dt>Assigned employee</dt><dd>{employeeName(row.bindings.assigned_to, workspace.people)}</dd><dt>Independent reviewer</dt><dd>{employeeName(row.bindings.reviewer_id, workspace.people)}</dd><dt>Open-request limit</dt><dd>{row.limits.max_open_requests}</dd></dl>
      <p>Saving this setup does not enable live AI. Every draft and exact email still needs the existing authorized review and send steps.</p>
      {Array.isArray(row.readiness?.reasons) && row.readiness.reasons.length > 0 && <ul aria-label="Missing workflow setup">{row.readiness.reasons.map(reason => <li key={reason}>{String(reason).replaceAll('_', ' ')}</li>)}</ul>}
      {row.status !== 'configured' && <p role="status">One or more bindings are missing or have changed. A manager must review and save current company guidance, AI configuration, Microsoft connection, and team assignments.</p>}
      {employee && row.readiness?.start_blocker && <p>Before starting: {row.readiness.start_blocker.replaceAll('_',' ')}.</p>}
      <div className="wi-actions">{manager && !employee && <button type="button" className="secondary" disabled={busy || Boolean(unresolved)} onClick={() => edit(row)}>Review setup: {row.name}</button>}{employee && canStartInstallation(row, data.actor) && <button type="button" className="primary" disabled={busy || Boolean(unresolved)} onClick={() => { setSelected(row.id); setMessage('') }}>New request: {row.name}</button>}</div>
    </article>)}
    {form && <form className="wi-form" onSubmit={save}>
      <fieldset disabled={busy}><legend>Customer follow-up · version {RECIPE_VERSION}</legend>
        {form.expected_revision > 0 && <p role="note">Saving creates a new setup revision. Requests started with an older revision remain in history but cannot progress; review or cancel them before starting replacements. Never replace a request with a pending or unknown AI or email outcome.</p>}
        <label>Workflow name<input maxLength={100} required value={form.name} onChange={e => field('name',e.target.value)}/></label>
        <label>What business result do you need?<textarea required minLength={10} maxLength={1000} value={form.outcome} onChange={e => field('outcome', e.target.value)} placeholder="For example: help the service team respond consistently to customer inquiries with a reviewed reply."/></label>
        <label>Supported recipe<select value={form.recipe_key} onChange={() => {}}><option value={RECIPE_KEY}>Customer follow-up · v1</option></select></label>
        <label>Approved company reply guidance<select value={form.bindings.context_version_id || ''} onChange={e => binding('context_version_id',e.target.value)}><option value="">Needs setup</option>{workspace.context && <option value={workspace.context.id}>{workspace.context.context?.company_name || org.name} · source version {workspace.context.version}</option>}{form.bindings.context_version_id && form.bindings.context_version_id !== workspace.context?.id && <option value={form.bindings.context_version_id}>Previously bound guidance · changed or unavailable</option>}</select></label>
        <label>Saved AI draft configuration<select value={form.bindings.configuration_id || ''} onChange={e => binding('configuration_id',e.target.value)}><option value="">Needs setup</option>{workspace.configuration?.configuration?.task === 'customer_reply' && <option value={workspace.configuration.id}>{workspace.configuration.configuration.provider} · {workspace.configuration.configuration.model}</option>}{form.bindings.configuration_id && form.bindings.configuration_id !== workspace.configuration?.id && <option value={form.bindings.configuration_id}>Previously bound AI setup · changed or unavailable</option>}</select></label>
        <label>Existing Microsoft connection<select value={form.bindings.microsoft_connection_id || ''} onChange={e => binding('microsoft_connection_id',e.target.value)}><option value="">Needs connection</option>{workspace.readiness?.microsoft_ready && <option value={workspace.readiness.microsoft_connection_id}>{workspace.readiness.microsoft_account}</option>}{form.bindings.microsoft_connection_id && form.bindings.microsoft_connection_id !== workspace.readiness?.microsoft_connection_id && <option value={form.bindings.microsoft_connection_id}>Previously bound connection · changed or unavailable</option>}</select></label>
        <label>Assigned employee<select value={form.bindings.assigned_to || ''} onChange={e => binding('assigned_to',e.target.value)}><option value="">Choose employee</option>{people.map(person => <option key={person.user_id} value={person.user_id}>{employeeName(person.user_id,people)} · {person.role}</option>)}</select></label>
        <label>Independent email reviewer<select value={form.bindings.reviewer_id || ''} onChange={e => binding('reviewer_id',e.target.value)}><option value="">Choose a different authorized reviewer</option>{managers.filter(person => person.user_id !== form.bindings.assigned_to).map(person => <option key={person.user_id} value={person.user_id}>{employeeName(person.user_id,people)} · {person.role}</option>)}</select></label>
        <label>Maximum open requests<input type="number" min={1} max={100} required value={form.limits.max_open_requests} onChange={e => field('limits',{max_open_requests: Number(e.target.value)})}/></label>
        <p>The assigned employee can request a draft when delegated drafting and company-approved AI setup are available. A separate authorized reviewer checks the draft and exact email.</p>
        <p>This limit bounds open requests created through this installation. It does not change AI spending limits. Additional Company Knowledge excerpts remain individually selected and reviewed for each draft.</p>
        <p>Manual-only controls are fixed: manager draft review, independent exact-email approval, and a separate send action. This setup does not change team roles, credentials, provider activation, or automatic actions.</p>
        <div className="wi-actions"><button type="submit" className="primary" disabled={!validInstallationForm(form)}>Save workflow setup</button><button type="button" className="secondary" onClick={close} disabled={Boolean(pending.current)}>Cancel</button></div>
      </fieldset>
    </form>}
    {selected && <form className="wi-form" onSubmit={start}><fieldset disabled={busy}><legend>New customer request</legend>{[['customer_name','Customer name',200],['customer_email','Customer email',320],['subject','Subject',200]].map(([key,label,max]) => <label key={key}>{label}<input required type={key==='customer_email'?'email':'text'} maxLength={max} value={intake[key]} onChange={e => setIntake({...intake,[key]:e.target.value})}/></label>)}<label>Customer request<textarea required maxLength={6000} value={intake.message} onChange={e => setIntake({...intake,message:e.target.value})}/></label><label className="wi-check"><input type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)}/>I checked these business details and they are appropriate to save in this company workspace.</label><p>This saves an assigned request using the current installation revision. The assigned employee can request the draft later when the approved workflow and AI setup are ready.</p><div className="wi-actions"><button type="submit" className="primary" disabled={!checked}>Save assigned request</button><button type="button" className="secondary" onClick={close} disabled={Boolean(pending.current)}>Cancel</button></div></fieldset></form>}
    {!employee && !form && !selected && <div className="wi-actions"><Link section="Customer Follow-up" onGo={onGo}>Open employee customer workspace</Link><Link section="AI Setup" onGo={onGo}>AI setup</Link><Link section="Integrations" onGo={onGo}>Connections</Link><Link section="Team Access" onGo={onGo}>Team & Roles</Link></div>}
  </section>
}
