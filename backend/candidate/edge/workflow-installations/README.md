# Workflow installations: isolated review candidate

This is source only. The contract has not been applied to a deployed database, and the Edge Function has not been deployed. All tests use synthetic fixture records in local PGlite. No provider request, activation change, OAuth setup, customer read, or email dispatch occurs from this route.

## HTTP contract

Authenticated POST to `workflow-installations`. The handler verifies the supplied bearer token with `auth.getUser`, rejects anonymous users, derives the actor from the verified user, and invokes exactly one service-only RPC. Every request includes `operation` and `organization_id`. Unknown keys are rejected.

- `load`: no other fields. Returns `ok`, `contract_version:1`, `organization_id`, `actor`, `recipes`, `installations`, `workspace` (the existing customer-workflow load result), `operation_receipts`, and `operation_receipts_limit:100`.
- `save`: `installation_id` (null for a new record), `expected_revision` (0 for new), UUID `request_key`, `recipe_key:'customer_followup'`, `recipe_version:1`, `name` (1–120 trimmed characters), `outcome` (10–1000 trimmed characters), `bindings`, and `limits`. Returns `installation`.
- `start`: `installation_id`, `expected_revision`, UUID `request_key`, and exact `intake:{customer_email,customer_name,subject,message}`. Returns `installation`, existing `workflow`, immutable `provenance`, and `replayed`. It does not prepare a draft, reserve paid inference, approve an action, or send an email.

All five binding keys are required and each accepts UUID or null: `context_version_id`, `configuration_id`, `microsoft_connection_id`, `assigned_to`, `reviewer_id`. The only limit is `max_open_requests`, an integer from 1 to 100. Missing or stale same-organization references can be retained as setup needing attention; cross-organization or nonexistent non-null references are rejected.

Recipe records return both `version` and `recipe_version`. Installation records return both `id` and `installation_id`, immutable `revision`, recipe identity, name, outcome, bindings, limits, audit identity/time, derived `status`, `readiness`, and `open_requests`. OAuth authority fingerprints are stored server-side and excluded from projections.

## Readiness and permissions

`status` is `configured` only when all required references are current and valid; otherwise it is `setup_needed`. This describes installation setup, not live model activation or automatic execution. The installer's `readiness.live_inference_enabled` and `automatic_execution_enabled` are always false because this route grants neither capability. Existing independently authorized inference readiness is preserved in `workspace.readiness`.

Readiness contains `configured`, `can_start`, `reasons` (string codes), and nullable `start_blocker`. Reason codes are `context_missing`, `context_changed`, `configuration_missing`, `configuration_changed`, `microsoft_missing`, `microsoft_changed`, `assignee_missing`, `assignee_unavailable`, `reviewer_missing`, `reviewer_conflict`, `reviewer_unavailable`, `draft_manager_missing`, and `installation_changed`. Start blockers also include `read_only`, `assignment_required`, and `open_request_limit`.

- Owners, admins, and consultants may configure and start installations.
- Members see and start only installations currently assigned to them. They cannot configure or reassign.
- Viewers can read but cannot save or start.
- The designated reviewer must be an owner/admin/consultant distinct from the assignee. That reviewer cannot start, author a draft for, or propose an email for the installation.
- A separate authorized draft manager must exist. The assigned person can fulfill this role if they are a manager.
- Existing workflow permissions and approval checks remain in force.

The current manual company-context version and customer-reply AI configuration are pinned. Existing optional explicit, current Company Knowledge excerpts remain supported through the existing immutable selection, source-hash, freshness, citation, and human-review contract. The installer does not ingest or select sources on the user's behalf.

## Durability and stale dependencies

Save request keys are scoped by organization and bound to exact actor, requested installation, expected revision, and specification. Exact retries return the originally saved immutable revision. Reusing a key for different data fails. Start uses the existing guarded customer intake and assignment functions in the same transaction as immutable installation provenance. It cannot adopt a preexisting uninstalled workflow key.

An organization row lock serializes install saves/starts and open-request admission. Max-open accounting spans all revisions of that installation. Cancelled workflows and emails recorded Executed or Rejected free capacity. Other states, including uncertainty and Failed, remain counted conservatively.

Current dependency identity, OAuth authority fingerprint, assignee/reviewer roles, and the head installation revision are rechecked by supplemental triggers through preparation, queue creation, approval, claim, durable Microsoft dispatch receipt, AI admission, and an existing activation dispatch marker. These triggers supplement the existing guards. Already-reserved model outcomes can still be recorded after a dependency changes.

Saving a new revision invalidates old in-flight installation revisions for further progression; it never silently retargets them. Existing checked cancellation remains available. A valid same-key start replay returns its existing workflow, even if current dependencies changed, without new work.

Load includes the latest 100 operation receipts for the authenticated actor, organization, and current installation visibility. Receipt fields are `operation`, `request_key`, `installation_id`, `installation_revision`, nullable `workflow_id`, and `recorded_at`. These can reconcile a lost acknowledgement after later edits. Absence from this bounded list is not proof that a write failed.

## Error and retry semantics

Explicit validation or verified PostgreSQL rejection returns `write_outcome:'not_applied'`. Transport failures, unclassified RPC errors, and malformed/mismatched success responses return `write_outcome:'unknown'`. A caller must retain its request key for unknown results and reconcile or retry the same request. An HTTP status alone is not a reliable write-outcome signal.

- 400: invalid request shape, reference, revision, recipe, installation, bindings, limits, or intake
- 401: `sign_in_required`
- 403: `origin_not_allowed`, `organization_access_denied`
- 405: `method_not_allowed`
- 413: `request_too_large`
- 409: `reviewer_conflict`, `idempotency_conflict`, `installation_changed_or_not_ready`
- 503: `workflow_installations_not_installed`, `installation_storage_unavailable`, `workflow_installations_unavailable`

No RPC error details, customer payloads, or credentials are returned in error messages.

## Exact proposed deployment scope

Review `backend/candidate/sql/workflow-installations-contract.sql` before any future installation. It assumes existing Customer Workflow, AI Draft, Microsoft OAuth binding, approval, receipt, organization membership, and audit contracts. Optional Company Knowledge and inference activation contracts remain independent.

New tables:

1. `public.workflow_recipe_versions`
2. `public.workflow_installations`
3. `public.workflow_installation_versions`
4. `private.workflow_installation_saves`
5. `public.workflow_installation_requests`

All have RLS enabled. PUBLIC, anon, and authenticated receive no table access or RPC execution. The service role receives SELECT on recipes; SELECT/INSERT/UPDATE on installation heads; SELECT/INSERT on installation versions, save receipts, and start provenance. No DELETE is granted. Version/receipt update or deletion is additionally blocked by immutable triggers. Recipe seeding is migration-owned, with no runtime write grant.

New public service-only RPCs:

- `workflow_installations_load(uuid,uuid)`
- `workflow_installations_save(uuid,uuid,uuid,integer,uuid,jsonb)`
- `workflow_installations_start(uuid,uuid,uuid,integer,uuid,jsonb)`

New private invoker helpers: `workflow_installation_immutable`, `workflow_installation_head_guard`, `workflow_installation_connection`, `workflow_installation_readiness`, `workflow_installation_project`, `workflow_installation_assert`, `workflow_installation_workflow_guard`, `workflow_installation_assert_action`, `workflow_installation_action_guard`, `workflow_installation_dispatch_guard`, and `workflow_installation_ai_guard`. All new functions use a fixed pg_catalog search path and have explicit revokes from browser/public roles. This contract introduces no security-definer function.

Supplemental triggers on existing tables:

- `installation_workflow_guard`: BEFORE UPDATE on `customer_reply_workflows`
- `installation_action_guard`: BEFORE INSERT OR UPDATE on `action_requests`
- `installation_dispatch_guard`: BEFORE INSERT on `action_execution_receipts`
- `zz_installation_ai_guard`: BEFORE INSERT OR UPDATE on `ai_draft_runs`

Existing function bodies, table columns, policies, and grants are not replaced. Uninstalled workflows return immediately from the new lineage guard. The candidate Edge Function uses the repository-pinned Supabase JS 2.58.0 and allows `https://www.cerbtek.com` and the existing Webflow origin. Service credentials are read only from runtime environment variables and are never part of the browser code.

## Verification boundary

Run from the candidate root:

`node --test --test-concurrency=1 backend/tests/workflow-installations-*.test.mjs`

The fixture dependencies are copied, unmodified source contracts (plus synthetic schema and OAuth binding fixture) required for self-contained local tests. They are not additional deployment instructions.

Coverage includes SQL/RLS permissions, recipe/revision/provenance immutability, exact retries, stale revision and tenant denial, assigned-member starts, reviewer independence, separate draft manager, max-open admission, context/config/OAuth/role changes, optional current Company Knowledge, independent activation, downstream AI/action/dispatch fencing, uninstalled-workflow regression, and full HTTP → PostgreSQL → frontend `verifyInstallations` compatibility.

PGlite executes the SQL and triggers, but does not prove live deployment configuration, network behavior, real provider calls, or multi-session PostgreSQL lock races. These remain unperformed. No live schema, grant, deployment, or activation was changed.
