> Historical provider candidate reference. Its source-only status describes the earlier packet; see ../billing-release.md and release evidence for the current approved inactive integration.

# Read-only Stripe reader and durable reconciliation worker

Incremental candidate prepared 2026-10-09. The verified first checkpoint remains unchanged at `/workspace/shared/kairo-billing-foundation-20261009`, with backup SHA-256 `a37e46b9b6170451a760794b83d83f49f14a4252f0654ff1769cd87a7627da89`.

## What is now implemented

- `provider.mjs`: real official Stripe client calls through an injected instance, with no credential discovery, account creation, purchase or mutable API method. Supports explicitly bound API versions `2026-08-26.dahlia` and `2026-09-30.endive`. Current SDK verification uses stripe-node 23.0.0, pinned in the test dependency lockfile.
- Account identity is verified before customer/subscription reads. Connected-account calls carry the exact bound context; platform calls verify the authenticated account. Every object and graph edge checks provider mode, customer and requested identity. There is no default-account fallback.
- Complete, bounded pagination covers subscription items, invoices, invoice lines, invoice payments, charges and refunds. The reader never follows a provider-supplied URL. Duplicate rows/cursors, malformed pages and exhausted limits remain unresolved.
- Subscription payment evidence requires an authoritative paid invoice with the matching recurring item, product, price, quantity and current service period. An active subscription alone is insufficient. Proration-only evidence remains unknown rather than receiving an invented access rule.
- All associated subscription-invoice refunds are read through first-class InvoicePayment relationships. PaymentIntent and legacy direct-Charge paths are supported. Ambiguous shared payments, incomplete charge/refund inventory, unsupported payment records and disputed charges fail closed. No metadata-derived tenant/subscription mapping exists.
- Two complete reads must agree before evidence is returned. A changing graph is retried, never committed as complete. This detects observed churn but is not an atomic Stripe snapshot; receipt revision fencing and configured freshness remain required.
- Receipt resolution now handles conclusive standalone-payment graphs with an immutable `not_subscription` disposition. It does not create a Kairo customer binding or grant company access. Ambiguous graphs remain held. Normal subscription resolution still requires a separately approved existing customer binding.
- `worker.mjs`, `worker-store.mjs`, `billing-worker-contract.sql`: a durable queue, bounded one-pass runner, unique source/revision jobs, expiring claims, monotonically fenced retries and append-only job history. Projection/receipt resolution, job completion and audit commit in one transaction. Expired leases, stale source revisions and cached/future provider evidence cannot overwrite current state. Unknown customers and provider failures remain retryable without a discard-after-N policy.
- Explicit account scoping is available with `bindingId`; a deliberately configured reader Map can route multiple bindings without fallback. Refresh cadence is an explicit operational setting. No scheduled process or listener starts automatically.

## Runtime contracts

The reader is created with `createStripeProviderReader({ client, binding, enabled:false, clock, ...technicalBounds })`. `client` must be an instantiated official Stripe SDK client supplied by an approved server host. Secrets are not accepted, stored, printed or read from environment variables by these modules. Provisioning the actual SDK client from a server secret manager is a separate approved setup step.

The supported reader methods are `readSubscription(projection)` and `resolveReceipt(receipt)`. The first returns strictly bounded subject-linked evidence for the existing pure reconciler. The second returns a first-class customer/subscription link or an explicit proven standalone disposition. Both default inactive before touching the client.

The runner is `runOnce({ enabled:false, store, provider, clock, bindingId, maxJobs, leaseSeconds, refreshAfterSeconds, retryBaseSeconds, retryMaxSeconds })`. Use `new BillingWorkerStore(db)`. A single-account reader should always pass its exact binding ID. Reader and worker share the same trusted seconds clock. The worker rejects evidence fetched before its claim or before the previous reconciliation, and rejects a fetched-at time later than its trusted commit-time check.

Technical bounds are resource controls, not commercial policy. Defaults include bounded page/request counts, timeouts, a limited batch size and capped retry delay. They create no spending permission, allowance, grace, rate or refund rule. Configure refresh cadence shorter than the approved policy's snapshot age; a missing cadence does not invent recurring work, and stale entitlement snapshots deny access.

The trusted database adapter must pin a connection for READ COMMITTED transactions and enforce acquisition/query/transaction bounds. No runtime grants or credentials are included. Apply both source-only SQL contracts only through a separately approved deployment. The new worker schema must follow the foundation schema. All new tables enable RLS and deny application-role access; there is no browser or public mutation RPC.

## Read methods used

Official SDK resources only:
- accounts.retrieve; customers.retrieve
- subscriptions.retrieve; subscriptionItems.list
- invoices.retrieve/list/listLineItems
- invoicePayments.list
- paymentIntents.retrieve
- charges.retrieve/list
- refunds.retrieve/list

There is no checkout, subscription mutation, payment, refund issuance, invoice finalization, meter submission, email or account-provisioning call. The worker may only persist reconciled internal state through its injected trusted database adapter.

## Tests and remaining activation work

Tests instantiate the real pinned Stripe SDK with a synthetic Fetch transport. The transport rejects non-GET methods and any unexpected origin; it never delegates to network fetch. Ephemeral dummy authentication values exist only in test memory. End-to-end synthetic tests exercise signed webhook intake → SQL receipt → durable job → SDK graph → fenced projection → configured entitlement, including refunds and unrelated standalone payments.

PGlite verifies SQL behavior; fake pool and injected clocks verify adapter/lease failure paths. These do not establish real hosted PostgreSQL multi-connection lock timing, installed-role permissions, actual merchant account access, live webhook delivery or production provider consistency. No hosted concurrency protocol, socket test, live SQL, grant, credential entry, provider call or deployment occurred.

Code implementation does not depend on picking prices. Activation still does: merchant/account binding, server credentials, approved runtime access/TLS hosting, customer provisioning, commercial terms and tax registrations, plan features/allowances, billable unit/cycle definitions, overage rates, provider-spend ownership, grace/refund/cancellation rules and retention. No values for those decisions are supplied by this candidate. Unsupported composite plans, proration-only access evidence, payment-record refund graphs or disputed charges remain explicitly denied until their semantics are reviewed.

## Injected PostgreSQL adapter

`createBillingDatabase({ pool, enabled:false, ...technicalBounds })` implements the store's `query` and `transaction` contracts against an injected node-postgres-compatible pool. It does not import a driver, instantiate a pool, open a socket on construction, select an account, read credentials or alter network/TLS settings.

Enabled operations acquire exactly one client, start `BEGIN ISOLATION LEVEL READ COMMITTED`, set transaction-local lock, statement and idle-transaction limits, execute only the supplied internal callback and require an acknowledged COMMIT. Defaults bound acquisition to 3 seconds, each query to 6 seconds and a transaction to 15 seconds, with 5-second statement and 2-second lock limits. These are technical safety bounds, not commercial terms. Direct `query` also executes within this transaction wrapper.

Acquisition timeouts release late-arriving clients without running SQL. Query/callback timeouts close the transaction handle and discard uncertain clients. Concurrent or unawaited operations cannot run later on a recycled connection. Confirmed callback failures roll back; a failed/timed-out/malformed COMMIT reply returns `database_commit_unknown` and discards the client without claiming rollback. The next invocation must inspect the durable receipt/job/projection state; it must not assume the previous transaction failed. Error messages, SQL details and credentials are never surfaced by the adapter.

The real pool's TLS configuration, connection credentials, role privileges, max connections and service hosting remain explicitly provisioned outside this module. The host must install its own sanitized pool-level error listener for idle-pool connection failures. The adapter owns error/end handling only while a client is checked out; connection failure closes the transaction without recycling that client. Fake-pool tests validate adapter ordering and failure behavior. They do not prove network, backend cancellation or hosted concurrency behavior.
