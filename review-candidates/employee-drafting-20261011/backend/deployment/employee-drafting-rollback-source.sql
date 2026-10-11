-- SOURCE-ONLY ROLLBACK REVIEW CANDIDATE. DO NOT EXECUTE WITHOUT DEPLOYMENT AUTHORIZATION.
-- Exact definitions and ACLs captured read-only 2026-10-11T01:30:53.963846Z.
-- Reverts ONLY employee-drafting function/trigger changes; never deletes work or changes activation.
-- Existing employee drafts may become blocked under restored manager-only queue/approval policy.
-- Prefer a forward fix when employee work is already reserved, uncertain, or awaiting review.
-- Stop new admission / restore previous Edge and UI sources as described in rollout notes.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DROP TRIGGER IF EXISTS installed_draft_review_guard ON public.ai_draft_runs;


CREATE OR REPLACE FUNCTION private.ai_inference_run_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
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
END $function$;

REVOKE ALL ON FUNCTION private.ai_inference_run_guard() FROM PUBLIC,"anon","authenticated","postgres","service_role";

GRANT EXECUTE ON FUNCTION private.ai_inference_run_guard() TO "postgres";

GRANT EXECUTE ON FUNCTION private.ai_inference_run_guard() TO "service_role";

CREATE OR REPLACE FUNCTION private.customer_knowledge_seal(p_org uuid, p_actor uuid, p_workflow uuid, p_key uuid, p_refs jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE sources jsonb; previous private.customer_knowledge_snapshots; w public.customer_reply_workflows;
BEGIN
 PERFORM private.customer_workflow_lock(p_org);PERFORM public.ai_draft_authorize(p_org,p_actor);
 w:=private.customer_workflow_access(p_org,p_actor,p_workflow,true);
 IF p_key IS NULL OR w.status='cancelled' OR w.action_request_id IS NOT NULL THEN RAISE EXCEPTION 'Workflow is closed for drafting';END IF;
 sources:=private.customer_knowledge_resolve(p_org,p_actor,p_refs);
 SELECT * INTO previous FROM private.customer_knowledge_snapshots WHERE organization_id=p_org AND request_key=p_key;
 IF FOUND THEN
  IF previous.workflow_id<>p_workflow OR previous.actor_user_id<>p_actor OR previous.source_refs<>p_refs OR previous.sources<>sources THEN RAISE EXCEPTION 'Knowledge snapshot conflict';END IF;
  RETURN;
 END IF;
 INSERT INTO private.customer_knowledge_snapshots(organization_id,workflow_id,request_key,actor_user_id,source_refs,sources) VALUES(p_org,p_workflow,p_key,p_actor,p_refs,sources);
END $function$;

REVOKE ALL ON FUNCTION private.customer_knowledge_seal(uuid,uuid,uuid,uuid,jsonb) FROM PUBLIC,"anon","authenticated","postgres","service_role";

GRANT EXECUTE ON FUNCTION private.customer_knowledge_seal(uuid,uuid,uuid,uuid,jsonb) TO "postgres";

GRANT EXECUTE ON FUNCTION private.customer_knowledge_seal(uuid,uuid,uuid,uuid,jsonb) TO "service_role";

CREATE OR REPLACE FUNCTION private.customer_workflow_assert_action(a action_requests)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE w public.customer_reply_workflows; draft public.ai_draft_runs;
BEGIN
 IF a.customer_workflow_id IS NULL THEN RETURN;END IF;
 PERFORM private.customer_workflow_lock(a.organization_id);
 SELECT * INTO w FROM public.customer_reply_workflows WHERE id=a.customer_workflow_id AND organization_id=a.organization_id FOR UPDATE;
 IF NOT FOUND OR w.status<>'awaiting_approval' OR w.action_request_id IS DISTINCT FROM a.id THEN RAISE EXCEPTION 'Customer workflow cancelled or binding changed';END IF;
 IF NOT private.customer_knowledge_fresh(w.organization_id,w.ai_request_key) THEN RAISE EXCEPTION 'Knowledge source changed or unavailable';END IF;
 IF w.context_version_id IS DISTINCT FROM (SELECT id FROM public.customer_reply_context_versions WHERE organization_id=w.organization_id ORDER BY version DESC LIMIT 1) THEN RAISE EXCEPTION 'Company context changed; proposal is stale';END IF;
 IF w.configuration_id IS DISTINCT FROM (SELECT id FROM public.ai_draft_configurations WHERE organization_id=w.organization_id ORDER BY version DESC LIMIT 1) THEN RAISE EXCEPTION 'AI configuration changed; proposal is stale';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.organization_members WHERE organization_id=w.organization_id AND user_id=w.assigned_to AND role IN ('owner','admin','consultant','member')) THEN RAISE EXCEPTION 'Assignee authorization revoked';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.organization_members WHERE organization_id=w.organization_id AND user_id=a.requested_by AND role IN ('owner','admin','consultant','member')) THEN RAISE EXCEPTION 'Proposer authorization revoked';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.organization_members WHERE organization_id=w.organization_id AND user_id=w.draft_requested_by AND role IN ('owner','admin','consultant')) THEN RAISE EXCEPTION 'Draft author authorization revoked';END IF;
 IF a.approved_by IS NULL OR a.approved_by IN (a.requested_by,w.requested_by,w.draft_requested_by,w.assigned_to) OR NOT EXISTS(SELECT 1 FROM public.organization_members WHERE organization_id=w.organization_id AND user_id=a.approved_by AND role IN ('owner','admin','consultant')) THEN RAISE EXCEPTION 'Distinct authorized employee approval required';END IF;
 SELECT * INTO draft FROM public.ai_draft_runs WHERE organization_id=w.organization_id AND request_key=w.ai_request_key AND configuration_id=w.configuration_id AND requested_by=w.draft_requested_by;
 IF NOT FOUND OR NOT private.customer_knowledge_citations(w.organization_id,w.ai_request_key,draft.draft) OR draft.status<>'accepted' OR a.payload IS DISTINCT FROM jsonb_build_object('to',w.customer_email,'subject',draft.draft->>'title','message',draft.draft->>'body') THEN RAISE EXCEPTION 'Exact accepted customer draft required';END IF;
END $function$;

REVOKE ALL ON FUNCTION private.customer_workflow_assert_action(public.action_requests) FROM PUBLIC,"anon","authenticated","postgres","service_role";

GRANT EXECUTE ON FUNCTION private.customer_workflow_assert_action(public.action_requests) TO "postgres";

GRANT EXECUTE ON FUNCTION private.customer_workflow_assert_action(public.action_requests) TO "service_role";

CREATE OR REPLACE FUNCTION private.workflow_installation_readiness(v workflow_installation_versions, p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE reasons jsonb:='[]'; c public.customer_reply_context_versions; cfg public.ai_draft_configurations; fingerprint text; assignee uuid; reviewer uuid; can_start boolean; actor_role text;
BEGIN
 SELECT * INTO c FROM public.customer_reply_context_versions WHERE organization_id=v.organization_id ORDER BY version DESC LIMIT 1;
 SELECT * INTO cfg FROM public.ai_draft_configurations WHERE organization_id=v.organization_id ORDER BY version DESC LIMIT 1;
 IF v.bindings->>'context_version_id' IS NULL THEN reasons:=reasons||'"context_missing"'::jsonb;
 ELSIF c.id IS NULL OR c.id::text IS DISTINCT FROM v.bindings->>'context_version_id' THEN reasons:=reasons||'"context_changed"'::jsonb;END IF;
 IF v.bindings->>'configuration_id' IS NULL THEN reasons:=reasons||'"configuration_missing"'::jsonb;
 ELSIF cfg.id IS NULL OR cfg.id::text IS DISTINCT FROM v.bindings->>'configuration_id' OR cfg.configuration->>'task' IS DISTINCT FROM 'customer_reply' OR cfg.configuration->>'source' IS DISTINCT FROM 'manual_context' OR cfg.configuration->'human_review' IS DISTINCT FROM 'true'::jsonb THEN reasons:=reasons||'"configuration_changed"'::jsonb;END IF;
 IF v.bindings->>'microsoft_connection_id' IS NULL THEN reasons:=reasons||'"microsoft_missing"'::jsonb;
 ELSE
  fingerprint:=private.workflow_installation_connection(v.organization_id,(v.bindings->>'microsoft_connection_id')::uuid);
  IF fingerprint IS NULL OR fingerprint IS DISTINCT FROM v.microsoft_binding_sha256 THEN reasons:=reasons||'"microsoft_changed"'::jsonb;END IF;
 END IF;
 assignee:=(v.bindings->>'assigned_to')::uuid;reviewer:=(v.bindings->>'reviewer_id')::uuid;
 -- Callers hold the organization row mutex. The existing kairo_guard_membership
 -- trigger acquires the same mutex for every membership mutation at READ COMMITTED.
 -- Do not row-lock memberships: service_role intentionally has SELECT-only access.
 IF assignee IS NULL THEN reasons:=reasons||'"assignee_missing"'::jsonb;
 ELSIF NOT EXISTS(SELECT 1 FROM public.organization_members WHERE organization_id=v.organization_id AND user_id=assignee AND role IN ('owner','admin','consultant','member')) THEN reasons:=reasons||'"assignee_unavailable"'::jsonb;END IF;
 IF reviewer IS NULL THEN reasons:=reasons||'"reviewer_missing"'::jsonb;
 ELSIF reviewer=assignee THEN reasons:=reasons||'"reviewer_conflict"'::jsonb;
 ELSIF NOT EXISTS(SELECT 1 FROM public.organization_members WHERE organization_id=v.organization_id AND user_id=reviewer AND role IN ('owner','admin','consultant')) THEN reasons:=reasons||'"reviewer_unavailable"'::jsonb;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.organization_members WHERE organization_id=v.organization_id AND role IN ('owner','admin','consultant') AND user_id IS DISTINCT FROM reviewer) THEN reasons:=reasons||'"draft_manager_missing"'::jsonb;END IF;
 IF v.revision IS DISTINCT FROM (SELECT revision FROM public.workflow_installations WHERE id=v.installation_id AND organization_id=v.organization_id) THEN reasons:=reasons||'"installation_changed"'::jsonb;END IF;
 SELECT role INTO actor_role FROM public.organization_members WHERE organization_id=v.organization_id AND user_id=p_actor;
 can_start:=reasons='[]'::jsonb AND p_actor IS DISTINCT FROM reviewer AND (actor_role IN ('owner','admin','consultant') OR (actor_role='member' AND p_actor=assignee));
 RETURN jsonb_build_object('configured',reasons='[]'::jsonb,'can_start',coalesce(can_start,false),'reasons',reasons,
 'start_blocker',CASE WHEN p_actor=reviewer THEN 'reviewer_conflict' WHEN actor_role='viewer' THEN 'read_only' WHEN actor_role='member' AND p_actor IS DISTINCT FROM assignee THEN 'assignment_required' ELSE NULL END,
 'live_inference_enabled',false,'automatic_execution_enabled',false,'source','manual_company_guidance','human_review_required',true);
END $function$;

REVOKE ALL ON FUNCTION private.workflow_installation_readiness(public.workflow_installation_versions,uuid) FROM PUBLIC,"anon","authenticated","postgres","service_role";

GRANT EXECUTE ON FUNCTION private.workflow_installation_readiness(public.workflow_installation_versions,uuid) TO "postgres";

GRANT EXECUTE ON FUNCTION private.workflow_installation_readiness(public.workflow_installation_versions,uuid) TO "service_role";

CREATE OR REPLACE FUNCTION public.ai_inference_dispatch(p_org uuid, p_actor uuid, p_config uuid, p_request_key uuid, p_run uuid, p_request_hash text, p_account text, p_fingerprint text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
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
END $function$;

REVOKE ALL ON FUNCTION public.ai_inference_dispatch(uuid,uuid,uuid,uuid,uuid,text,text,text) FROM PUBLIC,"anon","authenticated","postgres","service_role";

GRANT EXECUTE ON FUNCTION public.ai_inference_dispatch(uuid,uuid,uuid,uuid,uuid,text,text,text) TO "postgres";

GRANT EXECUTE ON FUNCTION public.ai_inference_dispatch(uuid,uuid,uuid,uuid,uuid,text,text,text) TO "service_role";

CREATE OR REPLACE FUNCTION public.ai_inference_reserve(p_org uuid, p_actor uuid, p_config uuid, p_request_key uuid, p_request_hash text, p_reserve bigint, p_account text, p_fingerprint text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
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
END $function$;

REVOKE ALL ON FUNCTION public.ai_inference_reserve(uuid,uuid,uuid,uuid,text,bigint,text,text) FROM PUBLIC,"anon","authenticated","postgres","service_role";

GRANT EXECUTE ON FUNCTION public.ai_inference_reserve(uuid,uuid,uuid,uuid,text,bigint,text,text) TO "postgres";

GRANT EXECUTE ON FUNCTION public.ai_inference_reserve(uuid,uuid,uuid,uuid,text,bigint,text,text) TO "service_role";

CREATE OR REPLACE FUNCTION public.customer_workflow_draft_input(p_org uuid, p_actor uuid, p_workflow uuid, p_expected_revision integer, p_config uuid, p_request_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE w public.customer_reply_workflows; c public.customer_reply_context_versions; source jsonb; snapshot private.customer_knowledge_snapshots; current_sources jsonb;
BEGIN
 PERFORM private.customer_workflow_lock(p_org);PERFORM public.ai_draft_authorize(p_org,p_actor);
 w:=private.customer_workflow_access(p_org,p_actor,p_workflow,true);
 IF w.status<>'drafting' OR w.revision IS DISTINCT FROM p_expected_revision OR w.configuration_id IS DISTINCT FROM p_config OR w.ai_request_key IS DISTINCT FROM p_request_key OR w.draft_requested_by IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'Draft binding changed';END IF;
 SELECT * INTO c FROM public.customer_reply_context_versions WHERE organization_id=p_org ORDER BY version DESC LIMIT 1;
 IF c.id IS DISTINCT FROM w.context_version_id THEN RAISE EXCEPTION 'Company context changed; prepare a new draft';END IF;
 IF w.configuration_id IS DISTINCT FROM (SELECT id FROM public.ai_draft_configurations WHERE organization_id=p_org ORDER BY version DESC LIMIT 1) THEN RAISE EXCEPTION 'AI configuration changed; prepare a new draft';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.organization_members WHERE organization_id=p_org AND user_id=w.assigned_to AND role IN ('owner','admin','consultant','member')) THEN RAISE EXCEPTION 'Assignee unavailable';END IF;
 SELECT * INTO snapshot FROM private.customer_knowledge_snapshots WHERE organization_id=p_org AND request_key=p_request_key;
 IF FOUND THEN
  IF snapshot.workflow_id<>w.id OR snapshot.actor_user_id<>p_actor THEN RAISE EXCEPTION 'Knowledge snapshot binding changed';END IF;
  current_sources:=private.customer_knowledge_resolve(p_org,p_actor,snapshot.source_refs);
  IF current_sources IS DISTINCT FROM snapshot.sources THEN RAISE EXCEPTION 'Knowledge snapshot changed';END IF;
 END IF;
 -- Explicit saved fields only. No profile, finance, credentials, document retrieval or inferred ingestion.
 source:=jsonb_build_object('company_context',c.context,'company_context_version',c.version,'customer_inquiry',jsonb_build_object('customer_name',w.customer_name,'subject',w.subject,'message',w.message));
 -- The email address is intentionally excluded from inference; only the immutable intake supplies the destination.
 RETURN jsonb_build_object('context',source::text)||CASE WHEN jsonb_array_length(coalesce(current_sources,'[]'))>0 THEN jsonb_build_object('sources',current_sources) ELSE '{}'::jsonb END;
END $function$;

REVOKE ALL ON FUNCTION public.customer_workflow_draft_input(uuid,uuid,uuid,integer,uuid,uuid) FROM PUBLIC,"anon","authenticated","postgres","service_role";

GRANT EXECUTE ON FUNCTION public.customer_workflow_draft_input(uuid,uuid,uuid,integer,uuid,uuid) TO "postgres";

GRANT EXECUTE ON FUNCTION public.customer_workflow_draft_input(uuid,uuid,uuid,integer,uuid,uuid) TO "service_role";

CREATE OR REPLACE FUNCTION public.customer_workflow_load(p_org uuid, p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
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
END $function$;

REVOKE ALL ON FUNCTION public.customer_workflow_load(uuid,uuid) FROM PUBLIC,"anon","authenticated","postgres","service_role";

GRANT EXECUTE ON FUNCTION public.customer_workflow_load(uuid,uuid) TO "postgres";

GRANT EXECUTE ON FUNCTION public.customer_workflow_load(uuid,uuid) TO "service_role";

CREATE OR REPLACE FUNCTION public.customer_workflow_prepare_sources(p_org uuid, p_actor uuid, p_workflow uuid, p_expected_revision integer, p_config uuid, p_request_key uuid, p_sources jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE w public.customer_reply_workflows; previous public.ai_draft_runs; config public.ai_draft_configurations; c public.customer_reply_context_versions; selected_sources jsonb; context_text text; input_bytes integer;
BEGIN
 PERFORM private.customer_workflow_lock(p_org);PERFORM public.ai_draft_authorize(p_org,p_actor);
 w:=private.customer_workflow_access(p_org,p_actor,p_workflow,true);
 IF w.status='cancelled' OR w.action_request_id IS NOT NULL THEN RAISE EXCEPTION 'Workflow is closed for drafting';END IF;
 IF w.ai_request_key=p_request_key THEN
  IF w.configuration_id IS DISTINCT FROM p_config OR w.draft_requested_by IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'Idempotency conflict';END IF;
  PERFORM private.customer_knowledge_seal(p_org,p_actor,w.id,p_request_key,p_sources);
  RETURN private.customer_workflow_project(w);
 END IF;
 IF w.revision IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'Workflow changed; reload';END IF;
 IF p_request_key IS NULL OR EXISTS(SELECT 1 FROM public.ai_draft_runs WHERE organization_id=p_org AND request_key=p_request_key) THEN RAISE EXCEPTION 'Use a new AI request key';END IF;
 SELECT * INTO previous FROM public.ai_draft_runs WHERE organization_id=p_org AND request_key=w.ai_request_key;
 -- Keep unadmitted keys as durable tombstones: a delayed old worker must never become an unbound manual run.
 IF w.ai_request_key IS NOT NULL AND NOT FOUND THEN RAISE EXCEPTION 'Prepared request is unresolved; resume same key or cancel';END IF;
 IF previous.status IN ('reserved','unknown') THEN RAISE EXCEPTION 'Unresolved model request requires reconciliation';END IF;
 SELECT * INTO c FROM public.customer_reply_context_versions WHERE organization_id=p_org ORDER BY version DESC LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION 'Saved company context required';END IF;
 IF previous.status IN ('awaiting_review','accepted') AND w.context_version_id=c.id AND w.configuration_id=(SELECT id FROM public.ai_draft_configurations WHERE organization_id=p_org ORDER BY version DESC LIMIT 1) THEN RAISE EXCEPTION 'Review or reject the existing draft first';END IF;
 SELECT * INTO config FROM public.ai_draft_configurations WHERE organization_id=p_org ORDER BY version DESC LIMIT 1;
 IF NOT FOUND OR config.id IS DISTINCT FROM p_config OR config.configuration->>'task' IS DISTINCT FROM 'customer_reply' THEN RAISE EXCEPTION 'Current customer reply configuration required';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.organization_members WHERE organization_id=p_org AND user_id=w.assigned_to AND role IN ('owner','admin','consultant','member')) THEN RAISE EXCEPTION 'Assignee unavailable';END IF;
 selected_sources:=private.customer_knowledge_resolve(p_org,p_actor,p_sources);
 context_text:=jsonb_build_object('company_context',c.context,'company_context_version',c.version,'customer_inquiry',jsonb_build_object('customer_name',w.customer_name,'subject',w.subject,'message',w.message))::text;
 input_bytes:=CASE WHEN jsonb_array_length(selected_sources)>0 THEN octet_length('{"context":'||to_json(context_text)::text||',"sources":'||private.customer_knowledge_wire(selected_sources)||'}') ELSE octet_length(context_text) END;
 IF input_bytes>(config.configuration->>'max_input_bytes')::integer THEN RAISE EXCEPTION 'Selected context exceeds saved AI input limit';END IF;
 PERFORM private.customer_knowledge_seal(p_org,p_actor,w.id,p_request_key,p_sources);
 UPDATE public.customer_reply_workflows SET status='drafting',context_version_id=c.id,configuration_id=p_config,ai_request_key=p_request_key,draft_requested_by=p_actor,revision=revision+1,updated_at=now(),updated_by=p_actor WHERE id=w.id RETURNING * INTO w;
 RETURN private.customer_workflow_project(w);
END $function$;

REVOKE ALL ON FUNCTION public.customer_workflow_prepare_sources(uuid,uuid,uuid,integer,uuid,uuid,jsonb) FROM PUBLIC,"anon","authenticated","postgres","service_role";

GRANT EXECUTE ON FUNCTION public.customer_workflow_prepare_sources(uuid,uuid,uuid,integer,uuid,uuid,jsonb) TO "postgres";

GRANT EXECUTE ON FUNCTION public.customer_workflow_prepare_sources(uuid,uuid,uuid,integer,uuid,uuid,jsonb) TO "service_role";

CREATE OR REPLACE FUNCTION public.customer_workflow_queue(p_org uuid, p_actor uuid, p_workflow uuid, p_expected_revision integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE w public.customer_reply_workflows; a public.ai_draft_runs; c public.oauth_connections; proposal public.action_requests; n integer; payload jsonb;
BEGIN
 PERFORM private.customer_workflow_lock(p_org);
 w:=private.customer_workflow_access(p_org,p_actor,p_workflow,true);
 IF w.status='cancelled' THEN RAISE EXCEPTION 'Workflow cancelled';END IF;
 IF w.action_request_id IS NOT NULL THEN RETURN private.customer_workflow_project(w);END IF;
 IF NOT private.customer_knowledge_fresh(p_org,w.ai_request_key) THEN RAISE EXCEPTION 'Knowledge source changed or unavailable';END IF;
 IF w.revision IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'Workflow changed; reload';END IF;
 IF w.context_version_id IS DISTINCT FROM (SELECT id FROM public.customer_reply_context_versions WHERE organization_id=p_org ORDER BY version DESC LIMIT 1) THEN RAISE EXCEPTION 'Company context changed; prepare a new draft';END IF;
 IF w.configuration_id IS DISTINCT FROM (SELECT id FROM public.ai_draft_configurations WHERE organization_id=p_org ORDER BY version DESC LIMIT 1) THEN RAISE EXCEPTION 'AI configuration changed; prepare a new draft';END IF;
 SELECT * INTO a FROM public.ai_draft_runs WHERE organization_id=p_org AND request_key=w.ai_request_key AND configuration_id=w.configuration_id AND requested_by=w.draft_requested_by FOR SHARE;
 IF NOT FOUND OR a.status<>'accepted' OR a.reviewed_by IS NULL THEN RAISE EXCEPTION 'Accepted AI draft required';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.organization_members WHERE organization_id=p_org AND user_id=w.assigned_to AND role IN ('owner','admin','consultant','member')) THEN RAISE EXCEPTION 'Assignee unavailable';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.organization_members WHERE organization_id=p_org AND user_id=w.draft_requested_by AND role IN ('owner','admin','consultant')) THEN RAISE EXCEPTION 'Draft author authorization revoked';END IF;
 IF jsonb_typeof(a.draft) IS DISTINCT FROM 'object' OR NOT a.draft ?& ARRAY['title','body','source_ids','warnings'] OR a.draft-ARRAY['title','body','source_ids','warnings']<>'{}'::jsonb
 OR jsonb_typeof(a.draft->'title') IS DISTINCT FROM 'string' OR length(btrim(a.draft->>'title')) NOT BETWEEN 1 AND 200 OR a.draft->>'title' ~ E'[\r\n]'
 OR jsonb_typeof(a.draft->'body') IS DISTINCT FROM 'string' OR length(btrim(a.draft->>'body')) NOT BETWEEN 1 AND 30000
 OR NOT private.customer_knowledge_citations(p_org,w.ai_request_key,a.draft)
 OR jsonb_typeof(a.draft->'warnings') IS DISTINCT FROM 'array' OR jsonb_array_length(a.draft->'warnings')>10
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(a.draft->'warnings') warning WHERE jsonb_typeof(warning)<>'string' OR length(warning #>> '{}')>1000) THEN RAISE EXCEPTION 'Invalid accepted AI draft';END IF;
 SELECT count(*) INTO n FROM public.oauth_connections x JOIN public.integrations i ON i.id=x.integration_id AND i.organization_id=x.organization_id WHERE x.organization_id=p_org AND x.provider='microsoft' AND x.status='Connected' AND x.oauth_verified_version=1 AND nullif(btrim(x.external_account_id),'') IS NOT NULL AND 'Mail.Send'=ANY(x.scopes) AND i.provider='Microsoft' AND i.integration_type='OAuth' AND i.status='Connected';
 IF n<>1 THEN RAISE EXCEPTION 'One verified Microsoft Mail.Send connection required';END IF;
 SELECT x.* INTO c FROM public.oauth_connections x JOIN public.integrations i ON i.id=x.integration_id AND i.organization_id=x.organization_id WHERE x.organization_id=p_org AND x.provider='microsoft' AND x.status='Connected' AND x.oauth_verified_version=1 AND nullif(btrim(x.external_account_id),'') IS NOT NULL AND 'Mail.Send'=ANY(x.scopes) AND i.provider='Microsoft' AND i.integration_type='OAuth' AND i.status='Connected' FOR SHARE OF x,i;
 payload:=jsonb_build_object('to',w.customer_email,'subject',a.draft->>'title','message',a.draft->>'body');
 INSERT INTO public.action_requests(organization_id,integration_id,connection_id,provider,action_type,status,title,summary,payload,requested_by,workflow_run_id,customer_workflow_id)
 VALUES(p_org,c.integration_id,c.id,'microsoft','send_email','Pending','Customer reply approval','Review customer reply: '||(a.draft->>'title'),payload,p_actor,NULL,w.id) RETURNING * INTO proposal;
 UPDATE public.customer_reply_workflows SET status='awaiting_approval',action_request_id=proposal.id,revision=revision+1,updated_at=now(),updated_by=p_actor WHERE id=w.id RETURNING * INTO w;
 RETURN private.customer_workflow_project(w);
END $function$;

REVOKE ALL ON FUNCTION public.customer_workflow_queue(uuid,uuid,uuid,integer) FROM PUBLIC,"anon","authenticated","postgres","service_role";

GRANT EXECUTE ON FUNCTION public.customer_workflow_queue(uuid,uuid,uuid,integer) TO "postgres";

GRANT EXECUTE ON FUNCTION public.customer_workflow_queue(uuid,uuid,uuid,integer) TO "service_role";

CREATE OR REPLACE FUNCTION public.customer_workflow_visible_run(p_org uuid, p_actor uuid, p_run uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE r public.ai_draft_runs; sources jsonb; stale boolean;
BEGIN
 PERFORM private.customer_workflow_lock(p_org);PERFORM public.ai_draft_authorize(p_org,p_actor);
 SELECT * INTO r FROM public.ai_draft_runs WHERE organization_id=p_org AND id=p_run;
 IF NOT FOUND THEN RAISE EXCEPTION 'Run unavailable';END IF;
 stale:=NOT private.customer_knowledge_fresh(p_org,r.request_key);
 SELECT CASE WHEN stale THEN '[]'::jsonb ELSE s.sources END INTO sources FROM private.customer_knowledge_snapshots s WHERE s.organization_id=p_org AND s.request_key=r.request_key;
 IF r.knowledge_bound AND (sources IS NULL OR stale) THEN r.draft:=NULL;stale:=true;END IF;
 RETURN to_jsonb(r)||jsonb_build_object('knowledge_sources',coalesce(sources,'[]'::jsonb),'knowledge_stale',stale);
END $function$;

REVOKE ALL ON FUNCTION public.customer_workflow_visible_run(uuid,uuid,uuid) FROM PUBLIC,"anon","authenticated","postgres","service_role";

GRANT EXECUTE ON FUNCTION public.customer_workflow_visible_run(uuid,uuid,uuid) TO "postgres";

GRANT EXECUTE ON FUNCTION public.customer_workflow_visible_run(uuid,uuid,uuid) TO "service_role";

DROP FUNCTION IF EXISTS public.customer_workflow_ai_readiness(uuid,uuid,uuid,integer,uuid,uuid,text,text);

DROP FUNCTION IF EXISTS private.workflow_installation_draft_review_guard();

DROP FUNCTION IF EXISTS private.ai_inference_authorize_request(uuid,uuid,uuid,uuid);

DROP FUNCTION IF EXISTS private.customer_workflow_draft_project(public.customer_reply_workflows,uuid);

DROP FUNCTION IF EXISTS private.customer_workflow_draft_authorize(uuid,uuid,uuid);

COMMIT;
