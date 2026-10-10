import React, { useEffect, useRef, useState } from 'react'
import { billingMetricLabel, canViewBillingStatus, validateBillingStatus } from './billing-status-model'
import BillingSandboxRun from './BillingSandboxRun'
import './billing-status.css'

export default function BillingStatus(props) {
  const actor = props.session?.user?.id
  if (!props.org?.id || !actor) return <section className="panel billing-status"><h2>Billing status</h2><p>Sign in and select a company to continue.</p></section>
  const role = props.members?.find(member => member.user_id === actor)?.role
  if (!canViewBillingStatus(role)) return <section className="panel billing-status"><h2>Billing access restricted</h2><p>Only this company’s owners and admins can view billing status.</p></section>
  // A company/account/role change discards the complete previous snapshot before
  // paint, even when this component is used without the App's key.
  return <BillingStatusBody key={`${props.org.id}:${actor}:${role}`} {...props}/>
}

function BillingStatusBody({ org, session, client }) {
  const [state, setState] = useState({ status: 'loading', snapshot: null })
  const request = useRef(0), mounted = useRef(false), inFlight = useRef(false)
  const actor = session.user.id
  const context = `${org.id}:${actor}`
  const live = useRef({ context, client })
  live.current = { context, client }
  const current = ticket => mounted.current && request.current === ticket && live.current.context === context && live.current.client === client

  async function refresh() {
    if (inFlight.current) return
    inFlight.current = true
    const ticket = ++request.current
    // A refresh reauthorizes access. Do not retain a privileged snapshot while
    // permission, deployment compatibility, or the next result is unknown.
    setState({ status: 'loading', snapshot: null })
    try {
      const { data, error } = await client.functions.invoke('billing-status', { body: { organization_id: org.id } })
      if (!current(ticket)) return
      if (error) throw new Error('Billing status unavailable.')
      const snapshot = validateBillingStatus(data, org.id, actor)
      setState({ status: 'ready', snapshot })
    } catch {
      if (current(ticket)) setState({ status: 'unavailable', snapshot: null })
    } finally {
      if (current(ticket)) inFlight.current = false
    }
  }
  useEffect(() => {
    mounted.current = true
    inFlight.current = false
    refresh()
    return () => { mounted.current = false; request.current++; inFlight.current = false }
  }, [context, client])

  const snapshot = state.snapshot
  return <div className="billing-status" aria-busy={state.status === 'loading'}>
    <section className="panel billing-intro" aria-labelledby="billing-status-title">
      <div><p className="eyebrow">BILLING STATUS</p><h2 id="billing-status-title">Billing status for {org.name}</h2><p>Saved configuration and observed usage for this company.</p></div>
      <button type="button" className="secondary" disabled={state.status === 'loading'} onClick={refresh}>Refresh billing status</button>
    </section>
    {state.status === 'loading' && <p role="status">Checking authorized billing status…</p>}
    {state.status === 'unavailable' && <section className="panel" aria-labelledby="billing-unavailable-title"><h3 id="billing-unavailable-title">Billing status unavailable</h3><p role="alert">The billing backend or your access could not be verified. No configuration, usage totals, or charges are confirmed. Refresh to try again.</p></section>}
    {snapshot && <>
      <BillingSandboxRun snapshot={snapshot} session={session} client={client}/>
      <section className="panel" aria-labelledby="billing-inactive-title">
        <div className="billing-inactive"><h3 id="billing-inactive-title">Billing remains inactive</h3><p>Commercial actions are disabled. Recorded bindings, subscriptions, and policy versions do not establish approval to charge customers.</p></div>
        <dl className="billing-facts">
          <div><dt>Integration state</dt><dd>{snapshot.integration_state === 'bound_inactive' ? 'Bound, inactive' : 'Not configured'}</dd></div>
          <div><dt>Company customer mapping</dt><dd>{snapshot.customer_bound ? 'Recorded' : 'Not configured'}</dd></div>
          <div><dt>Recorded customer mappings</dt><dd>{snapshot.binding_count}</dd></div>
          <div><dt>Provider credentials</dt><dd>Not verified</dd></div>
          <div><dt>Webhook readiness</dt><dd>Not verified</dd></div>
          <div><dt>Recorded subscriptions</dt><dd>{snapshot.subscription_count}</dd></div>
          <div><dt>Unresolved customer receipts</dt><dd>{snapshot.unresolved_receipts}</dd></div>
          <div><dt>Recorded policy versions</dt><dd>{snapshot.policy_versions}</dd></div>
          <div><dt>Customer charges</dt><dd>Not calculated</dd></div>
        </dl>
        <p className="billing-muted">Receipt counts cover customer-linked records only. Provider-wide holds and status still require operations review.</p>
        {snapshot.binding_count > 1 && <p className="billing-inactive">Multiple recorded bindings; review required. No single provider account is selected.</p>}
        {snapshot.provider && <div className="billing-provider"><h3>Recorded provider binding</h3><dl className="billing-facts">
          <div><dt>Account</dt><dd>{snapshot.provider.account_id}</dd></div>
          <div><dt>Provider mode</dt><dd>{snapshot.provider.livemode ? 'Live account binding; billing inactive' : 'Test account binding; billing inactive'}</dd></div>
          <div><dt>API version</dt><dd>{snapshot.provider.api_version}</dd></div>
        </dl></div>}
      </section>
      <section className="panel" aria-labelledby="billing-prerequisites-title">
        <h3 id="billing-prerequisites-title">Configuration prerequisites</h3>
        <p>Any future billing activation requires a reviewed provider and company mapping, approved commercial policies, and a separately authorized operational rollout.</p>
        <ul><li>Verify the provider account, mode, API version, and company customer mapping.</li><li>Review products, pricing, entitlements, usage allowances, and who pays provider costs.</li><li>Resolve outstanding receipts and verify operational readiness before authorizing activation.</li></ul>
        <p className="billing-muted">This status view does not verify those approvals or activate billing.</p>
      </section>
      <section className="panel" aria-labelledby="billing-usage-title">
        <h3 id="billing-usage-title">Observed usage</h3>
        <p>Lifetime recorded observations only. These are not billing-period totals, billable charges, or provider costs. Missing or unresolved source usage is not treated as zero.</p>
        {snapshot.usage.length ? <div className="billing-table-wrap" role="region" aria-label="Observed usage details" tabIndex={0}><table>
          <caption>Recorded usage by metric and unit</caption>
          <thead><tr><th scope="col">Metric</th><th scope="col">Unit</th><th scope="col">Measured units</th><th scope="col">Unresolved sources</th></tr></thead>
          <tbody>{snapshot.usage.map(item => <tr key={`${item.metric}:${item.unit}`}><th scope="row">{billingMetricLabel(item.metric)}</th><td>{item.unit}</td><td>{item.measured_units}</td><td>{item.unresolved_sources}</td></tr>)}</tbody>
        </table></div> : <p className="billing-empty">No usage observations are recorded. This does not establish zero usage.</p>}
        <p className="billing-muted">Phone-leg observations can overlap and must not be added together as a customer charge.</p>
      </section>
    </>}
  </div>
}
