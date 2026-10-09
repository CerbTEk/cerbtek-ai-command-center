# Guided customer setup release

## Scope

Frontend-only journey for the deployed, manually initiated customer-reply use case. Adds Customer Setup to the app sidebar, overview, help, and legacy root-link forwarding. Stages cover the intended outcome, current saved readiness, direct links to existing configuration screens, read-only validation, and activation requirements.

No database, Edge Function, authorization, credential, OAuth, membership, pricing, inference gate, phone, or billing changes. This candidate starts from deployed commit a08cb1de3c9de7eb4faef4ad4c273ba2b761f984.

## Data and truth boundaries

- The guide invokes only customer-workflow `load` and Company Knowledge `access` / `list`. These read saved records without model discovery, provider inference or Microsoft send calls.
- Every response uses the existing authenticated tenant/actor envelope. The guide validates the customer workflow contract, readiness flag types, saved record consistency and people. Company Knowledge list items are tenant-bound by their top-level envelope; the deployed projection does not include an organization ID on every item.
- Company reply guidance and the customer-reply model are reported as saved configuration. They are never described as a working provider connection.
- Microsoft readiness requires the existing server-side verified connection predicate. It does not establish current Microsoft availability or a successful live test.
- A separately recorded authorized reviewer is a setup prerequisite, while request-specific independence is still checked in Customer Follow-up.
- Optional source counts include only visible, published, current, company-wide documents. No private text or source body is rendered by the guide. Every excerpt must still be explicitly selected and reviewed in the customer workflow.
- No activation result is inferred. The current customer-workflow contract reports live inference disabled. Even a future true flag does not attest the deployed AI gate, credentials, model discovery, approved pricing, or successful provider acceptance.
- Existing visible history is bounded by the API and the user's role. A historical Microsoft acceptance does not establish delivery or overall activation.

## Resume, interruption and accessibility

Reopening the section reconstructs progress from saved records; there is no independently persisted checklist or duplicate setup record. Refresh clears old readiness first. Failed reads remain unconfirmed. Repeated clicks cannot start duplicate in-flight checks. Cancellation and unmount abort pending requests and invalidate their generations. A company or account switch remounts the whole guide before any previous snapshot can paint. A later role disagreement invalidates the snapshot. Token refresh for the same account does not discard the guide.

Existing section-navigation history, company query parameters, focus management, and customer/knowledge dirty guards are preserved. Links permit normal modified-click behavior. The guide uses semantic headings, status/alert messages, native links and buttons, visible keyboard focus, wrapping layouts, a narrow-screen CSS rule, and 44 px action targets. Dark-theme foreground/background pairs meet 4.5:1 normal-text contrast by offline calculation.

## Verification

Run `npm run check:setup` for focused model/DOM/app integration, production build, and static/bundle/contrast checks. The aggregate UI suite also includes these tests. The existing backend regression suite is unchanged by this frontend release. The release packet records exact commands, the excluded pre-existing stale-key test, and results.

Local DOM coverage includes read-only endpoints, each false-readiness state, optional source eligibility, malformed/cross-company/cross-actor responses, role drift, duplicate reads, cancellation, late results, retries, section dismissal, company/account changes, token refresh, sign-out, root and app bookmarks, browser Back, native links and narrow DOM.

Unperformed: authenticated hosted acceptance, live-provider responses or Microsoft sends, pixel/mobile-browser QA, hosted simultaneous-session timing, and deployed public byte comparisons. No database or provider test is required to publish this UI-only candidate.

## Publication and rollback

Parent release coordination owns publication. Compare the scoped manifest against remote main before updating it; preserve all unrelated changes. Deploy only the frontend/source files listed in the packet. The backend and its disabled inference gate remain as deployed. Rollback consists of restoring these frontend files to the prior deployed commit, with no data or schema rollback.
