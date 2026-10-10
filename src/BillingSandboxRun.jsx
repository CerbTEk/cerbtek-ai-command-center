import React, { useEffect, useState } from 'react'
import { useSafeOperation } from './use-safe-operation'
import { canRunSandboxBilling } from './billing-worker-model'
import { BILLING_ATTEMPT_KEY, runSandboxBillingOnce, sandboxAttemptState } from './billing-worker-attempt'

export default function BillingSandboxRun({ snapshot, session, client }) {
  if (!canRunSandboxBilling(snapshot, session, globalThis.location?.origin)) return null
  return <SandboxRunBody key={`${snapshot.organization_id}:${snapshot.actor_id}`} snapshot={snapshot} client={client}/>
}

function SandboxRunBody({ snapshot, client }) {
  const scope = `${snapshot.organization_id}:${snapshot.actor_id}:billing-sandbox`
  const { busy, run } = useSafeOperation(scope)
  const [result, setResult] = useState(null)
  const [attemptState, setAttemptState] = useState(() => sandboxAttemptState())
  useEffect(() => {
    const update = event => { if (event.key === BILLING_ATTEMPT_KEY || event.key === null) setAttemptState(sandboxAttemptState()) }
    globalThis.addEventListener('storage', update)
    return () => globalThis.removeEventListener('storage', update)
  }, [])

  function invoke() {
    if (attemptState !== 'available') return
    run(async isCurrent => {
      setResult(null)
      const next = await runSandboxBillingOnce(client, { isCurrent, onClaim: () => setAttemptState('attempted') })
      if (!isCurrent()) return
      setResult(next)
      setAttemptState(sandboxAttemptState())
    })
  }

  return <section className="panel" aria-labelledby="billing-sandbox-title" aria-busy={busy}>
    <h3 id="billing-sandbox-title">Owner sandbox billing check</h3>
    <p>This sends one manual pass to the fixed QA sandbox worker, with a maximum of one job. It does not enable billing or authorize customer charges.</p>
    <button type="button" className="secondary" disabled={busy || attemptState !== 'available'} onClick={invoke}>Run one sandbox billing pass</button>
    {busy && <p role="status">Waiting for the sandbox server result. Do not run another pass.</p>}
    {result && <div role="status"><p>{result.message}</p><p>{result.httpStatus === null ? (result.code === 'client_blocked' ? 'Request blocked in this browser.' : 'Outcome unknown.') : `Server result: ${result.code} (HTTP ${result.httpStatus})`}</p>
      {result.counters && <dl className="billing-facts">
        <div><dt>Jobs discovered</dt><dd>{result.counters.discovered}</dd></div>
        <div><dt>Jobs claimed</dt><dd>{result.counters.claimed}</dd></div>
        <div><dt>Jobs completed</dt><dd>{result.counters.completed}</dd></div>
        <div><dt>Jobs superseded</dt><dd>{result.counters.superseded}</dd></div>
        <div><dt>Jobs scheduled for retry</dt><dd>{result.counters.retried}</dd></div>
        <div><dt>Lost job leases</dt><dd>{result.counters.lease_lost}</dd></div>
      </dl>}
    </div>}
    {attemptState === 'attempted' && !busy && <p>{result ? 'This browser will not send another pass for this test.' : 'This sandbox test was previously attempted in this browser. Its outcome must be reviewed before any further test.'}</p>}
    {attemptState === 'unavailable' && !busy && <p>Browser safety locking or persistent storage is unavailable. This test cannot be run here.</p>}
    {result?.retrySafe && attemptState === 'available' && !busy && <p>The server rejected this request before running a job. You can try again manually after correcting the reported issue.</p>}
  </section>
}
