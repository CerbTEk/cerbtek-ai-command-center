# Customer operational reporting: reviewed frontend candidate

Baseline: deployed `33a1e82f7eb4b38e7b701184562e53e926c9d3e4`. This candidate is independent of the pending activation-control candidate. No backend, SQL, credential, membership, security grant, inference gate, provider account or live data changes are included.

## What users get

- AI Ops has separate **Automation runs** and **Customer requests** views. Customer records are not joined to generic automation runs by timestamp, name, provider or model.
- Customer reporting shows the latest loaded request sample, saved workflow state, assignment, email evidence, input/output token facts, usage coverage and per-model groupings.
- The read-only request detail shows saved milestone timestamps, the current explicitly bound AI request, model/configuration identity, token usage, reservation allowance, action status, receipt phase and immutable source references.
- Customer Follow-up includes the same request-history/evidence component alongside its existing action controls. Those action controls are unchanged.
- Refresh, date filters, subject search, outcome filters, explicit sample-limit notices, URL selection, Back/Forward and close-focus restoration are included. A repeated click on the active report tab is a no-op.

## Existing API and permission boundary

Only `customer-workflow` with `{ operation: 'load', organization_id }` is called by the new report. The endpoint verifies the user JWT and derives the actor server-side. Its existing `customer_workflow_load` function verifies current organization membership and returns at most 100 newest visible requests. Employees (`member`) see assigned requests only. Owners, admins, consultants and viewers retain the endpoint's existing company visibility. Staff status alone grants no additional visibility.

The frontend verifies the envelope, organization, actor, contract, request uniqueness, nested AI/action/context bindings, knowledge source validity, sample bound and employee assignment. Old responses are discarded after company/account changes, refresh or unmount. Read failure removes prior reporting data and shows unavailable counts. Expired knowledge reference metadata is hidden at render time; revalidation failure is handled without an uncaught render error.

No direct browser access to AI-run or receipt tables is added. No new endpoint, RPC, table, policy or grant is required. All source-only SQL files in the repository remain unchanged.

## Measurement definitions

- A linked AI run requires the existing exact organization, request key, configuration and requester bindings. Its historical provider/model comes from the bound immutable configuration, never current account setup.
- Input and output tokens preserve known zero. Missing or malformed values are not counted as zero. The report shows recorded coverage for each measure and does not extrapolate a company total.
- `reserved_microusd` is shown in its recorded micro-USD unit as a saved admission-control allowance. It is not actual spend, invoice cost or remaining balance. No provider prices, currency conversions, satisfaction scores or business ROI are calculated.
- Measured spend is **Not recorded** because the current contract contains no measured/invoiced cost field.
- Microsoft acceptance comes from the explicitly linked receipt or executed action. It is distinct from approval, delivery, reading and business resolution. A known receipt can resolve uncertainty in an older action status; conflicting not-sent/accepted records remain attention items.
- Cancelled requests with no dispatch receipt are not presented as awaiting new approval. Historical action status remains visible in facts. A pre-dispatch `ConfirmedNotSent` receipt with no dispatch timestamp does not create a fictitious dispatch milestone.
- The AI interval is reservation-to-recorded-result elapsed time. It is not provider/model latency.
- Timeline entries use existing stored timestamps only. Undated records are shown separately. No fabricated timestamps or inferred milestones are supplied.

## Important data limits

This is the current linked-record history, not a complete audit log. The endpoint returns only the current AI attempt for each request. Earlier draft attempts and assignment changes are not returned. Requests are capped at 100 before client-side creation-date filtering, so a selected date window may still be incomplete. Counts describe the loaded sample. Delivery and business resolution are not captured by this contract.

A complete historical attempt view cannot be built safely from the current endpoint or inferred from same-tenant AI runs. A future bounded server projection would first need a durable explicit workflow-to-attempt association. No such relation is added here. Any proposal should preserve employee-assignment visibility, derive actor identity at the authenticated Edge boundary, return only tenant-bound allowlisted fields, deny anonymous/authenticated direct table access, and grant only service-role SELECT on the exact new association plus execution of its narrow read function. Recording that association or adding resolution/delivery evidence would be a separately reviewed schema/write change. Existing historical rows must not be backfilled using similarity or time-based guesses.

## Validation and release handling

Run `npm run check:reporting` for focused UI/model, production build and read-only/bundle/style assertions. `npm run test:ui` covers the full UI suite. `check:all` now includes the reporting bundle check.

This environment has an existing explicitly excluded backend test: `manual AI request cannot hijack bound key; changed context blocks admission after input read`. The final backend command uses the same named exclusion as the prior release. No hosted concurrent-session or socket/protocol test is claimed. See the candidate evidence packet for exact final counts.

No authenticated hosted acceptance, actual provider call, real email, browser-rendered pixel check or mobile screenshot was performed. Responsive CSS, text contrast, focus and interrupted/repeated flows have synthetic coverage. Deployment is not performed by this candidate.

Publish only the scoped manifest files after parent coordination. Overlap with the pending activation candidate is limited to `src/CustomerReplyWorkspace.jsx`, package scripts and documentation; preserve that candidate's independent activation edits. `src/main.jsx` is unchanged. Rollback restores the scoped frontend files to the baseline; no database rollback is needed.
