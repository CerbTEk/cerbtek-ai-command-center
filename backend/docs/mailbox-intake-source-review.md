# Microsoft mailbox inquiry intake: source-only review candidate

Base: `0b938fca66335a2d92b97bbf16653152ad45f0ab` (verified main 2026-10-11). No live mail was read, no customer data used, no OAuth grants altered, and no deployment or main publication performed. This is a candidate, not a claim of a live feature.

## Product slice

A company owner/admin/consultant opens Mailbox intake on an installed customer follow-up workflow. Opening loads saved configuration only. Separate explicit actions list a bounded set of visible ordinary top-level folders, save the chosen folder, preview up to ten recent supported incoming messages, and import one checked message as an assigned customer request. The fixed mapping is sender name/address, subject, and extracted plain text. The imported request uses the existing installer assignment, approved company context/configuration, designated reviewer and open-request limit. It does not generate a draft or send an email.

Supported mailbox: the existing verified Microsoft connection's own account (`/me`), bound to the installation. No arbitrary mailbox selector, shared mailbox access, application-wide permissions, nested-folder browsing, search/hidden folders, attachment reads, automatic backfill, background polling, webhook subscription or unattended execution. The bounded provider interface can be reused by a separately authorized future sync worker; no scheduler exists in this slice.

## Minimum configuration and permission requirements

- Existing customer-workflow, workflow-installations, and employee-drafting contracts installed; current customer-follow-up v1 installation.
- Current pinned company reply guidance, AI configuration, assignee and distinct reviewer; existing installer readiness checks remain authoritative.
- Current verified Microsoft OAuth connection with delegated `Mail.Read`, in addition to existing `User.Read`/`offline_access` and installation's existing `Mail.Send` requirement. Intake itself never calls send endpoints.
- Current source binding for that exact installation revision and chosen folder.
- Edge runtime uses the existing Supabase service role and existing Microsoft token helper. No new credential, secret, application registration, permission grant or user-data transmission is performed by this source work.

Read-only source audit: `_shared/microsoft-connection.ts` already lists `Mail.Read` among supported scopes, but its defaults are only `openid profile offline_access User.Read`. A successfully connected account therefore does not prove mail-read capability. The candidate explicitly requires exact stored delegated `Mail.Read`; `Mail.ReadBasic` cannot provide the inquiry body, and this candidate deliberately does not substitute broader `Mail.ReadWrite` or application permissions. No live token/grant inspection was performed. If the current grant lacks `Mail.Read`, an authorized person must separately approve and complete Microsoft reconsent for that permission; tenant consent policy may require an administrator. Reconsent changes the OAuth fingerprint, so re-review/save the affected installation before saving a fresh mailbox source. This candidate neither requests nor grants reconsent.

## Boundaries and data flow

1. Edge validates current Supabase user with `getUser`, rejects anonymous users, uses exact request keys, and derives actor identity from the session. Only canonical www.cerbtek.com and retained Webflow origins are allowed; responses are no-store.
2. Every SQL operation is service-role-only SECURITY INVOKER. All new tables live in private schema, have RLS enabled, and have no browser grants or policies. The existing org mutex and current owner/admin/consultant membership gate all mailbox operations. Members/viewers never preview raw mail.
3. Before credential access and every Graph request, recheck current org, installation revision, connection fingerprint, scope, mailbox and selected folder. Existing refresh helper retains its binding checks. Fixed Graph v1.0 GET URLs only; opaque IDs are encoded, redirects rejected, provider continuation URLs never followed.
4. Graph account identity must match the installation connection. Responses are bounded to 256 KiB, 50 folder choices or 10 messages. Missing/malformed/oversized messages are skipped with a count; body content is not silently truncated. Search/hidden folders and conflicting reply addresses are rejected. Own-account sender addresses are conservatively excluded; sender fields remain unverified routing metadata.
5. Plain-text extraction removes markup, active content and unsafe control/bidi characters. UI renders text nodes only. No links, images or attachments are fetched. All email remains untrusted customer input, never authorization or executable instructions; existing AI source/review restrictions remain unchanged.
6. Preview saves a private actor-bound snapshot, usable for 15 minutes. Only server-produced text and source IDs are stored. Capture replaces that actor's prior previews for the same source. Expired previews are deleted on subsequent load/capture; this is lazy cleanup, not a timed deletion guarantee or scheduled retention worker. Import access expires regardless of cleanup. A successfully imported new snapshot is deleted immediately because the inquiry is then retained in the existing customer workflow record.
7. Import accepts only the preview UUID and source revision. Within one existing org-locked transaction, the database calls `workflow_installations_start` with the saved snapshot and records immutable source lineage. A unique `(organization_id, connection_id, mailbox_id, message_id)` constraint deduplicates across previews, installations and retries. Immutable Graph message IDs are requested; thread ID, internet message ID, folder ID, timestamp, source revision, installation revision, actor and linked workflow are retained privately. Imported inquiry text remains in the ordinary immutable customer workflow record.
8. No new AI/outbound action is created. Employees see imported requests only through existing assigned-workflow access; raw previews remain manager-only. A designated reviewer cannot import a new request they would subsequently approve because the existing start guard rejects that role conflict. Same-preview durable import receipts allow uncertainty reconciliation even after preview expiry.

## Verification and rollout limits

Focused offline tests use synthetic values, mocked Graph requests and existing PGlite fixtures. They cover bounds/sanitization, identity/scope/source changes, raw-mail role denial, actor-bound expiry, exact input projection, idempotent import and lineage, reviewer conflict and open-request-limit rollback. UI tests cover explicit actions, literal-text rendering, stale responses, role isolation, uncertain import retry, uncertain source save reload, duplicate-click locks and expiry. Existing installer tests and a production frontend build are also run. No new full-suite framework was added.

Independent source review passed after focused checks; the final source snapshot still requires a reviewed SQL installation plan and explicit publication/deployment approval. Live Microsoft consent/provider behavior, production database compatibility, deployed JWT/CORS and end-to-end customer-account QA have not been exercised. No claim of full-platform QA or automated monitoring is made.

## Primary references checked 2026-10-11

- Microsoft list messages and scoped folder endpoint: https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0
- Microsoft folder discovery, paging and search-folder distinctions: https://learn.microsoft.com/en-us/graph/api/user-list-mailfolders?view=graph-rest-1.0
- Microsoft immutable IDs, which remain stable across moves within the same mailbox: https://learn.microsoft.com/en-us/graph/outlook-immutable-id
- Microsoft message properties and sender/reply metadata: https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0
- Microsoft Mail.Read delegated permission: https://learn.microsoft.com/en-us/graph/permissions-reference#mailread
- Supabase database function privileges/security: https://supabase.com/docs/guides/database/functions
- Supabase current changelog: https://supabase.com/changelog (Markdown endpoint failed; HTML checked; no relevant new API dependency introduced).

## Final focused source verification

- Provider boundary: 26/26 Node tests.
- Edge route boundary: 6/6 Node tests.
- Database contract: 6/6 existing PGlite-fixture tests.
- UI and nearby regressions: 87/87 Vitest tests (28 mailbox, 12 installation, 40 customer setup, 7 setup app).
- Production frontend build: passed with exit code 0, final candidate.
- Independent review additionally exercised cross-folder/source-revision dedupe and immediate snapshot cleanup.

Commands: `node --test backend/tests/mailbox-provider.test.mjs backend/tests/mailbox-intake-routes.test.mjs backend/tests/mailbox-intake-sql.test.mjs`; `npx vitest run --config vitest.all.config.js tests/mailbox-intake.test.jsx tests/workflow-installations.test.jsx tests/customer-setup.test.jsx tests/customer-setup-app.test.jsx`; `npm run build`. All inputs synthetic. Full-suite and live-tenant QA are intentionally deferred.
