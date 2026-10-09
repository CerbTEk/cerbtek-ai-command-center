# Organization-scoped AI activation controls

Status: OFF-only source candidate, not installed or published. Base: remote main `e6b4917e894af4768e78db0e601bb3ec6e38ffdc`, independently read and content-verified on 2026-10-09. This rebased candidate preserves the deployed 11-file customer-reporting release, including shared per-request evidence, AI Ops reporting, routes, scripts and reporting tests. It supersedes the earlier 33a1e82-based activation candidate for any future release.

## Outcome and source of authority

`private.ai_inference_activations` is the single authoritative, append-only, organization-scoped activation approval history. Installation creates an empty table with `enabled DEFAULT false`. It creates no approval records, credentials, provider connections, models, or spending authority. There is no browser activation control or runtime activation writer.

Each future enabled approval must explicitly bind the organization, latest saved AI configuration ID, provider, exact model, provider-account reference, SHA-256 credential fingerprint, approving current owner, approval record reference, approval time, finite expiry, and positive request/daily/total micro-USD and daily/total run caps. Missing, malformed, disabled, future-dated, expired, superseded, wrong-account, wrong-credential or exhausted approval stays OFF. Saved task budgets and UI defaults are proposed task limits; they cannot authorize spending. Approved activation caps and saved task limits both apply.

The existing organization-specific secret naming pattern is preserved: `KAIRO_AI_<PROVIDER>_<ORG_WITHOUT_DASHES>_KEY`. A separately approved secure provisioning step must also supply the matching nonsecret `_ACCOUNT_REFERENCE`. The credential fingerprint is computed server-side and compared with the approved record. No deployment-wide provider key is used as an organization connection. This matching proves exact server-configured binding, not independent verification of ownership by the remote provider. Actual account identity and authority still need verification during secure setup.

## Enforcement and recovery

One private SQL evaluator supplies saved workflow readiness, credential-bound AI readiness, reservation admission and final dispatch checks. All paid paths use `ai_inference_reserve` and mandatory `ai_inference_dispatch`; the previous unbound reservation RPC loses runtime EXECUTE privilege. The new run trigger also blocks insertion without a valid activation and freezes organization/configuration/request/actor/cost/day/activation identity.

Admission and approval revision insertion serialize on the organization row. Actor authority is checked after acquiring that lock. A final admission-trigger time snapshot sets creation and UTC reservation day and checks activation plus saved task caps. Dispatch locks organization and run, rechecks actor authority, captures a new post-lock wall-clock snapshot, and revalidates exact approval revision, current config, account, credential, expiry, quota, request tuple and same UTC reservation day. A one-use timestamp claims dispatch. Repeated dispatch, disable/re-enable, and previous-day reservations cannot authorize a new provider attempt. Crashes, failed calls and unknown calls retain reserved usage; no automatic refunds or retries are introduced.

These database locks do not remain open over the external provider HTTP request. Revocation cannot recall an already-dispatched request. Hosted simultaneous-session behavior and real provider acceptance remain separate unrun acceptance checks.

Exact previous manual requests are recovered before credential resolution, model discovery or activation checks. The same request key cannot create another provider attempt. Connected-workflow replay still verifies the saved workflow/source snapshot first; if that source, context or revision changed, use the existing read-only request lookup. Lookup/review projections preserve the current knowledge visibility rules. OFF status never deletes history or resolves unknown outcomes.

## UI truthfulness

AI Setup requires the new versioned, exact organization/configuration-bound activation projection, available model, verified account binding, current expiry and strict server booleans. It clears stale readiness when saving a new configuration and disables controls at expiry. Customer Follow-up and Customer Setup distinguish saved activation authorization from live credential/model/provider acceptance. Missing old-server projections remain OFF. No positive end-to-end readiness is fabricated.

## Exact installation approval scope

Apply `backend/candidate/sql/ai-inference-activation-contract.sql` only after the deployed knowledge-draft contract and after approval of this access-control delta:

- New private activation table, RLS enabled, no browser privileges; `service_role` receives SELECT only. No application role receives INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER on approvals.
- New private activation append-only and no-truncate triggers, with their function denied to application roles.
- Two additive nullable run columns: `activation_id` and `activation_dispatch_started_at`; activation usage index and immutable admission trigger. Existing run history is retained.
- Service-only EXECUTE on the private evaluator/trigger and public readiness, bound-reservation and one-use-dispatch RPCs. All are SECURITY INVOKER with fixed `pg_catalog` search path and qualified relations; no new SECURITY DEFINER function or browser RPC grant.
- Revoke `service_role` EXECUTE on the old `ai_draft_reserve` RPC.
- Replace the existing knowledge-aware `customer_workflow_load` body to project shared activation readiness; preserve its existing ACL, actor checks, source visibility and history shape.

The installer aborts if prerequisite contracts are absent. Reapplying the completed installer aborts transactionally rather than changing existing approval records. Historical installation SQL remains unchanged; this contract must be the final migration in an installation sequence so older readiness definitions cannot overwrite it.

## Release sequence and rollback

1. Review the scoped source manifest, SQL, local tests and this privilege delta. Confirm current remote main still matches the candidate base; reconcile unrelated work without overwriting it.
2. Obtain explicit approval for the database permission/guard installation. Apply only this transaction. Verify empty activation history, false readiness for both companies, RLS, grants, old RPC revocation, existing membership/source/action history preservation, and no new run or provider credential.
3. Deploy the exact `ai-draft` package (including `activation.mjs`) with existing JWT/CORS settings; deploy the scoped frontend. The existing customer-workflow Edge package need not change because the SQL response carries the new projection. No company is enabled.
4. Verify remote source, deployment result, unauthenticated rejection, OFF readiness and no activity. Save a new private source/test/deployment backup.
5. Future ON requires a separate exact account/model/pricing/data/use-case/expiry/spend approval, secure provisioning authorization and appropriate independent reviewer setup. Installation approval is not ON approval.

If the new SQL or Edge deployment is incomplete, missing RPCs fail closed. Keep the restrictive guards and history; prefer a scoped forward fix. Do not restore the old unbound runtime grant, drop immutable history, clear reservations, or resend uncertain outcomes as a rollback. No destructive rollback is supplied.

## Local verification

`npm run check:all` includes all Node/PGlite backend tests, React DOM tests, funding RLS checks, marketing routing, production build and public bundle boundaries. Activation-specific tests use only synthetic in-memory records and mocked provider results. The runtime suite exercises the actual new SQL with the real handler and no provider network. Existing legacy SQL route tests explicitly label their synthetic activation adapter.

No live SQL, secrets entry, account provisioning, provider call, email send, browser login, local listener, socket workaround, denied reproduction, hosted concurrency or production publication is part of this candidate verification. Pixel/mobile browser QA and real authenticated/paid acceptance remain unrun.
