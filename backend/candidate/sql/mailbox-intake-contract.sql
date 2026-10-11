-- SOURCE-ONLY CANDIDATE. Requires workflow-installations and employee-drafting contracts.
-- Service-only manual intake. No scheduler, consent change, provider calls or dispatch.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
CREATE TABLE private.mailbox_intake_sources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
 installation_id uuid NOT NULL, installation_revision integer NOT NULL,
 revision integer NOT NULL CHECK(revision>0), connection_id uuid NOT NULL,
 mailbox_id text NOT NULL CHECK(length(mailbox_id) BETWEEN 1 AND 1024),
 folder_id text NOT NULL CHECK(length(folder_id) BETWEEN 1 AND 1024),
 folder_name text NOT NULL CHECK(length(folder_name) BETWEEN 1 AND 200),
 connection_fingerprint text NOT NULL, saved_by uuid NOT NULL REFERENCES auth.users(id), saved_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,installation_id,installation_revision),
 FOREIGN KEY(installation_id,organization_id,installation_revision) REFERENCES public.workflow_installation_versions(installation_id,organization_id,revision)
);
CREATE TABLE private.mailbox_intake_previews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
 source_id uuid NOT NULL REFERENCES private.mailbox_intake_sources(id), source_revision integer NOT NULL,
 actor_id uuid NOT NULL REFERENCES auth.users(id), message jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes'
);
CREATE INDEX mailbox_preview_expiry ON private.mailbox_intake_previews(organization_id,expires_at);
CREATE TABLE private.mailbox_intake_imports (
 organization_id uuid NOT NULL, connection_id uuid NOT NULL, mailbox_id text NOT NULL, message_id text NOT NULL,
 thread_id text NOT NULL, internet_message_id text, folder_id text NOT NULL, received_at timestamptz NOT NULL,
 source_id uuid NOT NULL REFERENCES private.mailbox_intake_sources(id), source_revision integer NOT NULL,
 installation_id uuid NOT NULL, installation_revision integer NOT NULL, preview_id uuid NOT NULL,
 workflow_id uuid NOT NULL, imported_by uuid NOT NULL REFERENCES auth.users(id), imported_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,connection_id,mailbox_id,message_id), UNIQUE(organization_id,preview_id),
 FOREIGN KEY(workflow_id,organization_id) REFERENCES public.customer_reply_workflows(id,organization_id),
 FOREIGN KEY(installation_id,organization_id,installation_revision) REFERENCES public.workflow_installation_versions(installation_id,organization_id,revision)
);
ALTER TABLE private.mailbox_intake_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.mailbox_intake_previews ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.mailbox_intake_imports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.mailbox_intake_sources,private.mailbox_intake_previews,private.mailbox_intake_imports FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE ON private.mailbox_intake_sources TO service_role;
GRANT SELECT,INSERT,DELETE ON private.mailbox_intake_previews TO service_role;
GRANT SELECT,INSERT ON private.mailbox_intake_imports TO service_role;
CREATE TRIGGER mailbox_import_immutable BEFORE UPDATE OR DELETE ON private.mailbox_intake_imports FOR EACH ROW EXECUTE FUNCTION private.workflow_installation_immutable();

-- Called again before each provider request and each DB write. Never authorizes members,
-- even if assigned to an installed workflow. No raw mailbox access through customer-workflow.
CREATE FUNCTION public.mailbox_intake_authorize(p_org uuid,p_actor uuid,p_installation uuid,p_revision integer,p_source_revision integer DEFAULT NULL,p_require_read boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE v public.workflow_installation_versions; c public.oauth_connections; s private.mailbox_intake_sources; fingerprint text;
BEGIN
 PERFORM private.customer_workflow_lock(p_org);
 IF private.customer_workflow_role(p_org,p_actor) NOT IN ('owner','admin','consultant') THEN RAISE EXCEPTION 'Manager authorization required';END IF;
 SELECT ver.* INTO v FROM public.workflow_installations h JOIN public.workflow_installation_versions ver ON ver.installation_id=h.id AND ver.organization_id=h.organization_id AND ver.revision=h.revision WHERE h.id=p_installation AND h.organization_id=p_org AND h.revision=p_revision;
 IF NOT FOUND OR v.recipe_key<>'customer_followup' OR v.recipe_version<>1 THEN RAISE EXCEPTION 'Installation changed or unavailable';END IF;
 SELECT * INTO c FROM public.oauth_connections WHERE id=(v.bindings->>'microsoft_connection_id')::uuid AND organization_id=p_org;
 fingerprint:=private.workflow_installation_connection(p_org,c.id);
 IF c.id IS NULL OR fingerprint IS NULL OR fingerprint IS DISTINCT FROM v.microsoft_binding_sha256 THEN RAISE EXCEPTION 'mailbox_connection_unavailable';END IF;
 IF p_require_read AND NOT coalesce('Mail.Read'=ANY(c.scopes),false) THEN RAISE EXCEPTION 'mail_read_required';END IF;
 SELECT * INTO s FROM private.mailbox_intake_sources WHERE organization_id=p_org AND installation_id=p_installation AND installation_revision=p_revision;
 IF p_source_revision IS NOT NULL AND (s.id IS NULL OR s.revision IS DISTINCT FROM p_source_revision OR s.connection_id IS DISTINCT FROM c.id OR s.mailbox_id IS DISTINCT FROM c.external_account_id OR s.connection_fingerprint IS DISTINCT FROM fingerprint) THEN RAISE EXCEPTION 'Mailbox source changed or unavailable';END IF;
 RETURN jsonb_build_object('connection_id',c.id,'mailbox_id',c.external_account_id,'connection_fingerprint',fingerprint,'mail_read',coalesce('Mail.Read'=ANY(c.scopes),false),
 'source',CASE WHEN s.id IS NULL THEN NULL ELSE to_jsonb(s)-'connection_fingerprint' END);
END $$;
CREATE FUNCTION public.mailbox_intake_load(p_org uuid,p_actor uuid,p_installation uuid,p_revision integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE a jsonb; receipts jsonb;
BEGIN
 a:=public.mailbox_intake_authorize(p_org,p_actor,p_installation,p_revision,NULL,false);
 DELETE FROM private.mailbox_intake_previews WHERE organization_id=p_org AND expires_at<=now();
 SELECT coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) INTO receipts FROM (SELECT preview_id,workflow_id,message_id FROM private.mailbox_intake_imports WHERE organization_id=p_org AND installation_id=p_installation AND imported_by=p_actor ORDER BY imported_at DESC LIMIT 20) r;
 RETURN jsonb_build_object('source',a->'source','capabilities',jsonb_build_object('mail_read',a->'mail_read','mailbox_id',a->'mailbox_id','account_name','Connected Microsoft account'),'imports',receipts);
END $$;
CREATE FUNCTION public.mailbox_intake_save(p_org uuid,p_actor uuid,p_installation uuid,p_revision integer,p_expected_source_revision integer,p_folder_id text,p_folder_name text,p_expected_binding jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE a jsonb; s private.mailbox_intake_sources;
BEGIN
 a:=public.mailbox_intake_authorize(p_org,p_actor,p_installation,p_revision);
 IF a-'source' IS DISTINCT FROM p_expected_binding-'source' THEN RAISE EXCEPTION 'Mailbox authority changed';END IF;
 IF p_expected_source_revision IS NULL OR p_expected_source_revision<0 OR coalesce(length(p_folder_id),0) NOT BETWEEN 1 AND 1024 OR coalesce(length(btrim(p_folder_name)),0) NOT BETWEEN 1 AND 200 OR p_folder_id ~ '[[:cntrl:]]' OR p_folder_name ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'Invalid mailbox folder';END IF;
 SELECT * INTO s FROM private.mailbox_intake_sources WHERE organization_id=p_org AND installation_id=p_installation AND installation_revision=p_revision;
 IF coalesce(s.revision,0) IS DISTINCT FROM p_expected_source_revision THEN RAISE EXCEPTION 'Mailbox source changed or unavailable';END IF;
 INSERT INTO private.mailbox_intake_sources(organization_id,installation_id,installation_revision,revision,connection_id,mailbox_id,folder_id,folder_name,connection_fingerprint,saved_by)
 VALUES(p_org,p_installation,p_revision,1,(a->>'connection_id')::uuid,a->>'mailbox_id',p_folder_id,p_folder_name,a->>'connection_fingerprint',p_actor)
 ON CONFLICT(organization_id,installation_id,installation_revision) DO UPDATE SET revision=private.mailbox_intake_sources.revision+1,folder_id=excluded.folder_id,folder_name=excluded.folder_name,connection_id=excluded.connection_id,mailbox_id=excluded.mailbox_id,connection_fingerprint=excluded.connection_fingerprint,saved_by=p_actor,saved_at=now() RETURNING * INTO s;
 DELETE FROM private.mailbox_intake_previews WHERE organization_id=p_org AND source_id=s.id;
 INSERT INTO public.audit_events(organization_id,actor_user_id,event_type,entity_type,entity_id,summary,metadata) VALUES(p_org,p_actor,'mailbox_source_saved','workflow_installations',p_installation,'Manual mailbox intake source saved',jsonb_build_object('source_id',s.id,'source_revision',s.revision,'installation_revision',p_revision));
 RETURN to_jsonb(s)-'connection_fingerprint';
END $$;
CREATE FUNCTION public.mailbox_intake_capture(p_org uuid,p_actor uuid,p_installation uuid,p_revision integer,p_source_revision integer,p_expected_binding jsonb,p_messages jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE a jsonb; m jsonb; p private.mailbox_intake_previews; result jsonb:='[]'; i jsonb;
BEGIN
 a:=public.mailbox_intake_authorize(p_org,p_actor,p_installation,p_revision,p_source_revision);
 IF a IS DISTINCT FROM p_expected_binding THEN RAISE EXCEPTION 'Mailbox authority changed';END IF;
 IF jsonb_typeof(p_messages) IS DISTINCT FROM 'array' OR jsonb_array_length(p_messages)>10 THEN RAISE EXCEPTION 'Invalid mailbox preview';END IF;
 DELETE FROM private.mailbox_intake_previews WHERE organization_id=p_org AND (expires_at<=now() OR (actor_id=p_actor AND source_id=(a->'source'->>'id')::uuid));
 FOR m IN SELECT value FROM jsonb_array_elements(p_messages) LOOP
  i:=m->'intake';
  IF jsonb_typeof(m) IS DISTINCT FROM 'object' OR NOT m ?& ARRAY['message_id','thread_id','internet_message_id','folder_id','received_at','has_attachments','intake'] OR m-ARRAY['message_id','thread_id','internet_message_id','folder_id','received_at','has_attachments','intake']<>'{}'::jsonb
   OR jsonb_typeof(m->'message_id') IS DISTINCT FROM 'string' OR length(m->>'message_id') NOT BETWEEN 1 AND 1024 OR jsonb_typeof(m->'thread_id') IS DISTINCT FROM 'string' OR length(m->>'thread_id') NOT BETWEEN 1 AND 1024
   OR m->>'folder_id' IS DISTINCT FROM a->'source'->>'folder_id' OR jsonb_typeof(m->'has_attachments') IS DISTINCT FROM 'boolean' OR jsonb_typeof(m->'received_at') IS DISTINCT FROM 'string' OR (m->>'received_at')::timestamptz IS NULL
   OR (m->'internet_message_id'<>'null'::jsonb AND (jsonb_typeof(m->'internet_message_id') IS DISTINCT FROM 'string' OR length(m->>'internet_message_id')>1024))
   OR jsonb_typeof(i) IS DISTINCT FROM 'object' OR NOT i ?& ARRAY['customer_email','customer_name','subject','message'] OR i-ARRAY['customer_email','customer_name','subject','message']<>'{}'::jsonb
   OR jsonb_typeof(i->'customer_email') IS DISTINCT FROM 'string' OR length(i->>'customer_email')>320 OR (i->>'customer_email') !~ '^[^[:space:]@,;<>]+@[^[:space:]@,;<>]+\.[^[:space:]@,;<>]+$'
   OR jsonb_typeof(i->'customer_name') IS DISTINCT FROM 'string' OR length(btrim(i->>'customer_name')) NOT BETWEEN 1 AND 200
   OR jsonb_typeof(i->'subject') IS DISTINCT FROM 'string' OR length(btrim(i->>'subject')) NOT BETWEEN 1 AND 200 OR i->>'subject' ~ E'[\r\n]'
   OR jsonb_typeof(i->'message') IS DISTINCT FROM 'string' OR length(btrim(i->>'message')) NOT BETWEEN 1 AND 6000 THEN RAISE EXCEPTION 'Invalid mailbox message';END IF;
  INSERT INTO private.mailbox_intake_previews(organization_id,source_id,source_revision,actor_id,message) VALUES(p_org,(a->'source'->>'id')::uuid,p_source_revision,p_actor,m) RETURNING * INTO p;
  result:=result||jsonb_build_array(m||jsonb_build_object('id',p.id,'expires_at',p.expires_at));
 END LOOP;
 RETURN result;
END $$;
CREATE FUNCTION public.mailbox_intake_import(p_org uuid,p_actor uuid,p_installation uuid,p_revision integer,p_source_revision integer,p_preview uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE a jsonb; p private.mailbox_intake_previews; r private.mailbox_intake_imports; w jsonb; s jsonb;
BEGIN
 a:=public.mailbox_intake_authorize(p_org,p_actor,p_installation,p_revision,p_source_revision);s:=a->'source';
 -- Durable same-preview receipt survives preview expiry. Recheck actor and source first.
 SELECT * INTO r FROM private.mailbox_intake_imports WHERE organization_id=p_org AND preview_id=p_preview;
 IF FOUND THEN
  IF r.imported_by IS DISTINCT FROM p_actor OR r.source_id IS DISTINCT FROM (s->>'id')::uuid OR r.source_revision IS DISTINCT FROM p_source_revision THEN RAISE EXCEPTION 'Mailbox import access denied';END IF;
  PERFORM private.customer_workflow_access(p_org,p_actor,r.workflow_id,false);
  RETURN jsonb_build_object('workflow_id',r.workflow_id,'replayed',true);
 END IF;
 SELECT * INTO p FROM private.mailbox_intake_previews WHERE id=p_preview AND organization_id=p_org AND source_id=(s->>'id')::uuid AND source_revision=p_source_revision AND actor_id=p_actor AND expires_at>now();
 IF NOT FOUND THEN RAISE EXCEPTION 'Mailbox preview expired or unavailable';END IF;
 SELECT * INTO r FROM private.mailbox_intake_imports WHERE organization_id=p_org AND connection_id=(a->>'connection_id')::uuid AND mailbox_id=a->>'mailbox_id' AND message_id=p.message->>'message_id';
 IF FOUND THEN
  PERFORM private.customer_workflow_access(p_org,p_actor,r.workflow_id,false);
  RETURN jsonb_build_object('workflow_id',r.workflow_id,'replayed',true);
 END IF;
 -- Start and source receipt commit together under the existing organization mutex.
 -- Exact saved preview, never client-submitted text. Existing reviewer/assignment/limits apply.
 w:=public.workflow_installations_start(p_org,p_actor,p_installation,p_revision,p.id,p.message->'intake');
 INSERT INTO private.mailbox_intake_imports(organization_id,connection_id,mailbox_id,message_id,thread_id,internet_message_id,folder_id,received_at,source_id,source_revision,installation_id,installation_revision,preview_id,workflow_id,imported_by)
 VALUES(p_org,(a->>'connection_id')::uuid,a->>'mailbox_id',p.message->>'message_id',p.message->>'thread_id',p.message->>'internet_message_id',p.message->>'folder_id',(p.message->>'received_at')::timestamptz,(s->>'id')::uuid,p_source_revision,p_installation,p_revision,p.id,(w->'workflow'->>'id')::uuid,p_actor) RETURNING * INTO r;
 INSERT INTO public.audit_events(organization_id,actor_user_id,event_type,entity_type,entity_id,summary,metadata) VALUES(p_org,p_actor,'mailbox_inquiry_imported','customer_reply_workflows',r.workflow_id,'Selected mailbox inquiry imported as an assigned request',jsonb_build_object('source_id',r.source_id,'source_revision',r.source_revision,'untrusted_input',true,'attachments_fetched',false));
 DELETE FROM private.mailbox_intake_previews WHERE id=p.id AND organization_id=p_org;
 RETURN jsonb_build_object('workflow_id',r.workflow_id,'replayed',false);
END $$;
DO $$ DECLARE signature text; BEGIN
 FOREACH signature IN ARRAY ARRAY[
 'public.mailbox_intake_authorize(uuid,uuid,uuid,integer,integer,boolean)',
 'public.mailbox_intake_load(uuid,uuid,uuid,integer)',
 'public.mailbox_intake_save(uuid,uuid,uuid,integer,integer,text,text,jsonb)',
 'public.mailbox_intake_capture(uuid,uuid,uuid,integer,integer,jsonb,jsonb)',
 'public.mailbox_intake_import(uuid,uuid,uuid,integer,integer,uuid)'
 ] LOOP
 EXECUTE 'REVOKE ALL ON FUNCTION '||signature||' FROM PUBLIC,anon,authenticated';
 EXECUTE 'GRANT EXECUTE ON FUNCTION '||signature||' TO service_role';
 END LOOP;
END $$;
COMMIT;
