-- SOURCE-ONLY REVIEW CANDIDATE. No live installation or grant change is authorized.
-- Requires the existing AI draft, Microsoft approval, OAuth, receipt and team contracts.
-- This connects their durable records; it does not create another dispatcher/approval engine.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
CREATE SCHEMA IF NOT EXISTS private;
DO $$ BEGIN
 IF NOT coalesce((SELECT relrowsecurity FROM pg_class WHERE oid='public.action_requests'::regclass),false) THEN
  RAISE EXCEPTION 'Existing action request RLS must be enabled before installing customer workflows';
 END IF;
END $$;
CREATE TABLE public.customer_reply_context_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id),
 version integer NOT NULL CHECK(version>0), context jsonb NOT NULL,
 source_kind text NOT NULL DEFAULT 'manual_company_guidance' CHECK(source_kind='manual_company_guidance'),
 created_by uuid NOT NULL REFERENCES auth.users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,version), UNIQUE(id,organization_id)
);
CREATE TABLE public.customer_reply_workflows (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id),
 request_key uuid NOT NULL, requested_by uuid NOT NULL REFERENCES auth.users(id), assigned_to uuid NOT NULL REFERENCES auth.users(id),
 customer_email text NOT NULL, customer_name text NOT NULL, subject text NOT NULL, message text NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 status text NOT NULL DEFAULT 'intake' CHECK(status IN ('intake','drafting','awaiting_approval','cancelled')),
 context_version_id uuid, configuration_id uuid REFERENCES public.ai_draft_configurations(id),
 ai_request_key uuid, draft_requested_by uuid REFERENCES auth.users(id), action_request_id uuid REFERENCES public.action_requests(id),
 cancelled_by uuid REFERENCES auth.users(id),cancelled_at timestamptz,
 updated_by uuid NOT NULL REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,request_key), UNIQUE(organization_id,ai_request_key), UNIQUE(action_request_id),
 UNIQUE(id,organization_id), FOREIGN KEY(context_version_id,organization_id) REFERENCES public.customer_reply_context_versions(id,organization_id)
);
CREATE INDEX customer_reply_queue ON public.customer_reply_workflows(organization_id,assigned_to,created_at DESC);
ALTER TABLE public.action_requests ADD COLUMN customer_workflow_id uuid;
ALTER TABLE public.action_requests ADD CONSTRAINT customer_action_tenant_binding
 FOREIGN KEY(customer_workflow_id,organization_id) REFERENCES public.customer_reply_workflows(id,organization_id);
CREATE UNIQUE INDEX customer_action_once ON public.action_requests(customer_workflow_id) WHERE customer_workflow_id IS NOT NULL;
ALTER TABLE public.customer_reply_context_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_reply_workflows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_reply_context_versions,public.customer_reply_workflows FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.customer_reply_context_versions TO service_role;
GRANT SELECT,INSERT,UPDATE ON public.customer_reply_workflows TO service_role;

CREATE FUNCTION private.customer_workflow_lock(p_org uuid) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Customer workflow requires READ COMMITTED';END IF;
 PERFORM 1 FROM public.organizations WHERE id=p_org FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Organization access denied';END IF;
END $$;
CREATE FUNCTION private.customer_workflow_role(p_org uuid,p_actor uuid) RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE r text;
BEGIN
 SELECT role INTO r FROM public.organization_members WHERE organization_id=p_org AND user_id=p_actor;
 IF r IS NULL OR r NOT IN ('owner','admin','consultant','member','viewer') THEN RAISE EXCEPTION 'Organization access denied';END IF;
 RETURN r;
END $$;
CREATE FUNCTION private.customer_workflow_access(p_org uuid,p_actor uuid,p_workflow uuid,p_write boolean DEFAULT false)
 RETURNS public.customer_reply_workflows LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE r public.customer_reply_workflows; actor_role text;
BEGIN
 actor_role:=private.customer_workflow_role(p_org,p_actor);
 SELECT * INTO r FROM public.customer_reply_workflows WHERE id=p_workflow AND organization_id=p_org;
 IF NOT FOUND OR (actor_role='member' AND r.assigned_to<>p_actor) OR (p_write AND actor_role='viewer') THEN RAISE EXCEPTION 'Workflow access denied';END IF;
 RETURN r;
END $$;
CREATE FUNCTION private.customer_context_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Company context versions are immutable';END $$;
CREATE TRIGGER customer_context_immutable BEFORE UPDATE OR DELETE ON public.customer_reply_context_versions FOR EACH ROW EXECUTE FUNCTION private.customer_context_immutable();
CREATE FUNCTION private.customer_intake_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF ROW(NEW.id,NEW.organization_id,NEW.request_key,NEW.requested_by,NEW.customer_email,NEW.customer_name,NEW.subject,NEW.message,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.request_key,OLD.requested_by,OLD.customer_email,OLD.customer_name,OLD.subject,OLD.message,OLD.created_at)
 THEN RAISE EXCEPTION 'Customer intake is immutable';END IF;
 IF OLD.action_request_id IS NOT NULL AND ROW(NEW.action_request_id,NEW.context_version_id,NEW.configuration_id,NEW.ai_request_key,NEW.draft_requested_by,NEW.assigned_to)
 IS DISTINCT FROM ROW(OLD.action_request_id,OLD.context_version_id,OLD.configuration_id,OLD.ai_request_key,OLD.draft_requested_by,OLD.assigned_to)
 THEN RAISE EXCEPTION 'Queued customer proposal is immutable';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER customer_intake_immutable BEFORE UPDATE ON public.customer_reply_workflows FOR EACH ROW EXECUTE FUNCTION private.customer_intake_immutable();

CREATE FUNCTION private.customer_workflow_project(w public.customer_reply_workflows) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE a public.ai_draft_runs; proposal public.action_requests; c public.customer_reply_context_versions; config public.ai_draft_configurations; receipt jsonb; projected_status text;
BEGIN
 SELECT * INTO a FROM public.ai_draft_runs WHERE organization_id=w.organization_id AND request_key=w.ai_request_key AND configuration_id=w.configuration_id AND requested_by=w.draft_requested_by;
 SELECT * INTO proposal FROM public.action_requests WHERE id=w.action_request_id AND organization_id=w.organization_id AND customer_workflow_id=w.id;
 SELECT * INTO c FROM public.customer_reply_context_versions WHERE id=w.context_version_id AND organization_id=w.organization_id;
 SELECT * INTO config FROM public.ai_draft_configurations WHERE id=w.configuration_id AND organization_id=w.organization_id;
 SELECT jsonb_build_object('phase',phase,'dispatch_started_at',dispatch_started_at,'provider_accepted_at',provider_accepted_at,'provider_reference',provider_reference,'reconciled_at',reconciled_at)
 INTO receipt FROM public.action_execution_receipts WHERE request_id=proposal.id AND organization_id=w.organization_id;
 projected_status:=w.status;
 IF w.status='drafting' THEN projected_status:=CASE a.status WHEN 'awaiting_review' THEN 'draft_ready' WHEN 'accepted' THEN 'draft_accepted' WHEN 'rejected' THEN 'draft_rejected' WHEN 'failed' THEN 'ai_failed' WHEN 'unknown' THEN 'ai_unknown' ELSE 'drafting' END;END IF;
 RETURN to_jsonb(w)||jsonb_build_object('status',projected_status,'ai_run',CASE WHEN a.id IS NULL THEN NULL ELSE to_jsonb(a) END,
 'action_request',CASE WHEN proposal.id IS NULL THEN NULL ELSE to_jsonb(proposal) END,'receipt',receipt,
 'context_version',CASE WHEN c.id IS NULL THEN NULL ELSE to_jsonb(c) END,'configuration',CASE WHEN config.id IS NULL THEN NULL ELSE to_jsonb(config) END,
 'configuration_stale',w.configuration_id IS NOT NULL AND w.configuration_id IS DISTINCT FROM (SELECT id FROM public.ai_draft_configurations WHERE organization_id=w.organization_id ORDER BY version DESC LIMIT 1),
 'context_stale',w.context_version_id IS NOT NULL AND w.context_version_id IS DISTINCT FROM (SELECT id FROM public.customer_reply_context_versions WHERE organization_id=w.organization_id ORDER BY version DESC LIMIT 1));
END $$;
CREATE FUNCTION public.customer_workflow_load(p_org uuid,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE actor_role text; contexts jsonb; config jsonb; rows jsonb; people jsonb; microsoft boolean; account text; connection_identifier text; reviewers boolean;
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
 RETURN jsonb_build_object('actor',jsonb_build_object('id',p_actor,'role',actor_role),'context',contexts,'configuration',config,'workflows',rows,'people',people,'limit',100,
 'readiness',jsonb_build_object('context_ready',contexts IS NOT NULL,'configuration_ready',coalesce(config->'configuration'->>'task'='customer_reply',false),'microsoft_ready',microsoft,'microsoft_connection_id',CASE WHEN microsoft THEN connection_identifier ELSE NULL END,'microsoft_account',CASE WHEN microsoft THEN account ELSE NULL END,'distinct_reviewer_available',reviewers,'live_inference_enabled',false));
END $$;
CREATE FUNCTION public.customer_workflow_save_context(p_org uuid,p_actor uuid,p_expected_version integer,p_context jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE v integer; c public.customer_reply_context_versions;
BEGIN
 PERFORM private.customer_workflow_lock(p_org);
 IF private.customer_workflow_role(p_org,p_actor) NOT IN ('owner','admin','consultant') THEN RAISE EXCEPTION 'Manager authorization required';END IF;
 SELECT coalesce(max(version),0) INTO v FROM public.customer_reply_context_versions WHERE organization_id=p_org;
 IF v IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'Context changed; reload';END IF;
 IF jsonb_typeof(p_context) IS DISTINCT FROM 'object' OR NOT p_context ?& ARRAY['company_name','reply_guidance'] OR p_context-ARRAY['company_name','reply_guidance']<>'{}'::jsonb
 OR jsonb_typeof(p_context->'company_name') IS DISTINCT FROM 'string' OR length(btrim(p_context->>'company_name')) NOT BETWEEN 1 AND 200
 OR jsonb_typeof(p_context->'reply_guidance') IS DISTINCT FROM 'string' OR length(btrim(p_context->>'reply_guidance')) NOT BETWEEN 10 AND 5000
 THEN RAISE EXCEPTION 'Invalid company context';END IF;
 INSERT INTO public.customer_reply_context_versions(organization_id,version,context,created_by) VALUES(p_org,v+1,p_context,p_actor) RETURNING * INTO c;
 RETURN to_jsonb(c);
END $$;
CREATE FUNCTION public.customer_workflow_intake(p_org uuid,p_actor uuid,p_request_key uuid,p_intake jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE w public.customer_reply_workflows;
BEGIN
 PERFORM private.customer_workflow_lock(p_org);
 IF private.customer_workflow_role(p_org,p_actor)='viewer' THEN RAISE EXCEPTION 'Contributor authorization required';END IF;
 IF p_request_key IS NULL OR jsonb_typeof(p_intake) IS DISTINCT FROM 'object' OR NOT p_intake ?& ARRAY['customer_email','customer_name','subject','message']
 OR p_intake-ARRAY['customer_email','customer_name','subject','message']<>'{}'::jsonb
 OR jsonb_typeof(p_intake->'customer_email') IS DISTINCT FROM 'string' OR length(p_intake->>'customer_email')>320 OR (p_intake->>'customer_email') !~ '^[^[:space:]@,;<>]+@[^[:space:]@,;<>]+\.[^[:space:]@,;<>]+$'
 OR jsonb_typeof(p_intake->'customer_name') IS DISTINCT FROM 'string' OR length(btrim(p_intake->>'customer_name')) NOT BETWEEN 1 AND 200
 OR jsonb_typeof(p_intake->'subject') IS DISTINCT FROM 'string' OR length(btrim(p_intake->>'subject')) NOT BETWEEN 1 AND 200 OR p_intake->>'subject' ~ E'[\r\n]'
 OR jsonb_typeof(p_intake->'message') IS DISTINCT FROM 'string' OR length(btrim(p_intake->>'message')) NOT BETWEEN 1 AND 6000
 THEN RAISE EXCEPTION 'Invalid customer intake';END IF;
 SELECT * INTO w FROM public.customer_reply_workflows WHERE organization_id=p_org AND request_key=p_request_key;
 IF FOUND THEN
  IF w.requested_by<>p_actor OR jsonb_build_object('customer_email',w.customer_email,'customer_name',w.customer_name,'subject',w.subject,'message',w.message)<>p_intake THEN RAISE EXCEPTION 'Idempotency conflict';END IF;
  PERFORM private.customer_workflow_access(p_org,p_actor,w.id,false);RETURN private.customer_workflow_project(w);
 END IF;
 INSERT INTO public.customer_reply_workflows(organization_id,request_key,requested_by,assigned_to,updated_by,customer_email,customer_name,subject,message)
 VALUES(p_org,p_request_key,p_actor,p_actor,p_actor,p_intake->>'customer_email',p_intake->>'customer_name',p_intake->>'subject',p_intake->>'message') RETURNING * INTO w;
 RETURN private.customer_workflow_project(w);
END $$;
CREATE FUNCTION public.customer_workflow_assign(p_org uuid,p_actor uuid,p_workflow uuid,p_expected_revision integer,p_assigned_to uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE w public.customer_reply_workflows;
BEGIN
 PERFORM private.customer_workflow_lock(p_org);
 IF private.customer_workflow_role(p_org,p_actor) NOT IN ('owner','admin','consultant') THEN RAISE EXCEPTION 'Manager authorization required';END IF;
 w:=private.customer_workflow_access(p_org,p_actor,p_workflow,true);
 IF w.revision IS DISTINCT FROM p_expected_revision OR w.status<>'intake' THEN RAISE EXCEPTION 'Assignment requires current intake revision';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.organization_members WHERE organization_id=p_org AND user_id=p_assigned_to AND role IN ('owner','admin','consultant','member')) THEN RAISE EXCEPTION 'Assignee unavailable';END IF;
 UPDATE public.customer_reply_workflows SET assigned_to=p_assigned_to,revision=revision+1,updated_at=now(),updated_by=p_actor WHERE id=w.id RETURNING * INTO w;
 RETURN private.customer_workflow_project(w);
END $$;

CREATE FUNCTION public.customer_workflow_prepare_draft(p_org uuid,p_actor uuid,p_workflow uuid,p_expected_revision integer,p_config uuid,p_request_key uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE w public.customer_reply_workflows; previous public.ai_draft_runs; config public.ai_draft_configurations; c public.customer_reply_context_versions;
BEGIN
 PERFORM private.customer_workflow_lock(p_org);PERFORM public.ai_draft_authorize(p_org,p_actor);
 w:=private.customer_workflow_access(p_org,p_actor,p_workflow,true);
 IF w.status='cancelled' OR w.action_request_id IS NOT NULL THEN RAISE EXCEPTION 'Workflow is closed for drafting';END IF;
 IF w.ai_request_key=p_request_key THEN
  IF w.configuration_id IS DISTINCT FROM p_config OR w.draft_requested_by IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'Idempotency conflict';END IF;
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
 UPDATE public.customer_reply_workflows SET status='drafting',context_version_id=c.id,configuration_id=p_config,ai_request_key=p_request_key,draft_requested_by=p_actor,revision=revision+1,updated_at=now(),updated_by=p_actor WHERE id=w.id RETURNING * INTO w;
 RETURN private.customer_workflow_project(w);
END $$;
CREATE FUNCTION public.customer_workflow_draft_input(p_org uuid,p_actor uuid,p_workflow uuid,p_expected_revision integer,p_config uuid,p_request_key uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE w public.customer_reply_workflows; c public.customer_reply_context_versions; source jsonb;
BEGIN
 PERFORM private.customer_workflow_lock(p_org);PERFORM public.ai_draft_authorize(p_org,p_actor);
 w:=private.customer_workflow_access(p_org,p_actor,p_workflow,true);
 IF w.status<>'drafting' OR w.revision IS DISTINCT FROM p_expected_revision OR w.configuration_id IS DISTINCT FROM p_config OR w.ai_request_key IS DISTINCT FROM p_request_key OR w.draft_requested_by IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'Draft binding changed';END IF;
 SELECT * INTO c FROM public.customer_reply_context_versions WHERE organization_id=p_org ORDER BY version DESC LIMIT 1;
 IF c.id IS DISTINCT FROM w.context_version_id THEN RAISE EXCEPTION 'Company context changed; prepare a new draft';END IF;
 IF w.configuration_id IS DISTINCT FROM (SELECT id FROM public.ai_draft_configurations WHERE organization_id=p_org ORDER BY version DESC LIMIT 1) THEN RAISE EXCEPTION 'AI configuration changed; prepare a new draft';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.organization_members WHERE organization_id=p_org AND user_id=w.assigned_to AND role IN ('owner','admin','consultant','member')) THEN RAISE EXCEPTION 'Assignee unavailable';END IF;
 -- Explicit saved fields only. No profile, finance, credentials, document retrieval or inferred ingestion.
 source:=jsonb_build_object('company_context',c.context,'company_context_version',c.version,'customer_inquiry',jsonb_build_object('customer_name',w.customer_name,'subject',w.subject,'message',w.message));
 -- The email address is intentionally excluded from inference; only the immutable intake supplies the destination.
 RETURN jsonb_build_object('context',source::text);
END $$;
CREATE FUNCTION private.customer_draft_reservation_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE w public.customer_reply_workflows; input jsonb; expected_hash text;
BEGIN
 SELECT * INTO w FROM public.customer_reply_workflows WHERE organization_id=NEW.organization_id AND ai_request_key=NEW.request_key;
 IF NOT FOUND THEN RETURN NEW;END IF;
 input:=public.customer_workflow_draft_input(NEW.organization_id,NEW.requested_by,w.id,w.revision,NEW.configuration_id,NEW.request_key);
 -- Exactly the existing handler's JSON.stringify({configuration_id,input}) ordering/encoding.
 expected_hash:=encode(sha256(convert_to('{"configuration_id":'||to_json(NEW.configuration_id::text)::text||',"input":{"context":'||to_json(input->>'context')::text||'}}','UTF8')),'hex');
 IF NEW.request_hash IS DISTINCT FROM expected_hash THEN RAISE EXCEPTION 'Draft source hash does not match saved context';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER customer_draft_reservation_guard BEFORE INSERT ON public.ai_draft_runs FOR EACH ROW EXECUTE FUNCTION private.customer_draft_reservation_guard();

CREATE FUNCTION public.customer_workflow_queue(p_org uuid,p_actor uuid,p_workflow uuid,p_expected_revision integer) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE w public.customer_reply_workflows; a public.ai_draft_runs; c public.oauth_connections; proposal public.action_requests; n integer; payload jsonb;
BEGIN
 PERFORM private.customer_workflow_lock(p_org);
 w:=private.customer_workflow_access(p_org,p_actor,p_workflow,true);
 IF w.status='cancelled' THEN RAISE EXCEPTION 'Workflow cancelled';END IF;
 IF w.action_request_id IS NOT NULL THEN RETURN private.customer_workflow_project(w);END IF;
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
 OR jsonb_typeof(a.draft->'source_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(a.draft->'source_ids')>1 OR NOT (a.draft->'source_ids' <@ '["manual-1"]'::jsonb)
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
END $$;

-- Guard runs from existing action approval/claim and the durable dispatch receipt.
-- Lock order matches the dispatcher: action first, organization next, workflow last.
CREATE FUNCTION private.customer_workflow_assert_action(a public.action_requests) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE w public.customer_reply_workflows; draft public.ai_draft_runs;
BEGIN
 IF a.customer_workflow_id IS NULL THEN RETURN;END IF;
 PERFORM private.customer_workflow_lock(a.organization_id);
 SELECT * INTO w FROM public.customer_reply_workflows WHERE id=a.customer_workflow_id AND organization_id=a.organization_id FOR UPDATE;
 IF NOT FOUND OR w.status<>'awaiting_approval' OR w.action_request_id IS DISTINCT FROM a.id THEN RAISE EXCEPTION 'Customer workflow cancelled or binding changed';END IF;
 IF w.context_version_id IS DISTINCT FROM (SELECT id FROM public.customer_reply_context_versions WHERE organization_id=w.organization_id ORDER BY version DESC LIMIT 1) THEN RAISE EXCEPTION 'Company context changed; proposal is stale';END IF;
 IF w.configuration_id IS DISTINCT FROM (SELECT id FROM public.ai_draft_configurations WHERE organization_id=w.organization_id ORDER BY version DESC LIMIT 1) THEN RAISE EXCEPTION 'AI configuration changed; proposal is stale';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.organization_members WHERE organization_id=w.organization_id AND user_id=w.assigned_to AND role IN ('owner','admin','consultant','member')) THEN RAISE EXCEPTION 'Assignee authorization revoked';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.organization_members WHERE organization_id=w.organization_id AND user_id=a.requested_by AND role IN ('owner','admin','consultant','member')) THEN RAISE EXCEPTION 'Proposer authorization revoked';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.organization_members WHERE organization_id=w.organization_id AND user_id=w.draft_requested_by AND role IN ('owner','admin','consultant')) THEN RAISE EXCEPTION 'Draft author authorization revoked';END IF;
 IF a.approved_by IS NULL OR a.approved_by IN (a.requested_by,w.requested_by,w.draft_requested_by,w.assigned_to) OR NOT EXISTS(SELECT 1 FROM public.organization_members WHERE organization_id=w.organization_id AND user_id=a.approved_by AND role IN ('owner','admin','consultant')) THEN RAISE EXCEPTION 'Distinct authorized employee approval required';END IF;
 SELECT * INTO draft FROM public.ai_draft_runs WHERE organization_id=w.organization_id AND request_key=w.ai_request_key AND configuration_id=w.configuration_id AND requested_by=w.draft_requested_by;
 IF NOT FOUND OR draft.status<>'accepted' OR a.payload IS DISTINCT FROM jsonb_build_object('to',w.customer_email,'subject',draft.draft->>'title','message',draft.draft->>'body') THEN RAISE EXCEPTION 'Exact accepted customer draft required';END IF;
END $$;
CREATE FUNCTION private.customer_action_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.customer_workflow_id IS NOT NULL AND NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('Approved','Executing') THEN PERFORM private.customer_workflow_assert_action(NEW);END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER customer_action_guard BEFORE UPDATE ON public.action_requests FOR EACH ROW EXECUTE FUNCTION private.customer_action_guard();
CREATE FUNCTION private.customer_dispatch_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE a public.action_requests;
BEGIN
 IF NEW.phase='Dispatching' THEN
  SELECT * INTO a FROM public.action_requests WHERE id=NEW.request_id AND organization_id=NEW.organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Action not found';END IF;
  IF a.customer_workflow_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.organization_members WHERE organization_id=a.organization_id AND user_id=NEW.actor_id AND role IN ('owner','admin','consultant')) THEN RAISE EXCEPTION 'Employee executor authorization required';END IF;
  PERFORM private.customer_workflow_assert_action(a);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER customer_dispatch_guard BEFORE INSERT ON public.action_execution_receipts FOR EACH ROW EXECUTE FUNCTION private.customer_dispatch_guard();
CREATE FUNCTION public.customer_workflow_cancel(p_org uuid,p_actor uuid,p_workflow uuid,p_expected_revision integer) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE w public.customer_reply_workflows; proposal public.action_requests; linked uuid;
BEGIN
 -- Read-only lookup gets the immutable action ID. No workflow lock before an action lock.
 w:=private.customer_workflow_access(p_org,p_actor,p_workflow,true);linked:=w.action_request_id;
 IF linked IS NOT NULL THEN SELECT * INTO proposal FROM public.action_requests WHERE id=linked AND organization_id=p_org FOR UPDATE;END IF;
 PERFORM private.customer_workflow_lock(p_org);
 w:=private.customer_workflow_access(p_org,p_actor,p_workflow,true);
 IF w.action_request_id IS DISTINCT FROM linked THEN RAISE EXCEPTION 'Workflow changed; reload';END IF;
 IF w.status='cancelled' THEN RETURN private.customer_workflow_project(w);END IF;
 IF w.revision IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'Workflow changed; reload';END IF;
 IF linked IS NOT NULL AND (proposal.status IN ('Executed','Failed') OR EXISTS(SELECT 1 FROM public.action_execution_receipts WHERE request_id=linked)) THEN RAISE EXCEPTION 'Dispatch started or outcome recorded; do not resend';END IF;
 UPDATE public.customer_reply_workflows SET status='cancelled',cancelled_by=p_actor,cancelled_at=now(),revision=revision+1,updated_at=now(),updated_by=p_actor WHERE id=w.id RETURNING * INTO w;
 -- A claimed pre-dispatch worker will fail the receipt guard; no unsafe Executing reset.
 RETURN private.customer_workflow_project(w);
END $$;

CREATE FUNCTION private.customer_workflow_audit() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 INSERT INTO public.audit_events(organization_id,actor_user_id,event_type,entity_type,entity_id,summary,metadata)
 VALUES(NEW.organization_id,CASE WHEN TG_TABLE_NAME='customer_reply_context_versions' THEN (to_jsonb(NEW)->>'created_by')::uuid ELSE (to_jsonb(NEW)->>'updated_by')::uuid END,
 'customer_workflow_recorded',TG_TABLE_NAME,NEW.id,'Customer reply workflow record saved',
 jsonb_build_object('revision',to_jsonb(NEW)->'revision','version',to_jsonb(NEW)->'version','status',to_jsonb(NEW)->'status'));
 RETURN NEW;
END $$;
CREATE TRIGGER customer_workflow_audit AFTER INSERT OR UPDATE ON public.customer_reply_workflows FOR EACH ROW EXECUTE FUNCTION private.customer_workflow_audit();
CREATE TRIGGER customer_context_audit AFTER INSERT ON public.customer_reply_context_versions FOR EACH ROW EXECUTE FUNCTION private.customer_workflow_audit();

-- Existing manual-action visibility is untouched. Linked customer proposals obey
-- the same assignment visibility as their protected parent, even via old dashboards.
-- The private definer helper exposes only a boolean, never workflow/customer data.
CREATE FUNCTION private.customer_action_readable(p_org uuid,p_request uuid,p_workflow uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT auth.uid() IS NOT NULL
 AND EXISTS(SELECT 1 FROM auth.users u WHERE u.id=auth.uid() AND NOT coalesce((to_jsonb(u)->>'is_anonymous')::boolean,false))
 AND EXISTS(SELECT 1 FROM public.customer_reply_workflows w JOIN public.organization_members m ON m.organization_id=w.organization_id AND m.user_id=auth.uid()
 WHERE w.organization_id=p_org AND w.id=p_workflow AND w.action_request_id=p_request
 AND (m.role IN ('owner','admin','consultant','viewer') OR (m.role='member' AND w.assigned_to=m.user_id)));
$$;
REVOKE ALL ON FUNCTION private.customer_action_readable(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION private.customer_action_readable(uuid,uuid,uuid) TO authenticated;
CREATE POLICY customer_action_assignment_read ON public.action_requests AS RESTRICTIVE FOR SELECT TO authenticated
 USING(customer_workflow_id IS NULL OR private.customer_action_readable(organization_id,id,customer_workflow_id));

-- No browser reads/writes or direct public access; authenticated Edge derives p_actor.
DO $$ DECLARE signature text; BEGIN
 FOREACH signature IN ARRAY ARRAY[
  'private.customer_workflow_lock(uuid)', 'private.customer_workflow_role(uuid,uuid)',
  'private.customer_workflow_access(uuid,uuid,uuid,boolean)', 'private.customer_context_immutable()',
  'private.customer_intake_immutable()', 'private.customer_workflow_project(public.customer_reply_workflows)',
  'public.customer_workflow_load(uuid,uuid)', 'public.customer_workflow_save_context(uuid,uuid,integer,jsonb)',
  'public.customer_workflow_intake(uuid,uuid,uuid,jsonb)', 'public.customer_workflow_assign(uuid,uuid,uuid,integer,uuid)',
  'public.customer_workflow_prepare_draft(uuid,uuid,uuid,integer,uuid,uuid)',
  'public.customer_workflow_draft_input(uuid,uuid,uuid,integer,uuid,uuid)',
  'private.customer_draft_reservation_guard()', 'public.customer_workflow_queue(uuid,uuid,uuid,integer)',
  'private.customer_workflow_assert_action(public.action_requests)', 'private.customer_action_guard()',
  'private.customer_dispatch_guard()', 'public.customer_workflow_cancel(uuid,uuid,uuid,integer)',
  'private.customer_workflow_audit()'
 ] LOOP
  EXECUTE 'REVOKE ALL ON FUNCTION '||signature||' FROM PUBLIC,anon,authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION '||signature||' TO service_role';
 END LOOP;
END $$;
COMMIT;
