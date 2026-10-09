# Knowledge Draft release candidate

Status: prepared for review only. No source push, database install, Edge deploy, frontend publication, provider configuration or paid call performed.

Base: deployed GitHub main `7c8a3dd37db7d9c27900f123865fca3aa7cbf4cd`, independently rechecked on October 9, 2026. Billing work is excluded.

## Scope
- Explicit manager search, preview and selection of up to five published company-wide excerpts
- Immutable per-request snapshot and exact ID/hash citations
- Current source/authority checks at preparation, reservation and final provider dispatch boundary
- Stale content redaction in customer workspace, AI run reads and linked email review responses
- Manual-only requests and existing provider adapters, company roles, independent approval and one-time send preserved

## Exact database approval needed
Apply only `backend/candidate/sql/knowledge-draft-contract.sql` after the deployed dependencies. The transaction adds:
- Private `customer_knowledge_snapshots`, RLS enabled, immutable insert-through-helper only; `service_role` gains SELECT solely on these selected snapshots. PUBLIC/anon/authenticated get no table privileges.
- `ai_draft_runs.knowledge_bound` default false; before-update guard makes that provenance marker immutable.
- Private SECURITY DEFINER helpers `customer_knowledge_resolve`, `customer_knowledge_fresh`, `customer_knowledge_seal`, and `customer_knowledge_search`, fixed `pg_catalog` search path. Only trusted service-role execution is granted. They never return private-audience documents; source access checks current company membership and publication/freshness.
- Service-only public SECURITY INVOKER RPCs `customer_workflow_prepare_sources`, `customer_workflow_knowledge_search`, `customer_workflow_knowledge_source`, `customer_workflow_draft_dispatch`, `customer_workflow_visible_run`, and `customer_workflow_visible_action`.
- Private pure/trigger helpers with service-only execution; no existing membership or credential mutations.
- Replacements of existing prepare/input/reservation/projection/load/queue/action-assert functions. Existing action read policy helper is narrowed to exclude stale knowledge-derived email content. Its existing authenticated execute grant is preserved; it returns only a boolean.

Existing direct privileges on `knowledge_documents`, `knowledge_document_versions`, and `knowledge_chunks` stay closed, including to the service role. No new authenticated/public source-table access is created. Freshness is checked under the existing organization mutex for workflow RPCs. No database transaction can span the provider HTTP request; hosted concurrency timing has not been claimed as verified.

## Edge/frontend approval needed
Coordinated Edge deployment: `ai-draft` (core and handler), `customer-workflow` (handler), `microsoft-action` (handler), with their unchanged index/shared dependencies. Preserve JWT verification and disabled paid inference. Publish only this candidate’s frontend and test/documentation delta on the verified baseline; do not mix billing drafts.

## Remaining acceptance and limits
- Private admin-only knowledge is not selectable for customer reply workflows.
- Citation IDs and immutable source provenance are checked; factual support still requires human review.
- No automatic document or inbox sync, embeddings, new provider credentials or inference activation.
- No browser pixel/mobile acceptance, authenticated hosted acceptance, real-provider response or live send was exercised.
- The previously disallowed stale-key exploit and hosted concurrency/socket paths were not reproduced. One existing test named “manual AI request cannot hijack bound key; changed context blocks admission after input read” was intentionally excluded from this candidate’s final backend invocation; this is not a claim of an unrestricted aggregate pass.
- Preserve new redaction/dispatch guards during rollback if any knowledge-bound runs have been created. Do not restore older raw-output handlers over those records.

## Verification artifacts
The sibling release packet contains final test logs, source SHA-256 manifest, isolated baseline identity, scoped patch and independent review report. Tests use fictional local fixtures and mocked provider responses. The original source files, SQL definitions, test scripts and logs are included in the private versioned backup; credentials, environment files and dependencies are excluded.
