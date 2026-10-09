import React from 'react'
import { KNOWLEDGE_SELECTION_LIMIT, formatTime } from './customer-reply-model'

export function KnowledgeSourcePreview({ source }) {
  return <div className="cr-knowledge-source">
    <h4>{source.title} · version {source.version}</h4>
    <p className="cr-muted">{source.source_kind === 'text_upload' ? 'Manually uploaded text file' : 'Manually entered text'} · {source.source_name} · Company-wide</p>
    <p className="cr-preserve">{source.content_text}</p>
    <p className="cr-muted">Review due: {formatTime(source.review_due_at)}</p>
    <details><summary>Exact saved excerpt identity</summary><dl className="cr-source-identity">
      <div><dt>Citation</dt><dd>{source.source_id}</dd></div>
      <div><dt>Document</dt><dd>{source.document_id}</dd></div>
      <div><dt>Version</dt><dd>{source.version_id}</dd></div>
      <div><dt>Excerpt</dt><dd>{source.chunk_id}</dd></div>
      <div><dt>Excerpt SHA-256</dt><dd>{source.content_sha256}</dd></div>
      <div><dt>Version SHA-256</dt><dd>{source.version_sha256}</dd></div>
    </dl></details>
  </div>
}

export default function CustomerKnowledgeSources({ workflow, state, enabled, disabled, onQuery, onAction }) {
  const snapshots = workflow.knowledge_sources || []
  const blocked = disabled || Boolean(state.pending)
  return <section aria-label="Company Knowledge excerpts">
    <h3>Company Knowledge excerpts</h3>
    <p>Optional: choose up to five current company-wide excerpts for a new draft. These are manually saved or uploaded text, with no automatic document sync or background search.</p>
    {workflow.knowledge_stale ? <p className="cr-notice cr-error" role="alert">A saved Company Knowledge source changed, expired, was archived, or is no longer accessible. Its excerpts and draft are hidden. Generation, draft acceptance, queuing, approval, and sending are blocked. Cancel this request and create a new one to review current sources.</p> : snapshots.length > 0 ? <div aria-label="Pinned Company Knowledge sources"><p>Saved with this AI request. Citations use these exact versions and excerpts.</p>{snapshots.map(source => <KnowledgeSourcePreview key={source.source_id} source={source}/>)}</div> : workflow.ai_request_key && <p className="cr-muted">This saved AI request has no Company Knowledge excerpts.</p>}
    {enabled && <div className="cr-knowledge-picker">
      <p className="cr-muted">Only the excerpts you explicitly select are included. Zero selections uses the saved request and company reply context.</p>
      <form aria-label="Search Company Knowledge" onSubmit={event => { event.preventDefault(); if (!blocked) onAction('search') }}>
        <label>Search current company-wide knowledge<input value={state.query} minLength={2} maxLength={200} disabled={blocked} onChange={event => onQuery(event.target.value)}/></label>
        <div className="cr-actions"><button type="submit" className="secondary" disabled={blocked || state.query.trim().length < 2 || state.query.trim().length > 200}>Search excerpts</button><button type="button" className="secondary" disabled={disabled} onClick={() => onAction('clear')}>Clear source selection</button></div>
      </form>
      {state.pending && <p role="status">Checking current source access…</p>}
      {state.searched && !state.pending && !state.results.length && <p role="status">No current company-wide excerpts matched this search.</p>}
      {state.results.length > 0 && <ul className="cr-knowledge-results" aria-label="Knowledge search results">{state.results.map(source => <li key={source.source_id}><div><b>{source.title}</b><p className="cr-muted">Version {source.version} · {source.source_kind === 'text_upload' ? 'Manual text upload' : 'Manual text'} · {source.source_name}</p></div><button type="button" className="secondary" disabled={blocked} onClick={() => onAction('preview', source)}>Review excerpt from {source.title}</button></li>)}</ul>}
      {state.preview && <section aria-label="Knowledge excerpt preview"><KnowledgeSourcePreview source={state.preview}/><button type="button" className="secondary" disabled={blocked || state.selected.length >= KNOWLEDGE_SELECTION_LIMIT || state.selected.some(source => source.source_id === state.preview.source_id)} onClick={() => onAction('select', state.preview)}>Select this excerpt</button></section>}
      <div aria-label="Selected Company Knowledge excerpts"><h4>Selected for new draft: {state.selected.length} of {KNOWLEDGE_SELECTION_LIMIT}</h4>{state.selected.map(source => <div key={source.source_id}><KnowledgeSourcePreview source={source}/><button type="button" className="secondary" disabled={blocked} onClick={() => onAction('remove', source)}>Remove excerpt from {source.title}</button></div>)}</div>
    </div>}
  </section>
}
