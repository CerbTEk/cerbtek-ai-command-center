# Kairo billing integration, inactive sandbox release

## Scope and verified base

Prepared against `CerbTEk/cerbtek-ai-command-center` main `577aee89e14657bd9c1fc7e1f85fc709bd1366b9`, freshly read from GitHub on 2026-10-09 at 21:10 UTC. All 184 baseline source files matched the prior published source manifest before integration. No homepage, artwork, logo, favicon, marketing entrypoint or public routing changes are included. Existing Company Knowledge, customer workflow, Team & Roles, activation, setup and reporting code is preserved.

The completed provider candidate's 18 backend files are copied byte-for-byte. They supply signed raw webhook intake, immutable receipts/history, first-class tenant mapping, refund-sensitive entitlement projections, source-verified usage facts, the official Stripe read adapter, fenced durable jobs and a pinned-connection PostgreSQL adapter. Stripe 23.0.0 is added only to development/test dependencies; it does not enter the browser bundle.

New integration:
- `backend/candidate/edge/billing/runtime.mjs`: a single explicit trusted-host composition of the existing pipeline. Defaults off before dependencies are touched; accepts only the verified isolated Kairo sandbox in test mode. Each enabled operation verifies the immutable persisted provider binding. It creates no listener or schedule. There is no live-mode composition.
- `backend/candidate/sql/billing-status-contract.sql`: fresh company Owner/Admin authorization and a narrow read-only status projection, under the same company lock as Team & Roles. Nonmembers, staff-only users, other roles, deleted and anonymous accounts are denied. No direct ledger grants are opened.
- `backend/candidate/edge/billing-status/`: user-JWT endpoint with verified current user, strict company-only input, bounded body, sanitized errors and matching response identity. No service-role or Stripe credential is used.
- Lazy `BillingStatus` app screen and tests: company-scoped configuration/usage, explicit unavailable states, refreshed authorization, stale-request fencing, no purchase or activation controls. Multiple bindings are flagged without choosing one. App navigation supports Billing without changing legacy public forwarding routes.

## What the runtime actually does

The host injects an official Stripe SDK client, node-postgres-compatible pool, webhook signing secret, independently verified `{id,account_id,account_kind,livemode,api_version}`, clock and explicit refresh cadence. Construction does not inspect an environment or establish any connection. `enabled:false` prevents all work.

With approved sandbox setup and `enabled:true`:
- `webhook(request)` verifies exact raw bytes and commits a deduplicated receipt before acknowledging it.
- `reconcileOnce()` performs one bounded pass over durable jobs for the exact binding; it only uses official provider GET operations and fences persistence against current receipt revisions and leases.
- `collectStoredUsage({organization_id,source_kind,source_id})` verifies the mapped company, reloads one real persisted AI/workflow/phone source, rechecks it under a transaction, and appends only source-backed observations. It does not accept caller-supplied quantities or scan/backfill automatically.
- `previewEntitlement(...)` loads a stored, immutable explicit policy and current scoped projection. It always returns `execution_authorized:false`; it is not an admission gate. Existing company membership, AI/phone activation and provider-spend controls remain independently authoritative.

The runtime returns no secrets. Diagnostics identify only configured test scope and explicitly leave credential validity/webhook delivery unverified. Enabled data processing is not permission to charge customers. No Stripe product, price, customer, subscription, invoice, payment, refund, webhook endpoint or grant is created by this code.

## Honest UI semantics

`not_configured` means there is no persisted customer mapping for this company. `bound_inactive` means a mapping exists, not that credentials work. Provider account metadata is displayed only through that company's existing mapping. Multiple mappings show review required.

Usage is `lifetime_observations_only`, not complete source coverage, a billing cycle, an allowance reservation or rated spend. Known values remain decimal strings to preserve exact integer totals. Unknown-to-measured updates count once; unknown sources are separate. Missing ledger rows do not prove zero usage. Customer charge and provider spend remain null. Phone legs can overlap and are never summed into a bill.

Unresolved receipt counts include only exact customer-linked receipts. Unknown-customer/binding-wide holds remain private operations data. The status screen does not prove reconciliation health, credentials, provider delivery, policy approval or commercial activation. Subscription and policy counts are recorded facts, not proof of entitlement. Policy versions count provider-binding policy history; they do not mean a company-assigned plan, which this schema does not invent.

## Exact deployable inactive-stage security scope

The user approved the following coordinated inactive release on 2026-10-09 at 21:16 UTC. Actual installation/publication results are tracked in the release evidence, not inferred by this source document:

1. Install the unchanged `billing-foundation-contract.sql` and `billing-worker-contract.sql`, in that order, after verifying their current source-table prerequisites. Foundation creates private `kairo_billing` schema and nine RLS-protected tables; worker adds two RLS-protected queue/history tables and two sequences. All application-role privileges are revoked; history remains append-only. No binding, customer or commercial policy is seeded.
2. Install `billing-status-contract.sql` after current Team & Roles. Its only new runtime read permission is EXECUTE for `authenticated` on `public.kairo_billing_status(uuid)` and `private.kairo_billing_status(uuid)`, plus existing/private-schema USAGE. Public wrapper is invoker; private reader is fixed-search-path definer and authorizes current Owner/Admin membership after a company share lock. It returns only the scoped fields documented above. `anon` and `service_role` have no execute grant. No private table grants are added.
3. Deploy only `billing-status` Edge function with gateway JWT verification retained. It forwards the user JWT through the existing public/anon client to the narrow RPC and independently calls `auth.getUser`. CORS is limited to the already verified `https://www.cerbtek.com`, `https://cerbtek.com`, and existing Webflow app origin. No provider credentials, OAuth scopes or authorization origins are added.
4. Publish the tightly scoped frontend/source changes and verify authenticated Owner/Admin, non-admin, company-switch, refresh, unavailable-backend and sign-out journeys. With empty billing tables, the screen accurately says not configured/inactive.

This stage installs a usable read-only status surface and preserves the full inactive runtime source. It does not configure the pipeline host, dedicated database role, Stripe credential or webhook delivery.

Production preflight found the optional phone runtime source table absent. Phone collection stays unavailable/fail-closed; no phone schema or service is installed by this release.

## Subsequent sandbox runtime setup: actual prerequisites

- Use the separately verified Kairo sandbox `acct_1UOjWDK7Ysc7KMp1`, not main account `acct_1UOjVrKBTeWGfa1w`. The sandbox's US/USD account metadata and active card capability were read on 2026-10-09 at 21:05 UTC; products and active prices were empty. This does not establish application credentials. `sandbox-proposal.json` records only nonsecret facts; it is not executable configuration. The provider website is currently `/products/Kairo`; the canonical product path is `/products/kairo`. No account setting is changed here.
- Reuse the existing Kairo Supabase Edge project as the smallest host path; no additional paid infrastructure is indicated. Existing workflow workers already run there. Official Supabase documentation supports npm/Node APIs, Postgres clients and pg_cron + pg_net scheduling. Use separate raw-webhook and scheduler-authenticated entrypoints with maxJobs:1 initially to fit the 150-second request ceiling. Driver/TLS compatibility and scheduler authentication still require hosted acceptance. Approve that host/pool deployment and its exact persistent access. Existing browser/API roles must not be reused as a broad billing service. Do not use a browser service-role key or silently bypass RLS. The injected adapter requires pinned READ COMMITTED transactions, bounded TLS connections, a sanitized pool-error listener and a separately reviewed restricted runtime role.
- Approve the least-privilege database grants/RLS for that exact runtime identity and binding. Needed operations are SELECT/lock on bound provider rows; SELECT customer mappings; append receipts, immutable links/dispositions/history and usage; SELECT/INSERT/UPDATE current projections and durable jobs; append job history; queue sequence use; SELECT/lock on scoped organizations and existing usage sources. Policy/customer/binding provisioning should remain a separate administrator action. Immutable-table UPDATE privileges needed solely for row locking must not become a mutation path. This packet does not create a BYPASSRLS role or invent permissive policies before that security decision.
- Securely provision a sandbox restricted Stripe read credential to the approved host and verify its exact account. Provider methods: accounts.retrieve, customers.retrieve, subscriptions.retrieve, subscriptionItems.list, invoices.retrieve/list/listLineItems, invoicePayments.list, paymentIntents.retrieve, charges.retrieve/list, refunds.retrieve/list. No write capabilities are required for the reader. Credential entry/grant setup is a separate approval/handoff; never put values in source, chat, browser variables, logs, fixtures or backups.
- Select one supported explicit API version, immutable internal binding ID, raw-body HTTPS webhook endpoint, server-side signing secret and rotation procedure. Approve creating/configuring that endpoint and its event selection separately. Hosted transport must retain body limits, TLS/rate controls and account-mode binding. No endpoint is created by this packet.
- Approve sandbox-only synthetic customer/subscription scenarios and exact test product/price/policy values before creating provider objects. Existing empty product/price inventories are not substituted with guessed prices. Commercial decisions (features, payment/trial/grace/refund rules, provider cost ownership) remain explicit immutable policy inputs.
- Define a reviewed scheduler identity and cadence shorter than approved snapshot freshness; invoke one bounded pass, monitor queue failure/hold/lease metrics, and separately approve any source collection/backfill cutover. An unchanged pending job is never silently discarded.

Production charging additionally needs actual commercial pricing, chargeable units/cycles/late usage, quota reservations, overages, tax registrations, customer provisioning and an independently approved live implementation. This candidate deliberately has no checkout, billable usage submission, invoice creation or live-charge switch.

## Verification and limits

Run `npm run check:all` after final changes. It includes Node/PGlite backend, DOM UI, funding RLS, routing, production build, existing public/bundle checks and Billing bundle checks. `npm run check:billing` is the focused equivalent. Tests use synthetic users, exact raw HMAC requests, a fake Stripe GET transport and isolated in-process PGlite; no sockets, paid provider calls, real email/phone or production writes.

Local results are recorded in the release evidence and final manifest. Hosted multi-session PostgreSQL timing, restricted-role installation, actual runtime credentials, real sandbox webhook delivery/provider acceptance, authenticated deployed journeys and browser pixels are not established by these tests. Do not call this live-ready or activated.

## Rollback

Keep the runtime disabled and stop its future scheduler before changing code. Frontend/status endpoint can be rolled back independently while retaining the private ledger. Do not delete receipts, usage, policies, projection or job history, remap customers, reset unresolved claims, or remove existing AI/phone/knowledge safety contracts. Any installed-schema rollback must be separately reviewed and preserve append-only history.

## References

Existing candidate detail: [foundation integration](billing/foundation-integration.md), [provider and worker](billing/provider-worker.md). Current security references reviewed: [Supabase database functions](https://supabase.com/docs/guides/database/functions), [Edge auth](https://supabase.com/docs/guides/functions/auth), [Supabase changelog](https://supabase.com/changelog). The relevant current changelog does not change this pinned client/RPC contract; no dependency upgrade is inferred.
