import { BillingError } from './core.mjs';
import { BillingStore } from './store.mjs';
import { safeWorkerErrorCode, workerTime } from './worker.mjs';

const fail = code => { throw new BillingError(code, 409); };
const first = result => result.rows[0];
const integer = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= min && v <= max;
const validTime = now => { if (!integer(now)) fail('worker_clock_invalid'); };
const validScope = bindingId => { if (bindingId !== null && (typeof bindingId !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(bindingId))) fail('worker_configuration_invalid'); };
const addTime = (now, seconds) => { const next = now + seconds; if (!integer(next)) fail('worker_clock_invalid'); return next; };
const normalizeJob = row => row && { ...row, source_revision: Number(row.source_revision), fence: Number(row.fence), attempts: Number(row.attempts),
  lease_expires_at: row.lease_expires_at === null ? null : Number(row.lease_expires_at) };

// Trusted internal adapter only. db.transaction reserves ONE connection and performs
// BEGIN/COMMIT/ROLLBACK at READ COMMITTED. No pool, URLs, credentials or live SQL here.
// Binding -> job -> projection is the mutation lock order. Provider I/O stays outside
// transactions. No public RPC accepts job claims or reconciliation evidence.
export class BillingWorkerStore {
  constructor(db) { this.db = db; }
  async audit(tx, job, event, now, code = null) {
    await tx.query(`INSERT INTO kairo_billing.reconciliation_job_history(job_id,event,fence,attempt,occurred_at,error_code)
      VALUES($1,$2,$3,$4,$5,$6)`, [job.id, event, job.fence, job.attempts, now, code]);
  }
  async discover({ now, limit, refreshAfterSeconds = null, bindingId = null }) {
    validTime(now);
    validScope(bindingId);
    if (!integer(limit, 1, 100) || (refreshAfterSeconds !== null && !integer(refreshAfterSeconds, 1))) fail('worker_configuration_invalid');
    return this.db.transaction(async tx => {
      // Excluding all existing logical jobs BEFORE LIMIT avoids starvation by unchanged
      // receipts in backoff. Unknown receipts remain in the durable queue without a cap.
      const candidates = (await tx.query(`SELECT * FROM (
        SELECT r.binding_id,'resolve_receipt'::text AS kind,r.event_id AS subject_id,1::bigint AS source_revision,
          r.payload_sha256 AS source_sha256,r.received_at AS source_at
        FROM kairo_billing.provider_receipts r LEFT JOIN kairo_billing.receipt_links l USING(binding_id,event_id)
        WHERE ($4::text IS NULL OR r.binding_id=$4) AND r.kind<>'ignored' AND l.event_id IS NULL AND NOT EXISTS(
          SELECT 1 FROM kairo_billing.receipt_dispositions d WHERE d.binding_id=r.binding_id AND d.event_id=r.event_id)
        AND NOT EXISTS(
          SELECT 1 FROM kairo_billing.reconciliation_jobs j WHERE j.binding_id=r.binding_id
          AND j.kind='resolve_receipt' AND j.subject_id=r.event_id AND j.source_revision=1)
        UNION ALL
        SELECT p.binding_id,'reconcile_subscription',p.subscription_id,p.revision,NULL::text,
          CASE WHEN p.projection->>'state'='needs_reconciliation' THEN (p.projection->>'last_receipt_at')::bigint
            ELSE (p.projection->>'reconciled_at')::bigint END
        FROM kairo_billing.subscription_projections p
        WHERE ($4::text IS NULL OR p.binding_id=$4) AND (p.projection->>'state'='needs_reconciliation' OR ($2::bigint IS NOT NULL
          AND p.projection->>'state'='reconciled' AND (p.projection->>'reconciled_at')::bigint<=$1::bigint-$2::bigint))
        AND NOT EXISTS(SELECT 1 FROM kairo_billing.reconciliation_jobs j WHERE j.binding_id=p.binding_id
          AND j.kind='reconcile_subscription' AND j.subject_id=p.subscription_id AND j.source_revision=p.revision)
      ) candidates ORDER BY source_at,binding_id,kind,subject_id,source_revision LIMIT $3`, [now, refreshAfterSeconds, limit, bindingId])).rows;
      let inserted = 0;
      for (const c of candidates) {
        const job = normalizeJob(first(await tx.query(`INSERT INTO kairo_billing.reconciliation_jobs
          (id,binding_id,kind,subject_id,source_revision,source_sha256,state,next_attempt_at,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,'queued',$7,$7,$7)
          ON CONFLICT(binding_id,kind,subject_id,source_revision) DO NOTHING RETURNING *`,
        [crypto.randomUUID(), c.binding_id, c.kind, c.subject_id, c.source_revision, c.source_sha256, now])));
        if (job) { await this.audit(tx, job, 'enqueued', now); inserted++; }
      }
      return inserted;
    });
  }
  async claim({ now, leaseSeconds, excludeJobIds = [], bindingId = null }) {
    validTime(now);
    validScope(bindingId);
    if (!integer(leaseSeconds, 1, 3600) || !Array.isArray(excludeJobIds) || excludeJobIds.length > 100
      || !excludeJobIds.every(id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) fail('worker_configuration_invalid');
    const expiry = addTime(now, leaseSeconds);
    return this.db.transaction(async tx => {
      const old = normalizeJob(first(await tx.query(`SELECT * FROM kairo_billing.reconciliation_jobs
        WHERE ((state IN ('queued','retry') AND next_attempt_at<=$1) OR (state='leased' AND lease_expires_at<=$1))
        AND NOT(id=ANY($2::uuid[])) AND ($3::text IS NULL OR binding_id=$3)
        ORDER BY CASE WHEN state='leased' THEN lease_expires_at ELSE next_attempt_at END,created_at,queue_order
        LIMIT 1 FOR UPDATE SKIP LOCKED`, [now, excludeJobIds, bindingId])));
      if (!old) return null;
      if (now < Number(old.updated_at)) fail('worker_clock_invalid');
      if (old.state === 'leased') await this.audit(tx, old, 'lease_expired', now, 'worker_lease_lost');
      const job = normalizeJob(first(await tx.query(`UPDATE kairo_billing.reconciliation_jobs
        SET state='leased',fence=fence+1,attempts=attempts+1,lease_expires_at=$2,updated_at=$3
        WHERE id=$1 RETURNING *`, [old.id, expiry, now])));
      await this.audit(tx, job, 'claimed', now);
      return job;
    });
  }
  async fence(tx, claim, now) {
    validTime(now);
    const job = normalizeJob(first(await tx.query('SELECT * FROM kairo_billing.reconciliation_jobs WHERE id=$1 FOR UPDATE', [claim.id])));
    if (!job || job.state !== 'leased' || job.fence !== claim.fence || job.lease_expires_at <= now) fail('worker_lease_lost');
    if (now < Number(job.updated_at)) fail('worker_clock_invalid');
    if (['binding_id','kind','subject_id','source_revision','source_sha256'].some(key => job[key] !== claim[key])) fail('worker_source_conflict');
    return job;
  }
  async source(tx, job) {
    if (job.kind === 'reconcile_subscription') {
      const row = first(await tx.query('SELECT projection,revision FROM kairo_billing.subscription_projections WHERE binding_id=$1 AND subscription_id=$2', [job.binding_id, job.subject_id]));
      if (!row) fail('worker_source_missing');
      if (Number(row.revision) > job.source_revision) return { superseded: true };
      if (Number(row.revision) !== job.source_revision) fail('worker_source_conflict');
      return { projection: row.projection };
    }
    const row = first(await tx.query('SELECT * FROM kairo_billing.provider_receipts WHERE binding_id=$1 AND event_id=$2', [job.binding_id, job.subject_id]));
    if (!row) fail('worker_source_missing');
    if (row.payload_sha256 !== job.source_sha256 || row.kind === 'ignored') fail('worker_source_conflict');
    const link = first(await tx.query('SELECT event_id FROM kairo_billing.receipt_links WHERE binding_id=$1 AND event_id=$2', [job.binding_id, job.subject_id]));
    const disposition = first(await tx.query('SELECT event_id FROM kairo_billing.receipt_dispositions WHERE binding_id=$1 AND event_id=$2', [job.binding_id, job.subject_id]));
    return link || disposition ? { resolved: true } : { receipt: { ...row, received_at: Number(row.received_at), provider_created_at: Number(row.provider_created_at) } };
  }
  async load(claim, { now }) {
    return this.db.transaction(async tx => this.source(tx, await this.fence(tx, claim, now)));
  }
  async complete(claim, result, { clock }) {
    return this.db.transaction(async tx => {
      // Lock in the same order as BillingStore's receipt/reconciliation path. This
      // serializes new receipts with the fenced commit without holding locks during I/O.
      await tx.query('SELECT id FROM kairo_billing.provider_bindings WHERE id=$1 FOR UPDATE', [claim.binding_id]);
      const started = workerTime(clock);
      const job = await this.fence(tx, claim, started);
      const source = await this.source(tx, job);
      let state = 'completed';
      if (source.superseded) state = 'superseded';
      else if (!source.resolved) {
        // Reuse the existing validated store within this exact transaction: nested
        // transaction calls are deliberately scoped, never BEGIN a second transaction.
        const scoped = new BillingStore({ transaction: callback => callback(tx) });
        if (job.kind === 'reconcile_subscription') {
          if (!result?.input || result.input.expected_revision !== job.source_revision) fail('worker_provider_result_invalid');
          const input = result.input;
          // The runner and provider reader must share a trusted seconds clock. A
          // matching revision alone does not make a cached/future response fresh.
          if (!integer(input.fetch_started_at) || !integer(input.fetched_at)
            || input.fetch_started_at < Math.max(Number(job.updated_at), source.projection.reconciled_at ?? 0)
            || input.fetched_at < input.fetch_started_at || input.fetched_at > started) fail('stale_reconciliation');
          await scoped.reconcile(job.binding_id, job.subject_id, result.input);
        } else {
          const resolution = result?.resolution;
          if (!resolution || typeof resolution.customer_id !== 'string') fail('worker_provider_result_invalid');
          // Job identity wins; an adapter cannot redirect completion to another event.
          const identity = { customer_id: resolution.customer_id, evidence_sha256: resolution.evidence_sha256,
            binding_id: job.binding_id, event_id: job.subject_id };
          if (resolution.disposition === 'not_subscription') {
            if (resolution.subscription_id != null) fail('worker_provider_result_invalid');
            // A conclusive standalone graph disposition neither creates a customer
            // binding nor grants access. Unknown/ambiguous graphs must throw/retry.
            await scoped.resolveNonSubscriptionReceipt(identity);
          } else {
            if (resolution.disposition != null) fail('worker_provider_result_invalid');
            const customer = first(await tx.query('SELECT customer_id FROM kairo_billing.customer_bindings WHERE binding_id=$1 AND customer_id=$2', [job.binding_id, resolution.customer_id]));
            if (!customer) fail('waiting_customer_binding');
            await scoped.resolveReceipt({ ...identity, subscription_id: resolution.subscription_id });
          }
        }
      }
      let now = workerTime(clock);
      if (now < started) fail('worker_clock_invalid');
      if (now >= job.lease_expires_at) fail('worker_lease_lost');
      await tx.query(`UPDATE kairo_billing.reconciliation_jobs SET state=$2,completed_at=$3,updated_at=$3,
        lease_expires_at=NULL,last_error_code=NULL WHERE id=$1`, [job.id, state, now]);
      await this.audit(tx, job, state, now);
      // The job row remains locked through COMMIT. Re-read the trusted clock after all
      // asynchronous writes; expiry rolls the projection, job and audit back together.
      const finalTime = workerTime(clock);
      if (finalTime < now) fail('worker_clock_invalid');
      if (finalTime >= job.lease_expires_at) fail('worker_lease_lost');
      return { state };
    });
  }
  async fail(claim, { now, clock = () => now, code, delaySeconds }) {
    validTime(now);
    if (!integer(delaySeconds, 1, 86400)) fail('worker_configuration_invalid');
    const retryAt = addTime(now, delaySeconds);
    const safeCode = safeWorkerErrorCode(new BillingError(code));
    try {
      return await this.db.transaction(async tx => {
        const current = workerTime(clock);
        if (current < now) fail('worker_clock_invalid');
        const job = await this.fence(tx, claim, current);
        await tx.query(`UPDATE kairo_billing.reconciliation_jobs SET state='retry',lease_expires_at=NULL,
          next_attempt_at=$2,updated_at=$3,last_error_code=$4 WHERE id=$1`, [job.id, Math.max(retryAt, addTime(current, delaySeconds)), current, safeCode]);
        await this.audit(tx, job, 'retried', current, safeCode);
        const finalTime = workerTime(clock);
        if (finalTime < current) fail('worker_clock_invalid');
        if (finalTime >= job.lease_expires_at) fail('worker_lease_lost');
        return { state: 'retried' };
      });
    } catch (error) {
      if (error instanceof BillingError && error.code === 'worker_lease_lost') return { state: 'lease_lost' };
      throw error;
    }
  }
}
