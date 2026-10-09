> Historical provider candidate reference. Its source-only status describes the earlier packet; see ../billing-release.md and release evidence for the current approved inactive integration.

# Integration packet

## Current state and what changed

All additions live in this separate packet. The frozen connected customer follow-up/Company Knowledge repository was read, not edited. Existing AI provider reservations remain separate from customer usage and charges. No old prototype billing/membership model was copied, no unrelated Stripe account was selected, and no customer/payment/provider mutation occurred.

Integrate all 18 billing paths listed in MANIFEST.json through a future approved source integration. The complete new-path patch is billing-provider-full-integration.patch; the incremental patch against the verified first billing checkpoint is billing-provider-incremental.patch. Additional files supply the read-only provider, database adapter, durable worker, worker schema, SDK fixtures and regression tests. The original foundation paths are:

- `backend/candidate/edge/billing/core.mjs`
- `backend/candidate/edge/billing/store.mjs`
- `backend/candidate/edge/billing/transport.mjs`
- `backend/candidate/sql/billing-foundation-contract.sql`
- `backend/tests/billing-core.test.mjs`
- `backend/tests/billing-store.test.mjs`
- `backend/tests/billing-transport.test.mjs`
- `backend/tests/fixtures/billing-fixtures.mjs`

Keep the packet's standalone package manifest separate from the application's package manifest. The existing Kairo backend wildcard test script discovers the new billing test files without changing application source. The app integration adds only the pinned stripe 23.0.0 development/test dependency; do not replace the app manifest with the standalone manifest. The packet adds no frontend screen, payment link or purchase button, and makes no change to existing AI/phone admission gates.

## Provider event flow

1. A separately approved host injects the correct endpoint signing secret through its server-side secret manager and an independently verified binding `{id, account_id, account_kind, livemode, api_version}`. The JSON example contains no account, secret, prices or active policy. For platform events Stripe omits the account field, so the secret-to-account setup is the authority; connected events must have the exact signed account. No automatic account discovery or fallback exists.
2. Only enable the Fetch handler after transport/account/security approval. Read exact incoming bytes; body parsing middleware must not run first. The candidate enforces POST, JSON MIME, a 256-KiB stream limit, a two-second body deadline, timestamp freshness and HMAC verification. Signature mismatch cannot reach persistence. Host TLS, request rate limits and Stripe IP restrictions remain deployment work.
3. `BillingStore` requires a trusted database adapter providing `query` and `transaction(fn)`. A production adapter must pin a connection with BEGIN/COMMIT/ROLLBACK, READ COMMITTED, lock/statement deadlines and private restricted database credentials. This packet supplies no credentials, grants or active production pool. PGlite implements the interface for SQL tests; the injected pool adapter is documented in PROVIDER-WORKER.md.
4. In one transaction, lock the provider-binding row, record a new event receipt, resolve only an existing first-class customer mapping and invalidate the affected subscription projection. A duplicate event ID with the same raw hash is acknowledged without any second projection mutation. A different payload under an existing ID is a conflict. Distinct event IDs for the same Stripe object do not create duplicate customer usage or charges.
5. Webhook snapshots never grant entitlement. Any new subscription/invoice lifecycle event requires fresh reconciliation, including out-of-order and same-second events. Event timestamps are retained for audit, never treated as a total-order version. Cancellation is a permanent tombstone for that subscription ID; a newly purchased subscription needs a new identity.
6. The implemented, inactive read-only provider adapter retrieves the current full subscription, its paid invoice evidence and all applicable refund/charge/invoice links. Begin the fetch only after reading the projection revision; compare-and-swap that revision when persisting, and retry retrieval if another receipt arrived. Return explicit binding/account/mode/customer/subscription identity with payment and refund evidence. Never use metadata as company authority. `refund_graph_complete` is a trusted-adapter assertion, not browser input. The implementation is in provider.mjs and remains inactive. See PROVIDER-WORKER.md for its supported official interfaces and strict evidence limits.
7. Stripe's Dahlia invoice `parent.subscription_details.subscription` is recognized. An explicit `parent:null` standalone invoice is safely ignored for subscription access. Missing/ambiguous invoice lineage remains unresolved. Refunds use an independently resolved charge → invoice → subscription graph. Unresolved refunds without a customer conservatively hold the binding's subscription access until resolved; customer-known unresolved events hold only that customer. Multiple-subscription or otherwise ambiguous graph results must remain held rather than guessed. Receipt resolution is immutable and cannot remap a company.
8. Return 2xx only after the receipt transaction commits. The stored normalized receipt is the durable work queue. Unknown customer/graph receipts are retained for operations review. Reconciliation failures must not be marked resolved or restore access. The durable bounded worker/queue is implemented with default inactivity; scheduling/hosting and operations monitoring still require approved runtime setup.

## Entitlement policy and history

Policy versions are explicitly approved, immutable JSON with content hashes. No production policy is seeded. Synthetic test values are examples chosen solely to exercise branches; they are not proposed product terms. Required policy fields cover exact account/price/product/quantity, feature list, allowed subscription statuses, paid-invoice requirement, freshness, effective dates, grace, refund access and provider-spend owner. `provider_spend_owner: "unconfigured"` denies execution.

The pure evaluator is a commercial gate only. It grants no organization role, sends no email, starts no call and invokes no model. The existing fresh membership checks, human approvals, resource scopes, provider-spend reservations and hard inference/phone gates remain independently required. A billing failure never grants history to a nonmember and never deletes historical records.

Refund options are explicit `suspend_any`, `suspend_full`, or `no_access_change`; pending/requires-action refunds remain unresolved. Full refunds sum successful partial refunds by charge, with matching currency and charge totals. Policies currently evaluate all reconciled refunds associated with that subscription; other refund/time-window scope requires a separately versioned contract. Canceled and incomplete-expired subscriptions cannot resurrect. Trial/grace/cancellation boundaries use explicit inclusive-start/exclusive-end timestamps; grace never extends a scheduled cancellation or trial end.

`evaluateMeter` accepts explicitly supplied integer usage and an explicit blocked/limited/unlimited meter rule. It is a policy calculation, not an atomic admission reservation or billing-cycle allocator. Overage can block or be recorded as unpriced. All charge outputs stay null. A caller must not use an unreserved lifetime total as a live allowance check.

## Usage lineage

- AI: `public.ai_draft_runs.id`, scoped to its real `organization_id`. Records actual persisted `usage.input_tokens` and `usage.output_tokens` for terminal/observable outcomes. Missing or untrustworthy usage is unknown. Existing `reserved_microusd` is a conservative provider-spend reservation and is never treated as a customer charge or actual provider invoice.
- Workflow: `public.workflow_runs.id` and `organization_id`. Counts a persisted workflow run as an observation of a run, not proof of a chargeable successful task. Start time comes from `started_at`.
- Phone: `kairo_phone_intake.calls.id` and `organization_id`. There is no workflow-run link in the current phone contract. Parent, child and dial-result `duration` values are preserved as three distinct terminal callback observations in seconds. They are never summed, rounded into billed minutes, treated as proof of human answer or given a price. The phone runtime can permanently retain null duration when its first terminal callback lacked it; that remains unknown and requires separate authorized provider reconciliation.

The adapter reloads the source under a transaction lock and SQL rechecks tenant, metric, unit, state, amount and event time. No client-supplied quantity is accepted. Replays return the existing observation ID. Unknown → measured appends a new history row; a changed known measurement conflicts and requires a future reviewed correction/reversal contract. The source start timestamp is normalized to millisecond precision, including PostgreSQL's finer timestamps; collection time is separate. Source deletion/retention policies and permanent source FK integration must be reviewed with the wider schema before live use.

Totals explicitly say `lifetime_observations_only`. Subscription-cycle allocation, late-arrival handling, chargeable-unit definitions, currency/rounding/rating, quota reservations, backfill cutovers, invoice generation and refund/usage adjustments are intentionally not inferred. Select a provider billing implementation only after commercial decisions; current Stripe guidance recommends Metronome for new usage-based billing, but no Metronome account, meter, contract or integration is created here.

## Decisions required before activation

- Correct merchant account, test sandbox versus live mode, API version, webhook secret/rotation and dedicated endpoint
- Products and prices, currency, monthly/annual terms, setup fee and when earned/charged
- Plan feature entitlements and explicit included usage for each metric
- Which AI/run/phone observations are chargeable; phone leg rules, increments and rounding
- Allowance window, atomic admission/reservations, late usage, backfills, overage policy and rates
- Who pays provider costs: customer-owned accounts or CerbTEK, with separate provider-spend enforcement
- Paid/trial/failed-payment/grace/cancellation policy; refunds' access effect and scope
- Tax nexus/registrations and collection policy; do not enable automatic tax without applicable registrations
- Customer binding/provisioning approval, restricted database access, retention and audit/read roles
- Hosting, TLS/IP restrictions, body/rate limits, durable queue/reconciliation monitoring and incident handling

## Verification boundaries and publication

Local synthetic tests exercise actual candidate SQL in fresh PGlite databases, raw HMAC signatures, HTTP Request/Response adapters and the store's transaction interface. They do not prove hosted multi-session lock timing, a real Postgres pool, production role grants, Stripe account binding, live webhook delivery, real-provider reconciliation, payment settlement, real calls or customer data behavior. No sockets, blocked project/test workaround, live SQL/grants, provider API calls, account creation, webhook configuration, publication or deployment were used.

Before production: review exact SQL and grants, configure/review the implemented trusted provider reader and durable worker, decide commercial policies, run authorized account-bound sandbox acceptance, prove hosted concurrency and same-transaction authorization, then separately approve source publication/deployment/activation. Preserve unrelated pending customer/knowledge/phone changes and immutable history throughout rollback. Runtime deactivation should stop new commercial actions while retaining authenticated history and later receipt reconciliation.
