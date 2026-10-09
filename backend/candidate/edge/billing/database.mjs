import { BillingError } from './core.mjs';
import { safeWorkerErrorCode } from './worker.mjs';

// Implements the documented injected node-postgres pool contract, without importing
// pg, constructing a pool, discovering credentials, or configuring network/TLS access.
// https://node-postgres.com/apis/pool
// https://node-postgres.com/features/transactions
// https://www.postgresql.org/docs/current/runtime-config-client.html
class DatabaseError extends BillingError {
  constructor(code) { super(code, 503); }
}
const error = code => new DatabaseError(code);
const rejectHandled = cause => { const pending = Promise.reject(cause); pending.catch(() => {}); return pending; };
const businessCodes = new Set(['event_id_payload_conflict', 'unsupported_usage_source', 'usage_source_changed',
  'usage_observation_conflict', 'usage_source_unverified', 'usage_source_unfinished', 'invalid_json',
  'policy_version_conflict', 'policy_unconfigured', 'invalid_meter_policy']);
function safeCallbackError(value) {
  if (value instanceof DatabaseError) return value;
  if (value instanceof BillingError) {
    const code = safeWorkerErrorCode(value);
    const status = Number.isInteger(value.status) && value.status >= 400 && value.status <= 599 ? value.status : 409;
    if (code !== 'worker_unexpected_error') return new BillingError(code, status);
    if (businessCodes.has(value.code)) return new BillingError(value.code, status);
  }
  return error('database_callback_failed');
}
const bounded = (n, max) => Number.isSafeInteger(n) && n >= 1 && n <= max;

export function createBillingDatabase({ pool, enabled = false, acquisitionTimeoutMs = 3000,
  queryTimeoutMs = 6000, transactionTimeoutMs = 15000, statementTimeoutMs = 5000,
  lockTimeoutMs = 2000, clock = () => performance.now() } = {}) {
  function configured() {
    if (enabled !== true) throw error('database_inactive');
    if (!pool || typeof pool.connect !== 'function' || typeof clock !== 'function'
      || !bounded(acquisitionTimeoutMs, 30000) || !bounded(queryTimeoutMs, 60000)
      || !bounded(transactionTimeoutMs, 300000) || !bounded(statementTimeoutMs, queryTimeoutMs)
      || !bounded(lockTimeoutMs, statementTimeoutMs) || queryTimeoutMs > transactionTimeoutMs) throw error('database_configuration_invalid');
  }
  // release(true) tells node-postgres to destroy rather than recycle an uncertain
  // connection. Never retry an uncertain release; the pool owns physical teardown.
  function release(client, destroy) {
    try { client.release(destroy); } catch { /* No raw error or extra SQL escapes. */ }
  }
  function acquire() {
    return new Promise((resolve, reject) => {
      let settled = false;
      let started;
      try { started = clock(); if (!Number.isFinite(started)) throw 0; }
      catch { reject(error('database_clock_invalid')); return; }
      const timer = setTimeout(() => { settled = true; reject(error('database_acquire_timeout')); }, acquisitionTimeoutMs);
      Promise.resolve().then(() => settled ? null : pool.connect()).then(client => {
        if (settled) { if (typeof client?.release === 'function') release(client, true); return; }
        settled = true; clearTimeout(timer);
        let elapsed;
        try { elapsed = clock() - started; if (!Number.isFinite(elapsed) || elapsed < 0) throw 0; }
        catch {
          if (typeof client?.release === 'function') release(client, true);
          reject(error('database_clock_invalid')); return;
        }
        if (elapsed >= acquisitionTimeoutMs) {
          if (typeof client?.release === 'function') release(client, true);
          reject(error('database_acquire_timeout')); return;
        }
        if (typeof client?.query !== 'function' || typeof client?.release !== 'function') {
          if (typeof client?.release === 'function') release(client, true);
          reject(error('database_client_invalid')); return;
        }
        resolve(client);
      }, () => { if (!settled) { settled = true; clearTimeout(timer); reject(error('database_acquire_failed')); } });
    });
  }
  async function transaction(callback) {
    configured();
    if (typeof callback !== 'function') throw error('database_configuration_invalid');
    const client = await acquire();
    let released = false, busy = false, began = false, accepting = false, phase = 'begin', fault = null;
    let previousTime = -Infinity, deadline, onClientError, onClientEnd, rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    aborted.catch(() => {});
    const timers = new Set();
    function later(callback, delay) {
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
      timers.add(timer); return timer;
    }
    function cancel(timer) { clearTimeout(timer); timers.delete(timer); }
    function dispose(destroy) {
      if (!released) {
        released = true; accepting = false;
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        release(client, destroy);
        // The pool installs its idle handler when a healthy client is returned.
        // A destroyed client retains our safe listener for late teardown errors.
        if (!destroy && onClientError) {
          client.removeListener('error', onClientError);
          client.removeListener('end', onClientEnd);
        }
      }
    }
    function time() {
      const value = clock();
      if (!Number.isFinite(value) || value < previousTime) throw error('database_clock_invalid');
      previousTime = value;
      return value;
    }
    try { deadline = time() + transactionTimeoutMs; } catch { dispose(true); throw error('database_clock_invalid'); }
    function stop(reason, destroy = true) {
      fault ??= reason; accepting = false;
      if (destroy) { dispose(true); rejectAbort(fault); }
      return fault;
    }
    function remaining() {
      try {
        const left = deadline - time();
        if (left <= 0) throw error('database_transaction_timeout');
        return left;
      } catch (cause) { throw stop(cause instanceof DatabaseError ? cause : error('database_clock_invalid')); }
    }
    // Exactly one SQL request may be outstanding. No queued client.query callbacks
    // can execute after a deadline, callback settlement, rollback, or pool release.
    function sql(text, values = [], { cleanup = false, committing = false } = {}) {
      if (released) return rejectHandled(error('database_transaction_closed'));
      if (busy) return rejectHandled(stop(error('database_concurrent_query')));
      let limit, queryStarted;
      try { limit = cleanup ? queryTimeoutMs : Math.min(queryTimeoutMs, remaining()); queryStarted = time(); }
      catch (cause) { return rejectHandled(cause instanceof DatabaseError ? cause : stop(error('database_clock_invalid'))); }
      busy = true;
      const pending = new Promise((resolve, reject) => {
        let settled = false;
        const timer = later(() => {
          settled = true;
          const code = committing ? 'database_commit_unknown' : (cleanup ? 'database_rollback_unknown'
            : limit < queryTimeoutMs ? 'database_transaction_timeout' : 'database_query_timeout');
          reject(stop(error(code)));
        }, limit);
        let request;
        try { request = client.query(text, values); }
        catch { request = Promise.reject(error('database_query_failed')); }
        Promise.resolve(request).then(result => {
          if (settled) return;
          settled = true; cancel(timer); busy = false;
          if (released) { reject(fault ?? error('database_transaction_closed')); return; }
          try {
            if (time() - queryStarted >= limit) {
              reject(stop(error(committing ? 'database_commit_unknown' : cleanup ? 'database_rollback_unknown'
                : limit < queryTimeoutMs ? 'database_transaction_timeout' : 'database_query_timeout'))); return;
            }
          } catch { reject(stop(error(committing ? 'database_commit_unknown' : 'database_clock_invalid'))); return; }
          if (!result || !Array.isArray(result.rows)) {
            const cause = error(committing ? 'database_commit_unknown' : 'database_response_invalid');
            fault ??= cause; accepting = false;
            if (committing) dispose(true);
            reject(cause); return;
          }
          resolve(result);
        }, () => {
          if (settled) return;
          settled = true; cancel(timer); busy = false;
          try {
            if (time() - queryStarted >= limit) {
              reject(stop(error(committing ? 'database_commit_unknown' : cleanup ? 'database_rollback_unknown'
                : limit < queryTimeoutMs ? 'database_transaction_timeout' : 'database_query_timeout'))); return;
            }
          } catch { reject(stop(error(committing ? 'database_commit_unknown' : 'database_clock_invalid'))); return; }
          const cause = error(committing ? 'database_commit_unknown' : cleanup ? 'database_rollback_unknown' : 'database_query_failed');
          fault ??= cause; accepting = false;
          if (committing || cleanup) dispose(true);
          reject(cause);
        });
      });
      pending.catch(() => {}); // Also contain an improperly unawaited caller promise.
      const guarded = Promise.race([pending, aborted]);
      guarded.catch(() => {});
      return guarded;
    }
    const tx = Object.freeze({ query(text, values = []) {
      if (!accepting || released || phase !== 'callback') return rejectHandled(error('database_transaction_closed'));
      if (typeof text !== 'string' || text.trim().length === 0 || !Array.isArray(values)) {
        fault ??= error('database_query_invalid'); accepting = false;
        return rejectHandled(fault);
      }
      return sql(text, values);
    } });
    if (typeof client.on === 'function' && typeof client.removeListener === 'function') {
      onClientError = () => stop(error(phase === 'commit' ? 'database_commit_unknown' : 'database_client_failed'));
      onClientEnd = () => stop(error(phase === 'commit' ? 'database_commit_unknown' : 'database_client_ended'));
      client.on('error', onClientError);
      client.on('end', onClientEnd);
    }
    try {
      const begin = await sql('BEGIN ISOLATION LEVEL READ COMMITTED');
      if (begin.command !== 'BEGIN') throw stop(error('database_response_invalid'));
      began = true;
      await sql("SELECT set_config('lock_timeout',$1,true), set_config('statement_timeout',$2,true), set_config('idle_in_transaction_session_timeout',$3,true)",
        [`${lockTimeoutMs}ms`, `${statementTimeoutMs}ms`, `${transactionTimeoutMs}ms`]);
      phase = 'callback'; accepting = true;
      const callbackWork = new Promise((resolve, reject) => {
        const timer = later(() => reject(stop(error('database_transaction_timeout'))), remaining());
        Promise.resolve().then(() => { remaining(); return callback(tx); }).then(result => {
          cancel(timer); accepting = false;
          if (fault) { reject(fault); return; }
          if (busy) { reject(stop(error('database_unawaited_query'))); return; }
          resolve(result);
        }, cause => { cancel(timer); accepting = false; reject(fault ?? safeCallbackError(cause)); });
      });
      const value = await Promise.race([callbackWork, aborted]);
      remaining();
      phase = 'commit';
      const commit = await sql('COMMIT', [], { committing: true });
      if (commit.command !== 'COMMIT') throw stop(error('database_commit_unknown'));
      dispose(false);
      return value;
    } catch (cause) {
      accepting = false;
      let failure = fault ?? safeCallbackError(cause);
      if (phase !== 'commit' && !released && began && !busy) {
        // A delayed timer must not allow a callback/query rejection to start cleanup
        // SQL after the transaction already expired by its trusted clock.
        try { remaining(); } catch (expired) { failure = fault ?? safeCallbackError(expired); }
      }
      if (phase === 'commit') {
        // A lost COMMIT reply can mean the transaction committed. Do not send a
        // misleading ROLLBACK or report that the original transaction was undone.
        failure = error('database_commit_unknown'); dispose(true);
      } else if (!released && began && !busy) {
        phase = 'rollback';
        try {
          const rollback = await sql('ROLLBACK', [], { cleanup: true });
          if (rollback.command !== 'ROLLBACK') throw error('database_rollback_unknown');
          dispose(false);
        } catch { failure = error('database_rollback_unknown'); dispose(true); }
      } else dispose(true);
      throw failure;
    } finally { accepting = false; }
  }
  return Object.freeze({ transaction, query: (text, values = []) => transaction(tx => tx.query(text, values)) });
}
