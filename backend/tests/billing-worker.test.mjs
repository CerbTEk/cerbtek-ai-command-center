import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BillingError, normalizeStripeEvent } from '../candidate/edge/billing/core.mjs';
import { runOnce, retryDelay } from '../candidate/edge/billing/worker.mjs';
import { BillingWorkerStore } from '../candidate/edge/billing/worker-store.mjs';
import { database, binding, event, snapshot, now, other, reconcileInput } from './fixtures/billing-fixtures.mjs';

// These are local single-engine PostgreSQL semantic/fake-provider tests, not hosted
// multi-connection, runtime-role deployment, real Stripe or scheduler verification.
const hash = 'a'.repeat(64);
const receipt = extra => normalizeStripeEvent(event(extra), binding, hash, now);
const rows = async (db, sql, params = []) => (await db.query(sql, params)).rows;
const jobs = db => rows(db, 'SELECT * FROM kairo_billing.reconciliation_jobs ORDER BY created_at,id');
const history = db => rows(db, 'SELECT * FROM kairo_billing.reconciliation_job_history ORDER BY id');
const deny = code => error => error.code === code;
const reader = overrides => ({ readSubscription: async projection => reconcileInput({ expected_revision: projection.revision }),
  resolveReceipt: async () => ({ customer_id: 'cus_SYNTHETIC', subscription_id: 'sub_SYNTHETIC', evidence_sha256: hash }), ...overrides });
async function seeded(fn) {
  const { db, store } = await database();
  try {
    await db.exec(await readFile(new URL('../candidate/sql/billing-worker-contract.sql', import.meta.url), 'utf8'));
    return await fn({ db, billing: store, store: new BillingWorkerStore(db) });
  } finally { await db.close(); }
}
const execute = (store, overrides = {}) => {
  const clock = overrides.clock ?? (() => now);
  return runOnce({ enabled: true, store, provider: reader({ readSubscription: async projection => reconcileInput({
    expected_revision: projection.revision, fetch_started_at: clock(), fetched_at: clock() }) }), clock, ...overrides });
};
async function seedProjection(billing, id = 'SYNTHETIC') {
  await billing.recordReceipt(receipt({ id: `evt_${id}`, data: { object: snapshot({ id: `sub_${id}` }) } }));
}

test('worker is inactive before any store, provider, or clock operation', async () => {
  const forbidden = new Proxy({}, { get() { assert.fail('inactive dependency accessed'); } });
  for (const enabled of [undefined, false, 'true', 1]) assert.deepEqual(await runOnce({ enabled, store: forbidden,
    provider: forbidden, clock: () => assert.fail('inactive clock called') }), { status: 503, code: 'billing_inactive' });
  assert.deepEqual(await runOnce(), { status: 503, code: 'billing_inactive' });
});
test('run bound, lease, refresh and clock inputs reject invalid configuration before SQL', async () => {
  let accesses = 0;
  const store = new Proxy({}, { get() { accesses++; return () => {}; } });
  for (const bad of [{ maxJobs: 0 }, { maxJobs: 101 }, { maxJobs: 1.5 }, { leaseSeconds: 0 },
    { refreshAfterSeconds: 0 }, { retryBaseSeconds: 0 }, { retryBaseSeconds: 10, retryMaxSeconds: 9 }, { bindingId: {} }]) {
    await assert.rejects(() => execute(store, bad), deny('worker_configuration_invalid'));
  }
  await assert.rejects(() => execute(store, { clock: () => NaN }), deny('worker_clock_invalid'));
  assert.equal(accesses, 0);
  assert.equal(retryDelay(10000, 5, 3600), 3600);
});
test('discovery is bounded and deduplicates before LIMIT, retaining unknown and excluding ignored receipts', () => seeded(async ({ db, billing, store }) => {
  for (let i = 1; i <= 3; i++) await billing.recordReceipt(receipt({ id: `evt_UNKNOWN${i}`, data: { object: snapshot({ id: `sub_UNKNOWN${i}`, customer: 'cus_UNKNOWN' }) } }));
  await billing.recordReceipt(receipt({ id: 'evt_IGNORED', type: 'customer.updated', data: { object: { id: 'cus_SYNTHETIC', object: 'customer' } } }));
  assert.equal(await store.discover({ now, limit: 2 }), 2);
  assert.equal(await store.discover({ now, limit: 2 }), 1);
  assert.equal(await store.discover({ now, limit: 2 }), 0);
  assert.equal((await jobs(db)).length, 3);
  assert((await jobs(db)).every(job => job.kind === 'resolve_receipt' && Number(job.source_revision) === 1));
  assert.equal((await history(db)).length, 3);
}));
test('fenced reconciliation commits projection, completion, and append-only audit together', () => seeded(async ({ db, billing, store }) => {
  await seedProjection(billing);
  const result = await execute(store, { provider: reader({ readSubscription: async p => {
    assert.equal((await jobs(db))[0].state, 'leased');
    assert.equal(p.revision, 1);
    return reconcileInput();
  } }) });
  assert.deepEqual(result, { status: 200, code: 'billing_worker_run', discovered: 1, claimed: 1, completed: 1,
    superseded: 0, retried: 0, lease_lost: 0, errors: [] });
  assert.equal((await jobs(db))[0].state, 'completed');
  assert.deepEqual((await history(db)).map(x => x.event), ['enqueued', 'claimed', 'completed']);
  const projections = await rows(db, 'SELECT * FROM kairo_billing.projection_history ORDER BY revision');
  assert.equal(projections.length, 2);
  assert.equal(projections[1].projection.state, 'reconciled');
  assert.equal((await execute(store)).claimed, 0);
}));
test('runOnce never exceeds maxJobs provider reads or claims', () => seeded(async ({ db, billing, store }) => {
  for (let i = 1; i <= 4; i++) await seedProjection(billing, `BOUND${i}`);
  let calls = 0;
  const provider = reader({ readSubscription: async p => {
    calls++;
    return reconcileInput({ expected_revision: p.revision, object: snapshot({ id: p.subscription_id }), payment: { state: 'unknown' } });
  } });
  assert.equal((await execute(store, { provider, maxJobs: 2 })).completed, 2);
  assert.equal(calls, 2);
  assert.equal((await jobs(db)).length, 2);
  assert.equal((await execute(store, { provider, maxJobs: 2 })).completed, 2);
  assert.equal(calls, 4);
}));
test('explicit binding scope limits both discovery and claims with no account fallback', () => seeded(async ({ db, billing, store }) => {
  await seedProjection(billing);
  const second = { ...binding, id: 'synthetic-other-binding', account_id: 'acct_OTHER' };
  await db.query('INSERT INTO kairo_billing.provider_bindings(id,account_id,account_kind,livemode,api_version) VALUES($1,$2,$3,$4,$5)',
    [second.id, second.account_id, second.account_kind, second.livemode, second.api_version]);
  await db.query('INSERT INTO kairo_billing.customer_bindings(binding_id,customer_id,organization_id) VALUES($1,$2,$3)', [second.id, 'cus_SYNTHETIC', other]);
  await billing.recordReceipt(normalizeStripeEvent(event({ id: 'evt_SECOND' }), second, hash, now));
  assert.equal(await store.discover({ now, limit: 10, bindingId: binding.id }), 1);
  assert.equal((await jobs(db))[0].binding_id, binding.id);
  assert.equal(await store.discover({ now, limit: 10, bindingId: second.id }), 1);
  const result = await execute(store, { bindingId: binding.id });
  assert.equal(result.completed, 1);
  assert.equal(result.claimed, 1);
  assert.equal((await jobs(db)).find(job => job.binding_id === second.id).state, 'queued');
  assert.equal((await execute(store, { bindingId: 'unconfigured-binding' })).claimed, 0);
  assert.equal((await rows(db, 'SELECT projection FROM kairo_billing.subscription_projections WHERE binding_id=$1', [second.id]))[0].projection.state, 'needs_reconciliation');
}));
test('provider errors remain durable retry work with bounded exponential backoff and safe code only', () => seeded(async ({ db, billing, store }) => {
  await seedProjection(billing);
  let time = now, calls = 0;
  const options = { clock: () => time, retryBaseSeconds: 2, retryMaxSeconds: 5,
    provider: reader({ readSubscription: async () => { calls++; throw new BillingError('provider_rate_limited'); } }) };
  for (const [attempt, delay] of [[1, 2], [2, 4], [3, 5], [4, 5]]) {
    const result = await execute(store, options);
    assert.equal(result.retried, 1);
    const job = (await jobs(db))[0];
    assert.equal(Number(job.attempts), attempt);
    assert.equal(Number(job.next_attempt_at), time + delay);
    assert.equal(job.last_error_code, 'provider_rate_limited');
    assert.equal((await execute(store, options)).claimed, 0);
    time += delay;
  }
  assert.equal(calls, 4);
  assert.equal((await jobs(db)).length, 1);
  assert.equal((await rows(db, 'SELECT * FROM kairo_billing.projection_history')).length, 1);
  assert.equal((await history(db)).filter(x => x.event === 'retried').length, 4);
}));
test('untrusted error messages, bodies, and arbitrary codes are never persisted or returned', () => seeded(async ({ db, billing, store }) => {
  await seedProjection(billing);
  const secret = 'private_response_and_credential';
  const result = await execute(store, { provider: reader({ readSubscription: async () => {
    const error = new Error(secret); error.code = secret; error.body = secret; throw error;
  } }) });
  assert.deepEqual(result.errors, ['worker_unexpected_error']);
  assert(!JSON.stringify([await jobs(db), await history(db), result]).includes(secret));
}));
test('new receipt during fetch supersedes old revision and cannot be overwritten by a stale response', () => seeded(async ({ db, billing, store }) => {
  await seedProjection(billing);
  const result = await execute(store, { provider: reader({ readSubscription: async () => {
    await billing.recordReceipt(receipt({ id: 'evt_NEWER' }));
    return reconcileInput();
  } }) });
  assert.equal(result.superseded, 1);
  let projection = (await rows(db, 'SELECT projection FROM kairo_billing.subscription_projections'))[0].projection;
  assert.equal(projection.revision, 2);
  assert.equal(projection.state, 'needs_reconciliation');
  assert.equal((await execute(store)).completed, 1);
  projection = (await rows(db, 'SELECT projection FROM kairo_billing.subscription_projections'))[0].projection;
  assert.equal(projection.revision, 3);
  assert.deepEqual((await jobs(db)).map(x => x.state).sort(), ['completed', 'superseded']);
}));
test('already superseded projection work finishes without another provider read', () => seeded(async ({ db, billing, store }) => {
  await seedProjection(billing);
  await store.discover({ now, limit: 1 });
  await billing.recordReceipt(receipt({ id: 'evt_BEFORECLAIM' }));
  let calls = 0;
  const report = await execute(store, { maxJobs: 1, provider: reader({ readSubscription: async () => { calls++; return reconcileInput(); } }) });
  assert.equal(report.superseded, 1);
  assert.equal(calls, 0);
}));
test('expired leases recover with higher fence; stale completion and stale failure cannot mutate replacement', () => seeded(async ({ db, billing, store }) => {
  await seedProjection(billing);
  await store.discover({ now, limit: 1 });
  const first = await store.claim({ now, leaseSeconds: 2 });
  assert.equal(await store.claim({ now: now + 1, leaseSeconds: 2 }), null);
  const second = await store.claim({ now: now + 2, leaseSeconds: 2 });
  assert.equal(second.id, first.id);
  assert.equal(second.fence, first.fence + 1);
  await assert.rejects(() => store.complete(first, { input: reconcileInput() }, { clock: () => now + 2 }), deny('worker_lease_lost'));
  assert.equal((await store.fail(first, { now: now + 2, code: 'provider_timeout', delaySeconds: 1 })).state, 'lease_lost');
  assert.equal((await jobs(db))[0].state, 'leased');
  assert.equal((await store.complete(second, { input: reconcileInput({ fetch_started_at: now + 2, fetched_at: now + 2 }) }, { clock: () => now + 2 })).state, 'completed');
  assert.deepEqual((await history(db)).map(x => x.event), ['enqueued', 'claimed', 'lease_expired', 'claimed', 'completed']);
}));
test('lease expiry during provider I/O leaves no projection mutation, then recovers on next pass', () => seeded(async ({ db, billing, store }) => {
  await seedProjection(billing);
  let time = now;
  const result = await execute(store, { leaseSeconds: 1, clock: () => time,
    provider: reader({ readSubscription: async () => { time++; return reconcileInput(); } }) });
  assert.equal(result.lease_lost, 1);
  assert.equal((await jobs(db))[0].state, 'leased');
  assert.equal((await rows(db, 'SELECT * FROM kairo_billing.projection_history')).length, 1);
  assert.equal((await execute(store, { clock: () => time })).completed, 1);
  assert.equal(Number((await jobs(db))[0].attempts), 2);
}));
test('lease expiring after reconciliation SQL rolls back projection, job completion and audit together', () => seeded(async ({ db, billing, store }) => {
  await seedProjection(billing);
  await store.discover({ now, limit: 1 });
  const job = await store.claim({ now, leaseSeconds: 2 });
  let checks = 0;
  await assert.rejects(() => store.complete(job, { input: reconcileInput() }, { clock: () => ++checks === 3 ? now + 2 : now }), deny('worker_lease_lost'));
  assert.equal((await rows(db, 'SELECT * FROM kairo_billing.projection_history')).length, 1);
  assert.equal((await jobs(db))[0].state, 'leased');
  assert.deepEqual((await history(db)).map(x => x.event), ['enqueued', 'claimed']);
}));
test('lease expiring during receipt resolution rolls back link, projection and completion atomically', () => seeded(async ({ db, billing, store }) => {
  await billing.recordReceipt(receipt({ id: 'evt_EXPIRY', type: 'refund.created', data: { object: { object: 'refund', id: 're_EXPIRY' } } }));
  await store.discover({ now, limit: 1 });
  const job = await store.claim({ now, leaseSeconds: 2 });
  let checks = 0;
  const resolution = { customer_id: 'cus_SYNTHETIC', subscription_id: 'sub_SYNTHETIC', evidence_sha256: hash };
  await assert.rejects(() => store.complete(job, { resolution }, { clock: () => ++checks === 3 ? now + 2 : now }), deny('worker_lease_lost'));
  assert.equal((await rows(db, 'SELECT * FROM kairo_billing.receipt_links')).length, 0);
  assert.equal((await rows(db, 'SELECT * FROM kairo_billing.projection_history')).length, 0);
  assert.equal((await jobs(db))[0].state, 'leased');
  assert.deepEqual((await history(db)).map(x => x.event), ['enqueued', 'claimed']);
}));
test('lease expiring during failure recording rolls back retry and failure audit', () => seeded(async ({ db, billing, store }) => {
  await seedProjection(billing);
  await store.discover({ now, limit: 1 });
  const job = await store.claim({ now, leaseSeconds: 2 });
  let checks = 0;
  assert.equal((await store.fail(job, { now, code: 'provider_timeout', delaySeconds: 5,
    clock: () => ++checks === 2 ? now + 2 : now })).state, 'lease_lost');
  assert.equal((await jobs(db))[0].state, 'leased');
  assert.deepEqual((await history(db)).map(x => x.event), ['enqueued', 'claimed']);
}));
test('a backwards clock cannot commit even when the lease would otherwise remain valid', () => seeded(async ({ db, billing, store }) => {
  await seedProjection(billing);
  await store.discover({ now, limit: 1 });
  const job = await store.claim({ now, leaseSeconds: 60 });
  let checks = 0;
  await assert.rejects(() => store.complete(job, { input: reconcileInput() }, { clock: () => ++checks === 1 ? now + 2 : now + 1 }), deny('worker_clock_invalid'));
  assert.equal((await rows(db, 'SELECT * FROM kairo_billing.projection_history')).length, 1);
  assert.equal((await jobs(db))[0].state, 'leased');
}));
test('invalid provider revision fails safely and leaves original projection pending', () => seeded(async ({ db, billing, store }) => {
  await seedProjection(billing);
  const report = await execute(store, { provider: reader({ readSubscription: async () => reconcileInput({ expected_revision: 2 }) }) });
  assert.equal(report.retried, 1);
  assert.deepEqual(report.errors, ['worker_provider_result_invalid']);
  assert.equal((await rows(db, 'SELECT * FROM kairo_billing.projection_history')).length, 1);
}));
test('future and pre-claim subscription evidence cannot freshen a matching projection revision', () => seeded(async ({ db, billing, store }) => {
  await seedProjection(billing);
  for (const [time, change] of [[now, { fetched_at: now + 1 }], [now + 5, { fetch_started_at: now, fetched_at: now + 5 }]]) {
    const report = await execute(store, { clock: () => time,
      provider: reader({ readSubscription: async () => reconcileInput(change) }) });
    assert.equal(report.retried, 1);
    assert.deepEqual(report.errors, ['stale_reconciliation']);
  }
  assert.equal((await rows(db, 'SELECT * FROM kairo_billing.projection_history')).length, 1);
}));
test('a refresh cannot replace a newer prior reconciliation using an earlier clock', () => seeded(async ({ db, billing, store }) => {
  await seedProjection(billing);
  await billing.reconcile(binding.id, 'sub_SYNTHETIC', reconcileInput({ fetch_started_at: now + 10, fetched_at: now + 10 }));
  // Simulate a differently clocked ingest/worker. Even if a new receipt requires a
  // refresh, evidence cannot move time behind the previous committed reconciliation.
  await billing.recordReceipt(receipt({ id: 'evt_CLOCKSKEW' }));
  await store.discover({ now, limit: 1 });
  const job = await store.claim({ now, leaseSeconds: 60 });
  await assert.rejects(() => store.complete(job, { input: reconcileInput({ expected_revision: 3 }) }, { clock: () => now }), deny('stale_reconciliation'));
  assert.equal((await rows(db, 'SELECT * FROM kairo_billing.projection_history')).length, 3);
}));
test('unknown receipt customer stays waiting until independently bound, then receipt resolution invalidates projection', () => seeded(async ({ db, billing, store }) => {
  await billing.recordReceipt(receipt({ id: 'evt_UNKNOWN', data: { object: snapshot({ customer: 'cus_UNKNOWN' }) } }));
  const provider = reader({ resolveReceipt: async () => ({ customer_id: 'cus_UNKNOWN', subscription_id: 'sub_SYNTHETIC', evidence_sha256: hash }) });
  const result = await execute(store, { provider });
  assert.equal(result.retried, 1);
  assert.deepEqual(result.errors, ['waiting_customer_binding']);
  assert.equal((await rows(db, 'SELECT * FROM kairo_billing.customer_bindings')).length, 1);
  assert.equal((await rows(db, 'SELECT * FROM kairo_billing.receipt_links')).length, 0);
  assert.equal((await rows(db, 'SELECT * FROM kairo_billing.subscription_projections')).length, 0);
  await db.query('INSERT INTO kairo_billing.customer_bindings(binding_id,customer_id,organization_id) VALUES($1,$2,$3)', [binding.id, 'cus_UNKNOWN', other]);
  assert.equal((await execute(store, { provider, clock: () => now + 5 })).completed, 1);
  assert.equal((await rows(db, 'SELECT * FROM kairo_billing.receipt_links')).length, 1);
  assert.equal((await rows(db, 'SELECT projection FROM kairo_billing.subscription_projections'))[0].projection.state, 'needs_reconciliation');
}));
test('resolved receipt discovered earlier completes without calling provider or reinvalidating', () => seeded(async ({ db, billing, store }) => {
  await billing.recordReceipt(receipt({ id: 'evt_REFUND', type: 'refund.created', data: { object: { object: 'refund', id: 're_ONE' } } }));
  await store.discover({ now, limit: 1 });
  await billing.resolveReceipt({ binding_id: binding.id, event_id: 'evt_REFUND', customer_id: 'cus_SYNTHETIC', subscription_id: 'sub_SYNTHETIC', evidence_sha256: hash });
  const report = await execute(store, { maxJobs: 1, provider: reader({ resolveReceipt: async () => assert.fail('already resolved') }) });
  assert.equal(report.completed, 1);
  assert.equal((await rows(db, 'SELECT * FROM kairo_billing.projection_history')).length, 1);
}));
test('verified standalone disposition clears irrelevant work without creating any customer or subscription mapping', () => seeded(async ({ db, billing, store }) => {
  await billing.recordReceipt(receipt({ id: 'evt_STANDALONE', type: 'refund.created', data: { object: { object: 'refund', id: 're_STANDALONE' } } }));
  const report = await execute(store, { provider: reader({ resolveReceipt: async () => ({ disposition: 'not_subscription', customer_id: 'cus_UNKNOWN', evidence_sha256: hash }) }) });
  assert.equal(report.completed, 1);
  assert.equal((await rows(db, 'SELECT * FROM kairo_billing.receipt_dispositions')).length, 1);
  assert.equal((await rows(db, 'SELECT * FROM kairo_billing.customer_bindings')).length, 1);
  assert.equal((await rows(db, 'SELECT * FROM kairo_billing.receipt_links')).length, 0);
  assert.equal((await rows(db, 'SELECT * FROM kairo_billing.subscription_projections')).length, 0);
  assert.equal((await execute(store)).claimed, 0);
}));
test('already disposed receipts are excluded from discovery and discovered stale work skips provider', () => seeded(async ({ db, billing, store }) => {
  for (const id of ['BEFORE', 'AFTER']) await billing.recordReceipt(receipt({ id: `evt_${id}`, type: 'refund.created', data: { object: { object: 'refund', id: `re_${id}` } } }));
  const resolve = id => billing.resolveNonSubscriptionReceipt({ binding_id: binding.id, event_id: `evt_${id}`, customer_id: 'cus_SYNTHETIC', evidence_sha256: hash });
  await resolve('BEFORE');
  assert.equal(await store.discover({ now, limit: 10 }), 1);
  await resolve('AFTER');
  assert.equal((await execute(store, { provider: reader({ resolveReceipt: async () => assert.fail('disposed receipt fetched') }) })).completed, 1);
  assert.equal((await rows(db, 'SELECT * FROM kairo_billing.receipt_dispositions')).length, 2);
  assert.equal((await jobs(db)).length, 1);
}));
test('ambiguous or unsupported provider graph is never disposed, dropped, or marked complete', () => seeded(async ({ db, billing, store }) => {
  await billing.recordReceipt(receipt({ id: 'evt_AMBIGUOUS', type: 'refund.created', data: { object: { object: 'refund', id: 're_AMBIGUOUS' } } }));
  const report = await execute(store, { provider: reader({ resolveReceipt: async () => { throw new BillingError('provider_graph_ambiguous'); } }) });
  assert.equal(report.retried, 1);
  assert.equal((await jobs(db))[0].state, 'retry');
  assert.equal((await rows(db, 'SELECT * FROM kairo_billing.receipt_dispositions')).length, 0);
  assert.equal((await rows(db, 'SELECT * FROM kairo_billing.receipt_links')).length, 0);
}));
test('reconciled projection refresh is absent by default and follows explicit caller cadence exactly', () => seeded(async ({ db, billing, store }) => {
  await seedProjection(billing);
  await execute(store);
  assert.equal(await store.discover({ now: now + 10000, limit: 1 }), 0);
  assert.equal(await store.discover({ now: now + 9, limit: 1, refreshAfterSeconds: 10 }), 0);
  assert.equal(await store.discover({ now: now + 10, limit: 1, refreshAfterSeconds: 10 }), 1);
  assert.equal(await store.discover({ now: now + 10, limit: 1, refreshAfterSeconds: 10 }), 0);
  const report = await execute(store, { clock: () => now + 10, refreshAfterSeconds: 10,
    provider: reader({ readSubscription: async p => reconcileInput({ expected_revision: p.revision, fetch_started_at: now + 10, fetched_at: now + 10 }) }) });
  assert.equal(report.completed, 1);
  assert.equal((await jobs(db)).length, 2);
  assert.equal(await store.discover({ now: now + 19, limit: 1, refreshAfterSeconds: 10 }), 0);
  assert.equal(await store.discover({ now: now + 20, limit: 1, refreshAfterSeconds: 10 }), 1);
}));
test('queue key, immutable identities and historical records cannot be overwritten or deleted', () => seeded(async ({ db, billing, store }) => {
  await seedProjection(billing); await execute(store);
  for (const sql of ["UPDATE kairo_billing.reconciliation_jobs SET subject_id='sub_CHANGED'", 'DELETE FROM kairo_billing.reconciliation_jobs',
    'TRUNCATE kairo_billing.reconciliation_jobs CASCADE', 'UPDATE kairo_billing.reconciliation_job_history SET error_code=NULL',
    'DELETE FROM kairo_billing.reconciliation_job_history', 'TRUNCATE kairo_billing.reconciliation_job_history',
    "UPDATE kairo_billing.reconciliation_jobs SET state='queued',completed_at=NULL"]) await assert.rejects(() => db.exec(sql));
  assert.equal((await jobs(db)).length, 1);
  assert.equal((await history(db)).length, 3);
}));
test('queue RLS enabled with no data role privileges or runtime grants', () => seeded(async ({ db }) => {
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await db.exec(`SET ROLE ${role}`);
    for (const table of ['reconciliation_jobs', 'reconciliation_job_history']) {
      for (const operation of ['SELECT * FROM', 'DELETE FROM', 'TRUNCATE']) await assert.rejects(() => db.exec(`${operation} kairo_billing.${table}`), e => e.code === '42501');
    }
    await db.exec('RESET ROLE');
  }
  const flags = await rows(db, "SELECT relrowsecurity FROM pg_class WHERE relnamespace='kairo_billing'::regnamespace AND relname IN ('reconciliation_jobs','reconciliation_job_history')");
  assert.equal(flags.length, 2);
  assert(flags.every(flag => flag.relrowsecurity));
}));
