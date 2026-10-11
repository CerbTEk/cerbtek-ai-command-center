# Installed employee drafting: source-only review

Prepared against the published installer baseline 8f6c3b2 on 2026-10-11. This package is not a migration or deployment. No production write, activation, provider request, email send, credential change, or access grant was performed. Existing live function definitions were inspected read-only to verify the manager gates and finish semantics before editing.

## Scope

A current `member` may generate an AI draft only for the customer workflow assigned to them by a current installed workflow version. The current installation must still match its pinned company context, AI configuration, Microsoft connection fingerprint, assignee, and distinct manager reviewer. General AI administration and uninstalled member drafting remain unavailable.

Member Edge requests permit only `run` and the six exact fields: operation, organization_id, configuration_id, request_key, customer_workflow_id, expected_revision. Actor identity comes from the authenticated session. Manual context, arbitrary sources, load, lookup, models, save and review are denied for members. A dedicated exact-workflow readiness RPC leaves the existing general readiness RPC manager-only.

Authority is independently rechecked when preparing, deriving input, reserving, inserting a run, transitioning its dispatch marker, and immediately before dispatch. Existing configuration, activation, credential binding, spending limits, one-use dispatch, knowledge freshness, and source-hash controls remain in place. Members must select no knowledge sources; manager selection retains existing resolution, snapshot, freshness and citation rules.

The existing `ai_draft_finish` definition remains unchanged so the trusted server can record an already-reserved outcome after authorization changes, including uncertain/billed outcomes. Current member visibility is rechecked before returning a run. If authorization changed during an operation, its durable outcome can exist even though the HTTP response is denied; it is not automatically retried.

Installed draft requesters cannot accept or reject their own draft, including after promotion to manager. Other manager reviews remain possible. Queueing still creates only an exact Pending email proposal; only the existing distinct designated manager reviewer can approve it, and existing execution/receipt checks remain. No member send or activation authority is added. Uninstalled review policy is unchanged.

A two-person organization may use a member drafter plus its manager reviewer. The old requirement for a second draft manager is removed from installation readiness because the assigned member is now the independent drafter.

## Frontend contract

`customer_workflow_load` adds `workflow.draft_authority` only to installed rows:

- contract_version: 1
- organization_id, workflow_id, workflow_revision, actor_id
- installation_id, installation_revision (the pinned provenance)
- can_generate: boolean
- reason: null or a denial reason

The projection is actor-specific and fails closed on stale dependencies. It describes draft authority, not activation or provider availability. Existing workflow state and independent activation still determine whether a new run can occur. Uninstalled rows omit the property. Successful preparation also includes the same projection using the new workflow revision.

## Exact SQL surface

New functions (all SECURITY INVOKER, service_role EXECUTE only):

- private.customer_workflow_draft_authorize(uuid,uuid,uuid)
- private.customer_workflow_draft_project(public.customer_reply_workflows,uuid)
- private.ai_inference_authorize_request(uuid,uuid,uuid,uuid)
- public.customer_workflow_ai_readiness(uuid,uuid,uuid,integer,uuid,uuid,text,text)
- private.workflow_installation_draft_review_guard()

Replaced functions, with signatures preserved:

- private.workflow_installation_readiness(public.workflow_installation_versions,uuid)
- private.customer_knowledge_seal(uuid,uuid,uuid,uuid,jsonb)
- public.customer_workflow_prepare_sources(uuid,uuid,uuid,integer,uuid,uuid,jsonb)
- public.customer_workflow_draft_input(uuid,uuid,uuid,integer,uuid,uuid)
- private.ai_inference_run_guard()
- public.ai_inference_reserve(uuid,uuid,uuid,uuid,text,bigint,text,text)
- public.ai_inference_dispatch(uuid,uuid,uuid,uuid,uuid,text,text,text)
- public.customer_workflow_queue(uuid,uuid,uuid,integer)
- private.customer_workflow_assert_action(public.action_requests)
- public.customer_workflow_visible_run(uuid,uuid,uuid)
- public.customer_workflow_load(uuid,uuid)

The existing private knowledge snapshot writer retains its existing SECURITY DEFINER setting and fixed pg_catalog search path. Other replaced functions remain SECURITY INVOKER. All 16 signatures explicitly revoke PUBLIC, anon and authenticated execution and grant only service_role. No table privileges or browser access are expanded. Existing manager-only ai_draft_authorize, ai_inference_readiness, ai_draft_review and outcome-only ai_draft_finish are not replaced. Legacy ai_draft_reserve remains revoked from service_role.

New trigger: installed_draft_review_guard BEFORE UPDATE ON public.ai_draft_runs, covering review transitions and changes of reviewer identity. Existing admission, knowledge, installation, approval and receipt triggers are retained.

## Files

- New candidate: backend/candidate/sql/employee-drafting-contract.sql
- Changed Edge: backend/candidate/edge/ai-draft/handler.mjs, activation.mjs
- New fixture/tests: backend/tests/fixtures/employee-drafting-fixture.mjs; employee-drafting-sql.test.mjs; employee-drafting-runtime.test.mjs
- Updated existing role-boundary expectation: backend/tests/ai-customer-workflow.test.mjs

The new fixture composes the existing workflow-installation-fixture.mjs with knowledge and activation enabled, then installs the follow-on SQL in disposable PGlite only. Synthetic provider outputs are in-memory stubs. PGlite exercises real function/trigger/grant behavior but does not verify production concurrent-transaction scheduling or a deployed Edge runtime. Production installation and live-provider validation remain outside this source-only task.
