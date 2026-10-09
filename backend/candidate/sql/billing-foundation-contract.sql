-- SOURCE-ONLY REVIEW CONTRACT. No live installation or runtime role grants authorized.
-- No products, customers, subscriptions, prices, payment calls or commercial policy seed.
BEGIN;
CREATE SCHEMA kairo_billing;
REVOKE ALL ON SCHEMA kairo_billing FROM PUBLIC, anon, authenticated, service_role;
CREATE TABLE kairo_billing.provider_bindings (
 id text PRIMARY KEY, account_id text NOT NULL CHECK(account_id ~ '^acct_[A-Za-z0-9]+$'),
 livemode boolean NOT NULL, account_kind text NOT NULL CHECK(account_kind IN ('platform','connected')),
 api_version text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(account_id,livemode,account_kind)
);
CREATE TABLE kairo_billing.customer_bindings (
 binding_id text NOT NULL REFERENCES kairo_billing.provider_bindings(id),
 customer_id text NOT NULL CHECK(customer_id ~ '^cus_[A-Za-z0-9]+$'),
 organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(binding_id,customer_id),
 UNIQUE(binding_id,customer_id,organization_id), UNIQUE(binding_id,organization_id)
);
CREATE TABLE kairo_billing.provider_receipts (
 binding_id text NOT NULL REFERENCES kairo_billing.provider_bindings(id), event_id text NOT NULL,
 payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
 event_type text NOT NULL, object_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('subscription','invoice','refund','unresolved','ignored')),
 customer_id text, subscription_id text, terminal boolean NOT NULL,
 provider_created_at bigint NOT NULL CHECK(provider_created_at>=0), received_at bigint NOT NULL CHECK(received_at>=0),
 PRIMARY KEY(binding_id,event_id)
);
CREATE TABLE kairo_billing.receipt_links (
 binding_id text NOT NULL, event_id text NOT NULL, customer_id text NOT NULL,
 organization_id uuid NOT NULL, subscription_id text NOT NULL,
 resolution_evidence_sha256 text NOT NULL CHECK(resolution_evidence_sha256 ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(binding_id,event_id),
 FOREIGN KEY(binding_id,event_id) REFERENCES kairo_billing.provider_receipts(binding_id,event_id) ON DELETE RESTRICT,
 FOREIGN KEY(binding_id,customer_id,organization_id) REFERENCES kairo_billing.customer_bindings(binding_id,customer_id,organization_id) ON DELETE RESTRICT
);
CREATE TABLE kairo_billing.receipt_dispositions (
 binding_id text NOT NULL, event_id text NOT NULL, customer_id text NOT NULL,
 disposition text NOT NULL CHECK(disposition='not_subscription'),
 evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
 recorded_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(binding_id,event_id),
 FOREIGN KEY(binding_id,event_id) REFERENCES kairo_billing.provider_receipts(binding_id,event_id) ON DELETE RESTRICT
);
CREATE TABLE kairo_billing.subscription_projections (
 binding_id text NOT NULL, subscription_id text NOT NULL, customer_id text NOT NULL, organization_id uuid NOT NULL,
 revision bigint NOT NULL CHECK(revision>0), projection jsonb NOT NULL CHECK(jsonb_typeof(projection)='object'),
 PRIMARY KEY(binding_id,subscription_id),
 FOREIGN KEY(binding_id,customer_id,organization_id) REFERENCES kairo_billing.customer_bindings(binding_id,customer_id,organization_id) ON DELETE RESTRICT
);
CREATE TABLE kairo_billing.projection_history (
 binding_id text NOT NULL, subscription_id text NOT NULL, revision bigint NOT NULL,
 projection jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(binding_id,subscription_id,revision),
 FOREIGN KEY(binding_id,subscription_id) REFERENCES kairo_billing.subscription_projections(binding_id,subscription_id) ON DELETE RESTRICT
);
CREATE TABLE kairo_billing.policy_versions (
 policy_id text NOT NULL, version integer NOT NULL CHECK(version>0),
 binding_id text NOT NULL REFERENCES kairo_billing.provider_bindings(id),
 policy jsonb NOT NULL CHECK(jsonb_typeof(policy)='object'),
 policy_sha256 text NOT NULL CHECK(policy_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(policy_id,version)
);
CREATE TABLE kairo_billing.usage_events (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
 source_kind text NOT NULL CHECK(source_kind IN ('ai_draft_run','workflow_run','phone_call')),
 source_id uuid NOT NULL, source_started_at timestamptz, metric text NOT NULL, unit text NOT NULL,
 state text NOT NULL CHECK(state IN ('measured','unknown')), quantity bigint,
 evidence_ref text NOT NULL, observation_sha256 text NOT NULL CHECK(observation_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((state='unknown' AND quantity IS NULL) OR (state='measured' AND quantity IS NOT NULL AND quantity>=0 AND quantity<=9007199254740991)),
 UNIQUE(organization_id,source_kind,source_id,metric,state)
);
CREATE INDEX usage_events_rollup ON kairo_billing.usage_events(organization_id,metric,created_at) WHERE state='measured';
CREATE INDEX receipts_unresolved ON kairo_billing.provider_receipts(binding_id,customer_id) WHERE kind<>'ignored';
CREATE FUNCTION kairo_billing.immutable_ledger() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Billing history is append-only' USING ERRCODE='42501'; END $$;
CREATE FUNCTION kairo_billing.validate_usage_source() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE source_org uuid; source_table text; source_row jsonb; expected_quantity bigint; expected_unit text; fact jsonb; leg text; expected_started_at timestamptz;
BEGIN
 source_table:=CASE NEW.source_kind WHEN 'ai_draft_run' THEN 'public.ai_draft_runs' WHEN 'workflow_run' THEN 'public.workflow_runs' WHEN 'phone_call' THEN 'kairo_phone_intake.calls' END;
 IF to_regclass(source_table) IS NULL THEN RAISE EXCEPTION 'Usage source contract unavailable' USING ERRCODE='23503'; END IF;
 -- Table names are a fixed internal allowlist. No caller supplied SQL identifiers.
 EXECUTE format('SELECT to_jsonb(s) FROM %s s WHERE id=$1 FOR SHARE', source_table) INTO source_row USING NEW.source_id;
 source_org:=(source_row->>'organization_id')::uuid;
 IF source_org IS DISTINCT FROM NEW.organization_id THEN RAISE EXCEPTION 'Usage source tenant mismatch' USING ERRCODE='23503'; END IF;
 IF NEW.source_kind='ai_draft_run' THEN
  IF source_row->>'status' IS NULL OR source_row->>'status' NOT IN ('awaiting_review','accepted','rejected','failed','unknown') OR NEW.metric NOT IN ('ai_input_tokens','ai_output_tokens') THEN RAISE EXCEPTION 'Invalid AI usage source'; END IF;
  expected_started_at:=date_trunc('milliseconds',(source_row->>'created_at')::timestamptz); expected_unit:='token'; fact:=source_row->'usage'->replace(NEW.metric,'ai_','');
 ELSIF NEW.source_kind='workflow_run' THEN
  IF NEW.metric<>'workflow_runs' THEN RAISE EXCEPTION 'Invalid workflow usage metric'; END IF;
  expected_started_at:=date_trunc('milliseconds',(source_row->>'started_at')::timestamptz); expected_unit:='run'; fact:='1'::jsonb;
 ELSE
  leg:=CASE NEW.metric WHEN 'phone_parent_reported_seconds' THEN 'parent' WHEN 'phone_child_reported_seconds' THEN 'child' WHEN 'phone_dialResult_reported_seconds' THEN 'dialResult' END;
  IF leg IS NULL THEN RAISE EXCEPTION 'Invalid phone usage metric'; END IF;
  expected_started_at:=date_trunc('milliseconds',(source_row->>'admitted_at')::timestamptz); expected_unit:='second';
  IF source_row->'state'->leg->>'status' IN ('completed','busy','failed','no-answer','canceled') THEN fact:=source_row->'state'->leg->'duration'; END IF;
 END IF;
 IF jsonb_typeof(fact)='number' AND fact::text ~ '^[0-9]+$' AND (fact::text)::numeric<=9007199254740991 THEN expected_quantity:=(fact::text)::bigint; END IF;
 IF NEW.source_kind='phone_call' AND expected_quantity>999999999 THEN expected_quantity:=NULL; END IF;
 IF NEW.source_started_at IS DISTINCT FROM expected_started_at OR NEW.unit IS DISTINCT FROM expected_unit OR NEW.quantity IS DISTINCT FROM expected_quantity OR NEW.state IS DISTINCT FROM (CASE WHEN expected_quantity IS NULL THEN 'unknown' ELSE 'measured' END) THEN RAISE EXCEPTION 'Usage must match persisted source' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER usage_source_guard BEFORE INSERT ON kairo_billing.usage_events FOR EACH ROW EXECUTE FUNCTION kairo_billing.validate_usage_source();
CREATE FUNCTION kairo_billing.validate_projection() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.projection->>'binding_id' IS DISTINCT FROM NEW.binding_id OR NEW.projection->>'subscription_id' IS DISTINCT FROM NEW.subscription_id
 OR NEW.projection->>'customer_id' IS DISTINCT FROM NEW.customer_id OR NEW.projection->>'organization_id' IS DISTINCT FROM NEW.organization_id::text
 OR (NEW.projection->>'revision')::bigint IS DISTINCT FROM NEW.revision
 THEN RAISE EXCEPTION 'Projection identity mismatch' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (ROW(NEW.binding_id,NEW.subscription_id,NEW.customer_id,NEW.organization_id) IS DISTINCT FROM ROW(OLD.binding_id,OLD.subscription_id,OLD.customer_id,OLD.organization_id)
 OR NEW.revision<>OLD.revision+1 OR (OLD.projection->'terminal'='true'::jsonb AND NEW.projection->'terminal' IS DISTINCT FROM 'true'::jsonb))
 THEN RAISE EXCEPTION 'Projection lineage or revision conflict' USING ERRCODE='40001'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER projection_guard BEFORE INSERT OR UPDATE ON kairo_billing.subscription_projections FOR EACH ROW EXECUTE FUNCTION kairo_billing.validate_projection();
CREATE FUNCTION kairo_billing.save_projection_history() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 INSERT INTO kairo_billing.projection_history(binding_id,subscription_id,revision,projection) VALUES(NEW.binding_id,NEW.subscription_id,NEW.revision,NEW.projection);
 RETURN NEW;
END $$;
CREATE TRIGGER projection_history AFTER INSERT OR UPDATE ON kairo_billing.subscription_projections FOR EACH ROW EXECUTE FUNCTION kairo_billing.save_projection_history();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['provider_bindings','customer_bindings','provider_receipts','receipt_links','receipt_dispositions','projection_history','policy_versions','usage_events'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON kairo_billing.%I FOR EACH ROW EXECUTE FUNCTION kairo_billing.immutable_ledger()', t);
  EXECUTE format('CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON kairo_billing.%I FOR EACH STATEMENT EXECUTE FUNCTION kairo_billing.immutable_ledger()', t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['provider_bindings','customer_bindings','provider_receipts','receipt_links','receipt_dispositions','subscription_projections','projection_history','policy_versions','usage_events'] LOOP
  EXECUTE format('ALTER TABLE kairo_billing.%I ENABLE ROW LEVEL SECURITY',t);
 END LOOP;
END $$;
CREATE TRIGGER immutable_projection_delete BEFORE DELETE ON kairo_billing.subscription_projections FOR EACH ROW EXECUTE FUNCTION kairo_billing.immutable_ledger();
CREATE TRIGGER immutable_projection_truncate BEFORE TRUNCATE ON kairo_billing.subscription_projections FOR EACH STATEMENT EXECUTE FUNCTION kairo_billing.immutable_ledger();
REVOKE ALL ON ALL TABLES IN SCHEMA kairo_billing FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA kairo_billing FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
