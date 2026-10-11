import React, { useEffect, useRef, useState } from 'react'
import { EMAIL_PROVIDERS, emailProviderName, safeAuthorizationUrl } from './company-email-model'
import { companyEmailReturn, prepareBrowserProof, saveBrowserProof, finalizationProof, markFinalizationAttempt, clearCompanyEmailReturn } from './company-email-callback'
import './company-email.css'
const isText = value => typeof value === 'string' && Boolean(value.trim())
export function verifyCompanyEmailStatus(value, organizationId) {
  if (!value || value.ok !== true || value.contract_version !== 1 || value.organization_id !== organizationId || typeof value.can_manage !== 'boolean' || !EMAIL_PROVIDERS.every(provider => typeof value.providers?.[provider]?.configured === 'boolean') || !Array.isArray(value.connections) || value.connections.length > 2 || !value.connections.every(row => isText(row.id) && /^[0-9a-f-]{36}$/i.test(row.oauth_revision) && EMAIL_PROVIDERS.includes(row.provider) && isText(row.status) && typeof row.is_own_connection === 'boolean' && typeof row.capabilities?.mail_read === 'boolean' && typeof row.capabilities?.mail_send === 'boolean' && Array.isArray(row.scopes) && row.scopes.every(isText)) || new Set(value.connections.map(row => row.provider)).size !== value.connections.length) throw new Error('email_status_unverified')
  return value
}
const defaultNavigate = url => window.location.assign(url)
export default function CompanyEmailConnections(props) {
  if (!props.org?.id || !props.session?.user?.id) return null
  return <Connections key={`${props.org.id}:${props.session.user.id}`} {...props}/>
}
function Connections({ org, session, client, onChanged, navigate = defaultNavigate }) {
  const [status, setStatus] = useState(null), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState(false)
  const [emailReturn, setEmailReturn] = useState(() => companyEmailReturn())
  const [selected, setSelected] = useState(null), [read, setRead] = useState(false), [send, setSend] = useState(false), [confirmed, setConfirmed] = useState(false), [uncertain, setUncertain] = useState(false)
  const mounted = useRef(true), lock = useRef(null), epoch = useRef(0), currentClient = useRef(client)
  currentClient.current = client
  async function call(route, body) {
    const result = await client.functions.invoke(route, { body: { organization_id: org.id, ...body } })
    if (result.error || result.data?.error || result.data?.ok === false) {
      let rejected = result.data
      if (result.error?.context instanceof Response) { try { rejected = await result.error.context.clone().json() } catch {} }
      const failure = new Error(rejected?.error || 'email_service_unavailable')
      failure.notApplied = rejected?.write_outcome === 'not_applied'
      throw failure
    }
    return result.data
  }
  async function run(action, mutation = false) {
    if (lock.current) return
    const token = { epoch: epoch.current, client }; lock.current = token; setBusy(true); setError(false); setMessage('')
    const current = () => mounted.current && lock.current === token && currentClient.current === client && epoch.current === token.epoch
    try { await action(current) } catch (failure) { if (current()) {
      setError(true)
      if (mutation && !failure.notApplied) setUncertain(true)
      setMessage(['browser_storage_required', 'browser_crypto_required', 'browser_proof_unavailable'].includes(failure.message) ? 'This browser cannot safely retain the sign-in proof. Allow session storage and use a secure, current browser before reconnecting.' : failure.message === 'provider_not_configured' || failure.message.includes('configuration') ? 'Company email sign-in is not configured on this Kairo server. Ask the platform operator to complete provider setup.' : mutation ? 'The connection change could not be confirmed. Refresh connection status before trying again. Existing workflow bindings may need review.' : 'Company email status could not be verified. Refresh to check this company’s current connections.')
    } } finally { if (current()) { lock.current = null; setBusy(false) } }
  }
  async function load() {
    await run(async current => {
      setEmailReturn(companyEmailReturn())
      setStatus(null); setSelected(null); setConfirmed(false)
      const value = verifyCompanyEmailStatus(await call('company-email-connections', { action: 'list' }), org.id)
      if (!current()) return
      const pendingReturn = companyEmailReturn()
      if (pendingReturn?.attempted && pendingReturn.organization_id === org.id && pendingReturn.actor_id === session.user.id && value.connections.some(row => row.id === pendingReturn.connection_id && row.provider === pendingReturn.provider && row.status === 'Connected')) {
        clearCompanyEmailReturn(pendingReturn.provider, pendingReturn.state); setEmailReturn(null)
        setMessage('The saved connection is now verified as connected. Review its current account and capabilities below. The earlier completion request was not repeated.')
      }
      setStatus(value); setUncertain(false); setSelected(null); setConfirmed(false)
    })
  }
  useEffect(() => { mounted.current = true; lock.current = null; setStatus(null); setSelected(null); load(); return () => { mounted.current = false; epoch.current++; lock.current = null } }, [client])
  useEffect(() => {
    const prevent = event => { if (busy) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent)
  }, [busy])
  useEffect(() => {
    if (status?.can_manage && !busy && emailReturn && !emailReturn.error && !emailReturn.attempted && emailReturn.organization_id === org.id && emailReturn.actor_id === session.user.id) finishSignIn()
  }, [status, busy, emailReturn, org.id, session.user.id])
  async function finishSignIn() {
    if (lock.current || !status?.can_manage || !emailReturn || emailReturn.error || emailReturn.attempted || emailReturn.organization_id !== org.id || emailReturn.actor_id !== session.user.id) return
    await run(async current => {
      const proof = finalizationProof(org.id, session.user.id)
      markFinalizationAttempt(proof.provider, proof.state); setEmailReturn(previous => ({ ...previous, attempted: true }))
      const value = await call('company-email-connections', { action: 'finalize', state: proof.state, browser_verifier: proof.browser_verifier, completion_secret: proof.completion_secret })
      if (!current()) return
      if (value?.ok !== true || value.connected !== true || value.organization_id !== org.id || value.provider !== proof.provider || value.connection_id !== proof.connection_id || value.state !== proof.state) throw new Error('finalization_unverified')
      clearCompanyEmailReturn(proof.provider, proof.state); setEmailReturn(null); setSelected(null); setUncertain(true)
      setMessage(`${emailProviderName(proof.provider)} sign-in completed for ${org.name || 'this company'}. Refresh connection status to review the verified account and granted capabilities.`)
      try { await onChanged?.() } catch { if (current()) setMessage('Company email sign-in is confirmed. Refresh the workspace to review its saved account and capabilities.') }
    }, true)
  }
  const canManage = status?.can_manage === true
  function choose(provider, action = 'connect') {
    if (!canManage || lock.current || uncertain || action === 'connect' && !status.providers[provider].configured) return
    setSelected({ provider, action }); setRead(false); setSend(false); setConfirmed(false); setMessage('')
  }
  async function submit(event) {
    event.preventDefault()
    if (!canManage || !selected || !confirmed || uncertain || lock.current || selected.action === 'connect' && !read && !send) return
    const row = status.connections.find(item => item.provider === selected.provider)
    await run(async current => {
      const binding = row ? { connection_id: row.id, expected_revision: row.oauth_revision } : {}
      if (selected.action === 'disconnect') {
        if (!row) return
        const value = await call('company-email-connections', { action: 'disconnect', ...binding })
        if (!current()) return
        if (value?.disconnected !== true) throw new Error('disconnect_unverified')
        setSelected(null); setUncertain(true); setMessage('Kairo disconnected this company email connection. Saved request history remains. Refresh status before connecting again. Provider account consent may remain until you revoke it with the provider.')
        try { await onChanged?.() } catch { if (current()) setMessage('Kairo disconnected this email connection. Refresh the workspace before reconnecting. Provider account consent may remain.') }
      } else {
        const browser = await prepareBrowserProof({ organizationId: org.id, actorId: session.user.id, provider: selected.provider })
        if (!current()) return
        const value = await call(`${selected.provider}-connect`, { browser_challenge: browser.challenge, intent: read && send ? 'read_send' : read ? 'read' : 'send', ...binding })
        if (!current()) return
        if (!isText(value?.connection_id) || row && value.connection_id !== row.id || !safeAuthorizationUrl(value?.authorize_url, selected.provider, value?.redirect_uri)) throw new Error('authorization_unverified')
        setUncertain(true)
        saveBrowserProof(browser.record, value)
        setUncertain(true); setMessage('Continue on the provider’s consent screen. The connection is not confirmed until you return and refresh its status.')
        navigate(value.authorize_url)
      }
    }, true)
  }
  return <section className="panel company-email" aria-label="Company email connections">
    <p className="eyebrow">COMPANY EMAIL</p><h3>Connect email for {org.name || 'this company'}</h3>
    <p>Sign in with a company Microsoft 365 or Google account through CerbTek. One connected account per provider per company is supported, using that account’s own mailbox. Shared mailboxes and personal Outlook accounts are not supported.</p>
    <p>Choose read access, send access, or both. Connecting does not import messages, generate drafts, or send email. Customer replies still require independent approval and a separate send action.</p>
    <button type="button" className="secondary" disabled={busy} onClick={load}>Refresh connection status</button>
    {busy && <p role="status">Checking company email…</p>}
    {message && <p role={error ? 'alert' : 'status'}>{message}</p>}
    {emailReturn && <div className="company-email-review" aria-label="Returned company sign-in">{emailReturn.error ? <p role="alert">{emailReturn.error === 'provider_authorization_failed' ? 'The provider did not complete email authorization. Refresh connection status and start a new company connection when ready.' : 'This sign-in return has no matching proof in this browser, or it expired. No account was connected by this return. Start a new connection from this browser.'}</p> : emailReturn.organization_id !== org.id || emailReturn.actor_id !== session.user.id ? <p role="alert">This sign-in belongs to a different company or Kairo user. Select the company and sign in as the original requester before finishing. No connection change has been applied here.</p> : <><p>Company sign-in returned from {emailProviderName(emailReturn.provider)}. Finish connecting it to <b>{org.name || 'this company'}</b> using the sign-in proof saved in this browser.</p><button type="button" className="primary" disabled={busy || !canManage || emailReturn.attempted} onClick={finishSignIn}>Finish company sign-in</button>{emailReturn.attempted && <p role="status">The earlier sign-in completion is unconfirmed. Refresh connection status to inspect the saved account. If no verified connection appears, reconnect from this browser. Do not repeat the completion request.</p>}</>}</div>}
    {status && !canManage && <p>Only a company owner, admin, or consultant can connect, reconnect, or disconnect company email.</p>}
    <div className="company-email-cards">{status && EMAIL_PROVIDERS.map(provider => {
      const row = status.connections.find(item => item.provider === provider), configured = status.providers[provider].configured
      return <article key={provider} aria-label={`${emailProviderName(provider)} connection`}><h4>{emailProviderName(provider)}</h4><p><b>{row?.status || 'Not connected'}</b></p>
        {row && <><dl><dt>Account</dt><dd>{row.account_email || row.account_name || 'Account not yet verified'}</dd><dt>Current capabilities</dt><dd>{[row.capabilities.mail_read && 'Read email', row.capabilities.mail_send && 'Send reviewed email'].filter(Boolean).join(' · ') || 'No verified email access'}</dd></dl>{row.scopes.length > 0 && <details><summary>Provider-granted permissions</summary><ul>{row.scopes.map(scope => <li key={scope}>{scope}</li>)}</ul></details>}</>}
        {!configured && <p role="status">Sign-in unavailable: the platform operator must configure this provider.</p>}
        <div className="wi-actions"><button type="button" className="primary" disabled={busy || !canManage || !configured || uncertain} onClick={() => choose(provider)}>{row ? 'Reconnect' : 'Connect'} {emailProviderName(provider)}</button>{row && !['Disconnected', 'Disabled'].includes(row.status) && <button type="button" className="secondary" disabled={busy || !canManage || uncertain} onClick={() => choose(provider, 'disconnect')}>Disconnect {emailProviderName(provider)}</button>}</div>
      </article>
    })}</div>
    {selected && status && <form className="company-email-review" onSubmit={submit} aria-label="Review company email access"><fieldset disabled={busy || uncertain}><legend>{selected.action === 'disconnect' ? 'Disconnect' : 'Connect'} {emailProviderName(selected.provider)} for {org.name || 'this company'}</legend>
      {status.connections.find(row => row.provider === selected.provider) && <p>Current account: <b>{status.connections.find(row => row.provider === selected.provider).account_email || status.connections.find(row => row.provider === selected.provider).account_name || 'Not verified'}</b></p>}
      {selected.action === 'connect' ? <><p>You’ll choose the company account on the provider’s sign-in page. CerbTek manages the app registration; no client ID, tenant ID, or secret is needed here.</p><label><input type="checkbox" checked={read} onChange={event => { setRead(event.target.checked); setConfirmed(false) }}/>Read email for manager-selected customer request intake</label><label><input type="checkbox" checked={send} onChange={event => { setSend(event.target.checked); setConfirmed(false) }}/>Send separately reviewed and approved customer replies</label>
        {read && <p role="note">Read consent covers the connected mailbox. Choosing a {selected.provider === 'google' ? 'Gmail label' : 'mail folder'} limits what Kairo imports; it does not narrow the provider’s mailbox-wide read permission. Messages are previewed and imported manually.</p>}
        {send && <p>Send permission permits Kairo to send email from this account. It does not approve any particular message. The exact provider, account, recipient, subject, and body must still be reviewed.</p>}
        <p>Access persists until disconnected or revoked. Your provider may require company administrator approval.</p>{status.connections.some(row => row.provider === selected.provider) && <p role="alert">Starting reconnection immediately invalidates the old Kairo connection, even if you cancel provider consent. Existing workflow bindings and saved approvals may need renewed review. Choose all capabilities the workflow should retain.</p>}</> : <p>Kairo will remove its saved access for this connection and block its future reads and sends. Existing workflow bindings and approvals may become stale. Saved request history and any email already accepted by the provider remain. This does not revoke the provider’s consent or undo an email.</p>}
      <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/>I authorize this {selected.action === 'disconnect' ? 'disconnection' : 'access request'} for {org.name || 'this company'}.</label>
      <div className="wi-actions"><button type="submit" className="primary" disabled={!confirmed || selected.action === 'connect' && !read && !send}>{selected.action === 'disconnect' ? 'Confirm disconnect' : 'Continue to company sign-in'}</button><button type="button" className="secondary" onClick={() => { if (!lock.current) { setSelected(null); setConfirmed(false) } }}>Cancel</button></div>
    </fieldset></form>}
  </section>
}
