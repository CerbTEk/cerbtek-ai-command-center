# Assigned employee AI drafting candidate

Status: source-only; do not publish the UI without its reviewed backend contract. No database migration, Edge deployment, provider inference, live email or activation was performed for this slice.

Baseline: CerbTEk/cerbtek-ai-command-center main commit `8f6c3b2fd85f0b8bebd2b0d96182af69d4e54209`. Frontend source files were checked against their exact GitHub blob identities before editing. Existing auth, recovery, layout, home and unrelated source are unchanged.

## Intended working path

A manager binds a customer follow-up installation to current company guidance, saved AI configuration, assignee and a different authorized reviewer. The assigned current member opens a request from that installation and explicitly requests an AI draft. A matching current server-derived draft authority projection enables the button. Existing saved activation and company limits remain mandatory. Missing setup stays visibly blocked.

The employee can read the saved task and company guidance and request only this workflow's bound draft. Employee Company Knowledge selection is not added; manager selection and all existing source freshness checks remain in place. The draft must be reviewed by a separate authorized manager, then queued for independent exact-email approval and explicit sending using the existing pipeline. Employee drafting adds no review, approval, sending, setup editing, provider credential or activation capability.

Uninstalled workflows retain the existing manager-only drafting policy. Existing request keys, interrupted-request resume behavior and unknown-outcome locks are preserved.

## Frontend permission contract

Installed rows returned from customer-workflow load carry `draft_authority` with `contract_version`, `organization_id`, `workflow_id`, `workflow_revision`, `actor_id`, `installation_id`, `installation_revision`, `can_generate`, and `reason`. The frontend rejects mismatched identities/revisions or an unsupported version. A member additionally must be the assigned employee. Server authorization remains authoritative at each preparation, admission and dispatch step; the projection is not an access token.

Both rendered controls and direct event handlers enforce these checks. The employee flow never sends a free-form inference input or configuration override. A prepared request resumes with its original request key and pinned revision. Installed draft authors cannot self-review even after a role change; no global legacy review policy is changed.

## Frontend changed files

- src/customer-reply-model.js
- src/CustomerReplyWorkspace.jsx
- src/WorkflowInstallations.jsx (wording updated for assigned drafting)
- tests/customer-reply.test.jsx

## Verification scope

Focused synthetic UI and backend tests, production bundle build and source comparisons only. No full launch QA or live customer/provider test. Backend contract, exact migration/Edge scope, grants and focused test evidence are supplied separately with this candidate and require independent review before production.

Focused results: 223 UI tests passed; 12 installer tests rerun after final wording; 23 new backend tests and 37 targeted backend regressions passed. Production bundle build passed. Independent review passed. No live-provider test or full launch QA was run.
