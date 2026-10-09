-- SOURCE-ONLY REVIEW CONTRACT. Apply only after the billing foundation contract.
-- No scheduler, listener, provider calls, live installation, or runtime role grants.
BEGIN;
CREATE TABLE kairo_billing.reconciliation_jobs (
 id uuid PRIMARY KEY,
 queue_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 binding_id text NOT NULL REFERENCES kairo_billing.provider_bindings(id) ON DELETE RESTRICT,
 kind text NOT NULL CHECK(kind IN ('resolve_receipt','reconcile_subscription')),
 subject_id text NOT NULL,
 source_revision bigint NOT NULL CHECK(source_revision BETWEEN 1 AND 9007199254740991),
 source_sha256 text CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN ('queued','leased','retry','completed','superseded')),
 fence bigint NOT NULL DEFAULT 0 CHECK(fence BETWEEN 0 AND 9007199254740991),
 attempts bigint NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 9007199254740991),
 next_attempt_at bigint NOT NULL CHECK(next_attempt_at>=0),
 lease_expires_at bigint CHECK(lease_expires_at>=0),
 created_at bigint NOT NULL CHECK(created_at>=0),
 updated_at bigint NOT NULL CHECK(updated_at>=created_at),
 completed_at bigint CHECK(completed_at>=created_at),
 last_error_code text CHECK(last_error_code ~ '^[a-z][a-z0-9_]{0,95}$'),
 UNIQUE(binding_id,kind,subject_id,source_revision),
 CHECK((kind='resolve_receipt' AND source_revision=1 AND source_sha256 IS NOT NULL)
    OR (kind='reconcile_subscription' AND source_sha256 IS NULL)),
 CHECK((state='leased')=(lease_expires_at IS NOT NULL)),
 CHECK((state IN ('completed','superseded'))=(completed_at IS NOT NULL))
);
CREATE INDEX reconciliation_jobs_ready ON kairo_billing.reconciliation_jobs(next_attempt_at,created_at,queue_order)
 WHERE state IN ('queued','retry');
CREATE INDEX reconciliation_jobs_expired ON kairo_billing.reconciliation_jobs(lease_expires_at,queue_order) WHERE state='leased';
CREATE TABLE kairo_billing.reconciliation_job_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 job_id uuid NOT NULL REFERENCES kairo_billing.reconciliation_jobs(id) ON DELETE RESTRICT,
 event text NOT NULL CHECK(event IN ('enqueued','claimed','lease_expired','retried','completed','superseded')),
 fence bigint NOT NULL CHECK(fence>=0), attempt bigint NOT NULL CHECK(attempt>=0),
 occurred_at bigint NOT NULL CHECK(occurred_at>=0),
 error_code text CHECK(error_code ~ '^[a-z][a-z0-9_]{0,95}$')
);
CREATE INDEX reconciliation_history_job ON kairo_billing.reconciliation_job_history(job_id,id);
CREATE FUNCTION kairo_billing.validate_reconciliation_job() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF ROW(NEW.id,NEW.queue_order,NEW.binding_id,NEW.kind,NEW.subject_id,NEW.source_revision,NEW.source_sha256,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.queue_order,OLD.binding_id,OLD.kind,OLD.subject_id,OLD.source_revision,OLD.source_sha256,OLD.created_at)
 OR OLD.state IN ('completed','superseded') OR NEW.updated_at<OLD.updated_at
 OR NEW.fence<OLD.fence OR NEW.fence>OLD.fence+1
 OR NEW.attempts<OLD.attempts OR NEW.attempts>OLD.attempts+1
 OR (NEW.fence<>OLD.fence AND (NEW.state<>'leased' OR NEW.attempts<>OLD.attempts+1))
 OR (NEW.attempts<>OLD.attempts AND NEW.fence<>OLD.fence+1)
 THEN RAISE EXCEPTION 'Reconciliation job identity or transition conflict' USING ERRCODE='40001'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reconciliation_job_guard BEFORE UPDATE ON kairo_billing.reconciliation_jobs
 FOR EACH ROW EXECUTE FUNCTION kairo_billing.validate_reconciliation_job();
CREATE TRIGGER reconciliation_job_no_delete BEFORE DELETE ON kairo_billing.reconciliation_jobs
 FOR EACH ROW EXECUTE FUNCTION kairo_billing.immutable_ledger();
CREATE TRIGGER reconciliation_job_no_truncate BEFORE TRUNCATE ON kairo_billing.reconciliation_jobs
 FOR EACH STATEMENT EXECUTE FUNCTION kairo_billing.immutable_ledger();
CREATE TRIGGER reconciliation_history_immutable BEFORE UPDATE OR DELETE ON kairo_billing.reconciliation_job_history
 FOR EACH ROW EXECUTE FUNCTION kairo_billing.immutable_ledger();
CREATE TRIGGER reconciliation_history_no_truncate BEFORE TRUNCATE ON kairo_billing.reconciliation_job_history
 FOR EACH STATEMENT EXECUTE FUNCTION kairo_billing.immutable_ledger();
ALTER TABLE kairo_billing.reconciliation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE kairo_billing.reconciliation_job_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON kairo_billing.reconciliation_jobs,kairo_billing.reconciliation_job_history FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON SEQUENCE kairo_billing.reconciliation_job_history_id_seq FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON SEQUENCE kairo_billing.reconciliation_jobs_queue_order_seq FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION kairo_billing.validate_reconciliation_job() FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
