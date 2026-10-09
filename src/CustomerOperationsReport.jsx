import React, { useEffect, useMemo, useRef, useState } from 'react'
import { buildCustomerReport } from './customer-reporting-model'
import { customerReplyError, employeeName, formatTime } from './customer-reply-model'
import CustomerRequestEvidence, { CustomerUsageSummary } from './CustomerRequestEvidence'
import './customer-reporting.css'

function selection() {
  const params = new URLSearchParams(window.location.search), days = Number(params.get('kairoCustomerDays'))
  return { id: params.get('kairoCustomerRequest'), days: [7, 30, 90].includes(days) ? days : null }
}
function BoundReport({ client, organizationId, userId }) {
  const [data, setData] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [refresh, setRefresh] = useState(0), [readAt, setReadAt] = useState(null)
  const [current, setCurrent] = useState(selection), [query, setQuery] = useState(''), [filter, setFilter] = useState('all')
  const epoch = useRef(0), heading = useRef(null), returnFocus = useRef(null), buttons = useRef(new Map())
  useEffect(() => {
    const version = ++epoch.current
    setData(null); setLoading(true); setError(''); setReadAt(null)
    async function load() {
      try {
        const result = await client.functions.invoke('customer-workflow', { body: { operation: 'load', organization_id: organizationId } })
        if (epoch.current !== version) return
        if (result.error || result.data?.ok !== true) throw new Error(result.data?.error || 'workspace_unavailable')
        buildCustomerReport(result.data, organizationId, userId)
        setData(result.data); setReadAt(new Date().toISOString())
      } catch (failure) { if (epoch.current === version) setError(customerReplyError(failure)) }
      finally { if (epoch.current === version) setLoading(false) }
    }
    load()
    return () => { epoch.current++ }
  }, [client, organizationId, userId, refresh])
  useEffect(() => { const sync = () => setCurrent(selection()); window.addEventListener('popstate', sync); return () => window.removeEventListener('popstate', sync) }, [])
  const computed = useMemo(() => {
    if (!data) return { report: null, error: '' }
    try { return { report: buildCustomerReport(data, organizationId, userId, { days: current.days, now: readAt || Date.now() }), error: '' } }
    catch (failure) { return { report: null, error: customerReplyError(failure) } }
  }, [data, organizationId, userId, current.days, readAt])
  const report = computed.report, displayError = error || computed.error
  const selected = report?.requests.find(item => item.id === current.id)
  useEffect(() => { if (selected) heading.current?.focus(); else if (!current.id && returnFocus.current) { buttons.current.get(returnFocus.current)?.focus(); returnFocus.current = null } }, [current.id, Boolean(selected)])
  function navigate(id, days = current.days) {
    const url = new URL(window.location.href)
    url.searchParams.set('kairoCompany', organizationId); url.searchParams.set('kairoReport', 'customer')
    if (id) url.searchParams.set('kairoCustomerRequest', id); else { returnFocus.current = current.id; url.searchParams.delete('kairoCustomerRequest') }
    if (days) url.searchParams.set('kairoCustomerDays', String(days)); else url.searchParams.delete('kairoCustomerDays')
    window.history.pushState({}, '', url.pathname + url.search + url.hash); setCurrent({ id, days })
  }
  const visible = (report?.requests || []).filter(item => (!query.trim() || item.workflow.subject.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) && (filter === 'all' || filter === 'attention' ? filter === 'all' || item.email.key === 'attention' || item.state.key === 'exception' : item.email.key === filter))
  return <section className="cor-report" aria-label="Customer operations report" aria-busy={loading}>
    <div className="cor-heading"><div><h2>Customer request operations</h2><p className="cor-muted">Follow saved requests through AI drafting, independent email review and provider acceptance.</p></div><button type="button" className="secondary" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Refresh request report</button></div>
    <p className="cor-muted">Up to the latest 100 requests allowed by your current company role{report?.role === 'member' ? '; employees see assigned requests only' : ''}. Counts describe this loaded sample. Customer AI usage is not attributed to generic automation runs.</p>
    {loading && <p role="status">Loading recorded customer activity…</p>}
    {displayError && <p role="alert" className="cor-warning">{displayError} Reporting counts are unavailable.</p>}
    {report && <>
      <div className="cor-toolbar"><label>Customer request period<select value={current.days || 'all'} onChange={event => navigate(null, event.target.value === 'all' ? null : Number(event.target.value))}><option value="all">All loaded requests</option><option value="7">Last 7 UTC days</option><option value="30">Last 30 UTC days</option><option value="90">Last 90 UTC days</option></select></label><label>Find a customer request<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search saved subjects"/></label><label>Recorded email outcome<select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All outcomes</option><option value="attention">Needs attention</option><option value="review">Awaiting email review</option><option value="approved">Approved · not sent</option><option value="accepted">Microsoft accepted</option></select></label></div>
      <p className="cor-muted">Updated {formatTime(readAt)}. {current.days ? 'Period filters request creation timestamps, not completion or invoice dates.' : 'No date filter is applied.'} Search and outcome filters affect the table; summary totals cover the selected period.</p>
      {report.limitReached && <p role="status" className="cor-warning">The 100-request limit was reached. Older requests may be missing even inside the selected period; these totals are not complete company totals.</p>}
      {current.days && report.undatedRequests > 0 && <p className="cor-warning">{report.undatedRequests} loaded requests have no valid creation timestamp and are excluded from this date-filtered view.</p>}
      <div className="cor-counts" aria-label="Recorded request outcomes">{[['Requests in sample', report.counts.requests], ['Microsoft accepted', report.counts.accepted], ['Awaiting email review', report.counts.awaitingReview], ['Needs attention', report.counts.attention]].map(([label, value]) => <div key={label}><strong>{value}</strong><span>{label}</span></div>)}</div>
      <p className="cor-muted">Approval, provider acceptance, email delivery and business resolution are separate milestones. Delivery and business resolution are not recorded by this workflow.</p>
      <CustomerUsageSummary report={report}/>
      <h3>Request history</h3>
      {!visible.length ? <p>{report.loadedCount ? 'No loaded requests match this view.' : 'No customer requests are recorded for your current company role. Saved requests will appear here.'}</p> : <div className="cor-table"><table><thead><tr><th scope="col">Saved request</th><th scope="col">Assigned employee</th><th scope="col">Workflow state</th><th scope="col">Email evidence</th><th scope="col">Details</th></tr></thead><tbody>{visible.map(item => <tr key={item.id}><td><strong>{item.workflow.subject}</strong><br/>{formatTime(item.workflow.created_at)}</td><td>{employeeName(item.workflow.assigned_to, data.people)}</td><td>{item.state.label}</td><td>{item.email.label}</td><td><button type="button" className="secondary" ref={button => { if (button) buttons.current.set(item.id, button); else buttons.current.delete(item.id) }} aria-label={`Inspect request: ${item.workflow.subject}`} onClick={() => navigate(item.id)}>Inspect request</button></td></tr>)}</tbody></table></div>}
      {current.id && !selected && <p role="status" className="cor-warning">This request is not available in the loaded sample or selected period. Choose all loaded requests or inspect another request.</p>}
      {selected && <section aria-label="Selected customer request"><div className="cor-heading"><h3 ref={heading} tabIndex={-1}>{selected.workflow.subject}</h3><button type="button" className="secondary" onClick={() => navigate(null)}>Close request details</button></div><CustomerRequestEvidence workflow={selected.workflow}/></section>}
    </>}
  </section>
}
export default function CustomerOperationsReport(props) {
  if (!props.organizationId || !props.userId || !props.client?.functions?.invoke) return <section className="cor-report" aria-label="Customer operations report"><h2>Customer request operations</h2><p role="status">An authenticated company connection is required to read customer activity.</p></section>
  return <BoundReport key={`${props.organizationId}:${props.userId}`} {...props}/>
}
