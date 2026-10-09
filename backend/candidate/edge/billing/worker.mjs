import { BillingError } from './core.mjs';

// Only these reviewed codes may enter durable queue/audit records. Never store exception
// messages, stacks, HTTP bodies, credentials, customer data, or arbitrary error.code values.
const safeCodes = new Set([
  'provider_inactive', 'provider_binding_mismatch', 'provider_version_unsupported',
  'provider_identity_mismatch', 'provider_response_invalid', 'provider_pagination_incomplete',
  'provider_page_limit', 'provider_request_limit', 'provider_timeout', 'provider_unavailable',
  'provider_rate_limited', 'provider_not_found', 'provider_graph_ambiguous',
  'provider_graph_unsupported', 'provider_snapshot_changed', 'provider_payment_evidence_unavailable',
  'provider_refund_evidence_incomplete', 'provider_binding_conflict', 'provider_binding_unconfigured',
  'reconciliation_revision_conflict', 'stale_reconciliation', 'terminal_subscription_cannot_reactivate',
  'invalid_subscription_snapshot', 'unsupported_subscription_items', 'invalid_subscription_period',
  'invalid_subscription_date', 'invalid_payment_evidence', 'refund_reconciliation_incomplete',
  'invalid_refund_evidence', 'invalid_resolution', 'resolution_lineage_conflict',
  'resolution_replay_conflict', 'projection_binding_conflict', 'unresolved_lineage',
  'waiting_customer_binding', 'worker_source_missing', 'worker_source_conflict',
  'worker_provider_result_invalid', 'worker_clock_invalid', 'worker_lease_lost', 'worker_configuration_invalid',
  'worker_unexpected_error',
]);
export const safeWorkerErrorCode = error => error instanceof BillingError && safeCodes.has(error.code)
  ? error.code : 'worker_unexpected_error';
const fail = code => { throw new BillingError(code, 503); };
const integer = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= min && v <= max;
export function workerTime(clock) {
  if (typeof clock !== 'function') fail('worker_clock_invalid');
  const now = clock();
  if (!integer(now)) fail('worker_clock_invalid');
  return now;
}
export function retryDelay(attempt, base, maximum) {
  return Math.min(maximum, base * 2 ** Math.min(30, Math.max(0, attempt - 1)));
}

// One explicitly invoked, bounded pass. Default inactivity is checked before even clock,
// configuration, store, or provider access. No background loop or runtime activation here.
// refreshAfterSeconds is an explicit operational freshness setting, never billing policy.
export async function runOnce({ enabled = false, store, provider, clock, maxJobs = 10,
  leaseSeconds = 60, refreshAfterSeconds = null, retryBaseSeconds = 5, retryMaxSeconds = 3600, bindingId = null } = {}) {
  if (enabled !== true) return { status: 503, code: 'billing_inactive' };
  if (!integer(maxJobs, 1, 100) || !integer(leaseSeconds, 1, 3600)
    || (refreshAfterSeconds !== null && !integer(refreshAfterSeconds, 1))
    || !integer(retryBaseSeconds, 1, 86400) || !integer(retryMaxSeconds, retryBaseSeconds, 86400)
    || (bindingId !== null && (typeof bindingId !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(bindingId)))
    || !store || typeof provider?.readSubscription !== 'function' || typeof provider?.resolveReceipt !== 'function') fail('worker_configuration_invalid');
  let lastTime = workerTime(clock);
  const monotonicClock = () => {
    const now = workerTime(clock);
    if (now < lastTime) fail('worker_clock_invalid');
    lastTime = now;
    return now;
  };
  const report = { status: 200, code: 'billing_worker_run', discovered: 0, claimed: 0,
    completed: 0, superseded: 0, retried: 0, lease_lost: 0, errors: [] };
  try {
    report.discovered = await store.discover({ now: monotonicClock(), limit: maxJobs, refreshAfterSeconds, bindingId });
    const attempted = [];
    for (let i = 0; i < maxJobs; i++) {
      const job = await store.claim({ now: monotonicClock(), leaseSeconds, excludeJobIds: attempted, bindingId });
      if (!job) break;
      attempted.push(job.id);
      report.claimed++;
      try {
        const source = await store.load(job, { now: monotonicClock() });
        let result;
        if (source.superseded) result = { superseded: true };
        else if (source.resolved) result = { resolved: true };
        else if (job.kind === 'reconcile_subscription') {
          result = { input: await provider.readSubscription(source.projection) };
        } else {
          result = { resolution: await provider.resolveReceipt(source.receipt) };
        }
        const outcome = await store.complete(job, result, { clock: monotonicClock });
        report[outcome.state]++;
      } catch (error) {
        const code = safeWorkerErrorCode(error);
        if (code === 'worker_lease_lost') {
          report.lease_lost++;
          report.errors.push(code);
          continue;
        }
        const outcome = await store.fail(job, { now: monotonicClock(), clock: monotonicClock, code,
          delaySeconds: retryDelay(Number(job.attempts), retryBaseSeconds, retryMaxSeconds) });
        report[outcome.state]++;
        report.errors.push(code);
      }
    }
    return report;
  } catch (error) {
    // A failed store operation is not a successful pass. Previously committed jobs remain
    // durable; an uncommitted claim/failure rolls back or recovers through its lease.
    throw new BillingError(safeWorkerErrorCode(error), 503);
  }
}
