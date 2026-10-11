# Workflow installer installation — 11 October 2026

The owner explicitly approved adding the workflow-installer database tables, restricted server functions and workflow checks to Kairo, and publishing its setup screen. This release does not activate AI, send messages, change ForgeCIF, grant membership-writing access, or create a customer installation/request.

## Source and integration

Frontend baseline: c44b2ceeac75c910c31a44ca28f1ab2b2e2d7ef3, including the published authentication layout and password recovery. Existing runnable files were verified against all 229 repository blobs before integration. The installer modifies only Customer Setup, Customer Follow-up, their focused tests, and six main navigation/callback guard locations; its new modules are isolated. Authentication, homepage, billing, provider configuration and unrelated work remain unchanged.

The original source-only review snapshot is retained at branch kairo/workflow-installer-review-20261011, commit d1cdce4180e6052091cfb056c19d62cc20a04753, under review-candidates/workflow-installer-20261011.

## Least-privilege production correction

Read-only preflight found organization_members permits service_role SELECT but not UPDATE. The original membership SELECT FOR SHARE therefore failed a no-row rollback-only permission probe. No grant was broadened. The deployed SQL removes only that redundant membership lock and clarifies the existing locking contract.

The live membership mutation trigger covers INSERT, UPDATE and DELETE, restricts callers to postgres/supabase_admin, requires READ COMMITTED and locks the same organization row already held by installer operations. Existing team RPCs acquire the same mutex. The corrected fixture reproduces those live permissions and trigger behavior. Independent correction review passed.

Corrected SQL SHA-256:
5db0e95d302bfc351c3eb126a6e53bd7a4c7f20ea6d04e9065eee6cc4fb2510e

## Installed database scope

Five RLS-enabled tables: workflow_recipe_versions, workflow_installations, workflow_installation_versions, private.workflow_installation_saves and workflow_installation_requests. Fourteen fixed-search-path invoker functions include three service-only load/save/start RPCs. Nine new triggers include four supplemental existing-workflow guards.

No browser/public grants were added. The service role gets only the reviewed new-object access. All 125 pre-existing function definitions/ACLs, 60 existing triggers, and 56 existing object grants/RLS settings were verified unchanged after the migration.

The edge route uses verified JWT and auth.getUser, derives the actor from that identity, and accepts only the exact versioned load/save/start operations. It cannot invoke an AI provider or send email.

## Focused verification

- 26 corrected backend SQL/HTTP/client-contract checks passed, including live membership least privilege.
- 178 installer/customer/password-recovery frontend checks passed.
- Existing authentication-layout snapshot passed.
- Five application-routing checks passed.
- Production Vite build passed.

No live authenticated customer workflow or provider acceptance test was run. Browser visual QA of the installer and real multi-session PostgreSQL races remain unverified. Configuration status does not establish live-provider readiness.

## Operational behavior and recovery

A configured installation binds the saved recipe/source/configuration/connection, employee, designated reviewer and open-request limit. An assigned employee can save an intake; an authorized manager still creates the AI draft. The designated email reviewer must be independent. Existing human approval, sending and receipt controls remain separate.

Saving a new installation revision fences progression of requests on an older revision. Their history remains. Unknown outcomes require reconciliation before replacement. For a post-installation incident, disable the installer entry/route and forward-fix while retaining existing lineage and safety guards. Do not drop provenance or supplemental restrictions beneath active requests. No destructive rollback is included.
