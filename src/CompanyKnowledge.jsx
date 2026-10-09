import React, { useEffect, useRef, useState } from 'react'
import { KNOWLEDGE_MAX_BYTES, defaultKnowledgeDraft, knowledgeAudience, knowledgeBytes, knowledgeError, knowledgeKey, knowledgeRequest, readKnowledgeFile } from './company-knowledge-client'
import './company-knowledge.css'

// Key the entire workspace, not just its requests. A company/account switch can
// never paint the previous company's source text while a new load is pending.
export default function CompanyKnowledgeWorkspace(props) {
  if (!props.org?.id || !props.session?.user?.id) return <section className="panel"><h2>Company Knowledge</h2><p>Sign in and select a company to continue.</p></section>
  return <KnowledgeBody key={`${props.org.id}:${props.session.user.id}`} {...props}/>
}
function KnowledgeBody({ org, session, client, onDirtyChange, onBusyChange }) {
  const actor = session.user.id
  const [access, setAccess] = useState(null), [documents, setDocuments] = useState([])
  const [busy, setBusy] = useState(''), [feedback, setFeedback] = useState(null), [fileBusy, setFileBusy] = useState(false)
  const [editor, setEditor] = useState(null), [draft, setDraft] = useState(defaultKnowledgeDraft)
  const [detail, setDetail] = useState(null), [confirmation, setConfirmation] = useState(null)
  const [query, setQuery] = useState(''), [results, setResults] = useState(null), [source, setSource] = useState(null)
  const [retry, setRetry] = useState(null), [needsRefresh, setNeedsRefresh] = useState(false)
  const operation = useRef(null), generation = useRef(0), mounted = useRef(true), fileGeneration = useRef(0)
  const dialog = useRef(null), editorTitle = useRef(null)
  const dirty = Boolean(editor)
  const managed = access?.can_manage === true
  const blocked = Boolean(busy || fileBusy || retry || needsRefresh || !access)
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false) }, [dirty, onDirtyChange])
  useEffect(() => { onBusyChange?.(Boolean(busy || fileBusy)); return () => onBusyChange?.(false) }, [busy, fileBusy, onBusyChange])
  useEffect(() => { mounted.current = true; refresh(); return () => { mounted.current = false; generation.current++; fileGeneration.current++; operation.current?.controller.abort() } }, [])
  useEffect(() => { if (editor) editorTitle.current?.focus() }, [editor])
  useEffect(() => {
    if (!confirmation) return
    const previous = document.activeElement, element = dialog.current
    if (typeof element?.showModal === 'function') element.showModal(); else element?.setAttribute('open', '')
    element?.querySelector('button')?.focus()
    return () => { if (typeof element?.close === 'function') element.close(); if (previous?.isConnected) previous.focus() }
  }, [confirmation])
  const current = ticket => mounted.current && ticket === generation.current
  function clearRestricted() { setDocuments([]); setDetail(null); setResults(null); setSource(null); setAccess(null); setEditor(null); setDraft(defaultKnowledgeDraft()); setConfirmation(null); fileGeneration.current++ }
  function acceptAccess(data) {
    // A successful response can reveal a role change as well as a denial. Drop
    // all older manager-only titles, history, and editor text in the same render.
    if (access?.actor_role && access.actor_role !== data.actor_role) {
      setDocuments([]); setDetail(null); setResults(null); setSource(null)
      setEditor(null); setDraft(defaultKnowledgeDraft()); setConfirmation(null)
      fileGeneration.current++; setFileBusy(false); setNeedsRefresh(true)
      setFeedback({ text: 'Your company role changed. Refresh knowledge to load your current source library.' })
    }
    setAccess(data)
  }
  function cancelRead() {
    if (operation.current?.mutation) return
    generation.current++; operation.current?.controller.abort(); operation.current = null; setBusy('')
  }
  async function run(label, task, mutation = false) {
    if (operation.current) return
    const ticket = ++generation.current, controller = new AbortController()
    operation.current = { controller, mutation }; setBusy(label); setFeedback(null)
    const request = (op, payload) => knowledgeRequest(client, org.id, actor, op, payload, controller.signal)
    try { await task(request, ticket) }
    catch (error) {
      if (current(ticket)) {
        if (['42501', 'P0002'].includes(error.code)) { clearRestricted(); setRetry(null); setNeedsRefresh(true) }
        setFeedback({ error: true, text: knowledgeError(error) })
      }
    } finally { if (current(ticket)) { operation.current = null; setBusy('') } }
  }
  function refresh() {
    if (retry || editor || operation.current) return
    return run('refresh', async (request, ticket) => {
      clearRestricted()
      const verified = await request('access')
      if (verified.contract !== 'company-knowledge-v1' || verified.ai_connected !== false) throw new Error('Unsupported contract')
      const list = await request('list')
      if (!Array.isArray(list.documents)) throw new Error('Invalid list')
      if (current(ticket)) { acceptAccess(list); setDocuments(list.documents); setNeedsRefresh(false); setFeedback(null) }
    })
  }
  function openDocument(documentId, versionId) {
    if (blocked || editor) return
    setSource(null)
    return run('open', async (request, ticket) => {
      const data = await request('get', { document_id: documentId, ...(versionId ? { version_id: versionId } : {}) })
      if (!data.document || !data.version || data.document.organization_id !== org.id || data.version.organization_id !== org.id || data.document.id !== documentId || data.version.document_id !== documentId || (versionId && data.version.id !== versionId)) throw new Error('Unverified source')
      if (current(ticket)) { acceptAccess(data); setDetail(data) }
    })
  }
  function startEdit(value = null) {
    if (!managed || blocked || editor) return
    setSource(null); setFeedback(null)
    setEditor(value ? { document_id: value.document.id, expected_revision: value.document.revision, previous_status: value.document.status } : { expected_revision: 0 })
    const v = value?.version
    setDraft(v ? { title: v.title, content_text: v.content_text, audience: v.audience, source_kind: v.source_kind, source_name: v.source_name, review_due_at: v.review_due_at.slice(0, 10) } : defaultKnowledgeDraft())
  }
  function closeEditor() { fileGeneration.current++; setFileBusy(false); setEditor(null); setDraft(defaultKnowledgeDraft()); setFeedback(null); setConfirmation(null) }
  async function importFile(event) {
    const file = event.target.files?.[0]; event.target.value = ''
    if (!file || blocked) return
    const ticket = ++fileGeneration.current; setFileBusy(true)
    try { const imported = await readKnowledgeFile(file); if (mounted.current && ticket === fileGeneration.current) { setDraft(value => ({ ...value, ...imported, title: value.title || file.name.replace(/\.(txt|md|markdown)$/i, '') })); setFeedback({ text: 'Text loaded locally. Review it before saving a company draft.' }) } }
    catch (error) { if (mounted.current && ticket === fileGeneration.current) setFeedback({ error: true, text: error.message }) }
    finally { if (mounted.current && ticket === fileGeneration.current) setFileBusy(false) }
  }
  function updateDraft(field, value) { fileGeneration.current++; setDraft(old => ({ ...old, [field]: value, ...(field === 'content_text' ? { source_kind: 'manual', source_name: 'Edited text' } : {}) })) }
  function saveDraft(event) {
    event.preventDefault()
    if (!editor || blocked || !managed || knowledgeBytes(draft.content_text) > KNOWLEDGE_MAX_BYTES || !draft.content_text.trim()) return
    return mutate('save', { ...editor, previous_status: undefined, ...draft, review_due_at: `${draft.review_due_at}T23:59:59.000Z`, request_key: knowledgeKey() })
  }
  function mutate(op, payload, isRetry = false) {
    if (operation.current || (!isRetry && blocked) || !managed) return
    // Keep exactly this body/key until the server confirms or explicitly rejects
    // it. A transport timeout never creates a replacement mutation or new key.
    const clean = Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined))
    setConfirmation(null)
    return run(op, async (request, ticket) => {
      try {
        const result = await request(op, clean)
        if (result.operation !== op || result.request_key !== clean.request_key || (clean.document_id && result.document_id !== clean.document_id) || !result.version_id || !Number.isInteger(result.revision) || !['draft', 'published', 'archived'].includes(result.status)) throw new Error('Unverified change')
        if (!current(ticket)) return
        setRetry(null); setEditor(null); setDraft(defaultKnowledgeDraft()); setDetail(null); setResults(null); setSource(null); fileGeneration.current++
        // Confirmed writes are never retried just because the subsequent list fails.
        try {
          const list = await request('list'); if (!Array.isArray(list.documents)) throw new Error('Invalid list')
          if (current(ticket)) { acceptAccess(list); setDocuments(list.documents); setNeedsRefresh(false); setFeedback({ text: op === 'save' ? 'Draft saved. Publish this version when its text, audience, and review date are ready.' : op === 'publish' ? 'This version is published for its selected company audience.' : 'Source archived. It is excluded from search; version history is retained.' }) }
        } catch (error) {
          if (current(ticket)) { clearRestricted(); setNeedsRefresh(true); setFeedback({ error: true, text: 'The change was saved, but the latest source list could not be loaded. Refresh to continue.' }) }
        }
      } catch (error) {
        if (current(ticket)) {
          if (['40001', '42501', 'P0002', '22023'].includes(error.code)) { setRetry(null); setNeedsRefresh(true); setEditor(null); setDraft(defaultKnowledgeDraft()); setDetail(null); fileGeneration.current++ }
          else setRetry({ operation: op, payload: clean })
        }
        throw error
      }
    }, true)
  }
  function search(event) {
    event.preventDefault()
    if (blocked || query.trim().length < 2) return
    setSource(null); setResults(null)
    return run('search', async (request, ticket) => {
      const data = await request('search', { query: query.trim(), limit: 10 })
      if (!Array.isArray(data.results)) throw new Error('Invalid search')
      if (current(ticket)) { acceptAccess(data); setResults(data.results) }
    })
  }
  function preview(item) {
    if (blocked) return
    setSource(null)
    return run('preview', async (request, ticket) => {
      const data = await request('source', { document_id: item.document_id, version_id: item.version_id, chunk_id: item.chunk_id })
      if (data.source?.source_id !== item.source_id || data.source?.content_sha256 !== item.content_sha256) throw new Error('Source changed')
      if (current(ticket)) { acceptAccess(data); setSource(data.source) }
    })
  }
  const selectedCurrent = detail?.version.id === detail?.document.current_version_id
  const readableDate = value => new Date(value).toLocaleDateString(undefined, { timeZone: 'UTC' })
  return <div className="company-knowledge">
    <section className="panel knowledge-intro" aria-labelledby="knowledge-heading"><div><p className="eyebrow">COMPANY KNOWLEDGE</p><h2 id="knowledge-heading">A source of truth for {org.name}</h2><p>Save company text, choose its audience, and publish a reviewed version for your team to find.</p></div><button type="button" className="secondary" disabled={Boolean(busy || retry || editor)} onClick={refresh}>Refresh knowledge</button><p className="knowledge-note">Text and Markdown only, up to 32 KiB per source. Keyword search and plain-text previews are available here. These sources are not yet connected to AI drafts. No PDF, OCR, website fetching, or external sync.</p></section>
    {!access && <section className="panel knowledge-notice" role={busy === 'refresh' ? 'status' : 'alert'}>{busy === 'refresh' ? 'Checking company knowledge access…' : 'Company Knowledge is unavailable until its security contract and service are installed and your membership is verified.'}</section>}
    {['refresh', 'open'].includes(busy) && <button type="button" className="secondary" onClick={cancelRead}>Cancel loading</button>}
    {feedback && <p className={`knowledge-feedback ${feedback.error ? 'knowledge-error' : ''}`} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
    {retry && <section className="panel knowledge-notice"><p>The outcome is unknown. Editing is paused to avoid duplicate versions. Retry checks the same saved request.</p><button type="button" className="primary" disabled={Boolean(busy)} onClick={() => mutate(retry.operation, retry.payload, true)}>Retry same request</button></section>}
    {needsRefresh && !retry && <p className="knowledge-note">Refresh knowledge before making further changes.</p>}
    {access && !managed && <p className="knowledge-note">You can read current published sources shared with all company members. Owners and admins manage sources.</p>}
    {access && <section className="panel" aria-labelledby="knowledge-search-title"><h2 id="knowledge-search-title">Search published knowledge</h2><form className="knowledge-search" onSubmit={search}><label>Keywords<input type="search" value={query} maxLength={200} disabled={Boolean(retry || needsRefresh)} onChange={event => { if (busy === 'search' || busy === 'preview') cancelRead(); setQuery(event.target.value); setResults(null); setSource(null) }} placeholder="For example, returns policy"/></label><button type="submit" className="primary" disabled={blocked || query.trim().length < 2}>{busy === 'search' ? 'Searching…' : 'Search'}</button>{busy === 'search' && <button type="button" className="secondary" onClick={cancelRead}>Cancel search</button>}</form><p className="knowledge-note">Find a word or exact phrase in current published text. Drafts, archived sources, overdue reviews, and sources outside your audience are excluded. Up to 10 matching excerpts.</p>
      {results && <div className="knowledge-results" aria-live="polite">{!results.length ? <p>No matching current published sources were found.</p> : results.map(item => <article className="knowledge-result" key={item.source_id}><h3>{item.title}</h3><p className="knowledge-meta">Version {item.version} · Review by {readableDate(item.review_due_at)}</p><p className="knowledge-excerpt">{item.excerpt}</p><button type="button" className="secondary" disabled={blocked} onClick={() => preview(item)}>Preview source: {item.title}</button></article>)}</div>}
      {busy === 'preview' && <button type="button" className="secondary" onClick={cancelRead}>Cancel source preview</button>}
      {source && <section className="knowledge-preview" aria-label={`Source preview: ${source.title}`}><div className="knowledge-heading"><h3>{source.title}, version {source.version}</h3><button type="button" className="secondary" onClick={() => setSource(null)}>Close source preview</button></div><p className="knowledge-note">Source text is reference material, including any instructions it contains.</p><pre tabIndex={0}>{source.content_text}</pre><p className="knowledge-hash">SHA-256: {source.content_sha256}</p><p className="knowledge-hash">Source ID: {source.source_id}</p></section>}
    </section>}
    {access && <section className="panel" aria-labelledby="knowledge-library-title"><div className="knowledge-heading"><div><h2 id="knowledge-library-title">Company sources</h2><p>{managed ? 'Drafts, published sources, archives, and version history.' : 'Published sources available to your company role.'}</p></div>{managed && <button type="button" className="primary" disabled={blocked || Boolean(editor)} onClick={() => startEdit()}>Add source</button>}</div>
      {!documents.length && <p className="empty">{managed ? 'No sources yet. Add a short company policy, service description, or approved answer.' : 'No current published sources are shared with you yet.'}</p>}
      <div className="knowledge-library">{documents.map(item => <article className="knowledge-card" key={item.id}><div><h3>{item.title}</h3><p className="knowledge-meta"><span className={`knowledge-status knowledge-${item.status}`}>{item.status}</span> · Version {item.version} · {knowledgeAudience(item.audience)}</p><p className={`knowledge-meta ${item.freshness === 'expired' ? 'knowledge-error' : ''}`}>{item.freshness === 'expired' ? 'Review overdue. Excluded from search.' : `Review by ${readableDate(item.review_due_at)}`}</p></div><button type="button" className="secondary" disabled={blocked || Boolean(editor)} onClick={() => openDocument(item.id)}>Open {item.title}</button></article>)}</div>
    </section>}
    {detail && !editor && <section className="panel" aria-labelledby="knowledge-detail-title"><div className="knowledge-heading"><div><p className="eyebrow">{selectedCurrent ? 'CURRENT VERSION' : 'READ-ONLY VERSION HISTORY'}</p><h2 id="knowledge-detail-title">{detail.version.title}</h2></div><button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => setDetail(null)}>Close document</button></div><p className="knowledge-meta">Version {detail.version.version} · {knowledgeAudience(detail.version.audience)} · Review by {readableDate(detail.version.review_due_at)}</p><pre className="knowledge-text" tabIndex={0}>{detail.version.content_text}</pre><p className="knowledge-hash">SHA-256: {detail.version.content_sha256}</p>
      {managed && <><div className="knowledge-actions">{selectedCurrent && <button type="button" className="secondary" disabled={blocked} onClick={() => startEdit(detail)}>Create new draft version</button>}{selectedCurrent && detail.document.status === 'draft' && <button type="button" className="primary" disabled={blocked || Date.parse(detail.version.review_due_at) <= Date.now()} onClick={() => setConfirmation({ type: 'publish', detail })}>Publish version {detail.version.version}</button>}{selectedCurrent && detail.document.status !== 'archived' && <button type="button" className="secondary" disabled={blocked} onClick={() => setConfirmation({ type: 'archive', detail })}>Archive source</button>}</div><details><summary>Version history ({detail.versions.length})</summary><ul className="knowledge-versions">{detail.versions.map(item => <li key={item.id}><button type="button" className="secondary" disabled={blocked || item.id === detail.version.id} onClick={() => openDocument(detail.document.id, item.id)}>View version {item.version}</button><span>{item.title} · {readableDate(item.created_at)}</span></li>)}</ul></details></>}
    </section>}
    {editor && managed && <section className="panel knowledge-editor" aria-labelledby="knowledge-editor-title"><h2 id="knowledge-editor-title">{editor.document_id ? 'Create a new draft version' : 'Add a company source'}</h2><p>Saving creates an immutable version. Publish is a separate step. Company admins only is the default audience.</p>{editor.previous_status === 'published' && <p className="knowledge-notice">Saving a new draft removes the previous published version from search until you publish again.</p>}<form onSubmit={saveDraft}>
      <label>Source title<input ref={editorTitle} value={draft.title} maxLength={160} disabled={blocked} required onChange={event => updateDraft('title', event.target.value)}/></label>
      <label>Import a text or Markdown file<input type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" disabled={blocked} onChange={importFile}/></label>
      {fileBusy && <p role="status">Reading text locally…</p>}
      <label>Source text<textarea rows={12} value={draft.content_text} disabled={blocked} required onChange={event => updateDraft('content_text', event.target.value)} aria-describedby="knowledge-text-bounds"/></label><p id="knowledge-text-bounds" className={knowledgeBytes(draft.content_text) > KNOWLEDGE_MAX_BYTES ? 'knowledge-error' : 'knowledge-note'}>{knowledgeBytes(draft.content_text).toLocaleString()} / 32,768 UTF-8 bytes · {draft.source_name}. Text is displayed literally; instructions and links inside it are not executed.</p>
      <div className="knowledge-fields"><label>Published audience<select value={draft.audience} disabled={blocked} onChange={event => updateDraft('audience', event.target.value)}><option value="private">Company admins only</option><option value="organization">All company members</option></select></label><label>Review by (UTC)<input type="date" value={draft.review_due_at} min={new Date(Date.now()+86400000).toISOString().slice(0,10)} max={new Date(Date.now()+365*86400000).toISOString().slice(0,10)} required disabled={blocked} onChange={event => updateDraft('review_due_at', event.target.value)}/></label></div><p className="knowledge-note">All company members includes current Owners, Admins, Consultants, Employees, and Viewers. Drafts and version history remain visible only to Owners and Admins. Overdue sources are excluded from search.</p>
      <div className="knowledge-actions"><button type="submit" className="primary" disabled={blocked || !draft.title.trim() || !draft.content_text.trim() || knowledgeBytes(draft.content_text) > KNOWLEDGE_MAX_BYTES}>{busy === 'save' ? 'Saving…' : 'Save draft'}</button><button type="button" className="secondary" disabled={Boolean(busy || retry)} onClick={() => setConfirmation({ type: 'discard' })}>Cancel editing</button></div>
    </form></section>}
    {confirmation && <dialog ref={dialog} className="panel knowledge-dialog" role="alertdialog" aria-modal="true" aria-labelledby="knowledge-confirm-title" aria-describedby="knowledge-confirm-body" onCancel={event => { event.preventDefault(); setConfirmation(null) }} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); setConfirmation(null) }
      if (event.key === 'Tab') { const buttons = [...event.currentTarget.querySelectorAll('button:not(:disabled)')], first = buttons[0], last = buttons.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() } }
    }}><h2 id="knowledge-confirm-title">{confirmation.type === 'discard' ? 'Discard unsaved editing?' : confirmation.type === 'publish' ? 'Publish this exact version?' : 'Archive this source?'}</h2><p id="knowledge-confirm-body">{confirmation.type === 'discard' ? 'Your unsaved text and file import will be discarded. Saved versions stay in the library.' : confirmation.type === 'publish' ? `Version ${confirmation.detail.version.version} of “${confirmation.detail.version.title}” will become searchable for ${knowledgeAudience(confirmation.detail.version.audience).toLowerCase()} until its review date.` : 'This source will stop appearing in search. Its immutable versions will remain available to company owners and admins.'}</p><div className="knowledge-actions"><button type="button" className="secondary" onClick={() => setConfirmation(null)}>Go back</button><button type="button" className="primary" onClick={() => { if (confirmation.type === 'discard') closeEditor(); else { const d = confirmation.detail; mutate(confirmation.type, { document_id: d.document.id, version_id: d.version.id, expected_revision: d.document.revision, request_key: knowledgeKey() }) } }}>{confirmation.type === 'discard' ? 'Discard editing' : confirmation.type === 'publish' ? 'Publish this version' : 'Archive source'}</button></div></dialog>}
  </div>
}
