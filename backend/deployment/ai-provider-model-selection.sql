-- Standalone, narrowly scoped SQL patch; Supabase CLI is not available here.
-- Only the provider predicate in the existing ai_draft_save function is changed.
-- Existing body, ownership, SECURITY INVOKER, search_path and all grants are preserved.
-- No credential, inference, staff/client permission, or migration-history changes.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $provider_patch$
DECLARE
 signature regprocedure := to_regprocedure('public.ai_draft_save(uuid,uuid,integer,jsonb)');
 definition text;
 old_predicate constant text := 'p_config->>''provider'' is distinct from ''openai''';
 new_predicate constant text := 'coalesce(p_config->>''provider'','''') not in (''openai'',''anthropic'',''gemini'')';
BEGIN
 IF signature IS NULL THEN RAISE EXCEPTION 'Existing ai_draft_save is required'; END IF;
 IF (SELECT prosecdef FROM pg_proc WHERE oid=signature) THEN RAISE EXCEPTION 'Unexpected SECURITY DEFINER function'; END IF;
 definition := pg_get_functiondef(signature);
 IF position(old_predicate IN definition)>0 THEN
  IF (length(definition)-length(replace(definition,old_predicate,'')))/length(old_predicate)<>1 THEN
   RAISE EXCEPTION 'Ambiguous provider predicate; review required';
  END IF;
  EXECUTE replace(definition,old_predicate,new_predicate);
 ELSIF position(new_predicate IN definition)=0 THEN
  RAISE EXCEPTION 'Unexpected provider validation; review required';
 END IF;
END
$provider_patch$;
COMMIT;
