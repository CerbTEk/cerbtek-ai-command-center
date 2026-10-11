# Employee drafting source-only review snapshot

This folder is an overlay for main commit `8f6c3b2fd85f0b8bebd2b0d96182af69d4e54209`. It is deliberately nested under `review-candidates/employee-drafting-20261011` in the review branch. The repository's runnable root source is unchanged; this branch is not the app release.

Review `docs/employee-drafting-candidate.md` and `backend/docs/employee-drafting-source-review.md` for the design, exact permission surface and validation limits. `candidate-manifest.json` records per-file SHA-256 values.

To verify locally, overlay the listed source/test files onto a separate checkout at the pinned baseline; do not copy them into an active deployment before the approved rollout. Install the pinned lockfile's dependencies in that separate environment, then run:

- `node --test --test-concurrency=1 backend/tests/employee-drafting-sql.test.mjs backend/tests/employee-drafting-runtime.test.mjs`
- `npm exec vitest run -- --config vitest.all.config.js tests/customer-reply.test.jsx tests/workflow-installations.test.jsx tests/customer-setup.test.jsx tests/ai-activation-readiness.test.jsx`
- `npm run build`

The SQL is a review candidate only. Running it against a deployed project changes the permitted actor scope for assigned installed-workflow drafting and requires the separate deployment authorization. Saving or reviewing this snapshot does not activate inference or authorize a paid model call.
