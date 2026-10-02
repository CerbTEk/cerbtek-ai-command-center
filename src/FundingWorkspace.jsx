import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, LockKeyhole, Plus, RefreshCw } from 'lucide-react'
import { supabase } from './supabase'
import { CATEGORIES, DEADLINES, FUNDING_COLUMNS, FUNDING_TABLE, MAX_LENGTHS, READINESS, STATUSES, VENTURES, canManageFunding, deadlineLabel, emptyOpportunity, filterOpportunities, officialUrl, opportunityPayload, validateOpportunity } from './funding-model'
import './investment.css'

// No funding records are bundled in public assets or persisted in browser storage.
export function FundingWorkspace({ session, staff, client = supabase, onDirtyChange }) {
  const allowed = canManageFunding(staff, session?.user?.id)
  if (!allowed) return <section className="panel" role="alert"><h2>Internal access only</h2><p>The funding workspace is limited to active CerbTek platform administrators.</p></section>
  return <FundingTracker key={session.user.id} client={client} onDirtyChange={onDirtyChange}/>
}
function FundingTracker({ client, onDirtyChange }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editor, setEditor] = useState(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('All')
  const [venture, setVenture] = useState('All')
  const alive = useRef(true)
  const request = useRef(0)
  useEffect(() => { alive.current = true; load(); return () => { alive.current = false; request.current += 1 } }, [])
  async function load() {
    const current = ++request.current
    setLoading(true); setError('')
    try {
      const response = await client.from(FUNDING_TABLE).select(FUNDING_COLUMNS).order('updated_at', { ascending: false }).limit(500)
      if (!alive.current || current !== request.current) return
      if (response.error) throw response.error
      setRows(response.data || [])
    } catch {
      if (!alive.current || current !== request.current) return
      setRows([])
      setError('Funding records could not be loaded. The private tracker may not be enabled yet, or your access may have changed. Ask a platform administrator to check setup, then retry.')
    } finally { if (alive.current && current === request.current) setLoading(false) }
  }
  const filtered = useMemo(() => filterOpportunities(rows, query, status, venture), [rows, query, status, venture])
  function saved(record) {
    setRows(previous => [record, ...previous.filter(x => x.id !== record.id)])
    setEditor(null); setNotice('Opportunity saved to the private CerbTek funding workspace.')
  }
  return <div className="funding-workspace">
    <section className="panel funding-intro"><div className="panel-head"><div><p className="eyebrow">CERBTEK LLC · INTERNAL</p><h2><LockKeyhole size={20}/> Funding opportunities</h2></div><a className="secondary" href={`${import.meta.env.BASE_URL}investors/`} target="_blank" rel="noopener noreferrer">Public investor page <ArrowUpRight size={15}/></a></div><p>Track research, readiness and next steps. This company-wide pipeline is separate from client organizations and is available only to active platform administrators.</p><div className="funding-caution"><b>One legal company, coordinated applications.</b> CerbTek AI Enablement and ForgeCIF are tracked as distinct ventures here. Check program rules at the CerbTek LLC level before applying. For example, NC IDEA permits one MICRO-or-SEED application per company per cycle. A listing is not a funding commitment or confirmation of eligibility.</div></section>
    {notice && <p className="message" role="status">{notice}</p>}
    {editor ? <OpportunityEditor key={editor.id} initial={editor} client={client} onDirtyChange={onDirtyChange} onSaved={saved} onCancel={() => setEditor(null)}/> : <>
      <div className="funding-toolbar"><label>Search<input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Opportunity, provider, owner…"/></label><label>Status<select value={status} onChange={e => setStatus(e.target.value)}><option>All</option>{STATUSES.map(x => <option key={x}>{x}</option>)}</select></label><label>Venture<select value={venture} onChange={e => setVenture(e.target.value)}><option>All</option>{VENTURES.map(x => <option key={x}>{x}</option>)}</select></label><button className="secondary" onClick={load} disabled={loading}><RefreshCw size={15}/> Refresh</button><button className="primary" disabled={loading || Boolean(error)} onClick={() => { setNotice(''); setEditor(emptyOpportunity(crypto.randomUUID())) }}><Plus size={16}/> Add opportunity</button></div>
      {loading ? <p role="status">Loading private funding records…</p> : error ? <p className="message" role="alert">{error}</p> : <>
        <p className="funding-count">{filtered.length} of {rows.length} opportunities{rows.length === 500 ? ' · showing the 500 most recently updated records' : ''}</p>
        {!filtered.length ? <div className="panel funding-empty"><h3>{rows.length ? 'No matching opportunities' : 'Build a researched pipeline'}</h3><p>{rows.length ? 'Try a different search or filter.' : 'Add an official-source opportunity, record eligibility gaps and assign the next action. No opportunities have been saved yet.'}</p></div> : <div className="funding-cards">{filtered.map(row => <OpportunityCard key={row.id} row={row} onEdit={() => { setNotice(''); setEditor({ ...emptyOpportunity(row.id), ...row }) }}/>)}</div>}
      </>}
    </>}
  </div>
}
function OpportunityCard({ row, onEdit }) {
  const url = officialUrl(row.official_url)
  return <article className="panel funding-card"><div className="panel-head"><span className="funding-tag">{row.category}</span><span className="funding-status">{row.status}</span></div><h3>{row.opportunity}</h3><p className="funding-provider">{row.provider} · {row.venture}</p><dl><div><dt>Readiness</dt><dd>{row.readiness}</dd></div><div><dt>Deadline</dt><dd>{deadlineLabel(row)}{row.deadline_note && <small>{row.deadline_note}</small>}</dd></div><div><dt>Amount & terms</dt><dd>{row.amount_terms || 'Not verified'}</dd></div><div><dt>Next action</dt><dd>{row.next_action || 'Assign a next step'}</dd></div><div><dt>Owner</dt><dd>{row.owner || 'Unassigned'}</dd></div><div><dt>Last verified</dt><dd>{row.last_verified || 'Not yet verified'}</dd></div></dl><div className="funding-card-actions"><button className="secondary" onClick={onEdit}>Review / edit</button>{url && <a href={url} target="_blank" rel="noopener noreferrer">Official source <ArrowUpRight size={14}/></a>}</div></article>
}
function OpportunityEditor({ initial, client, onSaved, onCancel, onDirtyChange }) {
  const [draft, setDraft] = useState(initial)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [discard, setDiscard] = useState(false)
  const busy = useRef(false)
  const mounted = useRef(true)
  const heading = useRef(null)
  const dirty = JSON.stringify(initial) !== JSON.stringify(draft)
  useEffect(() => { onDirtyChange?.(dirty || saving); return () => onDirtyChange?.(false) }, [dirty, saving, onDirtyChange])
  useEffect(() => { heading.current?.focus(); return () => { mounted.current = false } }, [])
  useEffect(() => {
    function warn(e) { if (dirty || busy.current) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  function field(key, value) { setDraft(d => ({ ...d, [key]: value })); setDiscard(false) }
  async function save(e) {
    e.preventDefault()
    if (busy.current) return
    const problem = validateOpportunity(draft)
    if (problem) { setError(problem); return }
    busy.current = true; setSaving(true); setError('')
    try {
      const table = client.from(FUNDING_TABLE)
      const write = initial.version ? table.update(opportunityPayload(draft)).eq('id', initial.id).eq('version', initial.version) : table.insert({ id: initial.id, ...opportunityPayload(draft) })
      const response = await write.select(FUNDING_COLUMNS).maybeSingle()
      if (response.error) throw response.error
      if (!response.data) throw new Error('conflict')
      if (mounted.current) onSaved(response.data)
    } catch (caught) {
      if (mounted.current) setError(caught.message === 'conflict' ? 'This record changed or your access changed. Your draft is still here. Copy your edits, cancel, then refresh before trying again.' : 'We could not confirm this save. Your draft is still here. Check the connection and refresh the list before retrying; the record may already have been saved.')
    } finally { busy.current = false; if (mounted.current) setSaving(false) }
  }
  function text(key, title, multi = false) { return <label className={multi ? 'funding-span' : ''}>{title}{multi ? <textarea value={draft[key] || ''} onChange={e => field(key, e.target.value)} maxLength={MAX_LENGTHS[key]}/> : <input value={draft[key] || ''} onChange={e => field(key, e.target.value)} maxLength={MAX_LENGTHS[key]} required={['opportunity', 'provider', 'official_url'].includes(key)} type={key === 'official_url' ? 'url' : 'text'}/>}</label> }
  function select(key, title, values) { return <label>{title}<select value={draft[key]} onChange={e => field(key, e.target.value)}>{values.map(x => <option key={x}>{x}</option>)}</select></label> }
  return <section className="panel"><h2 ref={heading} tabIndex={-1}>{initial.version ? 'Review opportunity' : 'Add opportunity'}</h2><p>Use official sources. Leave unverified information blank; don’t treat maximum awards or credits as committed funding. No application or outreach is sent from this tracker.</p><form onSubmit={save} className="funding-form"><fieldset disabled={saving}><legend className="sr-only">Opportunity details</legend>
    {text('opportunity', 'Opportunity *')}{text('provider', 'Provider *')}{select('venture', 'Venture', VENTURES)}{select('category', 'Category', CATEGORIES)}{text('official_url', 'Official HTTPS source *')}{text('owner', 'Owner')}{text('fit', 'Why this may fit', true)}{text('eligibility', 'Eligibility requirements & evidence gaps', true)}{select('readiness', 'Readiness', READINESS)}{select('status', 'Pipeline status', STATUSES)}{select('deadline_state', 'Deadline status', DEADLINES)}<label>Deadline date<input type="date" value={draft.deadline_date || ''} disabled={!['Fixed', 'Closed'].includes(draft.deadline_state)} required={draft.deadline_state === 'Fixed'} onChange={e => field('deadline_date', e.target.value)}/></label>{text('deadline_note', 'Deadline details, time & time zone', true)}{text('amount_terms', 'Amount, instrument & terms (if verified)', true)}{text('next_action', 'Next action', true)}<label>Last source verification<input type="date" value={draft.last_verified || ''} max={new Date().toISOString().slice(0,10)} onChange={e => field('last_verified', e.target.value)}/></label>{text('notes', 'Internal notes', true)}
    </fieldset>{error && <p role="alert" className="message">{error}</p>}{discard && <div className="message" role="alert"><p>Discard your unsaved changes?</p><div className="funding-card-actions"><button className="secondary" type="button" onClick={onCancel}>Discard changes</button><button className="secondary" type="button" onClick={() => setDiscard(false)}>Keep editing</button></div></div>}<div className="funding-form-actions"><button className="primary" disabled={saving}>{saving ? 'Saving…' : 'Save opportunity'}</button><button type="button" className="secondary" disabled={saving} onClick={() => dirty ? setDiscard(true) : onCancel()}>Cancel</button></div></form></section>
}

