-- SOURCE-ONLY REVIEW CANDIDATE. No production execution or provider calls.
-- Apply after company-email-oauth, employee-drafting and mailbox-intake contracts.
-- Legacy Microsoft function/column names remain compatibility aliases; existing
-- immutable installation records are not rewritten. New records bind email_connection_id.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';

CREATE OR REPLACE FUNCTION private.email_has_scope(c public.oauth_connections,p_capability text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(CASE c.provider
 WHEN 'microsoft' THEN (CASE p_capability WHEN 'read' THEN 'Mail.Read' WHEN 'send' THEN 'Mail.Send' END)=ANY(c.scopes)
 WHEN 'google' THEN (CASE p_capability WHEN 'read' THEN 'https://www.googleapis.com/auth/gmail.readonly' WHEN 'send' THEN 'https://www.googleapis.com/auth/gmail.send' END)=ANY(c.scopes)
 ELSE false END,false);
$$;
CREATE OR REPLACE FUNCTION private.installation_email_id(p_bindings jsonb)
RETURNS uuid LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(p_bindings->>'email_connection_id',p_bindings->>'microsoft_connection_id')::uuid;
$$;
CREATE OR REPLACE FUNCTION private.workflow_email_connection_live(c public.oauth_connections,i public.integrations)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF c.id IS NULL OR c.provider NOT IN ('microsoft','google') OR c.status IS DISTINCT FROM 'Connected' OR c.oauth_verified_version IS DISTINCT FROM 1 OR nullif(btrim(c.external_account_id),'') IS NULL
  OR i.id IS DISTINCT FROM c.integration_id OR i.organization_id IS DISTINCT FROM c.organization_id OR i.status IS DISTINCT FROM 'Connected' OR i.integration_type IS DISTINCT FROM 'OAuth'
  OR i.provider IS DISTINCT FROM (CASE c.provider WHEN 'microsoft' THEN 'Microsoft' WHEN 'google' THEN 'Google' END) THEN RETURN false;END IF;
 IF c.provider='google' OR c.oauth_connected_by IS NOT NULL THEN RETURN public.validate_email_connection(c.id,c.organization_id,private.email_connection_binding(c,i));END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE OR REPLACE FUNCTION private.workflow_installation_connection(p_org uuid,p_id uuid) RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE c public.oauth_connections; i public.integrations;
BEGIN
 PERFORM private.customer_workflow_lock(p_org);
 SELECT * INTO c FROM public.oauth_connections WHERE id=p_id AND organization_id=p_org FOR SHARE;
 IF NOT FOUND OR c.provider NOT IN ('microsoft','google') OR c.status IS DISTINCT FROM 'Connected' OR c.oauth_verified_version IS DISTINCT FROM 1 OR nullif(btrim(c.external_account_id),'') IS NULL OR NOT private.email_has_scope(c,'send') THEN RETURN NULL;END IF;
 SELECT * INTO i FROM public.integrations WHERE id=c.integration_id AND organization_id=p_org FOR SHARE;
 IF NOT FOUND OR i.provider IS DISTINCT FROM (CASE c.provider WHEN 'microsoft' THEN 'Microsoft' WHEN 'google' THEN 'Google' END) OR i.integration_type IS DISTINCT FROM 'OAuth' OR i.status IS DISTINCT FROM 'Connected' THEN RETURN NULL;END IF;
 IF NOT private.workflow_email_connection_live(c,i) THEN RETURN NULL;END IF;
 RETURN encode(sha256(convert_to(private.email_connection_binding(c,i)::text,'UTF8')),'hex');
END $$;

CREATE OR REPLACE FUNCTION private.workflow_installation_readiness(v public.workflow_installation_versions,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE reasons jsonb:='[]'; c public.customer_reply_context_versions; cfg public.ai_draft_configurations; fingerprint text; assignee uuid; reviewer uuid; can_start boolean; actor_role text;
BEGIN
 SELECT * INTO c FROM public.customer_reply_context_versions WHERE organization_id=v.organization_id ORDER BY version DESC LIMIT 1;
 SELECT * INTO cfg FROM public.ai_draft_configurations WHERE organization_id=v.organization_id ORDER BY version DESC LIMIT 1;
 IF v.bindings->>'context_version_id' IS NULL THEN reasons:=reasons||'"context_missing"'::jsonb;
 ELSIF c.id IS NULL OR c.id::text IS DISTINCT FROM v.bindings->>'context_version_id' THEN reasons:=reasons||'"context_changed"'::jsonb;END IF;
 IF v.bindings->>'configuration_id' IS NULL THEN reasons:=reasons||'"configuration_missing"'::jsonb;
 ELSIF cfg.id IS NULL OR cfg.id::text IS DISTINCT FROM v.bindings->>'configuration_id' OR cfg.configuration->>'task' IS DISTINCT FROM 'customer_reply' OR cfg.configuration->>'source' IS DISTINCT FROM 'manual_context' OR cfg.configuration->'human_review' IS DISTINCT FROM 'true'::jsonb THEN reasons:=reasons||'"configuration_changed"'::jsonb;END IF;
 IF private.installation_email_id(v.bindings) IS NULL THEN reasons:=reasons||'"email_missing"'::jsonb;
 ELSE
  fingerprint:=private.workflow_installation_connection(v.organization_id,private.installation_email_id(v.bindings));
  IF fingerprint IS NULL OR fingerprint IS DISTINCT FROM v.microsoft_binding_sha256 THEN reasons:=reasons||'"email_changed"'::jsonb;END IF;
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
 IF v.revision IS DISTINCT FROM (SELECT revision FROM public.workflow_installations WHERE id=v.installation_id AND organization_id=v.organization_id) THEN reasons:=reasons||'"installation_changed"'::jsonb;END IF;
 SELECT role INTO actor_role FROM public.organization_members WHERE organization_id=v.organization_id AND user_id=p_actor;
 can_start:=reasons='[]'::jsonb AND p_actor IS DISTINCT FROM reviewer AND (actor_role IN ('owner','admin','consultant') OR (actor_role='member' AND p_actor=assignee));
 RETURN jsonb_build_object('configured',reasons='[]'::jsonb,'can_start',coalesce(can_start,false),'reasons',reasons,
 'start_blocker',CASE WHEN p_actor=reviewer THEN 'reviewer_conflict' WHEN actor_role='viewer' THEN 'read_only' WHEN actor_role='member' AND p_actor IS DISTINCT FROM assignee THEN 'assignment_required' ELSE NULL END,
 'live_inference_enabled',false,'automatic_execution_enabled',false,'source','manual_company_guidance','human_review_required',true);
END $$;

CREATE OR REPLACE FUNCTION public.workflow_installations_save(p_org uuid,p_actor uuid,p_installation uuid,p_expected_revision integer,p_request_key uuid,p_spec jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
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
 OR jsonb_typeof(p_spec->'bindings') IS DISTINCT FROM 'object' OR NOT (((p_spec->'bindings') ?& ARRAY['context_version_id','configuration_id','email_connection_id','assigned_to','reviewer_id'] AND (p_spec->'bindings')-ARRAY['context_version_id','configuration_id','email_connection_id','assigned_to','reviewer_id']='{}'::jsonb) OR ((p_spec->'bindings') ?& ARRAY['context_version_id','configuration_id','microsoft_connection_id','assigned_to','reviewer_id'] AND (p_spec->'bindings')-ARRAY['context_version_id','configuration_id','microsoft_connection_id','assigned_to','reviewer_id']='{}'::jsonb))
 OR jsonb_typeof(p_spec->'limits') IS DISTINCT FROM 'object' OR NOT (p_spec->'limits') ? 'max_open_requests' OR (p_spec->'limits')-'max_open_requests'<>'{}'::jsonb OR jsonb_typeof(p_spec->'limits'->'max_open_requests') IS DISTINCT FROM 'number' OR (p_spec->'limits'->>'max_open_requests') !~ '^[0-9]+$' OR (p_spec->'limits'->>'max_open_requests')::numeric NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid installation specification';END IF;
 FOREACH field IN ARRAY ARRAY['context_version_id','configuration_id',CASE WHEN p_spec->'bindings' ? 'email_connection_id' THEN 'email_connection_id' ELSE 'microsoft_connection_id' END,'assigned_to','reviewer_id'] LOOP
  IF p_spec->'bindings'->field <> 'null'::jsonb AND (jsonb_typeof(p_spec->'bindings'->field) IS DISTINCT FROM 'string' OR (p_spec->'bindings'->>field) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN RAISE EXCEPTION 'Invalid binding reference';END IF;
  reference:=(p_spec->'bindings'->>field)::uuid;
  IF reference IS NOT NULL THEN
   IF field='context_version_id' AND NOT EXISTS(SELECT 1 FROM public.customer_reply_context_versions WHERE id=reference AND organization_id=p_org) OR field='configuration_id' AND NOT EXISTS(SELECT 1 FROM public.ai_draft_configurations WHERE id=reference AND organization_id=p_org) OR field IN ('microsoft_connection_id','email_connection_id') AND NOT EXISTS(SELECT 1 FROM public.oauth_connections WHERE id=reference AND organization_id=p_org) OR field IN ('assigned_to','reviewer_id') AND NOT EXISTS(SELECT 1 FROM public.organization_members WHERE user_id=reference AND organization_id=p_org) THEN RAISE EXCEPTION 'Binding unavailable';END IF;
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
 fingerprint:=private.workflow_installation_connection(p_org,private.installation_email_id(p_spec->'bindings'));
 INSERT INTO public.workflow_installation_versions(installation_id,organization_id,revision,recipe_key,recipe_version,name,outcome,bindings,limits,microsoft_binding_sha256,saved_by)
 VALUES(head.id,p_org,head.revision,p_spec->>'recipe_key',(p_spec->>'recipe_version')::integer,p_spec->>'name',p_spec->>'outcome',p_spec->'bindings',p_spec->'limits',fingerprint,p_actor) RETURNING * INTO v;
 INSERT INTO private.workflow_installation_saves(organization_id,request_key,actor_id,installation_id,installation_revision,request) VALUES(p_org,p_request_key,p_actor,head.id,head.revision,request);
 INSERT INTO public.audit_events(organization_id,actor_user_id,event_type,entity_type,entity_id,summary,metadata) VALUES(p_org,p_actor,'workflow_installation_saved','workflow_installations',head.id,'Workflow installation settings saved',jsonb_build_object('revision',head.revision,'recipe_key',v.recipe_key,'recipe_version',v.recipe_version));
 RETURN private.workflow_installation_project(v,p_actor);
END $$;

CREATE OR REPLACE FUNCTION private.workflow_installation_assert_action(a public.action_requests) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE w public.customer_reply_workflows; v public.workflow_installation_versions;
BEGIN
 IF a.customer_workflow_id IS NULL THEN RETURN;END IF;
 SELECT * INTO w FROM public.customer_reply_workflows WHERE id=a.customer_workflow_id AND organization_id=a.organization_id;
 v:=private.workflow_installation_assert(w,a.requested_by);
 IF v.installation_id IS NULL THEN RETURN;END IF;
 IF a.connection_id IS DISTINCT FROM private.installation_email_id(v.bindings) OR a.requested_by::text=v.bindings->>'reviewer_id' THEN RAISE EXCEPTION 'Installation action binding changed';END IF;
 IF a.status IN ('Approved','Executing','Executed') AND a.approved_by::text IS DISTINCT FROM v.bindings->>'reviewer_id' THEN RAISE EXCEPTION 'Designated installation reviewer required';END IF;
END $$;

CREATE OR REPLACE FUNCTION private.customer_workflow_project(w public.customer_reply_workflows) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE a public.ai_draft_runs; proposal public.action_requests; c public.customer_reply_context_versions; config public.ai_draft_configurations; receipt jsonb; projected_status text; knowledge_sources jsonb; knowledge_stale boolean; email_id uuid; email_provider text;
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
 SELECT coalesce(proposal.connection_id,private.installation_email_id(v.bindings)) INTO email_id
 FROM public.workflow_installation_requests r JOIN public.workflow_installation_versions v ON v.organization_id=r.organization_id AND v.installation_id=r.installation_id AND v.revision=r.installation_revision WHERE r.organization_id=w.organization_id AND r.workflow_id=w.id;
 email_id:=coalesce(email_id,proposal.connection_id);
 SELECT provider INTO email_provider FROM public.oauth_connections WHERE id=email_id AND organization_id=w.organization_id;
 projected_status:=w.status;
 IF w.status='drafting' THEN projected_status:=CASE a.status WHEN 'awaiting_review' THEN 'draft_ready' WHEN 'accepted' THEN 'draft_accepted' WHEN 'rejected' THEN 'draft_rejected' WHEN 'failed' THEN 'ai_failed' WHEN 'unknown' THEN 'ai_unknown' ELSE 'drafting' END;END IF;
 RETURN to_jsonb(w)||jsonb_build_object('knowledge_sources',coalesce(knowledge_sources,'[]'::jsonb),'knowledge_stale',knowledge_stale,'status',projected_status,'ai_run',CASE WHEN a.id IS NULL THEN NULL ELSE to_jsonb(a) END,
 'email_connection_id',email_id,'email_provider',email_provider,
 'action_request',CASE WHEN proposal.id IS NULL THEN NULL ELSE to_jsonb(proposal) END,'receipt',receipt,
 'context_version',CASE WHEN c.id IS NULL THEN NULL ELSE to_jsonb(c) END,'configuration',CASE WHEN config.id IS NULL THEN NULL ELSE to_jsonb(config) END,
 'configuration_stale',w.configuration_id IS NOT NULL AND w.configuration_id IS DISTINCT FROM (SELECT id FROM public.ai_draft_configurations WHERE organization_id=w.organization_id ORDER BY version DESC LIMIT 1),
 'context_stale',w.context_version_id IS NOT NULL AND w.context_version_id IS DISTINCT FROM (SELECT id FROM public.customer_reply_context_versions WHERE organization_id=w.organization_id ORDER BY version DESC LIMIT 1));
END $$;

CREATE OR REPLACE FUNCTION public.workflow_installations_start(p_org uuid,p_actor uuid,p_installation uuid,p_expected_revision integer,p_request_key uuid,p_intake jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
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
 SELECT * INTO stored FROM public.customer_reply_workflows WHERE id=previous.workflow_id AND organization_id=p_org;
 RETURN jsonb_build_object('installation',private.workflow_installation_project(v,p_actor),'workflow',private.customer_workflow_project(stored),'provenance',to_jsonb(previous),'replayed',false);
END $$;

CREATE OR REPLACE FUNCTION public.customer_workflow_load(p_org uuid,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE actor_role text; contexts jsonb; config jsonb; rows jsonb; people jsonb; microsoft boolean; account text; connection_identifier text; reviewers boolean; activation jsonb; emails jsonb;
BEGIN
 PERFORM private.customer_workflow_lock(p_org);
 actor_role:=private.customer_workflow_role(p_org,p_actor);
 SELECT to_jsonb(c) INTO contexts FROM public.customer_reply_context_versions c WHERE organization_id=p_org ORDER BY version DESC LIMIT 1;
 SELECT to_jsonb(c) INTO config FROM public.ai_draft_configurations c WHERE organization_id=p_org ORDER BY version DESC LIMIT 1;
 SELECT coalesce(jsonb_agg(private.customer_workflow_draft_project(w,p_actor) ORDER BY w.created_at DESC,w.id),'[]'::jsonb) INTO rows
 FROM (SELECT * FROM public.customer_reply_workflows WHERE organization_id=p_org AND (actor_role<>'member' OR assigned_to=p_actor) ORDER BY created_at DESC,id LIMIT 100) w;
 SELECT coalesce(jsonb_agg(jsonb_build_object('user_id',user_id,'role',role) ORDER BY user_id),'[]'::jsonb) INTO people FROM public.organization_members WHERE organization_id=p_org AND role IN ('owner','admin','consultant','member');
 SELECT count(*)=1,min(c.external_account_id),min(c.id::text) INTO microsoft,account,connection_identifier FROM public.oauth_connections c JOIN public.integrations i ON i.id=c.integration_id AND i.organization_id=c.organization_id
 WHERE c.organization_id=p_org AND c.provider='microsoft' AND c.status='Connected' AND c.oauth_verified_version=1 AND nullif(btrim(c.external_account_id),'') IS NOT NULL AND 'Mail.Send'=ANY(c.scopes)
 AND i.status='Connected' AND i.provider='Microsoft' AND i.integration_type='OAuth' AND private.workflow_email_connection_live(c,i);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'provider',c.provider,'oauth_revision',c.oauth_revision,'account_email',c.external_account_email,'account_name',coalesce(nullif(c.external_account_email,''),c.external_account_id),'external_account_id',c.external_account_id,'mail_read',private.workflow_email_connection_live(c,i) AND private.email_has_scope(c,'read'),'mail_send',private.workflow_email_connection_live(c,i) AND private.email_has_scope(c,'send')) ORDER BY c.provider,c.id),'[]'::jsonb) INTO emails
 FROM public.oauth_connections c JOIN public.integrations i ON i.id=c.integration_id AND i.organization_id=c.organization_id
 WHERE c.organization_id=p_org AND c.provider IN ('microsoft','google') AND c.status='Connected' AND c.oauth_verified_version=1 AND nullif(btrim(c.external_account_id),'') IS NOT NULL
 AND i.status='Connected' AND i.provider=CASE c.provider WHEN 'microsoft' THEN 'Microsoft' ELSE 'Google' END AND i.integration_type='OAuth';
 SELECT exists(SELECT 1 FROM public.organization_members WHERE organization_id=p_org AND user_id<>p_actor AND role IN ('owner','admin','consultant')) INTO reviewers;
 activation:=private.ai_inference_status(p_org,(config->>'id')::uuid);
 RETURN jsonb_build_object('knowledge_contract_version',1,'actor',jsonb_build_object('id',p_actor,'role',actor_role),'context',contexts,'configuration',config,'workflows',rows,'people',people,'limit',100,
 'readiness',jsonb_build_object('email_connections',emails,'email_ready',exists(SELECT 1 FROM jsonb_array_elements(emails) e WHERE e->'mail_send'='true'::jsonb),'context_ready',contexts IS NOT NULL,'configuration_ready',coalesce(config->'configuration'->>'task'='customer_reply',false),'microsoft_ready',microsoft,'microsoft_connection_id',CASE WHEN microsoft THEN connection_identifier ELSE NULL END,'microsoft_account',CASE WHEN microsoft THEN account ELSE NULL END,'distinct_reviewer_available',reviewers,'live_inference_enabled',activation->'enabled','activation',activation));
END $$;

CREATE OR REPLACE FUNCTION public.customer_workflow_queue_email(p_org uuid,p_actor uuid,p_workflow uuid,p_expected_revision integer,p_connection uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE w public.customer_reply_workflows; a public.ai_draft_runs; c public.oauth_connections; proposal public.action_requests; n integer; payload jsonb; installed public.workflow_installation_versions; selected uuid;
BEGIN
 PERFORM private.customer_workflow_lock(p_org);
 w:=private.customer_workflow_access(p_org,p_actor,p_workflow,true);
 IF w.status='cancelled' THEN RAISE EXCEPTION 'Workflow cancelled';END IF;
 IF w.action_request_id IS NOT NULL THEN
  IF p_connection IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.action_requests WHERE id=w.action_request_id AND organization_id=p_org AND connection_id=p_connection) THEN RAISE EXCEPTION 'Queued email account binding changed';END IF;
  RETURN private.customer_workflow_project(w);
 END IF;
 IF NOT private.customer_knowledge_fresh(p_org,w.ai_request_key) THEN RAISE EXCEPTION 'Knowledge source changed or unavailable';END IF;
 IF w.revision IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'Workflow changed; reload';END IF;
 IF w.context_version_id IS DISTINCT FROM (SELECT id FROM public.customer_reply_context_versions WHERE organization_id=p_org ORDER BY version DESC LIMIT 1) THEN RAISE EXCEPTION 'Company context changed; prepare a new draft';END IF;
 IF w.configuration_id IS DISTINCT FROM (SELECT id FROM public.ai_draft_configurations WHERE organization_id=p_org ORDER BY version DESC LIMIT 1) THEN RAISE EXCEPTION 'AI configuration changed; prepare a new draft';END IF;
 SELECT * INTO a FROM public.ai_draft_runs WHERE organization_id=p_org AND request_key=w.ai_request_key AND configuration_id=w.configuration_id AND requested_by=w.draft_requested_by FOR SHARE;
 IF NOT FOUND OR a.status<>'accepted' OR a.reviewed_by IS NULL THEN RAISE EXCEPTION 'Accepted AI draft required';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.organization_members WHERE organization_id=p_org AND user_id=w.assigned_to AND role IN ('owner','admin','consultant','member')) THEN RAISE EXCEPTION 'Assignee unavailable';END IF;
 PERFORM private.customer_workflow_draft_authorize(w.organization_id,w.draft_requested_by,w.id);
 IF jsonb_typeof(a.draft) IS DISTINCT FROM 'object' OR NOT a.draft ?& ARRAY['title','body','source_ids','warnings'] OR a.draft-ARRAY['title','body','source_ids','warnings']<>'{}'::jsonb
 OR jsonb_typeof(a.draft->'title') IS DISTINCT FROM 'string' OR length(btrim(a.draft->>'title')) NOT BETWEEN 1 AND 200 OR a.draft->>'title' ~ E'[\r\n]'
 OR jsonb_typeof(a.draft->'body') IS DISTINCT FROM 'string' OR length(btrim(a.draft->>'body')) NOT BETWEEN 1 AND 30000
 OR NOT private.customer_knowledge_citations(p_org,w.ai_request_key,a.draft)
 OR jsonb_typeof(a.draft->'warnings') IS DISTINCT FROM 'array' OR jsonb_array_length(a.draft->'warnings')>10
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(a.draft->'warnings') warning WHERE jsonb_typeof(warning)<>'string' OR length(warning #>> '{}')>1000) THEN RAISE EXCEPTION 'Invalid accepted AI draft';END IF;
 installed:=private.workflow_installation_assert(w,p_actor);
 selected:=private.installation_email_id(installed.bindings);
 IF installed.installation_id IS NOT NULL AND p_connection IS NOT NULL AND p_connection IS DISTINCT FROM selected THEN RAISE EXCEPTION 'Installed email account binding changed';END IF;
 selected:=coalesce(selected,p_connection);
 IF selected IS NULL THEN
  SELECT count(*),min(x.id::text)::uuid INTO n,selected FROM public.oauth_connections x WHERE x.organization_id=p_org AND private.workflow_installation_connection(p_org,x.id) IS NOT NULL;
  IF n<>1 THEN RAISE EXCEPTION 'Choose one verified email sending account';END IF;
 END IF;
 IF private.workflow_installation_connection(p_org,selected) IS NULL THEN RAISE EXCEPTION 'Verified email sending account unavailable';END IF;
 SELECT * INTO c FROM public.oauth_connections WHERE id=selected AND organization_id=p_org FOR SHARE;
 payload:=jsonb_build_object('to',w.customer_email,'subject',a.draft->>'title','message',a.draft->>'body');
 INSERT INTO public.action_requests(organization_id,integration_id,connection_id,provider,action_type,status,title,summary,payload,requested_by,workflow_run_id,customer_workflow_id)
 VALUES(p_org,c.integration_id,c.id,c.provider,'send_email','Pending','Customer reply approval','Review customer reply: '||(a.draft->>'title'),payload,p_actor,NULL,w.id) RETURNING * INTO proposal;
 UPDATE public.customer_reply_workflows SET status='awaiting_approval',action_request_id=proposal.id,revision=revision+1,updated_at=now(),updated_by=p_actor WHERE id=w.id RETURNING * INTO w;
 RETURN private.customer_workflow_project(w);
END $$;

CREATE OR REPLACE FUNCTION public.customer_workflow_queue(p_org uuid,p_actor uuid,p_workflow uuid,p_expected_revision integer) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT public.customer_workflow_queue_email(p_org,p_actor,p_workflow,p_expected_revision,NULL);
$$;

CREATE OR REPLACE FUNCTION private.guard_execution_request() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if TG_OP='INSERT' then
    if new.status is distinct from 'Pending' or new.approved_by is not null or new.approved_at is not null
       or new.executed_at is not null then
      raise exception 'New requests must be unapproved pending proposals';
    end if;
    if TG_TABLE_NAME='action_requests' then
      new := jsonb_populate_record(new, '{"approval_guard_version":0,"approved_connection_binding":null}'::jsonb);
    end if;
    return new;
  end if;
  -- Bind the approval to the entire original proposal, not a client hash.
  if (to_jsonb(new)-array['status','approved_by','approved_at','rejected_by','rejected_at','executed_at','error_message','updated_at','workflow_run_id','approval_guard_version','approved_connection_binding'])
     is distinct from
     (to_jsonb(old)-array['status','approved_by','approved_at','rejected_by','rejected_at','executed_at','error_message','updated_at','workflow_run_id','approval_guard_version','approved_connection_binding']) then
    raise exception 'Request proposal is immutable; create a new request';
  end if;
  if TG_TABLE_NAME='action_requests' and new.workflow_run_id is distinct from old.workflow_run_id then
    raise exception 'Approved workflow association is immutable';
  end if;
  if old.status is distinct from 'Pending' and (new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at) then
    raise exception 'Approval evidence is immutable';
  end if;
  if TG_TABLE_NAME='action_requests' and ((to_jsonb(new)->'approval_guard_version') is distinct from (to_jsonb(old)->'approval_guard_version') or (to_jsonb(new)->'approved_connection_binding') is distinct from (to_jsonb(old)->'approved_connection_binding')) then
    raise exception 'Approval guard version is server managed';
  end if;
  if new.status='Approved' and old.status='Pending' then
    if new.approved_by is null or new.approved_at is null or new.requested_by is null or new.approved_by=new.requested_by then
      raise exception 'Distinct human approval is required';
    end if;
    if TG_TABLE_NAME='action_requests' then
      perform private.assert_workflow_action_approval(new.workflow_run_id,new.organization_id,new.approved_by,new.action_type);
      new := jsonb_populate_record(new, jsonb_build_object('approval_guard_version',1,
        'approved_connection_binding',(select private.email_connection_binding(c,i) from public.oauth_connections c join public.integrations i on i.id=c.integration_id and i.organization_id=c.organization_id where c.id=new.connection_id and c.organization_id=new.organization_id)));
      if new.provider NOT IN ('microsoft','google') OR new.action_type IS DISTINCT FROM 'send_email' OR private.workflow_installation_connection(new.organization_id,new.connection_id) IS NULL OR NOT EXISTS(SELECT 1 FROM public.oauth_connections WHERE id=new.connection_id AND organization_id=new.organization_id AND integration_id=new.integration_id AND provider=new.provider) OR to_jsonb(new)->'approved_connection_binding'='null'::jsonb then raise exception 'Connection cannot be approved'; end if;
    end if;
  elsif new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at then
    raise exception 'Approval evidence requires an approval transition';
  end if;
  if new.status is distinct from old.status and not (
    (old.status='Pending' and new.status in ('Approved','Rejected')) or
    (TG_TABLE_NAME='action_requests' and old.status='Approved' and new.status='Executing') or
    (TG_TABLE_NAME='action_requests' and old.status='Executing' and new.status in ('Executed','Failed'))
  ) then raise exception 'Invalid or repeated execution transition'; end if;
  return new;
end $$;

CREATE OR REPLACE FUNCTION public.review_email_action(p_request_id uuid,p_actor_id uuid,p_decision text)
RETURNS public.action_requests LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE r public.action_requests; request_org uuid;
BEGIN
 SELECT organization_id INTO request_org FROM public.action_requests WHERE id=p_request_id;
 PERFORM private.customer_workflow_lock(request_org);
 SELECT * INTO r FROM public.action_requests WHERE id=p_request_id FOR UPDATE;
 IF r.id IS NULL OR r.organization_id IS DISTINCT FROM request_org OR r.status IS DISTINCT FROM 'Pending' OR r.provider NOT IN ('microsoft','google') OR r.action_type IS DISTINCT FROM 'send_email' THEN RAISE EXCEPTION 'Pending email proposal unavailable';END IF;
 IF p_decision IS NULL OR p_decision NOT IN ('approve','reject') THEN RAISE EXCEPTION 'Invalid email review decision';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.organization_members WHERE organization_id=r.organization_id AND user_id=p_actor_id AND role IN ('owner','admin','consultant'))
  AND (r.customer_workflow_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM public.staff_accounts WHERE user_id=p_actor_id AND active AND role IN ('platform_admin','consultant'))) THEN RAISE EXCEPTION 'Reviewer authorization revoked';END IF;
 IF p_decision='approve' THEN
  IF r.requested_by IS NULL OR r.requested_by=p_actor_id THEN RAISE EXCEPTION 'Distinct human approval is required';END IF;
  UPDATE public.action_requests SET status='Approved',approved_by=p_actor_id,approved_at=clock_timestamp(),error_message=NULL WHERE id=r.id RETURNING * INTO r;
 ELSE
  UPDATE public.action_requests SET status='Rejected',rejected_by=p_actor_id,rejected_at=clock_timestamp(),error_message=NULL WHERE id=r.id RETURNING * INTO r;
 END IF;
 RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.claim_microsoft_action(request_id uuid,actor_id uuid)
returns public.action_requests language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.action_requests; c public.oauth_connections; i public.integrations; bound_run uuid; request_org uuid;
begin
  if current_setting('transaction_isolation') is distinct from 'read committed' then raise exception 'Action authority requires READ COMMITTED';end if;
  select workflow_run_id,organization_id into bound_run,request_org from public.action_requests where id=request_id;
  PERFORM private.customer_workflow_lock(request_org);
  if bound_run is not null then perform public.assert_agent_workflow_lineage(bound_run,actor_id);end if;
  select * into r from public.action_requests where id=request_id for update;
  if r.organization_id IS DISTINCT FROM request_org OR r.workflow_run_id is distinct from bound_run then raise exception 'Workflow link changed';end if;
  if not found or r.status is distinct from 'Approved' then raise exception 'Request not approved or already claimed'; end if;
  if r.approval_guard_version is distinct from 1 then raise exception 'Legacy approval requires a new reviewed request'; end if;
  if r.provider NOT IN ('microsoft','google') or r.action_type is distinct from 'send_email' then raise exception 'Unsupported action'; end if;
  if r.approved_by is null or r.approved_at is null or r.requested_by is null or r.approved_by=r.requested_by then raise exception 'Approval invalid'; end if;
  perform private.assert_workflow_action_approval(r.workflow_run_id,r.organization_id,r.approved_by,r.action_type);
  if not exists(select 1 from public.organization_members where organization_id=r.organization_id and user_id=actor_id and role in ('owner','admin','consultant'))
    and not exists(select 1 from public.staff_accounts where user_id=actor_id and active and role in ('platform_admin','consultant')) then raise exception 'Actor not authorized'; end if;
  if not exists(select 1 from public.organization_members where organization_id=r.organization_id and user_id=r.approved_by and role in ('owner','admin','consultant'))
    and not exists(select 1 from public.staff_accounts where user_id=r.approved_by and active and role in ('platform_admin','consultant')) then raise exception 'Approver authorization revoked'; end if;
  select * into c from public.oauth_connections where id=r.connection_id and organization_id=r.organization_id and provider=r.provider for share;
  if not found or c.status is distinct from 'Connected' or c.oauth_verified_version is distinct from 1 or nullif(trim(c.external_account_id),'') is null or not private.email_has_scope(c,'send') or c.integration_id is distinct from r.integration_id then raise exception 'Connection unavailable or tenant binding invalid'; end if;
  select * into i from public.integrations where id=r.integration_id and organization_id=r.organization_id for share;
  if not found or i.status is distinct from 'Connected' or i.integration_type IS DISTINCT FROM 'OAuth' or i.provider IS DISTINCT FROM (CASE c.provider WHEN 'microsoft' THEN 'Microsoft' WHEN 'google' THEN 'Google' END) then raise exception 'Integration inactive'; end if;
  IF c.provider='google' OR c.oauth_connected_by IS NOT NULL THEN PERFORM public.validate_email_connection(c.id,c.organization_id,r.approved_connection_binding);END IF;
  if r.approved_connection_binding is distinct from private.email_connection_binding(c,i) then raise exception 'Approved connection identity changed'; end if;
  if r.workflow_run_id is not null and not exists(select 1 from public.workflow_runs where id=r.workflow_run_id and organization_id=r.organization_id and status='Waiting Approval' and context->>'action_request_id'=r.id::text) then raise exception 'Workflow tenant or approval binding invalid'; end if;
  if jsonb_typeof(r.payload)<>'object' or coalesce(r.payload->>'to','')='' or coalesce(r.payload->>'subject','')='' or coalesce(r.payload->>'message','')='' then raise exception 'Invalid approved payload'; end if;
  update public.action_requests set status='Executing' where id=r.id and status='Approved' returning * into r;
  return r;
end $$;

CREATE OR REPLACE FUNCTION public.record_microsoft_attempt(p_request_id uuid,p_actor_id uuid,p_phase text,p_provider_reference text default null)
returns boolean language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.action_requests; c public.oauth_connections; i public.integrations; bound_run uuid; request_org uuid;
begin
 select organization_id into request_org from public.action_requests where id=p_request_id;
 PERFORM private.customer_workflow_lock(request_org);
 if p_phase='Dispatching' then
  if current_setting('transaction_isolation') is distinct from 'read committed' then raise exception 'Dispatch authority requires READ COMMITTED';end if;
  select workflow_run_id into bound_run from public.action_requests where id=p_request_id;
  if bound_run is not null then perform public.assert_agent_workflow_lineage(bound_run,p_actor_id);end if;
 end if;
 select * into r from public.action_requests where id=p_request_id for update;
 if r.organization_id IS DISTINCT FROM request_org OR (p_phase='Dispatching' and r.workflow_run_id is distinct from bound_run) then raise exception 'Workflow link changed';end if;
 if not found or r.status is distinct from 'Executing' then raise exception 'Request is not claimed';end if;
 if p_phase='Dispatching' and (not exists(select 1 from public.organization_members where organization_id=r.organization_id and user_id=p_actor_id and role in ('owner','admin','consultant'))
 and not exists(select 1 from public.staff_accounts where user_id=p_actor_id and active and role in ('platform_admin','consultant'))) then raise exception 'Actor not authorized';end if;
 if p_phase='Dispatching' then
   perform private.assert_workflow_action_approval(r.workflow_run_id,r.organization_id,r.approved_by,r.action_type);
   if r.approved_by is null or r.approved_at is null or r.requested_by is null or r.approved_by=r.requested_by then raise exception 'Approval invalid';end if;
   if not exists(select 1 from public.organization_members where organization_id=r.organization_id and user_id=r.approved_by and role in ('owner','admin','consultant'))
   and not exists(select 1 from public.staff_accounts where user_id=r.approved_by and active and role in ('platform_admin','consultant')) then raise exception 'Approver authorization revoked';end if;
   if r.workflow_run_id is not null and not exists(select 1 from public.workflow_runs where id=r.workflow_run_id and organization_id=r.organization_id and status='Waiting Approval' and context->>'action_request_id'=r.id::text) then raise exception 'Workflow tenant or approval binding invalid';end if;
   select * into c from public.oauth_connections where id=r.connection_id and organization_id=r.organization_id for share;
   if not found then raise exception 'Connection missing';end if;
   select * into i from public.integrations where id=r.integration_id and organization_id=r.organization_id for share;
   if not found or i.status is distinct from 'Connected' or i.integration_type IS DISTINCT FROM 'OAuth' or i.provider IS DISTINCT FROM (CASE c.provider WHEN 'microsoft' THEN 'Microsoft' WHEN 'google' THEN 'Google' END) then raise exception 'Integration inactive';end if;
   if c.provider IS DISTINCT FROM r.provider OR c.integration_id IS DISTINCT FROM r.integration_id OR r.provider NOT IN ('microsoft','google') OR r.action_type IS DISTINCT FROM 'send_email' OR c.status is distinct from 'Connected' or c.oauth_verified_version is distinct from 1 or nullif(trim(c.external_account_id),'') is null or not private.email_has_scope(c,'send')
     or r.approved_connection_binding is distinct from private.email_connection_binding(c,i)
     or not exists(select 1 from public.integrations where id=r.integration_id and organization_id=r.organization_id and status='Connected') then raise exception 'Live connection controls changed';end if;
   IF c.provider='google' OR c.oauth_connected_by IS NOT NULL THEN PERFORM public.validate_email_connection(c.id,c.organization_id,r.approved_connection_binding);END IF;
   insert into public.action_execution_receipts(request_id,organization_id,phase,actor_id) values(r.id,r.organization_id,'Dispatching',p_actor_id);
 elsif p_phase='ProviderAccepted' then
   update public.action_execution_receipts set phase='ProviderAccepted',provider_accepted_at=now(),provider_reference=p_provider_reference
   where request_id=r.id and phase='Dispatching' and actor_id=p_actor_id;
   if not found then raise exception 'Dispatch receipt is missing or already accepted';end if;
 else raise exception 'Invalid attempt phase';end if;
 return true;
end $$;

CREATE OR REPLACE FUNCTION public.mailbox_intake_authorize(p_org uuid,p_actor uuid,p_installation uuid,p_revision integer,p_source_revision integer DEFAULT NULL,p_require_read boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE v public.workflow_installation_versions; c public.oauth_connections; s private.mailbox_intake_sources; fingerprint text;
BEGIN
 PERFORM private.customer_workflow_lock(p_org);
 IF private.customer_workflow_role(p_org,p_actor) NOT IN ('owner','admin','consultant') THEN RAISE EXCEPTION 'Manager authorization required';END IF;
 SELECT ver.* INTO v FROM public.workflow_installations h JOIN public.workflow_installation_versions ver ON ver.installation_id=h.id AND ver.organization_id=h.organization_id AND ver.revision=h.revision WHERE h.id=p_installation AND h.organization_id=p_org AND h.revision=p_revision;
 IF NOT FOUND OR v.recipe_key<>'customer_followup' OR v.recipe_version<>1 THEN RAISE EXCEPTION 'Installation changed or unavailable';END IF;
 SELECT * INTO c FROM public.oauth_connections WHERE id=private.installation_email_id(v.bindings) AND organization_id=p_org;
 fingerprint:=private.workflow_installation_connection(p_org,c.id);
 IF c.id IS NULL OR fingerprint IS NULL OR fingerprint IS DISTINCT FROM v.microsoft_binding_sha256 THEN RAISE EXCEPTION 'mailbox_connection_unavailable';END IF;
 IF p_require_read AND NOT private.email_has_scope(c,'read') THEN RAISE EXCEPTION 'mail_read_required';END IF;
 SELECT * INTO s FROM private.mailbox_intake_sources WHERE organization_id=p_org AND installation_id=p_installation AND installation_revision=p_revision;
 IF p_source_revision IS NOT NULL AND (s.id IS NULL OR s.revision IS DISTINCT FROM p_source_revision OR s.connection_id IS DISTINCT FROM c.id OR s.mailbox_id IS DISTINCT FROM c.external_account_id OR s.connection_fingerprint IS DISTINCT FROM fingerprint) THEN RAISE EXCEPTION 'Mailbox source changed or unavailable';END IF;
 RETURN jsonb_build_object('provider',c.provider,'account_email',c.external_account_email,'account_name',coalesce(nullif(c.external_account_email,''),c.external_account_id),'connection_id',c.id,'mailbox_id',c.external_account_id,'connection_fingerprint',fingerprint,'mail_read',private.email_has_scope(c,'read'),
 'source',CASE WHEN s.id IS NULL THEN NULL ELSE to_jsonb(s)-'connection_fingerprint' END);
END $$;

CREATE OR REPLACE FUNCTION public.mailbox_intake_load(p_org uuid,p_actor uuid,p_installation uuid,p_revision integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE a jsonb; receipts jsonb;
BEGIN
 a:=public.mailbox_intake_authorize(p_org,p_actor,p_installation,p_revision,NULL,false);
 DELETE FROM private.mailbox_intake_previews WHERE organization_id=p_org AND expires_at<=now();
 SELECT coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) INTO receipts FROM (SELECT preview_id,workflow_id,message_id FROM private.mailbox_intake_imports WHERE organization_id=p_org AND installation_id=p_installation AND imported_by=p_actor ORDER BY imported_at DESC LIMIT 20) r;
 RETURN jsonb_build_object('source',a->'source','capabilities',jsonb_build_object('provider',a->'provider','connection_id',a->'connection_id','mail_read',a->'mail_read','mailbox_id',a->'mailbox_id','account_name',a->'account_name'),'imports',receipts);
END $$;

REVOKE ALL ON FUNCTION private.email_has_scope(public.oauth_connections,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.email_has_scope(public.oauth_connections,text) TO service_role;
REVOKE ALL ON FUNCTION private.installation_email_id(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.installation_email_id(jsonb) TO service_role;
REVOKE ALL ON FUNCTION private.workflow_installation_connection(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.workflow_installation_connection(uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION private.workflow_installation_readiness(public.workflow_installation_versions,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.workflow_installation_readiness(public.workflow_installation_versions,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.workflow_installations_save(uuid,uuid,uuid,integer,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_installations_save(uuid,uuid,uuid,integer,uuid,jsonb) TO service_role;
REVOKE ALL ON FUNCTION private.workflow_installation_assert_action(public.action_requests) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.workflow_installation_assert_action(public.action_requests) TO service_role;
REVOKE ALL ON FUNCTION private.customer_workflow_project(public.customer_reply_workflows) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.customer_workflow_project(public.customer_reply_workflows) TO service_role;
REVOKE ALL ON FUNCTION public.customer_workflow_load(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.customer_workflow_load(uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.customer_workflow_queue_email(uuid,uuid,uuid,integer,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.customer_workflow_queue_email(uuid,uuid,uuid,integer,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.customer_workflow_queue(uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.customer_workflow_queue(uuid,uuid,uuid,integer) TO service_role;
REVOKE ALL ON FUNCTION private.guard_execution_request() FROM PUBLIC,anon,authenticated;
-- Preserve the existing trigger-only ACL; no new direct invocation grant.
REVOKE ALL ON FUNCTION public.claim_microsoft_action(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_microsoft_action(uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.record_microsoft_attempt(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_microsoft_attempt(uuid,uuid,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.mailbox_intake_authorize(uuid,uuid,uuid,integer,integer,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mailbox_intake_authorize(uuid,uuid,uuid,integer,integer,boolean) TO service_role;
REVOKE ALL ON FUNCTION public.mailbox_intake_load(uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mailbox_intake_load(uuid,uuid,uuid,integer) TO service_role;

REVOKE ALL ON FUNCTION public.workflow_installations_start(uuid,uuid,uuid,integer,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_installations_start(uuid,uuid,uuid,integer,uuid,jsonb) TO service_role;
REVOKE ALL ON FUNCTION private.workflow_email_connection_live(public.oauth_connections,public.integrations) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.workflow_email_connection_live(public.oauth_connections,public.integrations) TO service_role;
REVOKE ALL ON FUNCTION public.review_email_action(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.review_email_action(uuid,uuid,text) TO service_role;
COMMIT;
