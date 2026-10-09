# Customer reply connection contract

Source-only candidate. No deployment, database mutation, new credentials, paid inference or external email is performed by these files or their tests.

## Dependencies and release boundary

Install only after separate deployment/security approval, following the existing OAuth binding, action guard, reconciliation receipt, AI draft and team-access contracts. The candidate SQL is `../../sql/customer-workflow-contract.sql`. Installation is transactional and requires action-request RLS already enabled. Publish the matching customer-workflow Edge boundary and the connected-source branch in ai-draft together. Existing Microsoft action execution remains authoritative. AI paid inference remains hard-disabled in its runtime.

This is an employee email intake slice. It does not install the historical phone simulation, separate membership/entitlement tables, a new dispatcher, or a second approval engine. Phone handoff and retrieved knowledge require a separately versioned source contract.

## Public request boundary

All requests are authenticated POSTs to customer-workflow, contain organization_id, and use operation. JWT verification derives p_actor. Extra fields, including client actor, approval, source, provider endpoint and email-payload replacements, are rejected.

Successful responses contain ok: true, contract_version: 1, organization_id.

- load: Returns actor, context, configuration, workflows (newest 100), people and readiness. Members see assigned requests; managers and viewers see company requests. No credential is returned. Microsoft readiness contains exact microsoft_account and microsoft_connection_id, without claiming a From mailbox or delivery.
- save_context: expected_version and context with exactly company_name/reply_guidance. Managers only. Saves immutable versions with source_kind manual_company_guidance.
- intake: request_key UUID, customer_email, customer_name, subject, message. Creator is initial assignee. Replaying a key requires the same actor and exact fields.
- assign: workflow_id, expected_revision, assigned_to. Managers only; allowed before draft preparation, with current company contribution membership.
- prepare_draft: workflow_id, expected_revision, configuration_id, request_key. Current owner/admin/consultant only. Pins the exact current company source, AI configuration, actor and request key, and returns the incremented workflow revision.
- queue: workflow_id, expected_revision. Requires accepted AI result and current source/configuration. Freezes the original recipient plus exact AI title/body into one Pending action_requests row. Retries return the same proposal; they never create a duplicate or approve it.
- cancel: workflow_id, expected_revision. Sets a durable cancellation fence before any Dispatching receipt. A previously claimed action is not reset. Its delayed dispatcher cannot obtain a receipt after cancellation.

AI run uses the existing ai-draft endpoint with operation run, organization_id, customer_workflow_id, expected_revision, configuration_id and request_key. No input field is accepted. customer_workflow_draft_input derives the saved company guidance plus customer name/subject/message. The email address is not sent to the model. The existing manual-1 source identifier applies to this explicit source only; it is not a retrieval citation.

Review the draft through existing ai-draft review. Acceptance records content review only. Then queue the proposal and use existing microsoft-action approve/reject/execute. Approval and execution are separate. The external approver must currently belong to the company as owner/admin/consultant and differ from the original intake requester, current assignee, draft author and proposal requester. The executor must currently hold one of those company roles. Platform staff status alone does not confer authority for this slice.

## Recovery and freshness

Both company-context and AI-configuration changes invalidate unsent proposals. Dispatch authorization checks current membership, source, configuration, exact accepted payload and cancellation under existing action/organization locks.

Prepared request keys without a matching AI run remain pinned. Resume the same key; do not replace it. If the saved source/configuration changed before admission, cancel and start a new intake. Cancellation retains the old key binding. Recorded failed/rejected AI results can be explicitly regenerated with a new key; reserved/unknown results cannot. Recorded accepted or awaiting-review results can be replaced only after rejection or a source/configuration revision change. No timeout unlock is provided.

The action_requests record and action_execution_receipts are the recorded email outcome. Executing or unknown state never offers resend. ProviderAccepted/Executed means Microsoft accepted the message, not that the recipient received it. Recording completion remains possible after authority changes, so a received provider acknowledgement is never erased.

## Exact candidate ACL effects

- New context/workflow tables enable RLS and revoke all direct privileges from PUBLIC, anon, authenticated and service_role, then grant only service_role SELECT/INSERT on context and SELECT/INSERT/UPDATE on workflows.
- Each explicitly listed new service RPC and trigger helper revokes PUBLIC/anon/authenticated EXECUTE and grants service_role EXECUTE. Existing similarly named functions are not altered.
- New private customer_action_readable(uuid,uuid,uuid) is the sole SECURITY DEFINER helper. Its fixed pg_catalog search path and auth.uid/current membership checks expose only a boolean for the exact organization/request/workflow linkage. PUBLIC/anon/service_role cannot execute it; authenticated can execute it for the restrictive policy.
- A restrictive authenticated SELECT policy applies assignment visibility only to linked customer action rows. It grants no new table access and leaves manual action visibility subject to existing policies. Receipt tables retain their existing service-only access.
- No membership, staff role, invitation, existing manual-action write permission, OAuth scope or credential is created or expanded.

## Synthetic verification

Run node --test backend/tests/customer-*.test.mjs and the existing AI/Microsoft suites. Tests use PGlite and in-memory adapters only, with fictional data and no sockets, provider calls or hosted concurrency procedures. These checks exercise SQL semantics and sequential lifecycle interleavings, not production multi-session lock timing or live provider acceptance. Prepared-key replacement prevention was source-reviewed; production concurrent acceptance remains outstanding.
