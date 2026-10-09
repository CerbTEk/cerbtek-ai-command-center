-- READ-ONLY. Run immediately before a separately authorized team-access install.
-- Stop if reviewed role schemas, policies, owners, dependencies or names drift.
SELECT current_database() AS database_name,current_user AS actor,current_setting('server_version') AS postgres_version;
SELECT n.nspname,c.relname,c.relowner::regrole AS owner,c.relrowsecurity AS rls
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname IN ('organizations','organization_members','organization_invitations','audit_events');
SELECT table_name,column_name,data_type,is_nullable,column_default
 FROM information_schema.columns WHERE table_schema='public'
 AND table_name IN ('organizations','organization_members','organization_invitations','audit_events')
 ORDER BY table_name,ordinal_position;
SELECT conrelid::regclass AS relation,conname,pg_get_constraintdef(oid) AS definition
 FROM pg_constraint WHERE conrelid IN ('public.organization_members'::regclass,'public.organization_invitations'::regclass)
 ORDER BY conrelid,conname;
SELECT schemaname,tablename,policyname,roles,cmd,qual,with_check
 FROM pg_policies WHERE schemaname='public' AND tablename IN ('organization_members','organization_invitations') ORDER BY tablename,policyname;
SELECT grantee,table_name,privilege_type FROM information_schema.role_table_grants
 WHERE table_schema='public' AND table_name IN ('organization_members','organization_invitations','audit_events') ORDER BY table_name,grantee,privilege_type;
SELECT grantee,table_name,column_name,privilege_type FROM information_schema.role_column_grants
 WHERE table_schema='public' AND table_name IN ('organization_members','organization_invitations') ORDER BY table_name,grantee,column_name,privilege_type;
SELECT n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,
 p.proowner::regrole AS owner,p.prosecdef,p.proacl,p.proconfig
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN ('public','private') AND (p.proname LIKE 'kairo_%' OR p.proname IN ('bootstrap_organization_owner','can_manage_org','can_access_org'))
 ORDER BY n.nspname,p.proname;
SELECT t.tgrelid::regclass AS relation,t.tgname,pg_get_triggerdef(t.oid) AS definition
 FROM pg_trigger t WHERE t.tgrelid IN ('public.organizations'::regclass,'public.organization_members'::regclass,'public.organization_invitations'::regclass) AND NOT t.tgisinternal;
-- Existing privilege-bearing routines capable of writing these tables must be
-- reviewed for bypasses. This outputs metadata/code, never private member rows.
SELECT n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_functiondef(p.oid) AS definition
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN ('public','private') AND p.prokind='f'
 AND (p.prosrc ILIKE '%organization_members%' OR p.prosrc ILIKE '%organization_invitations%')
 AND p.prosrc ~* '(insert|update|delete)';
