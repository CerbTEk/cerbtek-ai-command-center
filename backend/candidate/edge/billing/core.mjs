// Source-only commercial foundation. No provider I/O, charges, credentials, or implicit policy.
export class BillingError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new BillingError(code, status); };
const plain = v => v && Object.getPrototypeOf(v) === Object.prototype;
const integer = (v, min = 0) => Number.isSafeInteger(v) && v >= min;
const id = v => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(v);
const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const encoder = new TextEncoder();
const sourceTime = v => { const d = v instanceof Date ? v : (typeof v === 'string' ? new Date(v) : null); return d && Number.isFinite(d.getTime()) ? d.toISOString() : null; };
const ref = v => typeof v === 'string' ? v : v?.id;
const hex = bytes => Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
export const digest = async bytes => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
export const canonical = value => JSON.stringify(sort(value));
function sort(v) {
  if (Array.isArray(v)) return v.map(sort);
  if (plain(v)) return Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])]));
  if (v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return v;
  fail('invalid_json');
}
export const fingerprint = async value => digest(encoder.encode(canonical(value)));

// Follows Stripe's published manual HMAC-SHA256 algorithm; verifies bytes before JSON decoding.
export async function verifyStripeSignature(raw, signature, secret, { now, toleranceSeconds = 300, maxBytes = 262144 } = {}) {
  if (!(raw instanceof Uint8Array) || raw.byteLength < 1 || raw.byteLength > maxBytes) fail('invalid_raw_body');
  if (!integer(now) || !integer(toleranceSeconds, 1) || toleranceSeconds > 300 || !integer(maxBytes, 1)) fail('invalid_verification_clock');
  if (typeof secret !== 'string' || secret.length < 16) fail('signing_secret_unavailable', 503);
  if (typeof signature !== 'string' || signature.length > 4096) fail('invalid_signature');
  const parts = signature.split(',').map(x => x.trim().split('='));
  const times = parts.filter(x => x[0] === 't');
  const signatures = parts.filter(x => x[0] === 'v1' && x.length === 2 && /^[a-f0-9]{64}$/.test(x[1]));
  if (times.length !== 1 || times[0].length !== 2 || !/^[0-9]{1,12}$/.test(times[0][1]) || !signatures.length) fail('invalid_signature');
  const timestamp = Number(times[0][1]);
  if (Math.abs(now - timestamp) > toleranceSeconds) fail('signature_expired');
  const prefix = encoder.encode(`${times[0][1]}.`), payload = new Uint8Array(prefix.length + raw.length);
  payload.set(prefix); payload.set(raw, prefix.length);
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  let valid = false;
  for (const [, value] of signatures) {
    const bytes = Uint8Array.from(value.match(/../g), x => parseInt(x, 16));
    valid = (await crypto.subtle.verify('HMAC', key, bytes, payload)) || valid;
  }
  if (!valid) fail('invalid_signature');
  let event;
  try { event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { fail('invalid_json'); }
  return { event, payload_sha256: await digest(raw) };
}

export function validateBinding(binding) {
  if (!plain(binding) || !id(binding.id) || !/^acct_[A-Za-z0-9]+$/.test(binding.account_id)
    || typeof binding.livemode !== 'boolean' || !['platform', 'connected'].includes(binding.account_kind)
    || typeof binding.api_version !== 'string' || !/^\d{4}-\d{2}-\d{2}\.[a-z]+$/.test(binding.api_version)) fail('provider_binding_unconfigured', 503);
  return binding;
}
const subscriptionEvents = new Set(['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.paused', 'customer.subscription.resumed']);
const invoiceEvents = new Set(['invoice.paid', 'invoice.payment_failed', 'invoice.voided', 'invoice.marked_uncollectible']);
const refundEvents = new Set(['refund.created', 'refund.updated', 'refund.failed', 'charge.refunded']);
export function normalizeStripeEvent(event, binding, payload_sha256, received_at) {
  validateBinding(binding);
  if (!plain(event) || event.object !== 'event' || !/^evt_[A-Za-z0-9]+$/.test(event.id) || !id(event.type)
    || !integer(event.created) || !integer(received_at) || !/^[a-f0-9]{64}$/.test(payload_sha256)
    || !plain(event.data?.object)) fail('invalid_event');
  if (event.livemode !== binding.livemode || event.api_version !== binding.api_version) fail('provider_mode_or_version_mismatch');
  if ((binding.account_kind === 'connected' && event.account !== binding.account_id)
    || (binding.account_kind === 'platform' && event.account != null)) fail('provider_account_mismatch');
  // Platform events omit account; the secret-to-account endpoint binding must be provisioned independently.
  const object = event.data.object;
  if ('livemode' in object && object.livemode !== binding.livemode) fail('object_mode_mismatch');
  if (!id(object.id)) fail('invalid_object');
  const result = { binding_id: binding.id, event_id: event.id, event_type: event.type,
    object_id: object.id, provider_created_at: event.created, received_at, payload_sha256,
    account_id: binding.account_id, account_kind: binding.account_kind, livemode: binding.livemode, api_version: binding.api_version,
    kind: 'ignored', customer_id: null, subscription_id: null, terminal: false };
  if (subscriptionEvents.has(event.type)) {
    if (object.object !== 'subscription' || !/^sub_/.test(object.id) || !/^cus_[A-Za-z0-9]+$/.test(ref(object.customer))) fail('invalid_subscription_event');
    Object.assign(result, { kind: 'subscription', customer_id: ref(object.customer), subscription_id: object.id, terminal: event.type === 'customer.subscription.deleted' });
  } else if (invoiceEvents.has(event.type)) {
    if (object.object !== 'invoice' || !/^cus_[A-Za-z0-9]+$/.test(ref(object.customer))) fail('invalid_invoice_event');
    // Dahlia uses parent.subscription_details.subscription; no metadata fallback.
    const sub = ref(object.parent?.subscription_details?.subscription);
    if (sub != null && !/^sub_[A-Za-z0-9]+$/.test(sub)) fail('invalid_invoice_lineage');
    Object.assign(result, { kind: sub ? 'invoice' : (object.parent === null ? 'ignored' : 'unresolved'), customer_id: ref(object.customer), subscription_id: sub ?? null });
  } else if (refundEvents.has(event.type)) {
    if (!['refund', 'charge'].includes(object.object)) fail('invalid_refund_event');
    // Charge/invoice/subscription graph resolution belongs to an independently authorized provider adapter.
    // An unresolved refund is recorded durably and suspends the customer when directly identifiable.
    Object.assign(result, { kind: 'refund', customer_id: ref(object.customer) ?? null,
      graph_object_kind: object.object, graph_object_id: object.id });
    if (result.customer_id !== null && !/^cus_[A-Za-z0-9]+$/.test(result.customer_id)) fail('invalid_customer');
  }
  return result;
}

export async function receiveStripeWebhook({ raw, signature, secret, binding, now, store, enabled = false }) {
  if (enabled !== true) return { status: 503, code: 'billing_inactive' };
  const verified = await verifyStripeSignature(raw, signature, secret, { now });
  const receipt = normalizeStripeEvent(verified.event, binding, verified.payload_sha256, now);
  return store.recordReceipt(receipt); // Must atomically record + invalidate; 2xx only after durable commit.
}

export function invalidateProjection(previous, receipt, organization_id) {
  if (!uuid(organization_id) || !receipt.subscription_id || !receipt.customer_id) fail('unresolved_lineage');
  if (previous && (previous.organization_id !== organization_id || previous.customer_id !== receipt.customer_id
    || previous.subscription_id !== receipt.subscription_id || previous.binding_id !== receipt.binding_id)) fail('projection_binding_conflict', 409);
  return { ...previous, organization_id, binding_id: receipt.binding_id, customer_id: receipt.customer_id,
    subscription_id: receipt.subscription_id, revision: (previous?.revision ?? 0) + 1,
    state: 'needs_reconciliation', terminal: Boolean(previous?.terminal || receipt.terminal),
    last_receipt_at: Math.max(previous?.last_receipt_at ?? 0, receipt.received_at),
    max_event_created_at: Math.max(previous?.max_event_created_at ?? 0, receipt.provider_created_at),
    snapshot: previous?.snapshot ?? null, reconciled_at: previous?.reconciled_at ?? null };
}

const statuses = ['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused'];
export function normalizeSubscriptionSnapshot(object, { binding, customer_id, subscription_id }) {
  validateBinding(binding);
  if (!plain(object) || object.object !== 'subscription' || object.id !== subscription_id
    || ref(object.customer) !== customer_id || object.livemode !== binding.livemode || !statuses.includes(object.status)
    || typeof object.cancel_at_period_end !== 'boolean') fail('invalid_subscription_snapshot');
  const items = object.items;
  if (!Array.isArray(items?.data) || items.has_more !== false || items.data.length !== 1) fail('unsupported_subscription_items');
  // Multi-item/composite plans are deliberately denied until an explicit mapping contract exists.
  const item = items.data[0];
  if (!id(item.price?.id) || !id(ref(item.price?.product)) || !integer(item.quantity, 1)
    || !integer(item.current_period_start) || !integer(item.current_period_end, 1) || item.current_period_start >= item.current_period_end) fail('invalid_subscription_period');
  for (const field of ['cancel_at', 'ended_at', 'trial_end']) if (object[field] != null && !integer(object[field])) fail('invalid_subscription_date');
  return { status: object.status, price_id: item.price.id, product_id: ref(item.price.product), quantity: item.quantity,
    period_start: item.current_period_start, period_end: item.current_period_end,
    cancel_at_period_end: object.cancel_at_period_end, cancel_at: object.cancel_at ?? null,
    ended_at: object.ended_at ?? null, trial_end: object.trial_end ?? null };
}

export function reconcileProjection(previous, { expected_revision, fetch_started_at, fetched_at, object, binding,
  payment, refunds, refund_graph_complete }) {
  if (!previous || previous.revision !== expected_revision) fail('reconciliation_revision_conflict', 409);
  if (!integer(fetch_started_at) || !integer(fetched_at) || fetch_started_at < previous.last_receipt_at || fetched_at < fetch_started_at) fail('stale_reconciliation', 409);
  if (binding.id !== previous.binding_id) fail('provider_binding_conflict');
  const snapshot = normalizeSubscriptionSnapshot(object, { binding, customer_id: previous.customer_id, subscription_id: previous.subscription_id });
  if (previous.terminal && !['canceled', 'incomplete_expired'].includes(snapshot.status)) fail('terminal_subscription_cannot_reactivate', 409);
  const matchesSubject = evidence => evidence.binding_id === binding.id && evidence.account_id === binding.account_id
    && evidence.livemode === binding.livemode && evidence.customer_id === previous.customer_id && evidence.subscription_id === previous.subscription_id;
  if (!plain(payment) || !['paid', 'unpaid', 'unknown'].includes(payment.state)
    || (payment.state === 'paid' && (!matchesSubject(payment) || !/^in_[A-Za-z0-9]+$/.test(payment.invoice_id) || !integer(payment.period_start) || !integer(payment.period_end, 1)
      || payment.period_start !== snapshot.period_start || payment.period_end !== snapshot.period_end))) fail('invalid_payment_evidence');
  if (refund_graph_complete !== true || !Array.isArray(refunds) || refunds.length > 1000) fail('refund_reconciliation_incomplete');
  const seen = new Set();
  for (const refund of refunds) {
    if (!plain(refund) || !matchesSubject(refund) || !/^ch_[A-Za-z0-9]+$/.test(refund.charge_id) || !/^re_[A-Za-z0-9]+$/.test(refund.id) || seen.has(refund.id) || !integer(refund.amount, 1)
      || !integer(refund.charge_amount, 1) || refund.amount > refund.charge_amount || !/^[a-z]{3}$/.test(refund.currency)
      || refund.subscription_id !== previous.subscription_id || !['succeeded', 'pending', 'failed', 'canceled', 'requires_action'].includes(refund.status)) fail('invalid_refund_evidence');
    seen.add(refund.id);
  }
  return { ...previous, revision: previous.revision + 1, state: 'reconciled', terminal: previous.terminal || ['canceled', 'incomplete_expired'].includes(snapshot.status), snapshot, payment: structuredClone(payment),
    refunds: structuredClone(refunds), reconciled_at: fetched_at };
}

// Policies are supplied as immutable approved versions. No prices, allowances or grace are inferred.
export function validatePolicy(policy) {
  if (!plain(policy) || !id(policy.id) || !integer(policy.version, 1) || policy.approved !== true
    || !id(policy.binding_id) || !id(policy.price_id) || !id(policy.product_id) || !integer(policy.quantity, 1)
    || !integer(policy.valid_from) || !integer(policy.valid_until, 1) || policy.valid_until <= policy.valid_from
    || !integer(policy.max_snapshot_age_seconds, 1) || !Array.isArray(policy.features) || !policy.features.every(id)
    || !Array.isArray(policy.allowed_statuses) || !policy.allowed_statuses.every(s => ['active', 'trialing', 'past_due'].includes(s))
    || typeof policy.require_paid_invoice !== 'boolean' || !['suspend_any', 'suspend_full', 'no_access_change'].includes(policy.refund_access)
    || !integer(policy.grace_seconds) || (policy.allowed_statuses.includes('past_due') && policy.grace_seconds === 0)
    || !plain(policy.meters) || !['unconfigured', 'customer', 'cerbtek'].includes(policy.provider_spend_owner)) fail('policy_unconfigured');
  for (const [meter, config] of Object.entries(policy.meters)) {
    if (!id(meter) || !plain(config) || !['blocked', 'unlimited', 'limited'].includes(config.mode)
      || (config.mode === 'limited' && (!integer(config.allowance) || !['block', 'record_unpriced'].includes(config.overage)))) fail('invalid_meter_policy');
  }
  return policy;
}

export function evaluateEntitlement({ organization_id, feature, projection, policy, now, enabled = false, customer_hold = true }) {
  const deny = reason => ({ allowed: false, reason, history_read_allowed_by_billing: true });
  // This grants no history authorization. The existing fresh organization membership/role remains required.
  if (enabled !== true) return deny('billing_inactive');
  if (!uuid(organization_id) || !id(feature) || !integer(now)) return deny('invalid_context');
  try { validatePolicy(policy); } catch { return deny('policy_unconfigured'); }
  if (policy.provider_spend_owner === 'unconfigured') return deny('provider_spend_owner_unconfigured');
  if (customer_hold !== false) return deny('unresolved_customer_event');
  if (!projection || projection.organization_id !== organization_id || projection.state !== 'reconciled') return deny('subscription_unverified');
  const p = projection, s = p.snapshot;
  if (p.terminal || !s || s.status === 'canceled' || s.status === 'incomplete_expired' || (s.ended_at !== null && now >= s.ended_at)) return deny('subscription_ended');
  if (policy.binding_id !== p.binding_id || policy.price_id !== s.price_id || policy.product_id !== s.product_id || policy.quantity !== s.quantity) return deny('plan_unmapped');
  if (now < policy.valid_from || now >= policy.valid_until) return deny('policy_expired');
  if (!integer(p.reconciled_at) || now < p.reconciled_at || now - p.reconciled_at > policy.max_snapshot_age_seconds) return deny('snapshot_stale');
  if (!policy.allowed_statuses.includes(s.status)) return deny('status_denied');
  if (now < s.period_start || (s.cancel_at !== null && now >= s.cancel_at)
    || (s.status === 'trialing' && (!integer(s.trial_end) || now >= s.trial_end))) return deny('subscription_expired');
  // Grace is explicit, and never extends a cancellation/trial end.
  const end = s.period_end + (s.status === 'past_due' && !s.cancel_at_period_end ? policy.grace_seconds : 0);
  if (now >= end) return deny('subscription_expired');
  if (policy.require_paid_invoice && p.payment?.state !== 'paid') return deny('payment_unverified');
  if (!Array.isArray(p.refunds) || p.refunds.some(r => ['pending', 'requires_action'].includes(r.status))) return deny('refund_unresolved');
  const successful = p.refunds.filter(r => r.status === 'succeeded');
  if (policy.refund_access === 'suspend_any' && successful.length) return deny('refund_policy_denied');
  if (policy.refund_access === 'suspend_full') {
    const totals = new Map();
    // Reconciler must supply charge identity so split partial refunds cannot evade a full-refund policy.
    for (const r of successful) {
      if (!id(r.charge_id)) return deny('refund_unresolved');
      const prior = totals.get(r.charge_id) ?? { amount: 0, charge_amount: r.charge_amount, currency: r.currency };
      if (prior.charge_amount !== r.charge_amount || prior.currency !== r.currency) return deny('refund_unresolved');
      prior.amount += r.amount; totals.set(r.charge_id, prior);
    }
    if ([...totals.values()].some(r => r.amount >= r.charge_amount)) return deny('refund_policy_denied');
  }
  if (!policy.features.includes(feature)) return deny('feature_not_entitled');
  return { allowed: true, reason: 'configured_policy', policy_id: policy.id, policy_version: policy.version, history_read_allowed_by_billing: true };
}

export function evaluateMeter({ policy, meter, used, requested }) {
  try { validatePolicy(policy); } catch { return { allowed: false, reason: 'policy_unconfigured', charge: null }; }
  if (!integer(used) || !integer(requested, 1) || !Number.isSafeInteger(used + requested)) return { allowed: false, reason: 'invalid_usage', charge: null };
  const rule = policy.meters[meter];
  if (!rule || rule.mode === 'blocked') return { allowed: false, reason: 'meter_unconfigured_or_blocked', charge: null };
  if (rule.mode === 'unlimited') return { allowed: true, reason: 'explicit_unlimited', charge: null };
  const overage = Math.max(0, used + requested - rule.allowance) - Math.max(0, used - rule.allowance);
  return { allowed: overage === 0 || rule.overage === 'record_unpriced', reason: overage ? 'overage_policy' : 'within_allowance', overage_units: overage, charge: null };
}

// Runtime adapters load persisted sources; callers never supply amounts or provider rates.
export function usageFromSource(source, kind) {
  if (!plain(source) || !uuid(source.id) || !uuid(source.organization_id)) fail('usage_source_unverified');
  const source_started_at = sourceTime(kind === 'ai_draft_run' ? source.created_at : kind === 'workflow_run' ? source.started_at : source.admitted_at);
  if (kind === 'ai_draft_run') {
    if (!['awaiting_review', 'accepted', 'rejected', 'failed', 'unknown'].includes(source.status)) fail('usage_source_unfinished');
    return ['input_tokens', 'output_tokens'].map(key => ({ organization_id: source.organization_id, source_kind: kind, source_id: source.id, source_started_at,
      metric: `ai_${key}`, unit: 'token', quantity: integer(source.usage?.[key]) ? source.usage[key] : null,
      state: integer(source.usage?.[key]) ? 'measured' : 'unknown', evidence_ref: source.id }));
  }
  if (kind === 'workflow_run') {
    // The workflow id is a trace, never a claim about chargeability or provider spend.
    return [{ organization_id: source.organization_id, source_kind: kind, source_id: source.id, source_started_at,
      metric: 'workflow_runs', unit: 'run', quantity: 1, state: 'measured', evidence_ref: source.id }];
  }
  if (kind === 'phone_call') {
    // Signed callback transport observations. Separate legs are never summed or rated.
    const terminal = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);
    return ['parent', 'child', 'dialResult'].map(leg => {
      const fact = source.state?.[leg];
      const known = terminal.has(fact?.status) && integer(fact?.duration) && fact.duration <= 999999999;
      return { organization_id: source.organization_id, source_kind: kind, source_id: source.id, source_started_at,
        metric: `phone_${leg}_reported_seconds`, unit: 'second', quantity: known ? fact.duration : null,
        state: known ? 'measured' : 'unknown', evidence_ref: `${source.id}:${leg}` };
    });
  }
  fail('unsupported_usage_source');
}
export async function collectUsage({ store, organization_id, source_kind, source_id }) {
  if (!uuid(organization_id) || !uuid(source_id)) fail('invalid_usage_identity');
  const source = await store.loadSource(organization_id, source_kind, source_id);
  if (!source || source.organization_id !== organization_id || source.id !== source_id) fail('usage_source_unverified');
  const observations = usageFromSource(source, source_kind);
  return store.recordUsage(observations);
}
