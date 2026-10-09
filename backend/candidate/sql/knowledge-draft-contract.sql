-- SOURCE-ONLY: installation requires review of the exact new service-only privileges.
-- Depends on the deployed Company Knowledge, Customer Workflow and AI Draft contracts.
-- No provider configuration, browser table grants, synchronization or paid inference activation.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
CREATE TABLE private.customer_knowledge_snapshots (
 organization_id uuid NOT NULL REFERENCES public.organizations(id),
 workflow_id uuid NOT NULL, request_key uuid NOT NULL, actor_user_id uuid NOT NULL REFERENCES auth.users(id),
 source_refs jsonb NOT NULL CHECK(jsonb_typeof(source_refs)='array' AND jsonb_array_length(source_refs)<=5),
 sources jsonb NOT NULL CHECK(jsonb_typeof(sources)='array' AND jsonb_array_length(sources)<=5),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,request_key),
 FOREIGN KEY(workflow_id,organization_id) REFERENCES public.customer_reply_workflows(id,organization_id)
);
ALTER TABLE private.customer_knowledge_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.customer_knowledge_snapshots FROM PUBLIC,anon,authenticated,service_role;
-- Only the trusted Edge service can read selected snapshots. No application role
-- can directly insert, replace, or delete them; the checked definer seals them.
GRANT SELECT ON private.customer_knowledge_snapshots TO service_role;
ALTER TABLE public.ai_draft_runs ADD COLUMN knowledge_bound boolean NOT NULL DEFAULT false;
CREATE FUNCTION private.customer_knowledge_snapshot_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP<>'INSERT' OR current_user NOT IN ('postgres','supabase_admin') THEN RAISE EXCEPTION 'Knowledge draft snapshots are immutable';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER customer_knowledge_snapshot_immutable BEFORE INSERT OR UPDATE OR DELETE ON private.customer_knowledge_snapshots FOR EACH ROW EXECUTE FUNCTION private.customer_knowledge_snapshot_immutable();

-- Reject chunks/metadata containing only ECMAScript whitespace before selection;
-- preserve the exact immutable bytes for every accepted excerpt.
CREATE FUNCTION private.customer_knowledge_usable(p_text text) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT length(btrim(p_text,chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279)))>0;
$$;
-- Private definer is required because Company Knowledge deliberately denies
-- direct service table reads. The only new read surface returns current,
-- explicitly published organization-audience chunks for a current company actor.
CREATE FUNCTION private.customer_knowledge_resolve(p_org uuid,p_actor uuid,p_refs jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ref jsonb; result jsonb:='[]'; item jsonb; seen text[]:=ARRAY[]::text[];
BEGIN
 PERFORM private.customer_workflow_lock(p_org);
 PERFORM private.customer_workflow_role(p_org,p_actor);
 IF NOT EXISTS(SELECT 1 FROM auth.users WHERE id=p_actor AND NOT coalesce((to_jsonb(users)->>'is_anonymous')::boolean,false)) THEN RAISE EXCEPTION 'Organization access denied';END IF;
 IF jsonb_typeof(p_refs) IS DISTINCT FROM 'array' OR jsonb_array_length(p_refs)>5 THEN RAISE EXCEPTION 'Select at most five exact knowledge sources';END IF;
 FOR ref IN SELECT value FROM jsonb_array_elements(p_refs) LOOP
  IF jsonb_typeof(ref) IS DISTINCT FROM 'object' OR NOT ref ?& ARRAY['document_id','version_id','chunk_id','content_sha256','version_sha256'] OR ref-ARRAY['document_id','version_id','chunk_id','content_sha256','version_sha256']<>'{}'::jsonb
  OR coalesce(ref->>'content_sha256','') !~ '^[0-9a-f]{64}$' OR coalesce(ref->>'version_sha256','') !~ '^[0-9a-f]{64}$'
  OR coalesce(ref->>'document_id','') !~ '^[0-9a-f-]{36}$' OR coalesce(ref->>'version_id','') !~ '^[0-9a-f-]{36}$' OR coalesce(ref->>'chunk_id','') !~ '^[0-9a-f-]{36}$'
  OR (ref->>'chunk_id')=ANY(seen) THEN RAISE EXCEPTION 'Invalid or duplicate knowledge source reference';END IF;
  seen:=array_append(seen,ref->>'chunk_id');
  SELECT jsonb_build_object('document_id',d.id,'version_id',v.id,'chunk_id',c.id,'source_id','knowledge:'||d.id||':'||v.id||':'||c.id,'title',v.title,'content_text',c.content_text,'content_sha256',c.content_sha256,'version_sha256',v.content_sha256,'version',v.version,'review_due_at',v.review_due_at,'audience',v.audience,'source_kind',v.source_kind,'source_name',v.source_name) INTO item
  FROM public.knowledge_documents d JOIN public.knowledge_document_versions v ON v.organization_id=d.organization_id AND v.document_id=d.id AND v.id=d.current_version_id
  JOIN public.knowledge_chunks c ON c.organization_id=d.organization_id AND c.document_id=d.id AND c.version_id=v.id
  WHERE d.organization_id=p_org AND d.id=(ref->>'document_id')::uuid AND v.id=(ref->>'version_id')::uuid AND c.id=(ref->>'chunk_id')::uuid
  AND d.status='published' AND v.audience='organization' AND v.review_due_at>clock_timestamp()
  AND private.customer_knowledge_usable(c.content_text) AND private.customer_knowledge_usable(v.title) AND private.customer_knowledge_usable(v.source_name)
  AND c.content_sha256=ref->>'content_sha256' AND v.content_sha256=ref->>'version_sha256';
  IF item IS NULL THEN RAISE EXCEPTION 'Knowledge source changed or unavailable';END IF;
  result:=result||jsonb_build_array(item);
 END LOOP;
 RETURN result;
END $$;
CREATE FUNCTION private.customer_knowledge_fresh(p_org uuid,p_request_key uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT NOT EXISTS(
  SELECT 1 FROM private.customer_knowledge_snapshots s CROSS JOIN LATERAL jsonb_array_elements(s.source_refs) ref
  WHERE s.organization_id=p_org AND s.request_key=p_request_key AND NOT EXISTS(
   SELECT 1 FROM public.knowledge_documents d JOIN public.knowledge_document_versions v ON v.organization_id=d.organization_id AND v.document_id=d.id AND v.id=d.current_version_id
   JOIN public.knowledge_chunks c ON c.organization_id=d.organization_id AND c.document_id=d.id AND c.version_id=v.id
   WHERE d.organization_id=p_org AND d.id=(ref->>'document_id')::uuid AND v.id=(ref->>'version_id')::uuid AND c.id=(ref->>'chunk_id')::uuid
   AND d.status='published' AND v.audience='organization' AND v.review_due_at>clock_timestamp()
  AND private.customer_knowledge_usable(c.content_text) AND private.customer_knowledge_usable(v.title) AND private.customer_knowledge_usable(v.source_name)
   AND c.content_sha256=ref->>'content_sha256' AND v.content_sha256=ref->>'version_sha256'
  )
 );
$$;
CREATE FUNCTION private.customer_knowledge_seal(p_org uuid,p_actor uuid,p_workflow uuid,p_key uuid,p_refs jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
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
END $$;

CREATE FUNCTION private.customer_knowledge_search(p_org uuid,p_actor uuid,p_query text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE refs jsonb; result jsonb:='[]'; item jsonb; actor_role text;
BEGIN
 PERFORM private.customer_workflow_lock(p_org);PERFORM public.ai_draft_authorize(p_org,p_actor);
 actor_role:=private.customer_workflow_role(p_org,p_actor);
 IF p_query IS NULL OR length(btrim(p_query)) NOT BETWEEN 2 AND 200 THEN RAISE EXCEPTION 'Search needs 2 to 200 characters';END IF;
 FOR refs IN SELECT jsonb_build_array(jsonb_build_object('document_id',d.id,'version_id',v.id,'chunk_id',c.id,'content_sha256',c.content_sha256,'version_sha256',v.content_sha256))
 FROM public.knowledge_documents d JOIN public.knowledge_document_versions v ON v.organization_id=d.organization_id AND v.document_id=d.id AND v.id=d.current_version_id
 JOIN public.knowledge_chunks c ON c.organization_id=d.organization_id AND c.document_id=d.id AND c.version_id=v.id
 WHERE d.organization_id=p_org AND d.status='published' AND v.audience='organization' AND v.review_due_at>clock_timestamp()
  AND private.customer_knowledge_usable(c.content_text) AND private.customer_knowledge_usable(v.title) AND private.customer_knowledge_usable(v.source_name)
 AND (strpos(lower(c.content_text),lower(btrim(p_query)))>0 OR strpos(lower(v.title),lower(btrim(p_query)))>0)
 ORDER BY v.title,d.id,c.ordinal LIMIT 10 LOOP
  item:=private.customer_knowledge_resolve(p_org,p_actor,refs)->0;result:=result||jsonb_build_array(item);
 END LOOP;
 RETURN jsonb_build_object('organization_id',p_org,'actor',jsonb_build_object('id',p_actor,'role',actor_role),'results',result);
END $$;
CREATE FUNCTION public.customer_workflow_knowledge_search(p_org uuid,p_actor uuid,p_query text) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT private.customer_knowledge_search(p_org,p_actor,p_query); $$;
CREATE FUNCTION public.customer_workflow_knowledge_source(p_org uuid,p_actor uuid,p_reference jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE sources jsonb; actor_role text;
BEGIN
 PERFORM private.customer_workflow_lock(p_org);PERFORM public.ai_draft_authorize(p_org,p_actor);
 actor_role:=private.customer_workflow_role(p_org,p_actor);sources:=private.customer_knowledge_resolve(p_org,p_actor,jsonb_build_array(p_reference));
 RETURN jsonb_build_object('organization_id',p_org,'actor',jsonb_build_object('id',p_actor,'role',actor_role),'source',sources->0);
END $$;

-- Compact canonical JSON matches the Edge's alphabetically ordered source keys.
CREATE FUNCTION private.customer_knowledge_wire(p_value jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE result text;
BEGIN
 IF jsonb_typeof(p_value)='object' THEN
  SELECT '{'||coalesce(string_agg(to_json(key)::text||':'||private.customer_knowledge_wire(value),',' ORDER BY key COLLATE "C"),'')||'}' INTO result FROM jsonb_each(p_value);RETURN result;
 ELSIF jsonb_typeof(p_value)='array' THEN
  SELECT '['||coalesce(string_agg(private.customer_knowledge_wire(value),',' ORDER BY ordinal),'')||']' INTO result FROM jsonb_array_elements(p_value) WITH ORDINALITY a(value,ordinal);RETURN result;
 ELSE RETURN p_value::text;END IF;
END $$;
CREATE FUNCTION private.customer_knowledge_request_hash(p_config uuid,p_input jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to('{"configuration_id":'||to_json(p_config::text)::text||',"input":{"context":'||to_json(p_input->>'context')::text||CASE WHEN p_input ? 'sources' THEN ',"sources":'||private.customer_knowledge_wire(p_input->'sources') ELSE '' END||'}}','UTF8')),'hex');
$$;
CREATE FUNCTION private.customer_knowledge_citations(p_org uuid,p_key uuid,p_draft jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE allowed jsonb; citations jsonb;
BEGIN
 SELECT '["manual-1"]'::jsonb||coalesce(jsonb_agg(src->'source_id'),'[]'::jsonb) INTO allowed
 FROM private.customer_knowledge_snapshots s CROSS JOIN LATERAL jsonb_array_elements(s.sources) src WHERE s.organization_id=p_org AND s.request_key=p_key;
 citations:=p_draft->'source_ids';
 IF jsonb_typeof(citations) IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 RETURN jsonb_array_length(citations)<=6 AND citations <@ allowed AND
 (SELECT count(*)=count(DISTINCT value) FROM jsonb_array_elements(citations));
END $$;


CREATE OR REPLACE FUNCTION public.customer_workflow_prepare_sources(p_org uuid,p_actor uuid,p_workflow uuid,p_expected_revision integer,p_config uuid,p_request_key uuid,p_sources jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
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
END $$;

CREATE OR REPLACE FUNCTION public.customer_workflow_prepare_draft(p_org uuid,p_actor uuid,p_workflow uuid,p_expected_revision integer,p_config uuid,p_request_key uuid) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT public.customer_workflow_prepare_sources(p_org,p_actor,p_workflow,p_expected_revision,p_config,p_request_key,'[]'::jsonb);
$$;

CREATE OR REPLACE FUNCTION public.customer_workflow_draft_input(p_org uuid,p_actor uuid,p_workflow uuid,p_expected_revision integer,p_config uuid,p_request_key uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
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
END $$;

CREATE OR REPLACE FUNCTION private.customer_draft_reservation_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE w public.customer_reply_workflows; input jsonb; expected_hash text;
BEGIN
 SELECT * INTO w FROM public.customer_reply_workflows WHERE organization_id=NEW.organization_id AND ai_request_key=NEW.request_key;
 IF NOT FOUND THEN RETURN NEW;END IF;
 input:=public.customer_workflow_draft_input(NEW.organization_id,NEW.requested_by,w.id,w.revision,NEW.configuration_id,NEW.request_key);
 -- Exactly the existing handler's JSON.stringify({configuration_id,input}) ordering/encoding.
 expected_hash:=private.customer_knowledge_request_hash(NEW.configuration_id,input);
 NEW.knowledge_bound:=jsonb_array_length(coalesce(input->'sources','[]'::jsonb))>0;
 IF NEW.request_hash IS DISTINCT FROM expected_hash THEN RAISE EXCEPTION 'Draft source hash does not match saved context';END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION public.customer_workflow_draft_dispatch(p_org uuid,p_actor uuid,p_workflow uuid,p_expected_revision integer,p_config uuid,p_request_key uuid,p_run uuid,p_request_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE input jsonb; r public.ai_draft_runs;
BEGIN
 -- A final current-authority check immediately before Edge provider dispatch.
 -- It cannot hold a database lock across an external HTTP request; no such claim is made.
 input:=public.customer_workflow_draft_input(p_org,p_actor,p_workflow,p_expected_revision,p_config,p_request_key);
 SELECT * INTO r FROM public.ai_draft_runs WHERE id=p_run AND organization_id=p_org AND request_key=p_request_key AND requested_by=p_actor AND configuration_id=p_config FOR UPDATE;
 IF NOT FOUND OR r.status<>'reserved' OR r.request_hash IS DISTINCT FROM p_request_hash OR p_request_hash IS DISTINCT FROM private.customer_knowledge_request_hash(p_config,input) THEN RAISE EXCEPTION 'Draft dispatch binding changed';END IF;
 RETURN true;
END $$;
CREATE FUNCTION private.customer_knowledge_output_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE w public.customer_reply_workflows;
BEGIN
 IF NEW.knowledge_bound IS DISTINCT FROM OLD.knowledge_bound THEN RAISE EXCEPTION 'Knowledge run binding is immutable';END IF;
 IF NOT NEW.knowledge_bound THEN RETURN NEW;END IF;
 IF NEW.status IN ('awaiting_review','accepted') AND NOT private.customer_knowledge_citations(NEW.organization_id,NEW.request_key,NEW.draft) THEN RAISE EXCEPTION 'Unverified knowledge citation';END IF;
 IF NEW.status='accepted' AND OLD.status<>'accepted' THEN
  SELECT * INTO w FROM public.customer_reply_workflows WHERE organization_id=NEW.organization_id AND ai_request_key=NEW.request_key;
  IF NOT FOUND OR w.status<>'drafting' THEN RAISE EXCEPTION 'Customer draft binding changed';END IF;
  PERFORM public.ai_draft_authorize(NEW.organization_id,NEW.reviewed_by);
  PERFORM private.customer_workflow_access(NEW.organization_id,NEW.reviewed_by,w.id,true);
  PERFORM public.customer_workflow_draft_input(NEW.organization_id,w.draft_requested_by,w.id,w.revision,w.configuration_id,w.ai_request_key);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER customer_knowledge_output_guard BEFORE UPDATE ON public.ai_draft_runs FOR EACH ROW EXECUTE FUNCTION private.customer_knowledge_output_guard();


CREATE OR REPLACE FUNCTION private.customer_workflow_project(w public.customer_reply_workflows) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE a public.ai_draft_runs; proposal public.action_requests; c public.customer_reply_context_versions; config public.ai_draft_configurations; receipt jsonb; projected_status text; knowledge_sources jsonb; knowledge_stale boolean;
BEGIN
 SELECT * INTO a FROM public.ai_draft_runs WHERE organization_id=w.organization_id AND request_key=w.ai_request_key AND configuration_id=w.configuration_id AND requested_by=w.draft_requested_by;
 SELECT * INTO proposal FROM public.action_requests WHERE id=w.action_request_id AND organization_id=w.organization_id AND customer_workflow_id=w.id;
 SELECT * INTO c FROM public.customer_reply_context_versions WHERE id=w.context_version_id AND organization_id=w.organization_id;
 SELECT * INTO config FROM public.ai_draft_configurations WHERE id=w.configuration_id AND organization_id=w.organization_id;
 SELECT jsonb_build_object('phase',phase,'dispatch_started_at',dispatch_started_at,'provider_accepted_at',provider_accepted_at,'provider_reference',provider_reference,'reconciled_at',reconciled_at)
 INTO receipt FROM public.action_execution_receipts WHERE request_id=proposal.id AND organization_id=w.organization_id;
 knowledge_stale:=NOT private.customer_knowledge_fresh(w.organization_id,w.ai_request_key);
 SELECT CASE WHEN knowledge_stale THEN '[]'::jsonb ELSE s.sources END INTO knowledge_sources FROM private.customer_knowledge_snapshots s WHERE s.organization_id=w.organization_id AND s.request_key=w.ai_request_key;
 IF knowledge_stale THEN a.draft:=NULL;proposal.payload:=NULL;proposal.summary:='Knowledge source unavailable';proposal.title:='Customer reply unavailable';END IF;
 projected_status:=w.status;
 IF w.status='drafting' THEN projected_status:=CASE a.status WHEN 'awaiting_review' THEN 'draft_ready' WHEN 'accepted' THEN 'draft_accepted' WHEN 'rejected' THEN 'draft_rejected' WHEN 'failed' THEN 'ai_failed' WHEN 'unknown' THEN 'ai_unknown' ELSE 'drafting' END;END IF;
 RETURN to_jsonb(w)||jsonb_build_object('knowledge_sources',coalesce(knowledge_sources,'[]'::jsonb),'knowledge_stale',knowledge_stale,'status',projected_status,'ai_run',CASE WHEN a.id IS NULL THEN NULL ELSE to_jsonb(a) END,
 'action_request',CASE WHEN proposal.id IS NULL THEN NULL ELSE to_jsonb(proposal) END,'receipt',receipt,
 'context_version',CASE WHEN c.id IS NULL THEN NULL ELSE to_jsonb(c) END,'configuration',CASE WHEN config.id IS NULL THEN NULL ELSE to_jsonb(config) END,
 'configuration_stale',w.configuration_id IS NOT NULL AND w.configuration_id IS DISTINCT FROM (SELECT id FROM public.ai_draft_configurations WHERE organization_id=w.organization_id ORDER BY version DESC LIMIT 1),
 'context_stale',w.context_version_id IS NOT NULL AND w.context_version_id IS DISTINCT FROM (SELECT id FROM public.customer_reply_context_versions WHERE organization_id=w.organization_id ORDER BY version DESC LIMIT 1));
END $$;

CREATE OR REPLACE FUNCTION public.customer_workflow_load(p_org uuid,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
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
 RETURN jsonb_build_object('knowledge_contract_version',1,'actor',jsonb_build_object('id',p_actor,'role',actor_role),'context',contexts,'configuration',config,'workflows',rows,'people',people,'limit',100,
 'readiness',jsonb_build_object('context_ready',contexts IS NOT NULL,'configuration_ready',coalesce(config->'configuration'->>'task'='customer_reply',false),'microsoft_ready',microsoft,'microsoft_connection_id',CASE WHEN microsoft THEN connection_identifier ELSE NULL END,'microsoft_account',CASE WHEN microsoft THEN account ELSE NULL END,'distinct_reviewer_available',reviewers,'live_inference_enabled',false));
END $$;

CREATE OR REPLACE FUNCTION public.customer_workflow_queue(p_org uuid,p_actor uuid,p_workflow uuid,p_expected_revision integer) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
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
END $$;

CREATE OR REPLACE FUNCTION private.customer_workflow_assert_action(a public.action_requests) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
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
END $$;

CREATE FUNCTION public.customer_workflow_visible_run(p_org uuid,p_actor uuid,p_run uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE r public.ai_draft_runs; sources jsonb; stale boolean;
BEGIN
 PERFORM private.customer_workflow_lock(p_org);PERFORM public.ai_draft_authorize(p_org,p_actor);
 SELECT * INTO r FROM public.ai_draft_runs WHERE organization_id=p_org AND id=p_run;
 IF NOT FOUND THEN RAISE EXCEPTION 'Run unavailable';END IF;
 stale:=NOT private.customer_knowledge_fresh(p_org,r.request_key);
 SELECT CASE WHEN stale THEN '[]'::jsonb ELSE s.sources END INTO sources FROM private.customer_knowledge_snapshots s WHERE s.organization_id=p_org AND s.request_key=r.request_key;
 IF r.knowledge_bound AND (sources IS NULL OR stale) THEN r.draft:=NULL;stale:=true;END IF;
 RETURN to_jsonb(r)||jsonb_build_object('knowledge_sources',coalesce(sources,'[]'::jsonb),'knowledge_stale',stale);
END $$;
CREATE FUNCTION public.customer_workflow_visible_action(p_org uuid,p_actor uuid,p_action uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE a public.action_requests; w public.customer_reply_workflows; stale boolean;
BEGIN
 PERFORM private.customer_workflow_lock(p_org);PERFORM public.ai_draft_authorize(p_org,p_actor);
 SELECT * INTO a FROM public.action_requests WHERE organization_id=p_org AND id=p_action;
 IF NOT FOUND OR a.customer_workflow_id IS NULL THEN RAISE EXCEPTION 'Customer action unavailable';END IF;
 w:=private.customer_workflow_access(p_org,p_actor,a.customer_workflow_id,false);
 IF w.action_request_id IS DISTINCT FROM a.id THEN RAISE EXCEPTION 'Customer action binding changed';END IF;
 stale:=NOT private.customer_knowledge_fresh(p_org,w.ai_request_key);
 IF stale THEN a.payload:=NULL;a.title:='Customer reply unavailable';a.summary:='Knowledge source unavailable';END IF;
 RETURN to_jsonb(a)||jsonb_build_object('knowledge_stale',stale);
END $$;
-- Existing authenticated action visibility becomes narrower for source-derived
-- emails: stale/restricted source content is not exposed in other dashboards.
CREATE OR REPLACE FUNCTION private.customer_action_readable(p_org uuid,p_request uuid,p_workflow uuid)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT auth.uid() IS NOT NULL
 AND EXISTS(SELECT 1 FROM auth.users u WHERE u.id=auth.uid() AND NOT coalesce((to_jsonb(u)->>'is_anonymous')::boolean,false))
 AND EXISTS(SELECT 1 FROM public.customer_reply_workflows w JOIN public.organization_members m ON m.organization_id=w.organization_id AND m.user_id=auth.uid()
 WHERE w.organization_id=p_org AND w.id=p_workflow AND w.action_request_id=p_request
 AND (m.role IN ('owner','admin','consultant','viewer') OR (m.role='member' AND w.assigned_to=m.user_id))
 AND private.customer_knowledge_fresh(w.organization_id,w.ai_request_key));
$$;
DO $$ DECLARE signature text; BEGIN
 FOREACH signature IN ARRAY ARRAY[
  'private.customer_knowledge_usable(text)', 'private.customer_knowledge_snapshot_immutable()', 'private.customer_knowledge_resolve(uuid,uuid,jsonb)',
  'private.customer_knowledge_fresh(uuid,uuid)', 'private.customer_knowledge_seal(uuid,uuid,uuid,uuid,jsonb)',
  'private.customer_knowledge_search(uuid,uuid,text)', 'private.customer_knowledge_wire(jsonb)',
  'private.customer_knowledge_request_hash(uuid,jsonb)', 'private.customer_knowledge_citations(uuid,uuid,jsonb)',
  'private.customer_knowledge_output_guard()', 'public.customer_workflow_prepare_sources(uuid,uuid,uuid,integer,uuid,uuid,jsonb)',
  'public.customer_workflow_knowledge_search(uuid,uuid,text)', 'public.customer_workflow_knowledge_source(uuid,uuid,jsonb)',
  'public.customer_workflow_draft_dispatch(uuid,uuid,uuid,integer,uuid,uuid,uuid,text)', 'public.customer_workflow_visible_run(uuid,uuid,uuid)',
  'public.customer_workflow_visible_action(uuid,uuid,uuid)'
 ] LOOP
  EXECUTE 'REVOKE ALL ON FUNCTION '||signature||' FROM PUBLIC,anon,authenticated,service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION '||signature||' TO service_role';
 END LOOP;
END $$;
-- CREATE OR REPLACE preserves existing grants on the unchanged signatures.
COMMIT;
