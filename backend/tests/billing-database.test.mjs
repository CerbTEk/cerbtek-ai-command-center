import test from 'node:test';
import assert from 'node:assert/strict';
import { createBillingDatabase } from '../candidate/edge/billing/database.mjs';
import { BillingError } from '../candidate/edge/billing/core.mjs';
import { EventEmitter } from 'node:events';

// Synthetic fake pools only. No pg dependency, client/pool construction, socket,
// credentials, database installation or hosted concurrency claims.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const denial = code => value => value.code === code && value.message === code;
function fake({ handler, connect } = {}) {
  const state = { acquisitions: 0, queries: [], releases: [] };
  const client = {
    query(text, values) {
      assert.equal(state.releases.length, 0, 'SQL was issued after client release');
      state.queries.push({ text, values });
      if (handler) { const result = handler(text, values, state); if (result !== undefined) return result; }
      return Promise.resolve({ command: text.split(' ')[0], rows: text === 'SELECT payload' ? [{ value: 'synthetic' }] : [] });
    },
    release(destroy) { state.releases.push(destroy); },
  };
  const pool = { connect() { state.acquisitions++; return connect ? connect(client) : Promise.resolve(client); } };
  const db = overrides => createBillingDatabase({ enabled: true, pool, acquisitionTimeoutMs: 30,
    queryTimeoutMs: 40, transactionTimeoutMs: 120, statementTimeoutMs: 30, lockTimeoutMs: 10, ...overrides });
  return { state, client, pool, db };
}
const texts = f => f.state.queries.map(row => row.text);

test('database adapter is dependency-free and default inactive before pool access', async () => {
  const pool = new Proxy({}, { get() { assert.fail('inactive pool accessed'); } });
  const db = createBillingDatabase({ pool });
  await assert.rejects(() => db.query('SELECT 1'), denial('database_inactive'));
  await assert.rejects(() => db.transaction(() => assert.fail()), denial('database_inactive'));
});
test('invalid time bounds or callback reject before pool acquisition', async () => {
  const f = fake();
  for (const changes of [{ queryTimeoutMs: 0 }, { acquisitionTimeoutMs: Infinity }, { transactionTimeoutMs: 20 }, { statementTimeoutMs: 50 }, { lockTimeoutMs: 31 }]) {
    await assert.rejects(() => f.db(changes).query('SELECT 1'), denial('database_configuration_invalid'));
  }
  await assert.rejects(() => f.db().transaction(null), denial('database_configuration_invalid'));
  assert.equal(f.state.acquisitions, 0);
});
test('query uses one pinned connection, explicit READ COMMITTED, local limits and confirmed commit', async () => {
  const f = fake();
  assert.deepEqual((await f.db().query('SELECT payload', [1])).rows, [{ value: 'synthetic' }]);
  assert.equal(f.state.acquisitions, 1);
  assert.deepEqual(texts(f), ['BEGIN ISOLATION LEVEL READ COMMITTED',
    "SELECT set_config('lock_timeout',$1,true), set_config('statement_timeout',$2,true), set_config('idle_in_transaction_session_timeout',$3,true)", 'SELECT payload', 'COMMIT']);
  assert.deepEqual(f.state.queries[1].values, ['10ms', '30ms', '120ms']);
  assert.deepEqual(f.state.queries[2].values, [1]);
  assert.deepEqual(f.state.releases, [false]);
});
test('all transaction statements and COMMIT share one client and post-settlement queries are closed', async () => {
  const f = fake(); let retained;
  const result = await f.db().transaction(async tx => { retained = tx; await tx.query('SELECT 1'); await tx.query('SELECT 2'); return 7; });
  assert.equal(result, 7); assert.equal(f.state.acquisitions, 1);
  await assert.rejects(() => retained.query('SELECT late'), denial('database_transaction_closed'));
  assert(!texts(f).includes('SELECT late'));
});
test('callback failures roll back and release while preserving reviewed business codes only', async () => {
  const f = fake();
  await assert.rejects(() => f.db().transaction(async tx => { await tx.query('SELECT 1'); throw new BillingError('reconciliation_revision_conflict', 409); }), denial('reconciliation_revision_conflict'));
  assert.equal(texts(f).at(-1), 'ROLLBACK'); assert.deepEqual(f.state.releases, [false]);
  const other = fake();
  await assert.rejects(() => other.db().transaction(() => { throw new Error('private-secret'); }), denial('database_callback_failed'));
  assert.equal(texts(other).at(-1), 'ROLLBACK');
});
test('query failure poisons a transaction even if callback catches it', async () => {
  const f = fake({ handler: text => text === 'SELECT fail' ? Promise.reject(new Error('private backend body')) : undefined });
  await assert.rejects(() => f.db().transaction(async tx => { try { await tx.query('SELECT fail'); } catch {} return 'not committed'; }), denial('database_query_failed'));
  assert.equal(texts(f).at(-1), 'ROLLBACK'); assert(!texts(f).includes('COMMIT')); assert.deepEqual(f.state.releases, [false]);
});
test('acquisition timeout destroys a late client without issuing SQL', async () => {
  const late = deferred(), f = fake({ connect: () => late.promise });
  await assert.rejects(() => f.db({ acquisitionTimeoutMs: 10 }).query('SELECT 1'), denial('database_acquire_timeout'));
  late.resolve(f.client); await sleep(5);
  assert.deepEqual(f.state.releases, [true]); assert.deepEqual(texts(f), []);
});
test('late acquisition rejection is contained and acquisition failures never leak error data', async () => {
  const late = deferred(), f = fake({ connect: () => late.promise });
  await assert.rejects(() => f.db({ acquisitionTimeoutMs: 10 }).query('SELECT 1'), denial('database_acquire_timeout'));
  late.reject(new Error('private host and password')); await sleep(5);
  assert.deepEqual(texts(f), []);
  const bad = fake({ connect: () => { throw new Error('private pool details'); } });
  await assert.rejects(() => bad.db().query('SELECT 1'), denial('database_acquire_failed'));
});
test('query timeout destroys uncertain connection and contains its late resolution', async () => {
  const query = deferred(), f = fake({ handler: text => text === 'SELECT slow' ? query.promise : undefined });
  await assert.rejects(() => f.db().query('SELECT slow'), denial('database_query_timeout'));
  assert.deepEqual(f.state.releases, [true]); assert(!texts(f).includes('ROLLBACK')); assert(!texts(f).includes('COMMIT'));
  const before = [...texts(f)]; query.resolve({ command: 'SELECT', rows: [] }); await sleep(5);
  assert.deepEqual(texts(f), before); assert.deepEqual(f.state.releases, [true]);
});
test('callback timeout disables late callback SQL and never sends COMMIT', async () => {
  const continuation = deferred(), f = fake(); let lateCode;
  await assert.rejects(() => f.db({ transactionTimeoutMs: 50 }).transaction(async tx => {
    await continuation.promise;
    try { await tx.query('SELECT late'); } catch (cause) { lateCode = cause.code; }
  }), denial('database_transaction_timeout'));
  assert.deepEqual(f.state.releases, [true]); continuation.resolve(); await sleep(5);
  assert.equal(lateCode, 'database_transaction_closed'); assert(!texts(f).includes('SELECT late')); assert(!texts(f).includes('COMMIT'));
});
test('COMMIT timeout is unknown, never a claimed rollback, and late success cannot change the outcome', async () => {
  const commit = deferred(), f = fake({ handler: text => text === 'COMMIT' ? commit.promise : undefined });
  await assert.rejects(() => f.db().query('SELECT 1'), denial('database_commit_unknown'));
  assert.deepEqual(f.state.releases, [true]); assert(!texts(f).includes('ROLLBACK'));
  commit.resolve({ command: 'COMMIT', rows: [] }); await sleep(5);
  assert.equal(texts(f).at(-1), 'COMMIT'); assert.deepEqual(f.state.releases, [true]);
});
test('COMMIT error or unexpected command is always unknown and discards the connection', async () => {
  for (const response of [() => Promise.reject(new Error('network reset private details')), () => Promise.resolve({ command: 'ROLLBACK', rows: [] })]) {
    const f = fake({ handler: text => text === 'COMMIT' ? response() : undefined });
    await assert.rejects(() => f.db().query('SELECT 1'), denial('database_commit_unknown'));
    assert(!texts(f).includes('ROLLBACK')); assert.deepEqual(f.state.releases, [true]);
  }
});
test('failed or timed-out rollback is unknown and never recycles the connection', async () => {
  for (const response of [() => Promise.reject(new Error('rollback network error')), () => new Promise(() => {})]) {
    const f = fake({ handler: text => text === 'ROLLBACK' ? response() : undefined });
    await assert.rejects(() => f.db().transaction(() => { throw new Error('callback'); }), denial('database_rollback_unknown'));
    assert.deepEqual(f.state.releases, [true]);
  }
});
test('unawaited or parallel transaction SQL cannot race with COMMIT or execute after release', async () => {
  const outstanding = deferred(), f = fake({ handler: text => text === 'SELECT pending' ? outstanding.promise : undefined });
  await assert.rejects(() => f.db().transaction(tx => { tx.query('SELECT pending'); return 1; }), denial('database_unawaited_query'));
  assert.deepEqual(f.state.releases, [true]); assert(!texts(f).includes('COMMIT'));
  outstanding.resolve({ command: 'SELECT', rows: [] }); await sleep(5);
  const pending = deferred(), parallel = fake({ handler: text => text === 'SELECT first' ? pending.promise : undefined });
  await assert.rejects(() => parallel.db().transaction(tx => Promise.all([tx.query('SELECT first'), tx.query('SELECT second')])), denial('database_concurrent_query'));
  assert(!texts(parallel).includes('SELECT second')); assert.deepEqual(parallel.state.releases, [true]);
  pending.reject(new Error('late private rejection')); await sleep(5);
});
test('expired or backwards injected clock closes the transaction before subsequent SQL', async () => {
  let tick = 0; const f = fake();
  await assert.rejects(() => f.db({ clock: () => tick }).transaction(async tx => { await tx.query('SELECT 1'); tick = 1000; await tx.query('SELECT too late'); }), denial('database_transaction_timeout'));
  assert(!texts(f).includes('SELECT too late')); assert.deepEqual(f.state.releases, [true]);
  let time = 10; const backward = fake();
  await assert.rejects(() => backward.db({ clock: () => time }).transaction(async tx => { time = 9; await tx.query('SELECT backwards'); }), denial('database_clock_invalid'));
  assert(!texts(backward).includes('SELECT backwards')); assert.deepEqual(backward.state.releases, [true]);
});
test('BEGIN or settings failure cannot run the callback or recycle an uncertain initial connection', async () => {
  const first = fake({ handler: text => text.startsWith('BEGIN') ? Promise.reject(new Error('private connection')) : undefined });
  await assert.rejects(() => first.db().transaction(() => assert.fail('callback ran')), denial('database_query_failed'));
  assert.deepEqual(texts(first), ['BEGIN ISOLATION LEVEL READ COMMITTED']); assert.deepEqual(first.state.releases, [true]);
  const setting = fake({ handler: text => text.includes('set_config') ? Promise.reject(new Error('private settings')) : undefined });
  await assert.rejects(() => setting.db().transaction(() => assert.fail('callback ran')), denial('database_query_failed'));
  assert.equal(texts(setting).at(-1), 'ROLLBACK'); assert.deepEqual(setting.state.releases, [false]);
});
test('malformed clients and malformed query responses fail closed with safe errors', async () => {
  let destroyed;
  const db = createBillingDatabase({ enabled: true, pool: { connect: async () => ({ release(value) { destroyed = value; } }) } });
  await assert.rejects(() => db.query('SELECT 1'), denial('database_client_invalid')); assert.equal(destroyed, true);
  const f = fake({ handler: text => text === 'SELECT malformed' ? Promise.resolve({ secret: 'private' }) : undefined });
  await assert.rejects(() => f.db().query('SELECT malformed'), denial('database_response_invalid'));
  assert.equal(texts(f).at(-1), 'ROLLBACK');
});
test('invalid SQL input aborts without issuing caller SQL, even when caught by callback', async () => {
  const f = fake();
  await assert.rejects(() => f.db().transaction(async tx => { try { await tx.query({ text: 'SELECT 1' }); } catch {} }), denial('database_query_invalid'));
  assert.equal(texts(f).at(-1), 'ROLLBACK'); assert.equal(texts(f).length, 3);
});
test('transaction deadline wins over a slower outstanding query and contains late settlement', async () => {
  let tick = 0; const pending = deferred(), f = fake({ handler: text => {
    if (text.includes('set_config')) tick = 30;
    if (text === 'SELECT pending') return pending.promise;
  } });
  await assert.rejects(() => f.db({ transactionTimeoutMs: 50, clock: () => tick }).query('SELECT pending'), denial('database_transaction_timeout'));
  assert.deepEqual(f.state.releases, [true]); assert(!texts(f).includes('ROLLBACK'));
  pending.reject(new Error('late private error')); await sleep(5);
});
test('clock-observed overdue acquisition and SQL results cannot beat delayed timer delivery', async () => {
  let tick = 0;
  const acquisition = fake({ connect: client => { tick = 100; return Promise.resolve(client); } });
  await assert.rejects(() => acquisition.db({ clock: () => tick }).query('SELECT 1'), denial('database_acquire_timeout'));
  assert.deepEqual(texts(acquisition), []); assert.deepEqual(acquisition.state.releases, [true]);
  tick = 0;
  const query = fake({ handler: text => { if (text === 'SELECT slow') tick = 100; } });
  await assert.rejects(() => query.db({ clock: () => tick }).query('SELECT slow'), denial('database_query_timeout'));
  assert(!texts(query).includes('COMMIT')); assert.deepEqual(query.state.releases, [true]);
  tick = 0;
  const commit = fake({ handler: text => { if (text === 'COMMIT') tick = 100; } });
  await assert.rejects(() => commit.db({ clock: () => tick }).query('SELECT 1'), denial('database_commit_unknown'));
  assert(!texts(commit).includes('ROLLBACK')); assert.deepEqual(commit.state.releases, [true]);
});
test('active-client error events discard safely and late teardown errors never issue SQL', async () => {
  const f = fake(), emitter = new EventEmitter();
  f.client.on = emitter.on.bind(emitter); f.client.removeListener = emitter.removeListener.bind(emitter);
  await assert.rejects(() => f.db().transaction(async tx => {
    emitter.emit('error', new Error('private connection data'));
    await tx.query('SELECT late');
  }), denial('database_client_failed'));
  assert.deepEqual(f.state.releases, [true]); assert(!texts(f).includes('SELECT late'));
  emitter.emit('error', new Error('late teardown')); assert.deepEqual(f.state.releases, [true]);
  const healthy = fake(), clean = new EventEmitter();
  healthy.client.on = clean.on.bind(clean); healthy.client.removeListener = clean.removeListener.bind(clean);
  await healthy.db().query('SELECT 1'); assert.equal(clean.listenerCount('error'), 0);
});
test('overdue query rejection or callback failure cannot initiate late rollback SQL', async () => {
  let tick = 0;
  const query = fake({ handler: text => {
    if (text === 'SELECT overdue') { tick = 100; return Promise.reject(new Error('private late rejection')); }
  } });
  await assert.rejects(() => query.db({ clock: () => tick }).query('SELECT overdue'), denial('database_query_timeout'));
  assert(!texts(query).includes('ROLLBACK')); assert.deepEqual(query.state.releases, [true]);
  tick = 0;
  const callback = fake();
  await assert.rejects(() => callback.db({ clock: () => tick }).transaction(() => {
    tick = 1000; throw new Error('private late callback');
  }), denial('database_transaction_timeout'));
  assert(!texts(callback).includes('ROLLBACK')); assert.deepEqual(callback.state.releases, [true]);
});
test('async error or end promptly aborts an unresolved callback without waiting for its deadline', { timeout: 1000 }, async () => {
  for (const [event, code] of [['error', 'database_client_failed'], ['end', 'database_client_ended']]) {
    const f = fake(), emitter = new EventEmitter(), started = deferred(), callback = deferred(); let retained;
    f.client.on = emitter.on.bind(emitter); f.client.removeListener = emitter.removeListener.bind(emitter);
    const operation = f.db({ transactionTimeoutMs: 5000 }).transaction(async tx => { retained = tx; started.resolve(); await callback.promise; });
    await started.promise;
    setTimeout(() => emitter.emit(event, new Error('private asynchronous disconnect')), 0);
    await assert.rejects(() => operation, denial(code));
    assert.deepEqual(f.state.releases, [true]); assert(!texts(f).includes('ROLLBACK')); assert(!texts(f).includes('COMMIT'));
    await assert.rejects(() => retained.query('SELECT late'), denial('database_transaction_closed'));
    callback.resolve(); await sleep(5); assert(!texts(f).includes('SELECT late'));
  }
});
test('async client error promptly rejects an outstanding query and ignores its late response', { timeout: 1000 }, async () => {
  const started = deferred(), pending = deferred(), f = fake({ handler: text => {
    if (text === 'SELECT pending') { started.resolve(); return pending.promise; }
  } }), emitter = new EventEmitter();
  f.client.on = emitter.on.bind(emitter); f.client.removeListener = emitter.removeListener.bind(emitter);
  const operation = f.db({ queryTimeoutMs: 4000, transactionTimeoutMs: 5000 }).query('SELECT pending');
  await started.promise;
  setTimeout(() => emitter.emit('error', new Error('private query disconnect')), 0);
  await assert.rejects(() => operation, denial('database_client_failed'));
  pending.resolve({ command: 'SELECT', rows: [] }); await sleep(5);
  assert.deepEqual(f.state.releases, [true]); assert.equal(texts(f).at(-1), 'SELECT pending');
});
test('async error or end during pending COMMIT is promptly unknown and never rolled back', { timeout: 1000 }, async () => {
  for (const event of ['error', 'end']) {
    const started = deferred(), pending = deferred(), f = fake({ handler: text => {
      if (text === 'COMMIT') { started.resolve(); return pending.promise; }
    } }), emitter = new EventEmitter();
    f.client.on = emitter.on.bind(emitter); f.client.removeListener = emitter.removeListener.bind(emitter);
    const operation = f.db({ queryTimeoutMs: 4000, transactionTimeoutMs: 5000 }).query('SELECT 1');
    await started.promise;
    setTimeout(() => emitter.emit(event, new Error('private commit disconnect')), 0);
    await assert.rejects(() => operation, denial('database_commit_unknown'));
    assert.deepEqual(f.state.releases, [true]); assert(!texts(f).includes('ROLLBACK'));
    pending.resolve({ command: 'COMMIT', rows: [] }); await sleep(5);
    assert.equal(texts(f).at(-1), 'COMMIT'); assert.deepEqual(f.state.releases, [true]);
  }
});
