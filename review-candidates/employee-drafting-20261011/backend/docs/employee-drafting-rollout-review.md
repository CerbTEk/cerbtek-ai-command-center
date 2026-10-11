# Employee drafting: scoped rollout and rollback review

Status: source-only. Production changes are on hold pending explicit authorization. This document does not authorize deployment, rollback, inference, sending, or activation changes.

## Fresh read-only preflight

Captured 2026-10-11 01:30:53 UTC, then the deployed AI Edge source was retrieved read-only.

- All 11 functions to be replaced exist; their complete SQL bodies exactly match the published installer baseline source.
- Their current effective grants are service-role execution only (no anon or authenticated execution).
- All five new function signatures are absent.
- The new installed_draft_review_guard trigger is absent; the four existing AI admission/source/knowledge/installation triggers are present.
- Required workflow, knowledge snapshot, inference activation and AI-run columns exist.
- Runtime roles still lack activation INSERT/UPDATE privileges.
- Deployed ai-draft is version 8, ACTIVE, verify_jwt=true, with no import map. Its four source files match the baseline: index.ts, handler.mjs, activation.mjs and core.mjs.

This evidence contains function/trigger definitions, schema metadata, grants and source files only. No application rows, activation records, model credentials or provider secrets were read for this preflight. Raw database catalog snapshots remain local and must not be committed to the review branch.

## Verification

- Focused final batch: 23/23 tests (15 PGlite SQL/security tests plus 8 real-HTTP-handler-to-PGlite tests with an in-memory mock provider).
- Targeted existing regressions: 37/37 tests.
- Source-only rollback SQL validated in disposable PGlite: restored 11 functions, removed the new trigger and five new functions, restored manager-only authorization. It was not executed remotely.
- Tests cover the installed member flow through independent draft review, Pending proposal, designated reviewer approval and a synthetic durable dispatch receipt, with no actual send.

Test logs are local evidence. They do not establish production concurrency timing or a deployed paid-provider end-to-end run.

## Prospective rollout, only after approval

1. Recheck current deployed definitions, Edge version and source checksums against this snapshot. Stop on drift; do not overwrite unrelated changes.
2. Preserve the current function/ACL snapshot and exact deployed Edge files before any replacement.
3. Install only backend/candidate/sql/employee-drafting-contract.sql through the approved migration process. It is one transaction: five functions added, 11 replaced, one trigger added, no table or row mutations, and no new browser privileges. Existing activation/configuration/provider credentials remain unchanged.
4. Verify the 16 function definitions, execution grants and new trigger read-only. Confirm general ai_draft_authorize, ai_inference_readiness, ai_draft_review and ai_draft_finish are unchanged.
5. Deploy only ai-draft using the reviewed handler.mjs and activation.mjs plus unchanged index.ts and core.mjs. Preserve verify_jwt=true, the existing exact CORS origin, and all environment configuration. Other Edge functions do not need redeployment.
6. Publish only the reviewed employee-draft UI changes. Do not replace unrelated pending drafts or root application changes.
7. Verify deployed hashes and read-only actor-scoped projections. Any live provider request or real email action requires its own valid existing authorization and approval controls. No deployment verification may create activation approvals, enlarge budgets, alter credentials or auto-send an email.

SQL-first with the previous Edge remains fail-closed for member generation because the previous Edge denies members. Missing bound-readiness functions also fail closed in the new Edge. A partial rollout is not successful deployment.

## Prospective rollback, only after approval

Before reverting, inspect whether any employee run is reserved, uncertain, completed or awaiting review. Prefer a forward fix when employee work already exists. Do not delete rows, release or reset reservations, change assignment/provenance, fabricate outcomes, or reset activation/configuration/provider credentials.

1. Restore only the employee-related frontend source changes and restore the exact ai-draft version-8 source files in backend/deployment/rollback-edge/ai-draft. Keep verify_jwt=true and existing environment settings. Restoring the old Edge prevents new member calls but does not undo an in-flight provider operation; preserve its durable outcome recording.
2. If the function rollback is explicitly approved after reviewing outstanding work, backend/deployment/employee-drafting-rollback-source.sql restores the exact 11 captured function definitions and original effective grants, drops the new review trigger, and drops only the five newly introduced functions. It has no row/data reset statements and no CASCADE drops.
3. Verify restored checksums, grants and trigger set, and confirm existing unknown/reserved outcomes remain intact.

After employee drafts exist, restoring manager-only SQL can intentionally block their later queue or approval. This is a policy consequence, not evidence that the stored work was lost. Do not disguise it through data deletion or reassignment; use an explicitly approved forward fix or explain the remaining blocker.

## Safe review-branch files

- backend/candidate/sql/employee-drafting-contract.sql
- backend/candidate/edge/ai-draft/handler.mjs and activation.mjs
- backend/tests/fixtures/employee-drafting-fixture.mjs
- backend/tests/employee-drafting-sql.test.mjs and employee-drafting-runtime.test.mjs
- backend/tests/ai-customer-workflow.test.mjs
- backend/docs/employee-drafting-source-review.md and this rollout review
- backend/deployment/employee-drafting-rollback-source.sql (definition-only, no user rows or credentials)
- backend/deployment/rollback-edge/ai-draft/{index.ts,handler.mjs,activation.mjs,core.mjs} (prior source only, no environment secret values)

Keep raw local preflight catalogs and metadata in backend/evidence out of the repository. The parent’s review artifact manifest supplies the final approved source checksums.
