-- Reviewed OFF-only installation candidate. Apply AFTER knowledge-draft-contract.sql.
-- No approval rows, keys, model catalog, account grants, or enabling statements are installed.
BEGIN;
DO $$ BEGIN
 IF to_regprocedure('public.customer_workflow_load(uuid,uuid)') IS NULL
 OR to_regprocedure('public.customer_workflow_draft_dispatch(uuid,uuid,uuid,integer,uuid,uuid,uuid,text)') IS NULL
 OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='ai_draft_runs' AND column_name='knowledge_bound')
 THEN RAISE EXCEPTION 'Install the complete knowledge-draft contract before activation controls';END IF;
END $$;
CREATE TABLE private.ai_inference_activations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES public.organizations(id),
 version integer NOT NULL CHECK(version>0), enabled boolean NOT NULL DEFAULT false,
 configuration_id uuid REFERENCES public.ai_draft_configurations(id), provider text, model text,
 account_reference text, credential_sha256 text,
 approved_by uuid REFERENCES auth.users(id), approval_reference text,
 approved_at timestamptz, expires_at timestamptz,
 request_microusd bigint, daily_microusd bigint, total_microusd bigint,
 daily_runs integer, total_runs integer,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id,version),
 CHECK(NOT enabled OR (
  configuration_id IS NOT NULL AND provider IN ('openai','anthropic','gemini') AND model ~ '^[-a-zA-Z0-9._:]{1,100}$'
  AND account_reference IS NOT NULL AND length(btrim(account_reference)) BETWEEN 1 AND 200
  AND credential_sha256 IS NOT NULL AND credential_sha256 ~ '^[a-f0-9]{64}$'
  AND approved_by IS NOT NULL AND approval_reference IS NOT NULL AND length(btrim(approval_reference)) BETWEEN 1 AND 500
  AND approved_at IS NOT NULL AND expires_at IS NOT NULL AND isfinite(approved_at) AND isfinite(expires_at) AND expires_at>approved_at
  AND request_microusd BETWEEN 1 AND 1000000 AND daily_microusd BETWEEN 1 AND 100000000 AND total_microusd BETWEEN 1 AND 100000000
  AND request_microusd<=daily_microusd AND daily_microusd<=total_microusd
  AND daily_runs BETWEEN 1 AND 100 AND total_runs BETWEEN 1 AND 10000 AND daily_runs<=total_runs
 ) IS TRUE)
);
ALTER TABLE private.ai_inference_activations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.ai_inference_activations FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON private.ai_inference_activations TO service_role;
-- No browser or server runtime can create/enable/update/delete approval records.
CREATE FUNCTION private.ai_inference_activation_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE v integer;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Activation approvals are append-only';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Requires READ COMMITTED';END IF;
 PERFORM 1 FROM public.organizations WHERE id=NEW.organization_id FOR UPDATE;
 SELECT coalesce(max(version),0) INTO v FROM private.ai_inference_activations WHERE organization_id=NEW.organization_id;
 IF NEW.version<>v+1 THEN RAISE EXCEPTION 'Activation revision changed';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_activation_immutable BEFORE INSERT OR UPDATE OR DELETE ON private.ai_inference_activations FOR EACH ROW EXECUTE FUNCTION private.ai_inference_activation_guard();
CREATE TRIGGER ai_activation_no_truncate BEFORE TRUNCATE ON private.ai_inference_activations FOR EACH STATEMENT EXECUTE FUNCTION private.ai_inference_activation_guard();
REVOKE ALL ON FUNCTION private.ai_inference_activation_guard() FROM PUBLIC,anon,authenticated,service_role;

ALTER TABLE public.ai_draft_runs ADD COLUMN activation_id uuid REFERENCES private.ai_inference_activations(id), ADD COLUMN activation_dispatch_started_at timestamptz;
CREATE INDEX ai_draft_activation_usage ON public.ai_draft_runs(activation_id);

-- One authoritative evaluation for saved readiness, admission and dispatch.
-- Identity/fingerprint never appear in the returned public projection.
CREATE FUNCTION private.ai_inference_status(p_org uuid,p_config uuid,p_account text DEFAULT NULL,p_fingerprint text DEFAULT NULL,p_require_credential boolean DEFAULT false,p_reserve bigint DEFAULT 0,p_run uuid DEFAULT NULL,p_at timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE a private.ai_inference_activations; c public.ai_draft_configurations; r public.ai_draft_runs;
 reason text:='activation_missing'; now_at timestamptz:=coalesce(p_at,clock_timestamp()); total_spent bigint; day_spent bigint; total_count bigint; day_count bigint; credential_matches boolean:=false;
BEGIN
 SELECT * INTO a FROM private.ai_inference_activations WHERE organization_id=p_org ORDER BY version DESC LIMIT 1;
 IF FOUND THEN
  reason:='activation_disabled';
  IF a.enabled IS TRUE THEN
   SELECT * INTO c FROM public.ai_draft_configurations WHERE organization_id=p_org ORDER BY version DESC LIMIT 1;
   reason:='activation_invalid';
   IF a.configuration_id IS NOT NULL AND a.provider IN ('openai','anthropic','gemini') AND a.model ~ '^[-a-zA-Z0-9._:]{1,100}$'
    AND length(btrim(a.account_reference)) BETWEEN 1 AND 200 AND a.credential_sha256 ~ '^[a-f0-9]{64}$'
    AND a.approved_by IS NOT NULL AND length(btrim(a.approval_reference)) BETWEEN 1 AND 500
    AND isfinite(a.approved_at) AND isfinite(a.expires_at) AND a.expires_at>a.approved_at AND a.approved_at<=now_at
    AND a.request_microusd BETWEEN 1 AND 1000000 AND a.daily_microusd BETWEEN 1 AND 100000000 AND a.total_microusd BETWEEN 1 AND 100000000
    AND a.request_microusd<=a.daily_microusd AND a.daily_microusd<=a.total_microusd
    AND a.daily_runs BETWEEN 1 AND 100 AND a.total_runs BETWEEN 1 AND 10000 AND a.daily_runs<=a.total_runs
    AND EXISTS(SELECT 1 FROM public.organization_members WHERE organization_id=p_org AND user_id=a.approved_by AND role='owner') THEN
    reason:='activation_authorized';
    IF a.expires_at<=now_at THEN reason:='activation_expired';
    ELSIF c.id IS NULL OR a.configuration_id IS DISTINCT FROM c.id OR p_config IS DISTINCT FROM c.id OR a.provider IS DISTINCT FROM c.configuration->>'provider' OR a.model IS DISTINCT FROM c.configuration->>'model' THEN reason:='activation_configuration_changed';
    END IF;
    credential_matches:=p_account IS NOT NULL AND p_fingerprint IS NOT NULL AND a.account_reference=p_account AND a.credential_sha256=p_fingerprint;
    IF reason='activation_authorized' AND p_require_credential AND NOT credential_matches THEN reason:='activation_account_mismatch';END IF;
    IF reason='activation_authorized' THEN
     IF p_run IS NOT NULL THEN
      SELECT * INTO r FROM public.ai_draft_runs WHERE id=p_run AND organization_id=p_org;
      IF NOT FOUND OR r.activation_id IS DISTINCT FROM a.id OR r.configuration_id IS DISTINCT FROM c.id OR r.status<>'reserved' THEN reason:='activation_configuration_changed';END IF;
     END IF;
     SELECT coalesce(sum(reserved_microusd),0),count(*) INTO total_spent,total_count FROM public.ai_draft_runs WHERE organization_id=p_org AND activation_id=a.id;
     SELECT coalesce(sum(reserved_microusd),0),count(*) INTO day_spent,day_count FROM public.ai_draft_runs WHERE organization_id=p_org AND reservation_day=(now_at AT TIME ZONE 'UTC')::date;
     IF p_reserve IS NULL OR p_reserve<0 OR p_reserve>a.request_microusd OR total_spent+p_reserve>a.total_microusd OR day_spent+p_reserve>a.daily_microusd
      OR (p_run IS NULL AND p_reserve=0 AND (total_spent>=a.total_microusd OR day_spent>=a.daily_microusd)) THEN reason:='activation_budget_exhausted';
     ELSIF total_count+(CASE WHEN p_reserve>0 THEN 1 ELSE 0 END)>a.total_runs OR day_count+(CASE WHEN p_reserve>0 THEN 1 ELSE 0 END)>a.daily_runs
      OR (p_run IS NULL AND p_reserve=0 AND (total_count>=a.total_runs OR day_count>=a.daily_runs)) THEN reason:='activation_run_limit';END IF;
    END IF;
   END IF;
  END IF;
 END IF;
 RETURN jsonb_build_object('contract_version',1,'organization_id',p_org,'configuration_id',p_config,'enabled',reason='activation_authorized','status',reason,'activation_id',a.id,
  'expires_at',CASE WHEN a.expires_at IS NOT NULL AND isfinite(a.expires_at) THEN a.expires_at ELSE NULL END,
  'account_binding_verified',reason='activation_authorized' AND credential_matches,
  'limits',CASE WHEN a.enabled THEN jsonb_build_object('request_microusd',a.request_microusd,'daily_microusd',a.daily_microusd,'total_microusd',a.total_microusd,'daily_runs',a.daily_runs,'total_runs',a.total_runs) ELSE NULL END);
END $$;
REVOKE ALL ON FUNCTION private.ai_inference_status(uuid,uuid,text,text,boolean,bigint,uuid,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.ai_inference_status(uuid,uuid,text,text,boolean,bigint,uuid,timestamptz) TO service_role;

CREATE FUNCTION public.ai_inference_readiness(p_org uuid,p_actor uuid,p_config uuid,p_account text DEFAULT NULL,p_fingerprint text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM public.ai_draft_authorize(p_org,p_actor);
 RETURN private.ai_inference_status(p_org,p_config,p_account,p_fingerprint,true);
END $$;

CREATE FUNCTION private.ai_inference_run_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE verdict jsonb; admission_at timestamptz; c public.ai_draft_configurations; spent bigint; runs bigint;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.id,NEW.organization_id,NEW.configuration_id,NEW.request_key,NEW.request_hash,NEW.requested_by,NEW.reserved_microusd,NEW.reservation_day,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.configuration_id,OLD.request_key,OLD.request_hash,OLD.requested_by,OLD.reserved_microusd,OLD.reservation_day,OLD.created_at) OR NEW.activation_id IS DISTINCT FROM OLD.activation_id OR (OLD.activation_dispatch_started_at IS NOT NULL AND NEW.activation_dispatch_started_at IS DISTINCT FROM OLD.activation_dispatch_started_at) THEN RAISE EXCEPTION 'Run activation binding is immutable';END IF;
  RETURN NEW;
 END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Requires READ COMMITTED';END IF;
 PERFORM 1 FROM public.organizations WHERE id=NEW.organization_id FOR UPDATE;
 PERFORM public.ai_draft_authorize(NEW.organization_id,NEW.requested_by);
 admission_at:=clock_timestamp();
 IF NEW.status<>'reserved' OR NEW.activation_dispatch_started_at IS NOT NULL THEN RAISE EXCEPTION 'Invalid new reservation state';END IF;
 NEW.created_at:=admission_at;
 NEW.reservation_day:=(admission_at AT TIME ZONE 'UTC')::date;
 verdict:=private.ai_inference_status(NEW.organization_id,NEW.configuration_id,NULL,NULL,false,NEW.reserved_microusd,NULL,admission_at);
 IF verdict->'enabled' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'AI activation denied: %',verdict->>'status';END IF;
 IF NEW.activation_id IS NOT NULL AND NEW.activation_id IS DISTINCT FROM (verdict->>'activation_id')::uuid THEN RAISE EXCEPTION 'Activation revision changed';END IF;
 SELECT * INTO c FROM public.ai_draft_configurations WHERE id=NEW.configuration_id AND organization_id=NEW.organization_id;
 SELECT coalesce(sum(reserved_microusd),0),count(*) INTO spent,runs FROM public.ai_draft_runs WHERE organization_id=NEW.organization_id AND reservation_day=NEW.reservation_day;
 IF spent+NEW.reserved_microusd>(c.configuration->>'daily_budget_microusd')::bigint OR runs>=(c.configuration->>'max_daily_runs')::integer THEN RAISE EXCEPTION 'Daily allowance exhausted';END IF;
 NEW.activation_id:=(verdict->>'activation_id')::uuid;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_inference_run_admission BEFORE INSERT OR UPDATE ON public.ai_draft_runs FOR EACH ROW EXECUTE FUNCTION private.ai_inference_run_guard();
REVOKE ALL ON FUNCTION private.ai_inference_run_guard() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.ai_inference_run_guard() TO service_role;

-- The old unbound reserve RPC is no longer available to the deployed runtime.
REVOKE EXECUTE ON FUNCTION public.ai_draft_reserve(uuid,uuid,uuid,uuid,text,bigint) FROM service_role;
CREATE FUNCTION public.ai_inference_reserve(p_org uuid,p_actor uuid,p_config uuid,p_request_key uuid,p_request_hash text,p_reserve bigint,p_account text,p_fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE c public.ai_draft_configurations; r public.ai_draft_runs; verdict jsonb; spent bigint; runs integer; reservation_date date;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Requires READ COMMITTED';END IF;
 PERFORM 1 FROM public.organizations WHERE id=p_org FOR UPDATE;
 PERFORM public.ai_draft_authorize(p_org,p_actor);
 SELECT * INTO r FROM public.ai_draft_runs WHERE organization_id=p_org AND request_key=p_request_key;
 IF FOUND THEN
  IF r.configuration_id<>p_config OR r.request_hash<>p_request_hash OR r.requested_by<>p_actor THEN RAISE EXCEPTION 'Idempotency conflict';END IF;
  RETURN jsonb_build_object('created',false,'run',to_jsonb(r));
 END IF;
 verdict:=private.ai_inference_status(p_org,p_config,p_account,p_fingerprint,true,p_reserve);
 IF verdict->'enabled' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'AI activation denied: %',verdict->>'status';END IF;
 IF EXISTS(SELECT 1 FROM public.ai_draft_runs WHERE organization_id=p_org AND status IN ('reserved','unknown')) THEN RAISE EXCEPTION 'Unresolved model request requires reconciliation';END IF;
 SELECT * INTO c FROM public.ai_draft_configurations WHERE organization_id=p_org ORDER BY version DESC LIMIT 1;
 IF NOT FOUND OR c.id<>p_config THEN RAISE EXCEPTION 'Configuration superseded; reload';END IF;
 reservation_date:=(clock_timestamp() AT TIME ZONE 'UTC')::date;
 SELECT coalesce(sum(reserved_microusd),0),count(*) INTO spent,runs FROM public.ai_draft_runs WHERE organization_id=p_org AND reservation_day=reservation_date;
 IF p_reserve IS NULL OR p_reserve<1 OR p_reserve>1000000 OR spent+p_reserve>(c.configuration->>'daily_budget_microusd')::bigint OR runs>=(c.configuration->>'max_daily_runs')::integer THEN RAISE EXCEPTION 'Daily allowance exhausted';END IF;
 INSERT INTO public.ai_draft_runs(organization_id,configuration_id,request_key,request_hash,requested_by,reserved_microusd,reservation_day,activation_id)
 VALUES(p_org,p_config,p_request_key,p_request_hash,p_actor,p_reserve,reservation_date,(verdict->>'activation_id')::uuid) RETURNING * INTO r;
 RETURN jsonb_build_object('created',true,'run',to_jsonb(r));
END $$;

CREATE FUNCTION public.ai_inference_dispatch(p_org uuid,p_actor uuid,p_config uuid,p_request_key uuid,p_run uuid,p_request_hash text,p_account text,p_fingerprint text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE r public.ai_draft_runs; verdict jsonb; dispatch_at timestamptz;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Requires READ COMMITTED';END IF;
 PERFORM 1 FROM public.organizations WHERE id=p_org FOR UPDATE;
 SELECT * INTO r FROM public.ai_draft_runs WHERE id=p_run AND organization_id=p_org FOR UPDATE;
 PERFORM public.ai_draft_authorize(p_org,p_actor);
 dispatch_at:=clock_timestamp();
 IF r.id IS NULL OR r.status<>'reserved' OR r.activation_dispatch_started_at IS NOT NULL OR r.reservation_day IS DISTINCT FROM (dispatch_at AT TIME ZONE 'UTC')::date OR r.requested_by IS DISTINCT FROM p_actor OR r.configuration_id IS DISTINCT FROM p_config OR r.request_key IS DISTINCT FROM p_request_key OR r.request_hash IS DISTINCT FROM p_request_hash THEN RAISE EXCEPTION 'Draft dispatch binding changed';END IF;
 verdict:=private.ai_inference_status(p_org,p_config,p_account,p_fingerprint,true,0,p_run,dispatch_at);
 IF verdict->'enabled' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'AI activation denied: %',verdict->>'status';END IF;
 -- Single-use claim. A crash after this point remains reserved/uncertain, never retried.
 UPDATE public.ai_draft_runs SET activation_dispatch_started_at=dispatch_at WHERE id=p_run;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.ai_inference_readiness(uuid,uuid,uuid,text,text),public.ai_inference_reserve(uuid,uuid,uuid,uuid,text,bigint,text,text),public.ai_inference_dispatch(uuid,uuid,uuid,uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ai_inference_readiness(uuid,uuid,uuid,text,text),public.ai_inference_reserve(uuid,uuid,uuid,uuid,text,bigint,text,text),public.ai_inference_dispatch(uuid,uuid,uuid,uuid,uuid,text,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.customer_workflow_load(p_org uuid,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE actor_role text; contexts jsonb; config jsonb; rows jsonb; people jsonb; microsoft boolean; account text; connection_identifier text; reviewers boolean; activation jsonb;
BEGIN
 PERFORM private.customer_workflow_lock(p_org);
 actor_role:=private.customer_workflow_role(p_org,p_actor);
 SELECT to_jsonb(c) INTO contexts FROM public.customer_reply_context_versions c WHERE organization_id=p_org ORDER BY version DESC LIMIT 1;
 SELECT to_jsonb(c) INTO config FROM public.ai_draft_configurations c WHERE organization_id=p_org ORDER BY version DESC LIMIT 1;
 SELECT coalesce(jsonb_agg(private.customer_workflow_project(w) ORDER BY w.created_at DESC,w.id),'[]'::jsonb) INTO rows
 FROM (SELECT * FROM public.customer_reply_workflows WHERE organization_id=p_org AND (actor_role<>'member' OR assigned_to=p_actor) ORDER BY created_at DESC,id LIMIT 100) w;
 SELECT coalesce(jsonb_agg(jsonb_build_object('user_id',user_id,'role',role) ORDER BY user_id),'[]'::jsonb) INTO people FROM public.organization_members WHERE organization_id=p_org AND role IN ('owner','admin','consultant','member');
 SELECT count(*)=1,min(c.external_account_id),min(c.id::text) INTO microsoft,account,connection_identifier FROM public.oauth_connections c JOIN public.integrations i ON i.id=c.integration_id AND i.organization_id=c.organization_id
 WHERE c.organization_id=p_org AND c.provider='microsoft' AND c.status='Connected' AND c.oauth_verified_version=1 AND nullif(btrim(c.external_account_id),'') IS NOT NULL AND 'Mail.Send'=ANY(c.scopes)
 AND i.status='Connected' AND i.provider='Microsoft' AND i.integration_type='OAuth';
 SELECT exists(SELECT 1 FROM public.organization_members WHERE organization_id=p_org AND user_id<>p_actor AND role IN ('owner','admin','consultant')) INTO reviewers;
 activation:=private.ai_inference_status(p_org,(config->>'id')::uuid);
 RETURN jsonb_build_object('knowledge_contract_version',1,'actor',jsonb_build_object('id',p_actor,'role',actor_role),'context',contexts,'configuration',config,'workflows',rows,'people',people,'limit',100,
 'readiness',jsonb_build_object('context_ready',contexts IS NOT NULL,'configuration_ready',coalesce(config->'configuration'->>'task'='customer_reply',false),'microsoft_ready',microsoft,'microsoft_connection_id',CASE WHEN microsoft THEN connection_identifier ELSE NULL END,'microsoft_account',CASE WHEN microsoft THEN account ELSE NULL END,'distinct_reviewer_available',reviewers,'live_inference_enabled',activation->'enabled','activation',activation));
END $$;

COMMIT;
