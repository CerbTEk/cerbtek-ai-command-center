import React, { useEffect, useRef, useState } from 'react'
import { emailProviderName } from './company-email-model'
import { verifyMailboxResponse, mailboxError } from './mailbox-intake-model'
import './workflow-installations.css'

// The manager-only installation entry point owns authorization display. The
// service independently authorizes every request; this component never grants it.
export default function MailboxIntake(props) {
  const { org, session, installation } = props
  if (!org?.id || !session?.user?.id || installation?.organization_id !== org.id || !installation?.id || !Number.isSafeInteger(installation.revision) || installation.revision < 1) return <p role="alert">A verified company workflow is required for mailbox intake.</p>
  return <Intake key={`${org.id}:${session.user.id}:${installation.id}:${installation.revision}`} {...props}/>
}
function Intake({ org, client, installation, onClose, onImported, onBusyChange }) {
  const [data, setData] = useState(null), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [failed, setFailed] = useState(false)
  const [folders, setFolders] = useState(null), [folderId, setFolderId] = useState(''), [previews, setPreviews] = useState(null), [checked, setChecked] = useState({})
  const [needsReload, setNeedsReload] = useState(false), [uncertain, setUncertain] = useState(null), [now, setNow] = useState(Date.now())
  const mounted = useRef(true), lock = useRef(null), pending = useRef(null), activeClient = useRef(client), busyCallback = useRef(onBusyChange)
  activeClient.current = client; busyCallback.current = onBusyChange
  const context = { organizationId: org.id, installationId: installation.id, installationRevision: installation.revision, connectionId: installation.bindings?.email_connection_id || installation.bindings?.microsoft_connection_id, provider: data?.capabilities.provider }
  const dirty = Boolean(folderId && folderId !== data?.source?.folder_id || previews?.previews.length || uncertain)
  useEffect(() => { busyCallback.current?.(busy) }, [busy])
  useEffect(() => () => busyCallback.current?.(false), [])
  useEffect(() => {
    const protect = event => { if (busy || dirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', protect)
    return () => window.removeEventListener('beforeunload', protect)
  }, [busy, dirty])
  useEffect(() => {
    if (!previews?.previews.length) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [previews])

  async function call(operation, extra = {}, validation = {}) {
    const result = await client.functions.invoke('mailbox-intake', { body: { operation, organization_id: org.id, installation_id: installation.id, installation_revision: installation.revision, ...extra } })
    if (result.error || result.data?.ok !== true) {
      let rejection = result.data
      if (result.error?.context instanceof Response) { try { rejection = await result.error.context.clone().json() } catch { /* Unknown outcomes remain unknown. */ } }
      const error = new Error('mailbox_intake_unavailable')
      error.code = rejection?.error
      error.notApplied = rejection?.ok === false && rejection.write_outcome === 'not_applied'
      throw error
    }
    return verifyMailboxResponse(result.data, operation, { ...context, ...validation })
  }
  async function run(operation, action) {
    if (lock.current) return
    const token = { client }
    lock.current = token; setBusy(true); setFailed(false); setMessage('')
    const current = () => mounted.current && lock.current === token && activeClient.current === client
    try { await action(current) }
    catch (error) {
      if (!current()) return
      setFailed(true)
      if (operation === 'import' && pending.current && (!error.notApplied || pending.current.uncertain)) {
        pending.current = { ...pending.current, uncertain: true }; setUncertain(pending.current)
        setMessage('The import outcome is unconfirmed. Retry this same preview to safely reconcile it, or refresh intake status. Do not create a replacement request.')
      } else {
        if (operation === 'import') { pending.current = null; setUncertain(null) }
        if (operation !== 'load') setNeedsReload(true)
        if (operation === 'load') setData(null)
        setMessage(mailboxError(error) + (operation === 'save' && !error.notApplied ? ' The folder save may have completed. Refresh intake status to check its saved revision; do not repeat the save.' : ''))
      }
    } finally { if (current()) { lock.current = null; setBusy(false) } }
  }
  async function imported(receipt, current, text) {
    pending.current = null; setUncertain(null)
    setData(previous => ({ ...previous, imports: [receipt, ...previous.imports.filter(row => row.preview_id !== receipt.preview_id)].slice(0, 20) }))
    setPreviews(previous => previous ? { ...previous, previews: previous.previews.filter(row => row.id !== receipt.preview_id && row.message_id !== receipt.message_id) } : previous)
    setChecked(previous => { const next = { ...previous }; delete next[receipt.preview_id]; return next })
    setMessage(text)
    try { await onImported?.(receipt.workflow_id) }
    catch { if (current()) setMessage(`${text} The customer workspace could not be refreshed; refresh it before looking for this saved request.`) }
  }
  async function load() {
    await run('load', async current => {
      const value = await call('load')
      if (!current()) return
      setData(value); setFolderId(value.source?.folder_id || ''); setFolders(null); setNeedsReload(false)
      const receipt = pending.current && value.imports.find(row => row.preview_id === pending.current.previewId)
      if (receipt && receipt.message_id !== pending.current.messageId) throw new Error('mailbox_response_unverified')
      if (receipt) await imported(receipt, current, 'The earlier import is confirmed in the saved customer workflow. No draft was generated or email sent.')
      else if (pending.current) { setUncertain(pending.current); setMessage('No receipt for the earlier import was returned. Its outcome remains unconfirmed. Retry the same preview ID to safely reconcile it.'); setFailed(true) }
      else { setPreviews(null); setChecked({}) }
    })
  }
  useEffect(() => {
    mounted.current = true; lock.current = null; setData(null); setFolders(null); setBusy(false)
    if (pending.current) { pending.current = { ...pending.current, uncertain: true }; setUncertain(pending.current) }
    else { setPreviews(null); setChecked({}) }
    load()
    return () => { mounted.current = false; lock.current = null }
  }, [client])
  const provider = data?.capabilities.provider, providerName = emailProviderName(provider), sourceKind = provider === 'google' ? 'label' : 'folder'
  const canRead = data?.capabilities.mail_read === true && !needsReload && !uncertain
  async function listFolders() {
    if (!canRead) return
    await run('folders', async current => { const value = await call('folders'); if (current()) setFolders(value) })
  }
  async function saveFolder(event) {
    event.preventDefault()
    if (!canRead || !folders?.folders.some(row => row.id === folderId) || folderId === data.source?.folder_id) return
    const source = data.source
    await run('save', async current => {
      const value = await call('save', { expected_source_revision: source?.revision || 0, folder_id: folderId }, { mailboxId: data.capabilities.mailbox_id, sourceRevision: source?.revision || 0, folderId, sourceId: source?.id })
      if (!current()) return
      setData(previous => ({ ...previous, source: value.source })); setPreviews(null); setChecked({})
      setMessage(`Mailbox ${sourceKind} saved. Preview messages when you are ready; no messages have been imported.`)
    })
  }
  async function previewMessages() {
    if (!canRead || !data.source || folderId !== data.source.folder_id) return
    await run('preview', async current => {
      const value = await call('preview', { source_revision: data.source.revision })
      if (current()) { setPreviews({ ...value, source: { ...data.source } }); setChecked({}); setNow(Date.now()) }
    })
  }
  async function importMessage(preview, retry = false) {
    if (lock.current || !data?.source || !checked[preview.id] || !retry && (!canRead || needsReload || Date.parse(preview.expires_at) <= Date.now()) || retry && pending.current?.previewId !== preview.id) return
    const attempt = retry ? pending.current : { previewId: preview.id, messageId: preview.message_id, sourceRevision: data.source.revision }
    pending.current = attempt
    await run('import', async current => {
      const value = await call('import', { source_revision: attempt.sourceRevision, preview_id: attempt.previewId })
      if (!current()) return
      await imported({ preview_id: attempt.previewId, message_id: attempt.messageId, workflow_id: value.workflow_id }, current, value.replayed ? 'This message was already imported. Its saved customer workflow is confirmed.' : 'Message imported as an assigned customer request. No draft was generated or email sent.')
    })
  }
  function close() {
    if (lock.current || pending.current) return
    if (!dirty || window.confirm('Discard the unsaved folder selection and in-memory message previews?')) onClose?.()
  }
  return <section className="wi-panel" aria-label="Manager mailbox intake">
    <p className="eyebrow">MANAGER MAILBOX INTAKE</p><h2>Import a customer request from email</h2>
    <p><b>{installation.name}</b> · workflow setup revision {installation.revision}</p>
    <p>{provider === 'google' ? 'Choose a supported Gmail label in the connected account’s own mailbox.' : 'Choose a visible ordinary top-level folder in the connected account’s own mailbox. Shared mailboxes, nested folders, and hidden or search folders are unavailable.'}</p><p>Source selection limits application import. Provider read consent covers the mailbox; selecting a {sourceKind} does not narrow that permission.</p>
    <p>Each action is manual. There is no background sync, attachment retrieval, draft generation, or email sending. Preview text is shown only to authorized managers and temporarily stored for import; import access expires after 15 minutes.</p>
    <p>Fixed mapping: message sender name and email → customer; subject → request subject; plain-text message → customer request. Review whether the content is appropriate for this company before importing it.</p>
    {busy && <p role="status">Checking mailbox intake…</p>}
    {message && <p role={failed ? 'alert' : 'status'}>{message}</p>}
    <div className="wi-actions"><button type="button" className="secondary" disabled={busy} onClick={load}>Refresh intake status</button><button type="button" className="secondary" disabled={busy || Boolean(uncertain)} onClick={close}>Close mailbox intake</button></div>
    {data && <>
      <p>Connected {providerName} account: <b>{data.capabilities.account_name}</b>. Only its own mailbox is supported.</p>
      {!data.capabilities.mail_read && <p role="alert">{provider === 'google' ? 'Gmail read' : 'Mail.Read'} permission is missing. A company manager can review and explicitly grant read access in Connections, then refresh intake status. This screen cannot grant mailbox access.</p>}
      {data.source ? <p>Saved {sourceKind}: <b>{data.source.folder_name}</b> · source revision {data.source.revision}</p> : <p>No mailbox {sourceKind} is saved for this workflow.</p>}
      <div className="wi-actions"><button type="button" className="secondary" disabled={busy || !canRead} onClick={listFolders}>List available {sourceKind}s</button></div>
      {folders && <form className="wi-form" onSubmit={saveFolder}><fieldset disabled={busy || !canRead}><legend>Mailbox source {sourceKind}</legend>
        <label>{provider === 'google' ? 'Available Gmail label' : 'Available top-level folder'}<select value={folderId} onChange={event => { setFolderId(event.target.value); setPreviews(null); setChecked({}) }}><option value="">Choose a {sourceKind}</option>{data.source && !folders.folders.some(row => row.id === data.source.folder_id) && <option value={data.source.folder_id} disabled>Saved {sourceKind} unavailable in this list</option>}{folders.folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>
        {!folders.folders.length && <p>No supported visible {sourceKind}s were returned.</p>}
        {folders.has_more && <p>Only the first 50 supported {sourceKind}s are shown. Additional sources are outside this version’s supported selection.</p>}
        <button className="primary" type="submit" disabled={!folderId || folderId === data.source?.folder_id || !folders.folders.some(row => row.id === folderId)}>Save {sourceKind}</button>
      </fieldset></form>}
      {folderId && data.source && folderId !== data.source.folder_id && <p>Save this {sourceKind} selection before previewing messages.</p>}
      <div className="wi-actions"><button type="button" className="primary" disabled={busy || !canRead || !data.source || folderId !== data.source.folder_id} onClick={previewMessages}>Preview messages</button></div>
      {previews && <div aria-label="Message previews">
        <p>{previews.previews.length} message preview{previews.previews.length === 1 ? '' : 's'} · {previews.skipped} skipped. {previews.has_more ? 'More messages exist; this preview is limited to 10 messages.' : ''}</p>
        {!previews.previews.length && <p>No supported messages are available in this preview.</p>}
        {previews.previews.map(preview => {
          const expired = Date.parse(preview.expires_at) <= now, retry = uncertain?.previewId === preview.id
          return <article className="wi-record wi-form" key={preview.id} aria-label={`Preview: ${preview.intake.subject}`}>
            <h3>{preview.intake.subject}</h3><p>{providerName} mailbox source · {previews.source.folder_name} · source revision {previews.source.revision}</p>
            <dl><dt>Customer</dt><dd>{preview.intake.customer_name}</dd><dt>Email</dt><dd>{preview.intake.customer_email}</dd><dt>Received</dt><dd>{new Date(preview.received_at).toLocaleString()}</dd><dt>Message ID</dt><dd>{preview.message_id}</dd>{preview.thread_id && <><dt>Thread ID</dt><dd>{preview.thread_id}</dd></>}</dl>
            <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{preview.intake.message}</p>
            {preview.has_attachments && <p>Attachments are present. Their contents are not retrieved or imported.</p>}
            <p>{expired ? 'Preview expired. Preview messages again before a new import.' : `Preview expires ${new Date(preview.expires_at).toLocaleTimeString()}.`}</p>
            <label className="wi-check"><input type="checkbox" checked={Boolean(checked[preview.id])} disabled={busy || Boolean(uncertain) || expired || needsReload} onChange={event => setChecked(previous => ({ ...previous, [preview.id]: event.target.checked }))}/>I reviewed this message and confirm it is appropriate company content to save as a customer request.</label>
            <button type="button" className="primary" disabled={busy || !checked[preview.id] || (!retry && (!canRead || expired || needsReload))} onClick={() => importMessage(preview, retry)}>{retry ? 'Retry this import safely' : 'Import this message'}</button>
          </article>
        })}
      </div>}
      {data.imports.length > 0 && <div aria-label="Recent mailbox imports"><h3>Recent imports</h3><p>Saved workflow references for this manager. Original mailbox provenance remains attached to each imported request.</p><ul>{data.imports.map(receipt => <li key={receipt.preview_id}>Workflow {receipt.workflow_id} · {providerName} message {receipt.message_id}</li>)}</ul></div>}
    </>}
  </section>
}
