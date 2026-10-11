-- SOURCE-ONLY REVIEW CANDIDATE. Do not execute against a deployed project.
-- Requires existing customer-workflow, AI draft, Microsoft approval/receipt and OAuth contracts.
-- Adds no provider calls, credentials, activation, automatic dispatch, or browser table grants.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';

CREATE TABLE public.workflow_recipe_versions (
 recipe_key text NOT NULL, version integer NOT NULL CHECK(version>0),
 name text NOT NULL, description text NOT NULL, definition jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(recipe_key,version)
);
INSERT INTO public.workflow_recipe_versions(recipe_key,version,name,description,definition) VALUES(
 'customer_followup',1,'Customer follow-up','Turn a customer request into a reviewed follow-up using saved company guidance.',
 '{"source":"manual_company_guidance","optional_sources":"explicit_current_company_knowledge","workflow":"customer_reply","human_review":true,"designated_reviewer":true,"automatic_execution":false,"live_inference_enabled":false,"steps":["intake","assignment","manual_draft_request","human_draft_review","designated_email_approval","manual_execution"]}'::jsonb);
CREATE TABLE public.workflow_installations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id),
 revision integer NOT NULL CHECK(revision>0), created_by uuid NOT NULL REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,organization_id)
);
CREATE TABLE public.workflow_installation_versions (
 installation_id uuid NOT NULL, organization_id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0),
 recipe_key text NOT NULL, recipe_version integer NOT NULL,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
 outcome text NOT NULL CHECK(length(btrim(outcome)) BETWEEN 10 AND 1000),
 bindings jsonb NOT NULL, limits jsonb NOT NULL,
 microsoft_binding_sha256 text, saved_by uuid NOT NULL REFERENCES auth.users(id), saved_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(installation_id,organization_id,revision),
 FOREIGN KEY(installation_id,organization_id) REFERENCES public.workflow_installations(id,organization_id),
 FOREIGN KEY(recipe_key,recipe_version) REFERENCES public.workflow_recipe_versions(recipe_key,version)
);
ALTER TABLE public.workflow_installations ADD CONSTRAINT installation_current_revision
 FOREIGN KEY(id,organization_id,revision) REFERENCES public.workflow_installation_versions(installation_id,organization_id,revision) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE private.workflow_installation_saves (
 organization_id uuid NOT NULL REFERENCES public.organizations(id), request_key uuid NOT NULL, actor_id uuid NOT NULL REFERENCES auth.users(id),
 installation_id uuid NOT NULL, installation_revision integer NOT NULL, request jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,request_key),
 FOREIGN KEY(installation_id,organization_id,installation_revision) REFERENCES public.workflow_installation_versions(installation_id,organization_id,revision)
);
CREATE TABLE public.workflow_installation_requests (
 organization_id uuid NOT NULL REFERENCES public.organizations(id), request_key uuid NOT NULL,
 installation_id uuid NOT NULL, installation_revision integer NOT NULL, workflow_id uuid NOT NULL,
 started_by uuid NOT NULL REFERENCES auth.users(id), started_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,request_key), UNIQUE(workflow_id,organization_id),
 FOREIGN KEY(installation_id,organization_id,installation_revision) REFERENCES public.workflow_installation_versions(installation_id,organization_id,revision),
 FOREIGN KEY(workflow_id,organization_id) REFERENCES public.customer_reply_workflows(id,organization_id)
);
CREATE INDEX workflow_installation_org ON public.workflow_installations(organization_id,created_at DESC);
CREATE INDEX workflow_installation_open ON public.workflow_installation_requests(organization_id,installation_id,workflow_id);
ALTER TABLE public.workflow_recipe_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_installation_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.workflow_installation_saves ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_installation_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.workflow_recipe_versions,public.workflow_installations,public.workflow_installation_versions,private.workflow_installation_saves,public.workflow_installation_requests FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.workflow_recipe_versions TO service_role;
GRANT SELECT,INSERT,UPDATE ON public.workflow_installations TO service_role;
GRANT SELECT,INSERT ON public.workflow_installation_versions,private.workflow_installation_saves,public.workflow_installation_requests TO service_role;

CREATE FUNCTION private.workflow_installation_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Workflow recipe, version and request provenance are immutable';END $$;
CREATE TRIGGER recipe_version_immutable BEFORE UPDATE OR DELETE ON public.workflow_recipe_versions FOR EACH ROW EXECUTE FUNCTION private.workflow_installation_immutable();
CREATE TRIGGER installation_version_immutable BEFORE UPDATE OR DELETE ON public.workflow_installation_versions FOR EACH ROW EXECUTE FUNCTION private.workflow_installation_immutable();
CREATE TRIGGER installation_save_immutable BEFORE UPDATE OR DELETE ON private.workflow_installation_saves FOR EACH ROW EXECUTE FUNCTION private.workflow_installation_immutable();
CREATE TRIGGER installation_request_immutable BEFORE UPDATE OR DELETE ON public.workflow_installation_requests FOR EACH ROW EXECUTE FUNCTION private.workflow_installation_immutable();
CREATE FUNCTION private.workflow_installation_head_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF ROW(NEW.id,NEW.organization_id,NEW.created_by,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.created_by,OLD.created_at) OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Invalid installation revision';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER installation_head_guard BEFORE UPDATE ON public.workflow_installations FOR EACH ROW EXECUTE FUNCTION private.workflow_installation_head_guard();

-- Fingerprint includes the existing OAuth authority/revision binding without exposing
-- secret references. Token refresh does not change this identity; reconsent does.
CREATE FUNCTION private.workflow_installation_connection(p_org uuid,p_id uuid) RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE c public.oauth_connections; i public.integrations;
BEGIN
 SELECT * INTO c FROM public.oauth_connections WHERE id=p_id AND organization_id=p_org FOR SHARE;
 IF NOT FOUND OR c.provider IS DISTINCT FROM 'microsoft' OR c.status IS DISTINCT FROM 'Connected' OR c.oauth_verified_version IS DISTINCT FROM 1 OR nullif(btrim(c.external_account_id),'') IS NULL OR NOT coalesce('Mail.Send'=ANY(c.scopes),false) THEN RETURN NULL;END IF;
 SELECT * INTO i FROM public.integrations WHERE id=c.integration_id AND organization_id=p_org FOR SHARE;
 IF NOT FOUND OR i.provider IS DISTINCT FROM 'Microsoft' OR i.integration_type IS DISTINCT FROM 'OAuth' OR i.status IS DISTINCT FROM 'Connected' THEN RETURN NULL;END IF;
 IF (SELECT count(*) FROM public.oauth_connections x JOIN public.integrations y ON y.id=x.integration_id AND y.organization_id=x.organization_id WHERE x.organization_id=p_org AND x.provider='microsoft' AND x.status='Connected' AND x.oauth_verified_version=1 AND nullif(btrim(x.external_account_id),'') IS NOT NULL AND 'Mail.Send'=ANY(x.scopes) AND y.provider='Microsoft' AND y.integration_type='OAuth' AND y.status='Connected')<>1 THEN RETURN NULL;END IF;
 RETURN encode(sha256(convert_to(private.microsoft_connection_binding(c,i)::text,'UTF8')),'hex');
END $$;
CREATE FUNCTION private.workflow_installation_readiness(v public.workflow_installation_versions,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
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
END $$;
CREATE FUNCTION private.workflow_installation_project(v public.workflow_installation_versions,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE readiness jsonb; open_count integer;
BEGIN
 readiness:=private.workflow_installation_readiness(v,p_actor);
 SELECT count(*) INTO open_count FROM public.workflow_installation_requests r JOIN public.customer_reply_workflows w ON w.id=r.workflow_id AND w.organization_id=r.organization_id LEFT JOIN public.action_requests a ON a.id=w.action_request_id AND a.organization_id=w.organization_id
 WHERE r.organization_id=v.organization_id AND r.installation_id=v.installation_id AND w.status<>'cancelled' AND coalesce(a.status,'') NOT IN ('Executed','Rejected');
 IF open_count>=(v.limits->>'max_open_requests')::integer THEN readiness:=readiness||jsonb_build_object('can_start',false,'start_blocker','open_request_limit');END IF;
 RETURN (to_jsonb(v)-'microsoft_binding_sha256')||jsonb_build_object('id',v.installation_id,'status',CASE WHEN (readiness->>'configured')::boolean THEN 'configured' ELSE 'setup_needed' END,'readiness',readiness,'open_requests',open_count);
END $$;
CREATE FUNCTION public.workflow_installations_load(p_org uuid,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE role text; workspace jsonb; recipes jsonb; installations jsonb; receipts jsonb;
BEGIN
 PERFORM private.customer_workflow_lock(p_org);role:=private.customer_workflow_role(p_org,p_actor);
 workspace:=public.customer_workflow_load(p_org,p_actor);
 SELECT coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('recipe_version',version) ORDER BY recipe_key,version),'[]'::jsonb) INTO recipes FROM public.workflow_recipe_versions r;
 SELECT coalesce(jsonb_agg(private.workflow_installation_project(v,p_actor) ORDER BY i.created_at DESC,i.id),'[]'::jsonb) INTO installations FROM public.workflow_installations i JOIN public.workflow_installation_versions v ON v.installation_id=i.id AND v.organization_id=i.organization_id AND v.revision=i.revision
 WHERE i.organization_id=p_org AND (role<>'member' OR v.bindings->>'assigned_to'=p_actor::text);
 SELECT coalesce(jsonb_agg(to_jsonb(receipt) ORDER BY receipt.recorded_at DESC,receipt.request_key),'[]'::jsonb) INTO receipts FROM (
  SELECT op.* FROM (
   SELECT 'save'::text AS operation,s.request_key,s.installation_id,s.installation_revision,NULL::uuid AS workflow_id,s.recorded_at FROM private.workflow_installation_saves s WHERE s.organization_id=p_org AND s.actor_id=p_actor
   UNION ALL
   SELECT 'start',r.request_key,r.installation_id,r.installation_revision,r.workflow_id,r.started_at FROM public.workflow_installation_requests r WHERE r.organization_id=p_org AND r.started_by=p_actor
  ) op JOIN public.workflow_installations i ON i.id=op.installation_id AND i.organization_id=p_org JOIN public.workflow_installation_versions v ON v.installation_id=i.id AND v.organization_id=i.organization_id AND v.revision=i.revision
  WHERE role<>'member' OR v.bindings->>'assigned_to'=p_actor::text ORDER BY op.recorded_at DESC,op.request_key LIMIT 100
 ) receipt;
 RETURN jsonb_build_object('organization_id',p_org,'actor',jsonb_build_object('id',p_actor,'role',role),'recipes',recipes,'installations',installations,'workspace',workspace,'operation_receipts',receipts,'operation_receipts_limit',100);
END $$;
CREATE FUNCTION public.workflow_installations_save(p_org uuid,p_actor uuid,p_installation uuid,p_expected_revision integer,p_request_key uuid,p_spec jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE previous private.workflow_installation_saves; head public.workflow_installations; v public.workflow_installation_versions; request jsonb; field text; reference uuid; fingerprint text;
BEGIN
 PERFORM private.customer_workflow_lock(p_org);
 IF private.customer_workflow_role(p_org,p_actor) NOT IN ('owner','admin','consultant') THEN RAISE EXCEPTION 'Manager authorization required';END IF;
 request:=jsonb_build_object('installation_id',p_installation,'expected_revision',p_expected_revision,'spec',p_spec);
 IF p_request_key IS NULL OR p_expected_revision IS NULL OR p_expected_revision<0 THEN RAISE EXCEPTION 'Invalid save request';END IF;
 SELECT * INTO previous FROM private.workflow_installation_saves WHERE organization_id=p_org AND request_key=p_request_key;
 IF FOUND THEN
  IF previous.actor_id IS DISTINCT FROM p_actor OR previous.request IS DISTINCT FROM request THEN RAISE EXCEPTION 'Idempotency conflict';END IF;
  SELECT * INTO v FROM public.workflow_installation_versions WHERE installation_id=previous.installation_id AND organization_id=p_org AND revision=previous.installation_revision;
  RETURN private.workflow_installation_project(v,p_actor);
 END IF;
 IF jsonb_typeof(p_spec) IS DISTINCT FROM 'object' OR NOT p_spec ?& ARRAY['recipe_key','recipe_version','name','outcome','bindings','limits'] OR p_spec-ARRAY['recipe_key','recipe_version','name','outcome','bindings','limits']<>'{}'::jsonb
 OR p_spec->>'recipe_key' IS DISTINCT FROM 'customer_followup' OR p_spec->'recipe_version' IS DISTINCT FROM '1'::jsonb
 OR jsonb_typeof(p_spec->'name') IS DISTINCT FROM 'string' OR length(btrim(p_spec->>'name')) NOT BETWEEN 1 AND 120
 OR jsonb_typeof(p_spec->'outcome') IS DISTINCT FROM 'string' OR length(btrim(p_spec->>'outcome')) NOT BETWEEN 10 AND 1000
 OR jsonb_typeof(p_spec->'bindings') IS DISTINCT FROM 'object' OR NOT (p_spec->'bindings') ?& ARRAY['context_version_id','configuration_id','microsoft_connection_id','assigned_to','reviewer_id'] OR (p_spec->'bindings')-ARRAY['context_version_id','configuration_id','microsoft_connection_id','assigned_to','reviewer_id']<>'{}'::jsonb
 OR jsonb_typeof(p_spec->'limits') IS DISTINCT FROM 'object' OR NOT (p_spec->'limits') ? 'max_open_requests' OR (p_spec->'limits')-'max_open_requests'<>'{}'::jsonb OR jsonb_typeof(p_spec->'limits'->'max_open_requests') IS DISTINCT FROM 'number' OR (p_spec->'limits'->>'max_open_requests') !~ '^[0-9]+$' OR (p_spec->'limits'->>'max_open_requests')::numeric NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid installation specification';END IF;
 FOREACH field IN ARRAY ARRAY['context_version_id','configuration_id','microsoft_connection_id','assigned_to','reviewer_id'] LOOP
  IF p_spec->'bindings'->field <> 'null'::jsonb AND (jsonb_typeof(p_spec->'bindings'->field) IS DISTINCT FROM 'string' OR (p_spec->'bindings'->>field) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN RAISE EXCEPTION 'Invalid binding reference';END IF;
  reference:=(p_spec->'bindings'->>field)::uuid;
  IF reference IS NOT NULL THEN
   IF field='context_version_id' AND NOT EXISTS(SELECT 1 FROM public.customer_reply_context_versions WHERE id=reference AND organization_id=p_org) OR field='configuration_id' AND NOT EXISTS(SELECT 1 FROM public.ai_draft_configurations WHERE id=reference AND organization_id=p_org) OR field='microsoft_connection_id' AND NOT EXISTS(SELECT 1 FROM public.oauth_connections WHERE id=reference AND organization_id=p_org) OR field IN ('assigned_to','reviewer_id') AND NOT EXISTS(SELECT 1 FROM public.organization_members WHERE user_id=reference AND organization_id=p_org) THEN RAISE EXCEPTION 'Binding unavailable';END IF;
  END IF;
 END LOOP;
 IF p_installation IS NULL THEN
  IF p_expected_revision<>0 THEN RAISE EXCEPTION 'Installation changed; reload';END IF;
  INSERT INTO public.workflow_installations(organization_id,revision,created_by) VALUES(p_org,1,p_actor) RETURNING * INTO head;
 ELSE
  SELECT * INTO head FROM public.workflow_installations WHERE id=p_installation AND organization_id=p_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'Installation access denied';END IF;
  IF head.revision IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'Installation changed; reload';END IF;
  UPDATE public.workflow_installations SET revision=revision+1 WHERE id=head.id AND organization_id=p_org RETURNING * INTO head;
 END IF;
 fingerprint:=private.workflow_installation_connection(p_org,(p_spec->'bindings'->>'microsoft_connection_id')::uuid);
 INSERT INTO public.workflow_installation_versions(installation_id,organization_id,revision,recipe_key,recipe_version,name,outcome,bindings,limits,microsoft_binding_sha256,saved_by)
 VALUES(head.id,p_org,head.revision,p_spec->>'recipe_key',(p_spec->>'recipe_version')::integer,p_spec->>'name',p_spec->>'outcome',p_spec->'bindings',p_spec->'limits',fingerprint,p_actor) RETURNING * INTO v;
 INSERT INTO private.workflow_installation_saves(organization_id,request_key,actor_id,installation_id,installation_revision,request) VALUES(p_org,p_request_key,p_actor,head.id,head.revision,request);
 INSERT INTO public.audit_events(organization_id,actor_user_id,event_type,entity_type,entity_id,summary,metadata) VALUES(p_org,p_actor,'workflow_installation_saved','workflow_installations',head.id,'Workflow installation settings saved',jsonb_build_object('revision',head.revision,'recipe_key',v.recipe_key,'recipe_version',v.recipe_version));
 RETURN private.workflow_installation_project(v,p_actor);
END $$;
CREATE FUNCTION public.workflow_installations_start(p_org uuid,p_actor uuid,p_installation uuid,p_expected_revision integer,p_request_key uuid,p_intake jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE role text; head public.workflow_installations; v public.workflow_installation_versions; previous public.workflow_installation_requests; projected jsonb; w jsonb; stored public.customer_reply_workflows;
BEGIN
 PERFORM private.customer_workflow_lock(p_org);role:=private.customer_workflow_role(p_org,p_actor);
 IF role='viewer' THEN RAISE EXCEPTION 'Contributor authorization required';END IF;
 SELECT * INTO head FROM public.workflow_installations WHERE id=p_installation AND organization_id=p_org;
 IF NOT FOUND THEN RAISE EXCEPTION 'Installation access denied';END IF;
 SELECT * INTO v FROM public.workflow_installation_versions WHERE installation_id=head.id AND organization_id=p_org AND revision=head.revision;
 IF role='member' AND v.bindings->>'assigned_to' IS DISTINCT FROM p_actor::text THEN RAISE EXCEPTION 'Installation access denied';END IF;
 IF p_request_key IS NULL OR p_expected_revision IS NULL OR p_expected_revision<1 THEN RAISE EXCEPTION 'Invalid start request';END IF;
 SELECT * INTO previous FROM public.workflow_installation_requests WHERE organization_id=p_org AND request_key=p_request_key;
 IF FOUND THEN
  IF previous.started_by IS DISTINCT FROM p_actor OR previous.installation_id IS DISTINCT FROM p_installation OR previous.installation_revision IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'Idempotency conflict';END IF;
  SELECT * INTO stored FROM public.customer_reply_workflows WHERE id=previous.workflow_id AND organization_id=p_org;
  IF jsonb_build_object('customer_email',stored.customer_email,'customer_name',stored.customer_name,'subject',stored.subject,'message',stored.message) IS DISTINCT FROM p_intake THEN RAISE EXCEPTION 'Idempotency conflict';END IF;
  PERFORM private.customer_workflow_access(p_org,p_actor,stored.id,false);
  SELECT * INTO v FROM public.workflow_installation_versions WHERE installation_id=p_installation AND organization_id=p_org AND revision=previous.installation_revision;
  RETURN jsonb_build_object('installation',private.workflow_installation_project(v,p_actor),'workflow',private.customer_workflow_project(stored),'provenance',to_jsonb(previous),'replayed',true);
 END IF;
 IF head.revision IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'Installation changed; reload';END IF;
 projected:=private.workflow_installation_project(v,p_actor);
 IF v.bindings->>'reviewer_id'=p_actor::text THEN RAISE EXCEPTION 'reviewer_conflict';END IF;
 IF NOT (projected->'readiness'->>'can_start')::boolean THEN RAISE EXCEPTION 'Installation dependencies changed, missing, or open request limit reached';END IF;
 IF EXISTS(SELECT 1 FROM public.customer_reply_workflows WHERE organization_id=p_org AND request_key=p_request_key) THEN RAISE EXCEPTION 'Idempotency conflict';END IF;
 -- Existing guards validate immutable intake, current actor and same-org assignment.
 w:=public.customer_workflow_intake(p_org,p_actor,p_request_key,p_intake);
 IF w->>'assigned_to' IS DISTINCT FROM v.bindings->>'assigned_to' THEN w:=public.customer_workflow_assign(p_org,p_actor,(w->>'id')::uuid,(w->>'revision')::integer,(v.bindings->>'assigned_to')::uuid);END IF;
 INSERT INTO public.workflow_installation_requests(organization_id,request_key,installation_id,installation_revision,workflow_id,started_by) VALUES(p_org,p_request_key,p_installation,v.revision,(w->>'id')::uuid,p_actor) RETURNING * INTO previous;
 INSERT INTO public.audit_events(organization_id,actor_user_id,event_type,entity_type,entity_id,summary,metadata) VALUES(p_org,p_actor,'workflow_installation_started','workflow_installations',head.id,'Installed workflow request created',jsonb_build_object('revision',v.revision,'workflow_id',w->>'id'));
 RETURN jsonb_build_object('installation',private.workflow_installation_project(v,p_actor),'workflow',w,'provenance',to_jsonb(previous),'replayed',false);
END $$;

-- A single supplemental invariant is shared by existing prepare/queue/approval and
-- durable receipt boundaries. It never bypasses or replaces their guards.
CREATE FUNCTION private.workflow_installation_assert(w public.customer_reply_workflows,p_actor uuid) RETURNS public.workflow_installation_versions LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE r public.workflow_installation_requests; v public.workflow_installation_versions; ready jsonb;
BEGIN
 SELECT * INTO r FROM public.workflow_installation_requests WHERE workflow_id=w.id AND organization_id=w.organization_id;
 IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM private.customer_workflow_lock(w.organization_id);
 SELECT * INTO v FROM public.workflow_installation_versions WHERE installation_id=r.installation_id AND organization_id=r.organization_id AND revision=r.installation_revision;
 IF NOT FOUND THEN RAISE EXCEPTION 'Installation provenance missing';END IF;
 ready:=private.workflow_installation_readiness(v,p_actor);
 IF NOT (ready->>'configured')::boolean THEN RAISE EXCEPTION 'Installation dependencies changed or unavailable';END IF;
 IF w.assigned_to::text IS DISTINCT FROM v.bindings->>'assigned_to' OR (w.context_version_id IS NOT NULL AND w.context_version_id::text IS DISTINCT FROM v.bindings->>'context_version_id') OR (w.configuration_id IS NOT NULL AND w.configuration_id::text IS DISTINCT FROM v.bindings->>'configuration_id') THEN RAISE EXCEPTION 'Installation workflow binding changed';END IF;
 IF w.draft_requested_by::text=v.bindings->>'reviewer_id' OR w.requested_by::text=v.bindings->>'reviewer_id' THEN RAISE EXCEPTION 'reviewer_conflict';END IF;
 RETURN v;
END $$;
CREATE FUNCTION private.workflow_installation_workflow_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 -- Cancellation is always available through the existing checked cancellation path.
 IF NEW.status<>'cancelled' THEN PERFORM private.workflow_installation_assert(NEW,NEW.updated_by);END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER installation_workflow_guard BEFORE UPDATE ON public.customer_reply_workflows FOR EACH ROW EXECUTE FUNCTION private.workflow_installation_workflow_guard();
CREATE FUNCTION private.workflow_installation_assert_action(a public.action_requests) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE w public.customer_reply_workflows; v public.workflow_installation_versions;
BEGIN
 IF a.customer_workflow_id IS NULL THEN RETURN;END IF;
 SELECT * INTO w FROM public.customer_reply_workflows WHERE id=a.customer_workflow_id AND organization_id=a.organization_id;
 v:=private.workflow_installation_assert(w,a.requested_by);
 IF v.installation_id IS NULL THEN RETURN;END IF;
 IF a.connection_id::text IS DISTINCT FROM v.bindings->>'microsoft_connection_id' OR a.requested_by::text=v.bindings->>'reviewer_id' THEN RAISE EXCEPTION 'Installation action binding changed';END IF;
 IF a.status IN ('Approved','Executing','Executed') AND a.approved_by::text IS DISTINCT FROM v.bindings->>'reviewer_id' THEN RAISE EXCEPTION 'Designated installation reviewer required';END IF;
END $$;
CREATE FUNCTION private.workflow_installation_action_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' OR (NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('Approved','Executing')) THEN PERFORM private.workflow_installation_assert_action(NEW);END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER installation_action_guard BEFORE INSERT OR UPDATE ON public.action_requests FOR EACH ROW EXECUTE FUNCTION private.workflow_installation_action_guard();
CREATE FUNCTION private.workflow_installation_dispatch_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE a public.action_requests;
BEGIN
 IF NEW.phase='Dispatching' THEN
  SELECT * INTO a FROM public.action_requests WHERE id=NEW.request_id AND organization_id=NEW.organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Action not found';END IF;
  PERFORM private.workflow_installation_assert_action(a);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER installation_dispatch_guard BEFORE INSERT ON public.action_execution_receipts FOR EACH ROW EXECUTE FUNCTION private.workflow_installation_dispatch_guard();
-- Recheck pinned installation dependencies at model admission and at the existing
-- optional activation dispatch marker. Explicit knowledge sources retain their
-- existing immutable selection, freshness, citation, and approval guards.
CREATE FUNCTION private.workflow_installation_ai_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE w public.customer_reply_workflows; v public.workflow_installation_versions;
BEGIN
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)->'activation_dispatch_started_at') IS NOT DISTINCT FROM (to_jsonb(OLD)->'activation_dispatch_started_at') THEN RETURN NEW;END IF;
 SELECT * INTO w FROM public.customer_reply_workflows WHERE organization_id=NEW.organization_id AND ai_request_key=NEW.request_key;
 IF NOT FOUND THEN RETURN NEW;END IF;
 v:=private.workflow_installation_assert(w,NEW.requested_by);
 IF v.installation_id IS NOT NULL THEN PERFORM public.customer_workflow_draft_input(NEW.organization_id,NEW.requested_by,w.id,w.revision,NEW.configuration_id,NEW.request_key);END IF;
 RETURN NEW;
END $$;
-- Name runs after existing customer source-binding guards.
CREATE TRIGGER zz_installation_ai_guard BEFORE INSERT OR UPDATE ON public.ai_draft_runs FOR EACH ROW EXECUTE FUNCTION private.workflow_installation_ai_guard();
DO $$ DECLARE signature text; BEGIN
 FOREACH signature IN ARRAY ARRAY[
 'private.workflow_installation_immutable()', 'private.workflow_installation_head_guard()',
 'private.workflow_installation_connection(uuid,uuid)',
 'private.workflow_installation_readiness(public.workflow_installation_versions,uuid)',
 'private.workflow_installation_project(public.workflow_installation_versions,uuid)',
 'public.workflow_installations_load(uuid,uuid)',
 'public.workflow_installations_save(uuid,uuid,uuid,integer,uuid,jsonb)',
 'public.workflow_installations_start(uuid,uuid,uuid,integer,uuid,jsonb)',
 'private.workflow_installation_assert(public.customer_reply_workflows,uuid)',
 'private.workflow_installation_workflow_guard()', 'private.workflow_installation_assert_action(public.action_requests)',
 'private.workflow_installation_action_guard()', 'private.workflow_installation_dispatch_guard()', 'private.workflow_installation_ai_guard()'
 ] LOOP
  EXECUTE 'REVOKE ALL ON FUNCTION '||signature||' FROM PUBLIC,anon,authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION '||signature||' TO service_role';
 END LOOP;
END $$;
COMMIT;
