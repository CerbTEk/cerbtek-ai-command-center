# Kairo customer-follow-up installer — source-only candidate

Baseline: CerbTEk/cerbtek-ai-command-center main 5e3d62bc32b03b556d45760e089badf2c8b4a54a. `main.jsx` blob 1b9fe5b76bbe2dbd8cb3c3fb9815c6f7d2a7e2e3 verified from GitHub. No homepage, billing, credential, deployed SQL, access grant, provider, or customer-data mutation was performed.

## Customer path

1. Customer Setup → Set up a workflow.
2. Record the business outcome and a name; choose customer follow-up recipe v1.
3. Bind the existing versioned reply guidance, AI draft configuration, verified Microsoft connection, assigned employee, and designated independent email reviewer. Set a 1–100 open-request cap.
4. Save. Missing prerequisites remain `setup_needed`; current bindings yield `configured`, explicitly manual-only. This does not enable AI, perform OAuth, purchase anything, retrieve mail, generate a draft, or send email.
5. Employee Customer Follow-up → New request under the configured workflow. Saving atomically creates the real existing request and assignment, with durable installation/version provenance.
6. Existing manager draft generation, draft review, exact-email approval, separate Microsoft send and receipt screens remain in place. Bound source/configuration/connection/reviewer restrictions are enforced on the backend, not merely displayed.

Members can start only installations assigned to them. Viewers can read only. Setup management is limited to existing owner/admin/consultant roles. The designated reviewer cannot author the request or draft. A distinct draft-capable manager is required. Additional Company Knowledge excerpts retain the existing per-request explicit selection and guards.

## Source changes to integrate

New:
- src/WorkflowInstallations.jsx
- src/workflow-installation-model.js
- src/workflow-installations.css
- tests/workflow-installations.test.jsx
- backend/candidate/sql/workflow-installations-contract.sql
- backend/candidate/edge/workflow-installations/index.ts
- backend/candidate/edge/workflow-installations/handler.mjs
- backend/tests/workflow-installations-*.test.mjs and synthetic fixture/dependency files

Modified:
- src/CustomerSetupJourney.jsx: embeds setup component and forwards navigation protection callbacks.
- src/CustomerReplyWorkspace.jsx: embeds employee launch component, merges its dirty/busy state, opens newly saved request.
- src/main.jsx: apply main-integration.patch to the current remote baseline, do not overwrite the file. Extends existing dirty/busy navigation guards to Customer Setup and passes callbacks.
- tests/customer-setup.test.jsx and tests/customer-reply.test.jsx: isolate the separately tested installer component in the pre-existing focused component suites.

Do not upload the entire candidate checkout. It contains copied baseline files and a local node_modules symlink used only for verification. Preserve all unrelated code and drafts.

## API contract

Authenticated route: workflow-installations. All operations take organization_id. Actor identity comes from verified Supabase Auth, never the caller.

- load: current actor, immutable recipe catalog, current visible installations, existing workflow workspace, and actor-scoped operation receipts for uncertain-save reconciliation.
- save: installation_id (null for new), expected_revision (0 for new), request_key, recipe_key, recipe_version, name, outcome, bindings, limits. Returns exact persisted installation revision. Same-key retries require identical actor and payload.
- start: installation_id, expected_revision, request_key, intake (customer_name, customer_email, subject, message). Creates the existing intake and assignment in one transaction; returns installation, workflow, and provenance. No downstream action is invoked.

Binding keys: context_version_id, configuration_id, microsoft_connection_id, assigned_to, reviewer_id. Missing values are explicit nulls. Limits: max_open_requests. Installation statuses: setup_needed or configured. Readiness is derived by the server from current tenant-bound dependencies. Credentials and Microsoft authority fingerprint are not projected.

The frontend retains only a pending operation type and UUID in actor/company-scoped session storage. Unknown outcomes block replacement actions; unchanged retries reuse the same key; actor-scoped saved receipts reconcile across remounts. Explicit server `write_outcome: not_applied` permits correction. Absence of a receipt is never treated as failure.

## Revision behavior

Saving an existing installation creates an immutable new revision. Old requests are retained but fail closed for progression against a newer installation head. UI warns before saving. Cancellation remains governed by the existing safe cancellation path; unknown provider outcomes must be reconciled before replacement.

## Verification and release boundary

Focused frontend tests and production build are run locally. Existing setup/reply component tests isolate the new installer, which has its own role/tenant/lifecycle suite. Backend fixtures use isolated PGlite and synthetic identities; no live customer or provider data. Exact test counts/logs are recorded in the handoff.

Not yet verified by this candidate: live Supabase installation, deployed edge runtime, real multi-session PostgreSQL race behavior, visual browser QA, or live AI/Microsoft acceptance. These are not implied by a configured record or passing synthetic tests.

Publication and production SQL require parent review. Required deployment is a coordinated SQL contract + authenticated edge function + frontend release. Releasing frontend alone shows service unavailable and never claims setup is installed.
