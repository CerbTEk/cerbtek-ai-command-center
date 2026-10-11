-- CANDIDATE ONLY: reviewed installation required. Never run as part of a frontend build.
-- Depends on existing organizations, organization_members, auth.users and audit_events.
-- No customer content, membership changes, provider credentials, or AI calls.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE public.knowledge_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
  current_version_id uuid,
  revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(organization_id,id)
);
CREATE TABLE public.knowledge_document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  document_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0),
  title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 160),
  content_text text NOT NULL CHECK(octet_length(content_text) BETWEEN 1 AND 32768 AND length(btrim(content_text))>0),
  content_sha256 text NOT NULL CHECK(content_sha256 ~ '^[0-9a-f]{64}$'),
  source_kind text NOT NULL CHECK(source_kind IN ('manual','text_upload')),
  source_name text NOT NULL CHECK(length(source_name) BETWEEN 1 AND 160),
  audience text NOT NULL DEFAULT 'private' CHECK(audience IN ('private','organization')),
  review_due_at timestamptz NOT NULL,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(organization_id,document_id) REFERENCES public.knowledge_documents(organization_id,id) ON DELETE RESTRICT,
  UNIQUE(organization_id,document_id,id), UNIQUE(organization_id,document_id,version)
);
ALTER TABLE public.knowledge_documents ADD CONSTRAINT knowledge_current_version_fk
  FOREIGN KEY(organization_id,id,current_version_id) REFERENCES public.knowledge_document_versions(organization_id,document_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE public.knowledge_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, document_id uuid NOT NULL, version_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK(ordinal>=0),
  content_text text NOT NULL CHECK(length(content_text) BETWEEN 1 AND 1000),
  content_sha256 text NOT NULL CHECK(content_sha256 ~ '^[0-9a-f]{64}$'),
  FOREIGN KEY(organization_id,document_id,version_id) REFERENCES public.knowledge_document_versions(organization_id,document_id,id) ON DELETE RESTRICT,
  UNIQUE(organization_id,version_id,ordinal)
);
CREATE TABLE private.knowledge_requests (
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id), request_key uuid NOT NULL,
  request_sha256 text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(organization_id,actor_user_id,request_key)
);
CREATE INDEX knowledge_documents_company ON public.knowledge_documents(organization_id,updated_at DESC,id);
CREATE INDEX knowledge_chunks_version ON public.knowledge_chunks(organization_id,document_id,version_id);
ALTER TABLE public.knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.knowledge_requests ENABLE ROW LEVEL SECURITY;
-- All reads and writes pass authenticated, current-membership-aware RPCs. There
-- are deliberately no direct-table policies or service-role application bypass.
REVOKE ALL ON public.knowledge_documents, public.knowledge_document_versions, public.knowledge_chunks, private.knowledge_requests FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION private.kairo_knowledge_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path='pg_catalog' AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Knowledge versions and chunks are immutable'; END IF;
  IF current_user NOT IN ('postgres','supabase_admin') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Use the Company Knowledge RPC'; END IF;
  IF NEW.content_sha256 IS DISTINCT FROM encode(sha256(convert_to(NEW.content_text,'UTF8')),'hex') THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Source hash mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER knowledge_versions_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.knowledge_document_versions FOR EACH ROW EXECUTE FUNCTION private.kairo_knowledge_immutable();
CREATE TRIGGER knowledge_chunks_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.knowledge_chunks FOR EACH ROW EXECUTE FUNCTION private.kairo_knowledge_immutable();
CREATE FUNCTION private.kairo_knowledge_document_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path='pg_catalog' AS $$
BEGIN
  IF current_user NOT IN ('postgres','supabase_admin') OR TG_OP='DELETE' THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Use Company Knowledge archive; direct changes are blocked';
  END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.organization_id,NEW.created_by,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.created_by,OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Source identity is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER knowledge_document_guard BEFORE INSERT OR UPDATE OR DELETE ON public.knowledge_documents FOR EACH ROW EXECUTE FUNCTION private.kairo_knowledge_document_guard();

-- Private definer is necessary to keep table access closed. Public wrapper is
-- SECURITY INVOKER. No staff bypass; no caller-supplied actor; fixed search_path.
CREATE FUNCTION private.kairo_company_knowledge(p_organization_id uuid,p_operation text,p_payload jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='pg_catalog' AS $$
<<knowledge>>
DECLARE
  actor uuid:=auth.uid(); actor_role text; managed boolean; mutating boolean;
  doc public.knowledge_documents; ver public.knowledge_document_versions;
  doc_id uuid; version_id uuid; expected integer; request_key uuid; request_hash text;
  prior private.knowledge_requests; result jsonb; envelope jsonb; items jsonb;
  source_text text; source_title text; source_kind text; source_name text; audience text;
  review_due timestamptz; next_version integer; query_text text; result_limit integer;
  chunk_text text; i integer; selected_chunk public.knowledge_chunks;
BEGIN
  IF actor IS NULL OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id=actor) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Sign in to Company Knowledge'; END IF;
  IF p_operation IS NULL OR p_operation NOT IN ('access','list','get','save','publish','archive','search','source') OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid knowledge operation';
  END IF;
  IF octet_length(p_payload::text)>220000 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Request too large'; END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='25001',MESSAGE='Knowledge requires READ COMMITTED'; END IF;
  mutating:=p_operation IN ('save','publish','archive');
  -- Same organization mutex as Team & Roles. Membership is re-read after the
  -- lock, so revocation cannot race a read/write under an old JWT claim.
  IF mutating THEN PERFORM 1 FROM public.organizations WHERE id=p_organization_id FOR UPDATE;
  ELSE PERFORM 1 FROM public.organizations WHERE id=p_organization_id FOR SHARE; END IF;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Company access unavailable'; END IF;
  SELECT role INTO actor_role FROM public.organization_members WHERE organization_id=p_organization_id AND user_id=actor;
  IF actor_role IS NULL OR actor_role NOT IN ('owner','admin','consultant','member','viewer') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Company access unavailable'; END IF;
  managed:=actor_role IN ('owner','admin');
  envelope:=jsonb_build_object('ok',true,'schema_version',1,'organization_id',p_organization_id,'actor_user_id',actor,'actor_role',actor_role,'can_manage',managed);
  IF p_operation='access' THEN RETURN envelope || jsonb_build_object('contract','company-knowledge-v1','max_text_bytes',32768,'max_documents',200,'retrieval','keyword','ai_connected',false); END IF;
  IF mutating THEN
    IF NOT managed THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Only company owners and admins can manage knowledge'; END IF;
    BEGIN request_key:=(p_payload->>'request_key')::uuid; expected:=(p_payload->>'expected_revision')::integer;
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid request key or revision'; END;
    IF request_key IS NULL OR expected IS NULL OR expected<0 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Request key and expected revision are required'; END IF;
    request_hash:=encode(sha256(convert_to(p_operation||':'||(p_payload-'request_key')::text,'UTF8')),'hex');
    SELECT * INTO prior FROM private.knowledge_requests WHERE organization_id=p_organization_id AND actor_user_id=actor AND knowledge_requests.request_key=knowledge.request_key;
    IF FOUND THEN
      IF prior.request_sha256<>request_hash THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Request key already used with different content'; END IF;
      RETURN prior.response || jsonb_build_object('replayed',true);
    END IF;
  END IF;

  IF p_operation='list' THEN
    SELECT coalesce(jsonb_agg(q.item ORDER BY q.updated_at DESC,q.id),'[]') INTO items FROM (
      SELECT d.id,d.updated_at,jsonb_build_object('id',d.id,'revision',d.revision,'status',d.status,'version_id',v.id,'version',v.version,'title',v.title,'audience',v.audience,'source_kind',v.source_kind,'source_name',v.source_name,'content_sha256',v.content_sha256,'updated_at',d.updated_at,'review_due_at',v.review_due_at,'freshness',CASE WHEN v.review_due_at<=clock_timestamp() THEN 'expired' ELSE 'current' END) item
      FROM public.knowledge_documents d JOIN public.knowledge_document_versions v ON v.id=d.current_version_id AND v.organization_id=d.organization_id AND v.document_id=d.id
      WHERE d.organization_id=p_organization_id AND (managed OR (d.status='published' AND v.audience='organization' AND v.review_due_at>clock_timestamp()))
      ORDER BY d.updated_at DESC,d.id LIMIT 200
    ) q;
    RETURN envelope || jsonb_build_object('documents',items);
  END IF;
  IF p_operation='search' THEN
    query_text:=btrim(p_payload->>'query');
    BEGIN result_limit:=coalesce((p_payload->>'limit')::integer,10); EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid search limit'; END;
    IF query_text IS NULL OR length(query_text) NOT BETWEEN 2 AND 200 OR result_limit NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Search needs 2 to 200 characters and a limit of 1 to 10'; END IF;
    -- Literal case-insensitive keyword substring. No regex, URL fetch, rendering,
    -- provider, embeddings, generated answer, or unfiltered similarity search.
    SELECT coalesce(jsonb_agg(q.item ORDER BY q.title,q.document_id,q.ordinal),'[]') INTO items FROM (
      SELECT v.title,d.id document_id,c.ordinal,jsonb_build_object('document_id',d.id,'version_id',v.id,'chunk_id',c.id,'source_id','knowledge:'||d.id||':'||v.id||':'||c.id,'title',v.title,'excerpt',c.content_text,'content_sha256',c.content_sha256,'version_sha256',v.content_sha256,'version',v.version,'updated_at',d.updated_at,'review_due_at',v.review_due_at,'freshness','current') item
      FROM public.knowledge_documents d JOIN public.knowledge_document_versions v ON v.id=d.current_version_id AND v.organization_id=d.organization_id AND v.document_id=d.id
      JOIN public.knowledge_chunks c ON c.version_id=v.id AND c.organization_id=d.organization_id AND c.document_id=d.id
      WHERE d.organization_id=p_organization_id AND d.status='published' AND v.review_due_at>clock_timestamp() AND (managed OR v.audience='organization')
        AND (strpos(lower(c.content_text),lower(query_text))>0 OR strpos(lower(v.title),lower(query_text))>0)
      ORDER BY v.title,d.id,c.ordinal LIMIT result_limit
    ) q;
    RETURN envelope || jsonb_build_object('results',items,'retrieval','keyword','ai_connected',false);
  END IF;

  BEGIN doc_id:=(p_payload->>'document_id')::uuid; version_id:=(p_payload->>'version_id')::uuid;
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid source identifier'; END;
  IF doc_id IS NULL AND p_operation<>'save' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Document is required'; END IF;
  IF doc_id IS NOT NULL THEN
    SELECT * INTO doc FROM public.knowledge_documents WHERE organization_id=p_organization_id AND id=doc_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='Source unavailable'; END IF;
    SELECT * INTO ver FROM public.knowledge_document_versions WHERE organization_id=p_organization_id AND document_id=doc.id AND id=doc.current_version_id;
    IF NOT managed AND (doc.status<>'published' OR ver.audience<>'organization' OR ver.review_due_at<=clock_timestamp()) THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='Source unavailable'; END IF;
    IF mutating AND doc.revision<>expected THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Source changed. Refresh before saving'; END IF;
  END IF;

  IF p_operation='source' THEN
    IF doc.status<>'published' OR ver.review_due_at<=clock_timestamp() OR version_id IS DISTINCT FROM doc.current_version_id THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='Source unavailable'; END IF;
    BEGIN SELECT * INTO selected_chunk FROM public.knowledge_chunks WHERE organization_id=p_organization_id AND document_id=doc.id AND knowledge_chunks.version_id=ver.id AND id=(p_payload->>'chunk_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid source identifier'; END;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='Source unavailable'; END IF;
    RETURN envelope || jsonb_build_object('source',jsonb_build_object('document_id',doc.id,'version_id',ver.id,'chunk_id',selected_chunk.id,'source_id','knowledge:'||doc.id||':'||ver.id||':'||selected_chunk.id,'title',ver.title,'content_text',selected_chunk.content_text,'content_sha256',selected_chunk.content_sha256,'version_sha256',ver.content_sha256,'version',ver.version,'review_due_at',ver.review_due_at,'freshness','current'));
  END IF;
  IF p_operation='get' THEN
    IF version_id IS NOT NULL AND version_id<>doc.current_version_id THEN
      IF NOT managed THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='Source unavailable'; END IF;
      SELECT * INTO ver FROM public.knowledge_document_versions WHERE organization_id=p_organization_id AND document_id=doc.id AND id=version_id;
      IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='Source unavailable'; END IF;
    END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',v.id,'version',v.version,'title',v.title,'content_sha256',v.content_sha256,'created_at',v.created_at) ORDER BY v.version DESC),'[]') INTO items
      FROM public.knowledge_document_versions v WHERE v.organization_id=p_organization_id AND v.document_id=doc.id AND (managed OR v.id=doc.current_version_id);
    RETURN envelope || jsonb_build_object('document',to_jsonb(doc),'version',to_jsonb(ver),'versions',items);
  END IF;

  IF p_operation='save' THEN
    source_text:=p_payload->>'content_text'; source_title:=btrim(p_payload->>'title'); source_kind:=p_payload->>'source_kind'; source_name:=p_payload->>'source_name'; audience:=p_payload->>'audience';
    BEGIN review_due:=(p_payload->>'review_due_at')::timestamptz;
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid review date'; END;
    IF jsonb_typeof(p_payload->'content_text') IS DISTINCT FROM 'string' OR source_text IS NULL OR octet_length(source_text) NOT BETWEEN 1 AND 32768 OR length(btrim(source_text))=0
      OR source_title IS NULL OR length(source_title) NOT BETWEEN 1 AND 160 OR source_kind IS NULL OR source_kind NOT IN ('manual','text_upload')
      OR source_name IS NULL OR length(source_name) NOT BETWEEN 1 AND 160 OR audience IS NULL OR audience NOT IN ('private','organization')
      OR review_due IS NULL OR NOT isfinite(review_due) OR review_due<=clock_timestamp() OR review_due>clock_timestamp()+interval '366 days' THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Use a title, bounded text, supported audience, and a future review date within one year';
    END IF;
    IF doc_id IS NULL THEN
      IF expected<>0 THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='New document needs revision zero'; END IF;
      IF (SELECT count(*) FROM public.knowledge_documents WHERE organization_id=p_organization_id)>=200 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Company source limit reached'; END IF;
      INSERT INTO public.knowledge_documents(organization_id,created_by) VALUES(p_organization_id,actor) RETURNING * INTO doc;
    END IF;
    SELECT coalesce(max(v.version),0)+1 INTO next_version FROM public.knowledge_document_versions v WHERE v.organization_id=p_organization_id AND v.document_id=doc.id;
    IF next_version>100 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Source version limit reached'; END IF;
    INSERT INTO public.knowledge_document_versions(organization_id,document_id,version,title,content_text,content_sha256,source_kind,source_name,audience,review_due_at,created_by)
      VALUES(p_organization_id,doc.id,next_version,source_title,source_text,encode(sha256(convert_to(source_text,'UTF8')),'hex'),source_kind,source_name,audience,review_due,actor) RETURNING * INTO ver;
    FOR i IN 0..((length(source_text)-1)/1000) LOOP
      chunk_text:=substr(source_text,i*1000+1,1000);
      INSERT INTO public.knowledge_chunks(organization_id,document_id,version_id,ordinal,content_text,content_sha256) VALUES(p_organization_id,doc.id,ver.id,i,chunk_text,encode(sha256(convert_to(chunk_text,'UTF8')),'hex'));
    END LOOP;
    UPDATE public.knowledge_documents SET current_version_id=ver.id,status='draft',revision=revision+1,updated_at=clock_timestamp() WHERE id=doc.id AND organization_id=p_organization_id RETURNING * INTO doc;
  ELSIF p_operation='publish' THEN
    IF doc.status<>'draft' OR version_id IS DISTINCT FROM doc.current_version_id OR ver.review_due_at<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Publish requires the current unexpired draft'; END IF;
    UPDATE public.knowledge_documents SET status='published',revision=revision+1,updated_at=clock_timestamp() WHERE id=doc.id AND organization_id=p_organization_id RETURNING * INTO doc;
  ELSIF p_operation='archive' THEN
    IF doc.status='archived' OR version_id IS DISTINCT FROM doc.current_version_id THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Source changed. Refresh before archiving'; END IF;
    UPDATE public.knowledge_documents SET status='archived',revision=revision+1,updated_at=clock_timestamp() WHERE id=doc.id AND organization_id=p_organization_id RETURNING * INTO doc;
  END IF;
  INSERT INTO public.audit_events(organization_id,actor_user_id,event_type,entity_type,entity_id,summary,metadata)
    VALUES(p_organization_id,actor,'knowledge_'||p_operation,'knowledge_document',doc.id,'Company knowledge '||p_operation,jsonb_build_object('version_id',ver.id,'version',ver.version,'revision',doc.revision,'audience',ver.audience,'content_sha256',ver.content_sha256,'request_key',request_key));
  result:=envelope || jsonb_build_object('document_id',doc.id,'version_id',ver.id,'version',ver.version,'revision',doc.revision,'status',doc.status,'content_sha256',ver.content_sha256,'request_key',request_key,'operation',p_operation,'replayed',false);
  INSERT INTO private.knowledge_requests(organization_id,actor_user_id,request_key,request_sha256,response) VALUES(p_organization_id,actor,request_key,request_hash,result);
  RETURN result;
END $$;

CREATE FUNCTION public.kairo_company_knowledge(p_organization_id uuid,p_operation text,p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path='pg_catalog' AS $$ SELECT private.kairo_company_knowledge(p_organization_id,p_operation,p_payload); $$;
REVOKE ALL ON FUNCTION private.kairo_knowledge_immutable(),private.kairo_knowledge_document_guard() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION private.kairo_company_knowledge(uuid,text,jsonb), public.kairo_company_knowledge(uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT USAGE ON SCHEMA private TO authenticated;
GRANT EXECUTE ON FUNCTION private.kairo_company_knowledge(uuid,text,jsonb), public.kairo_company_knowledge(uuid,text,jsonb) TO authenticated;
COMMIT;
