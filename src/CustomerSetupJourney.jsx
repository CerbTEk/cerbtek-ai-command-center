import React, { useEffect, useRef, useState } from 'react'
import { knowledgeRequest } from './company-knowledge-client'
import { deriveCustomerSetup, verifySetupKnowledge, verifySetupWorkspace } from './customer-setup-model'
import './customer-setup.css'

function SectionLink({ section, onGo, children }) {
  return <a href={`#${encodeURIComponent(section)}`} onClick={event => { if (onGo && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); onGo(section) } }}>{children}</a>
}
export default function CustomerSetupJourney(props) {
  if (!props.org?.id || !props.session?.user?.id) return <section className="panel"><h2>Customer setup</h2><p>Sign in and choose a company to continue.</p></section>
  return <SetupBody key={`${props.session.user.id}:${props.org.id}`} {...props}/>
}
function SetupBody({ org, session, client, planning = {}, onGo }) {
  const [snapshot, setSnapshot] = useState(null), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState(false)
  const generation = useRef(0), operation = useRef(null), mounted = useRef(true)
  useEffect(() => { mounted.current = true; refresh(); return () => { mounted.current = false; generation.current++; operation.current?.abort(); operation.current = null } }, [client])
  const current = ticket => mounted.current && generation.current === ticket
  function cancel() {
    generation.current++; operation.current?.abort(); operation.current = null
    setSnapshot(null); setBusy(false); setError(false); setMessage('Check cancelled. Saved setup is unchanged. Check saved setup again when you are ready.')
  }
  async function refresh() {
    if (operation.current) return
    const controller = new AbortController(), ticket = ++generation.current
    operation.current = controller; setSnapshot(null); setBusy(true); setError(false); setMessage('')
    try {
      const result = await client.functions.invoke('customer-workflow', { body: { organization_id: org.id, operation: 'load' }, signal: controller.signal })
      if (!current(ticket)) return
      if (result.error || result.data?.error) throw new Error('setup_unavailable')
      const workspace = verifySetupWorkspace(result.data, org.id, session.user.id)
      let documents = null, knowledgeUnavailable = false
      try {
        const access = await knowledgeRequest(client, org.id, session.user.id, 'access', {}, controller.signal)
        if (!current(ticket)) return
        if (access.actor_role !== workspace.actor.role) throw new Error('setup_scope_changed')
        if (access.contract !== 'company-knowledge-v1' || access.ai_connected !== false) throw new Error('setup_unverified')
        const library = await knowledgeRequest(client, org.id, session.user.id, 'list', {}, controller.signal)
        if (!current(ticket)) return
        if (library.actor_role !== workspace.actor.role) throw new Error('setup_scope_changed')
        documents = verifySetupKnowledge(library, org.id, workspace.actor.role)
      } catch (failure) { if (!current(ticket)) return; if (failure.message === 'setup_scope_changed') throw failure; knowledgeUnavailable = true }
      if (!current(ticket)) return
      setSnapshot({ workspace, documents, knowledgeUnavailable, checkedAt: new Date().toISOString() })
      setMessage('Saved setup checked. No model request, connection change, or email was sent.')
    } catch {
      if (current(ticket)) { setError(true); setMessage('Saved setup could not be verified for this company and account. No readiness has been confirmed. Check again, or ask a company owner to review access.') }
    } finally { if (current(ticket)) { operation.current = null; setBusy(false) } }
  }
  const setup = snapshot && deriveCustomerSetup(snapshot.workspace, snapshot.documents, planning)
  return <div className="customer-setup" aria-label="Guided customer reply setup">
    <section className="panel setup-outcome" aria-labelledby="setup-outcome-title">
      <p className="eyebrow">1 · CHOOSE THE OUTCOME</p><h2 id="setup-outcome-title">Reply to a customer with a reviewed email</h2>
      <p>Save an inquiry, draft from approved company guidance, have a different authorized person review the exact email, then use a separate send action.</p>
      <p>Available in this release: manual inquiry capture, versioned reply guidance, optional selected Company Knowledge excerpts, AI draft configuration, human approval, and recorded Microsoft email outcomes. Phone intake, automatic inbox retrieval, Google or AWS connectors, and billing are not part of this setup.</p>
      <p className="setup-note">Code available → saved configuration → verified connection → live acceptance. These are separate states. This guide never activates a provider or sends a message.</p>
    </section>
    <section className="panel" aria-labelledby="setup-readiness-title">
      <p className="eyebrow">2 · CHECK CURRENT READINESS</p><h2 id="setup-readiness-title">Saved setup for {org.name}</h2>
      <p>Return here at any time. Progress is rebuilt from your saved company records, with no completion checkboxes or separate setup draft to lose.</p>
      <div className="setup-actions"><button type="button" className="primary" disabled={busy} onClick={refresh}>{snapshot ? 'Recheck saved setup' : 'Check saved setup'}</button>{busy && <button type="button" className="secondary" onClick={cancel}>Cancel check</button>}</div>
      {busy && <p role="status">Checking saved setup…</p>}
      {message && <p role={error ? 'alert' : 'status'}>{message}</p>}
      {!snapshot && !busy && <p>Configuration and activation status are unknown until the saved records can be verified.</p>}
      {snapshot && <><p className="setup-note">Checked {new Date(snapshot.checkedAt).toLocaleString()} · Current company role: {snapshot.workspace.actor.role}. This is a read-only snapshot, not a live-provider test.</p><p><b>{setup.configuredCount} of 4 setup prerequisites recorded.</b> Activation still needs review.</p><p className="setup-blocked"><b>Continue with:</b> {setup.next.detail} <SectionLink section={setup.next.section} onGo={onGo}>Open {setup.next.section === 'Team Access' ? 'Team & Roles' : setup.next.section}</SectionLink></p></>}
    </section>
    <section className="panel" aria-labelledby="setup-configure-title">
      <p className="eyebrow">3 · CONNECT AND CONFIGURE</p><h2 id="setup-configure-title">Use the existing setup screens</h2>
      {setup ? <><ol className="setup-cards">{setup.steps.map(step => <li key={step.id}><div className="setup-card-heading"><h3>{step.title}</h3><span className={step.complete ? 'setup-saved' : 'setup-needed'}>{step.status}</span></div><p>{step.detail}</p><SectionLink section={step.section} onGo={onGo}>{step.action}</SectionLink></li>)}</ol><div className="setup-optional"><h3>Optional: add reviewed company sources</h3><p>{snapshot.knowledgeUnavailable ? 'Company Knowledge status could not be verified. Open its workspace to check access and saved sources.' : setup.knowledgeCount ? `${setup.knowledgeCount} current, published company-wide source${setup.knowledgeCount === 1 ? '' : 's'} visible to your account. Each excerpt still needs explicit selection and review in Customer Follow-up.` : 'No current, published company-wide sources are visible to your account. Manual reply guidance can be used without extra excerpts.'}</p><p>Private, draft, archived, or overdue sources are not eligible for customer drafts. Nothing is retrieved or sent to a model automatically.</p><SectionLink section="Company Knowledge" onGo={onGo}>Open Company Knowledge</SectionLink></div></> : <p>Verify the saved records above to see which setup steps need attention.</p>}
      <details className="setup-planning"><summary>Company profile and readiness assessment</summary><p>These record your business context and planning. Completing them does not prove a connection or activate customer replies.</p><p>Last loaded workspace: profile {setup?.profileComplete ? 'complete' : 'not confirmed complete'}; assessment {setup?.assessmentComplete ? 'complete' : 'not confirmed complete'}.</p><div className="setup-actions"><SectionLink section="Onboarding" onGo={onGo}>Company profile</SectionLink><SectionLink section="AI Readiness" onGo={onGo}>Readiness assessment</SectionLink></div></details>
    </section>
    <section className="panel" aria-labelledby="setup-validation-title">
      <p className="eyebrow">4 · VALIDATE SAFELY</p><h2 id="setup-validation-title">Check records before testing a live workflow</h2>
      <p>The check above reads only the existing customer-workflow and Company Knowledge services. It does not refresh provider models, generate a draft, grant access, or send email.</p>
      <ol><li>Save and review approved company guidance and the customer-reply configuration in their existing screens.</li><li>Return here and recheck the saved connection and reviewer prerequisites.</li><li>Inspect any saved request with a pending or unknown outcome before deciding whether another attempt is safe.</li></ol>
      {setup?.uncertain && <p role="alert" className="setup-blocked">A visible request has an unresolved AI or email outcome. Open Customer Follow-up and inspect it. Do not generate a replacement or resend.</p>}
      {snapshot && <p>{snapshot.workspace.workflows.length} visible saved requests checked (up to {snapshot.workspace.limit || 100}). {setup.accepted} record Microsoft acceptance; acceptance does not establish delivery or overall activation. History is limited to records available to your role.</p>}
      <SectionLink section="Customer Follow-up" onGo={onGo}>Review saved customer requests</SectionLink>
    </section>
    <section className="panel" aria-labelledby="setup-activation-title">
      <p className="eyebrow">5 · REVIEW ACTIVATION REQUIREMENTS</p><h2 id="setup-activation-title">Live activation is not confirmed</h2>
      <p>This guide has no activation switch. A configured model, a saved connection, or a past email record cannot establish end-to-end live acceptance.</p>
      {setup ? <ul className="setup-blockers" aria-label="Activation blockers">{setup.blockers.map(blocker => <li key={blocker.id}>{blocker.detail}</li>)}</ul> : <p>Verify saved setup first. Live-provider availability and acceptance remain unverified.</p>}
      <p>An authorized administrator must review the organization-bound provider credential, current approved model and pricing, bounded usage limits, approved business data, and the deployed inference gate. Then a separately authorized live-provider test and exact-email approval/send acceptance are needed. Recheck current company access and source versions at each action.</p>
      <p>Saving setup never purchases a plan, starts a subscription, enables paid inference, or turns on an unattended workflow.</p>
      <div className="setup-actions"><SectionLink section="AI Setup" onGo={onGo}>Review AI setup requirements</SectionLink><SectionLink section="Customer Follow-up" onGo={onGo}>Open Customer Follow-up</SectionLink><SectionLink section="Overview" onGo={onGo}>Return to overview</SectionLink></div>
    </section>
  </div>
}
