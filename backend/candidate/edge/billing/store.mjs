import { BillingError, canonical, fingerprint, usageFromSource, validatePolicy, invalidateProjection, reconcileProjection } from './core.mjs';
const fail = (code, status = 409) => { throw new BillingError(code, status); };
const first = result => result.rows[0];
// db.transaction(fn) must reserve one connection, BEGIN/COMMIT/ROLLBACK, and use READ COMMITTED.
// PGlite implements this interface for synthetic tests. No pool/credentials are created here.
export class BillingStore {
  constructor(db) { this.db = db; }
  async recordReceipt(receipt) {
    return this.db.transaction(async tx => {
      const binding = first(await tx.query('SELECT * FROM kairo_billing.provider_bindings WHERE id=$1 FOR UPDATE', [receipt.binding_id]));
      if (!binding || binding.account_id !== receipt.account_id || binding.account_kind !== receipt.account_kind || binding.livemode !== receipt.livemode || binding.api_version !== receipt.api_version) fail('provider_binding_conflict');
      const existing = first(await tx.query('SELECT * FROM kairo_billing.provider_receipts WHERE binding_id=$1 AND event_id=$2', [receipt.binding_id, receipt.event_id]));
      if (existing) {
        if (existing.payload_sha256 !== receipt.payload_sha256) fail('event_id_payload_conflict');
        return { status: 200, code: 'duplicate', event_id: receipt.event_id };
      }
      await tx.query(`INSERT INTO kairo_billing.provider_receipts(binding_id,event_id,payload_sha256,event_type,object_id,kind,customer_id,subscription_id,terminal,provider_created_at,received_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [receipt.binding_id, receipt.event_id, receipt.payload_sha256, receipt.event_type, receipt.object_id, receipt.kind, receipt.customer_id, receipt.subscription_id, receipt.terminal, receipt.provider_created_at, receipt.received_at]);
      const customer = receipt.customer_id && first(await tx.query('SELECT * FROM kairo_billing.customer_bindings WHERE binding_id=$1 AND customer_id=$2', [receipt.binding_id, receipt.customer_id]));
      if (customer && receipt.subscription_id) {
        await this.linkAndInvalidate(tx, receipt, customer, receipt.subscription_id, receipt.payload_sha256);
        return { status: 200, code: 'recorded', event_id: receipt.event_id };
      }
      return { status: 200, code: receipt.kind === 'ignored' ? 'ignored' : 'needs_lineage_resolution', event_id: receipt.event_id };
    });
  }
  async linkAndInvalidate(tx, receipt, customer, subscription_id, evidence) {
    await tx.query('INSERT INTO kairo_billing.receipt_links(binding_id,event_id,customer_id,organization_id,subscription_id,resolution_evidence_sha256) VALUES($1,$2,$3,$4,$5,$6)',
      [receipt.binding_id, receipt.event_id, customer.customer_id, customer.organization_id, subscription_id, evidence]);
    const prior = first(await tx.query('SELECT projection FROM kairo_billing.subscription_projections WHERE binding_id=$1 AND subscription_id=$2 FOR UPDATE', [receipt.binding_id, subscription_id]))?.projection;
    const next = invalidateProjection(prior, { ...receipt, customer_id: customer.customer_id, subscription_id,
      received_at: Number(receipt.received_at), provider_created_at: Number(receipt.provider_created_at) }, customer.organization_id);
    await tx.query(`INSERT INTO kairo_billing.subscription_projections(binding_id,subscription_id,customer_id,organization_id,revision,projection) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(binding_id,subscription_id) DO UPDATE SET revision=excluded.revision,projection=excluded.projection`,
      [next.binding_id, next.subscription_id, next.customer_id, next.organization_id, next.revision, JSON.stringify(next)]);
  }
  // Called only after a trusted, approved adapter resolves Stripe's charge -> invoice -> subscription graph.
  // A graph hash is evidence identity, not authorization. This method is not exposed as an RPC/HTTP endpoint.
  async resolveReceipt({ binding_id, event_id, customer_id, subscription_id, evidence_sha256 }) {
    if (!/^sub_[A-Za-z0-9]+$/.test(subscription_id) || !/^[a-f0-9]{64}$/.test(evidence_sha256)) fail('invalid_resolution');
    return this.db.transaction(async tx => {
      await tx.query('SELECT id FROM kairo_billing.provider_bindings WHERE id=$1 FOR UPDATE', [binding_id]);
      const receipt = first(await tx.query('SELECT * FROM kairo_billing.provider_receipts WHERE binding_id=$1 AND event_id=$2', [binding_id, event_id]));
      const customer = first(await tx.query('SELECT * FROM kairo_billing.customer_bindings WHERE binding_id=$1 AND customer_id=$2', [binding_id, customer_id]));
      if(first(await tx.query('SELECT 1 FROM kairo_billing.receipt_dispositions WHERE binding_id=$1 AND event_id=$2',[binding_id,event_id])))fail('resolution_lineage_conflict');
      if (!receipt || !customer || receipt.kind === 'ignored' || (receipt.customer_id && receipt.customer_id !== customer_id)
        || (receipt.subscription_id && receipt.subscription_id !== subscription_id)) fail('resolution_lineage_conflict');
      const prior = first(await tx.query('SELECT * FROM kairo_billing.receipt_links WHERE binding_id=$1 AND event_id=$2', [binding_id, event_id]));
      if (prior) {
        if (prior.customer_id !== customer_id || prior.subscription_id !== subscription_id || prior.resolution_evidence_sha256 !== evidence_sha256) fail('resolution_replay_conflict');
        return { replayed: true };
      }
      await this.linkAndInvalidate(tx, receipt, customer, subscription_id, evidence_sha256);
      return { replayed: false };
    });
  }
  async resolveNonSubscriptionReceipt({binding_id,event_id,customer_id,evidence_sha256}) {
    if (!/^cus_[A-Za-z0-9]+$/.test(customer_id)||!/^[a-f0-9]{64}$/.test(evidence_sha256)) fail('invalid_resolution');
    return this.db.transaction(async tx=>{
      await tx.query('SELECT id FROM kairo_billing.provider_bindings WHERE id=$1 FOR UPDATE',[binding_id]);
      const r=first(await tx.query('SELECT * FROM kairo_billing.provider_receipts WHERE binding_id=$1 AND event_id=$2',[binding_id,event_id]));
      if(!r||r.subscription_id||(r.customer_id&&r.customer_id!==customer_id)||r.kind==='subscription'||r.kind==='ignored')fail('resolution_lineage_conflict');
      if(first(await tx.query('SELECT 1 FROM kairo_billing.receipt_links WHERE binding_id=$1 AND event_id=$2',[binding_id,event_id])))fail('resolution_lineage_conflict');
      const old=first(await tx.query('SELECT * FROM kairo_billing.receipt_dispositions WHERE binding_id=$1 AND event_id=$2',[binding_id,event_id]));
      if(old){if(old.customer_id!==customer_id||old.evidence_sha256!==evidence_sha256)fail('resolution_replay_conflict');return {replayed:true}}
      await tx.query("INSERT INTO kairo_billing.receipt_dispositions(binding_id,event_id,customer_id,disposition,evidence_sha256) VALUES($1,$2,$3,'not_subscription',$4)",[binding_id,event_id,customer_id,evidence_sha256]);
      return {replayed:false};
    });
  }
  async reconcile(binding_id, subscription_id, input) {
    return this.db.transaction(async tx => {
      const storedBinding = first(await tx.query('SELECT * FROM kairo_billing.provider_bindings WHERE id=$1 FOR UPDATE', [binding_id]));
      if (!storedBinding || ['id','account_id','account_kind','livemode','api_version'].some(k => storedBinding[k] !== input.binding?.[k])) fail('provider_binding_conflict');
      const previous = first(await tx.query('SELECT projection FROM kairo_billing.subscription_projections WHERE binding_id=$1 AND subscription_id=$2 FOR UPDATE', [binding_id, subscription_id]))?.projection;
      const next = reconcileProjection(previous, input);
      await tx.query('UPDATE kairo_billing.subscription_projections SET revision=$3,projection=$4 WHERE binding_id=$1 AND subscription_id=$2', [binding_id, subscription_id, next.revision, JSON.stringify(next)]);
      return next;
    });
  }
  async entitlementContext(organization_id, binding_id, subscription_id) {
    // One SQL snapshot: projection plus pending refunds. External role authentication stays upstream.
    const row = first(await this.db.query(`SELECT p.projection, EXISTS(
      SELECT 1 FROM kairo_billing.provider_receipts r LEFT JOIN kairo_billing.receipt_links l USING(binding_id,event_id)
      WHERE r.binding_id=p.binding_id AND r.kind<>'ignored' AND l.event_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM kairo_billing.receipt_dispositions d WHERE d.binding_id=r.binding_id AND d.event_id=r.event_id)
      AND (r.customer_id IS NULL OR r.customer_id=p.customer_id)) AS customer_hold
      FROM kairo_billing.subscription_projections p WHERE p.organization_id=$1 AND p.binding_id=$2 AND p.subscription_id=$3`, [organization_id, binding_id, subscription_id]));
    return row ?? { projection: null, customer_hold: true };
  }
  async loadSource(organization_id, kind, source_id) {
    const tables = { ai_draft_run: 'public.ai_draft_runs', workflow_run: 'public.workflow_runs', phone_call: 'kairo_phone_intake.calls' };
    const table = tables[kind]; if (!table) fail('unsupported_usage_source', 400);
    const exists = first(await this.db.query('SELECT to_regclass($1) AS name', [table]));
    if (!exists?.name) fail('usage_source_contract_unavailable', 503);
    return first(await this.db.query(`SELECT * FROM ${table} WHERE organization_id=$1 AND id=$2`, [organization_id, source_id]));
  }
  async recordUsage(observations) {
    return this.db.transaction(async tx => {
      const results = [];
      for (const o of observations) {
        // Serialize by organization; unknown -> measured appends, measured -> changed is a conflict.
        await tx.query('SELECT id FROM public.organizations WHERE id=$1 FOR UPDATE', [o.organization_id]);
        const tables = { ai_draft_run: 'public.ai_draft_runs', workflow_run: 'public.workflow_runs', phone_call: 'kairo_phone_intake.calls' };
        if (!tables[o.source_kind]) fail('unsupported_usage_source', 400);
        const source = first(await tx.query(`SELECT * FROM ${tables[o.source_kind]} WHERE organization_id=$1 AND id=$2 FOR SHARE`, [o.organization_id, o.source_id]));
        if (!source || !usageFromSource(source, o.source_kind).some(expected => canonical(expected) === canonical(o))) fail('usage_source_changed');
        const hash = await fingerprint(o);
        const old = first(await tx.query('SELECT id,observation_sha256 FROM kairo_billing.usage_events WHERE organization_id=$1 AND source_kind=$2 AND source_id=$3 AND metric=$4 AND state=$5', [o.organization_id,o.source_kind,o.source_id,o.metric,o.state]));
        if (old) {
          if (old.observation_sha256 !== hash) fail('usage_observation_conflict');
          results.push({ id: old.id, replayed: true }); continue;
        }
        const eventId = crypto.randomUUID();
        await tx.query('INSERT INTO kairo_billing.usage_events(id,organization_id,source_kind,source_id,metric,unit,state,quantity,evidence_ref,observation_sha256,source_started_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [eventId,o.organization_id,o.source_kind,o.source_id,o.metric,o.unit,o.state,o.quantity,o.evidence_ref,hash,o.source_started_at]);
        results.push({ id: eventId, replayed: false });
      }
      return results;
    });
  }
  async recordPolicy(policy) {
    validatePolicy(policy);
    const hash = await fingerprint(policy);
    return this.db.transaction(async tx => {
      const binding = first(await tx.query('SELECT id FROM kairo_billing.provider_bindings WHERE id=$1 FOR UPDATE', [policy.binding_id]));
      if (!binding) fail('provider_binding_conflict');
      const old = first(await tx.query('SELECT policy_sha256 FROM kairo_billing.policy_versions WHERE policy_id=$1 AND version=$2', [policy.id, policy.version]));
      if (old) {
        if (old.policy_sha256 !== hash) fail('policy_version_conflict');
        return { replayed: true, policy_sha256: hash };
      }
      await tx.query('INSERT INTO kairo_billing.policy_versions(policy_id,version,binding_id,policy,policy_sha256) VALUES($1,$2,$3,$4,$5)', [policy.id,policy.version,policy.binding_id,JSON.stringify(policy),hash]);
      return { replayed: false, policy_sha256: hash };
    });
  }
  async loadPolicy(policy_id, version) {
    return first(await this.db.query('SELECT policy FROM kairo_billing.policy_versions WHERE policy_id=$1 AND version=$2',[policy_id,version]))?.policy ?? null;
  }
  async usageTotals(organization_id, metric) {
    const rows = (await this.db.query(`SELECT source_kind,source_id,state,quantity FROM kairo_billing.usage_events WHERE organization_id=$1 AND metric=$2`, [organization_id, metric])).rows;
    const measured = rows.filter(x=>x.state==='measured'), known = new Set(measured.map(x=>`${x.source_kind}:${x.source_id}`));
    return { scope: 'lifetime_observations_only', measured_units: measured.reduce((sum,x)=>sum+BigInt(x.quantity),0n).toString(),
      unresolved_sources: rows.filter(x=>x.state==='unknown'&&!known.has(`${x.source_kind}:${x.source_id}`)).length,
      customer_charge: null, provider_spend: null };
  }
}
