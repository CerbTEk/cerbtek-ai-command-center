# Kairo deployed billing RPC source snapshot

Source-only snapshot dated 2026-10-10 for Supabase project `suohuogalotxhsnkumvy`.

This directory preserves recovered, byte-verified deployed Edge Function source. It is not an original migration history or a reconstructed SQL migration. It contains no database exports, row data, operational reports, deployment requests, credential values, or private execution evidence. Environment-variable names are source references; test tokens and keys are explicitly synthetic fixtures.

## Deployed OFF versions and provenance

- `billing-worker`: deployed version **7**, `verify_jwt=true`, hard-OFF. The runtime verifies the fixed operator through fresh Supabase Auth and confirms current owner membership through the fixed QA company's authorized status RPC on each enabled worker request. Exact-origin CORS supports the existing Kairo app. The worker remains empty-POST-only, fixed-scope, and limited to one job per invocation.
- `billing-webhook`: deployed version **5**, `verify_jwt=false`, hard-OFF. Authentication remains verified raw-body Stripe signature validation. The recovered nine-file webhook source is unchanged.
- Both entrypoints override every `_ENABLED` lookup to the literal string `false`. Committing this directory does not activate either function, install SQL, change grants, publish frontend changes, or create provider objects.

The recorded immutable deployed **EZBR bundle** SHA-256 values are:

| Function/version | Deployed bundle SHA-256 |
| --- | --- |
| billing-worker v7 | `aff9848f0863c730f88a39c8a8083d7732b1ee4598827cf2c2fb769f902dc72e` |
| billing-webhook v5 | `8efb942114ef97e393517e7783e120202f618cf03c86cb4bdbe9b6bd17a97e0f` |

These identify the deployed bundle artifacts, not an archive generated from this repository directory. Worker v7 source was byte-verified against the deployed bundle on 2026-10-10 at 23:13:30 UTC. Webhook v5 was recovered from its deployed bundle and verified unchanged during the same deployment review. Original archived candidate and rollback sources are preserved separately and are not replaced by this additive snapshot.

## Layout and local tests

Each function retains its own original nine-file relative layout under `backend/billing-worker` and `backend/billing-webhook`. No source files have been merged across the independent bundles.

From this directory, use Node.js 22 or newer and run:

```sh
npm install --ignore-scripts
npm test
```

The portable package pins `@supabase/supabase-js` to `2.58.0`. The two focused test files exercise exact-origin CORS, inactive guards, fresh identity/current-owner checks, denial and revocation handling, fixed request scope, and the pinned SDK with synthetic in-memory fetch. Tests do not use real credentials, invoke deployed workers, contact Stripe, or activate billing. The reviewed source passed 52 focused tests before snapshot publication.

## Source integrity

SHA-256 below covers exact bytes of each preserved source/test/package file. The README is descriptive provenance added for this snapshot.

| Relative path | SHA-256 |
| --- | --- |
| `backend/billing-webhook/billing/core.mjs` | `55c9ab382691bb5f7ade06b08f29552f2d7cc060838d16a792589a11cb7e6045` |
| `backend/billing-webhook/billing/provider.mjs` | `29cb11478e4c110959597f67d544824728197c200ab262593c4a829cdb6a40af` |
| `backend/billing-webhook/billing/rpc-client.ts` | `de772afc63a5b69a223d149d42f6fa264b8dd5b5844d3fdae2fd230f423b086c` |
| `backend/billing-webhook/billing/rpc-edge-host.mjs` | `0ecb71aa144b4f544a7798dbdd9c3b6ab939481440a77903cee713841e1e78bc` |
| `backend/billing-webhook/billing/rpc-store.mjs` | `42f0dfb48632ea0cf6e76201e87e0a937c288b1a77b1d768305605f6b67bdc67` |
| `backend/billing-webhook/billing/sandbox-scope.mjs` | `896645e726c1412c0d4e795e4cd73b85af2e15a96e15d45b797c4dc4eaf67eff` |
| `backend/billing-webhook/billing/transport.mjs` | `34392c51b8bbbc3b2a33d4e76f8c8c19843dd130ba21ab9d34bbc7f68a07244a` |
| `backend/billing-webhook/billing/worker.mjs` | `192a3affa2e23899ae714a6aca0c05d4669f1d0f707061fc95fea63d689fc262` |
| `backend/billing-webhook/billing-webhook/index.ts` | `efd2604dc9156e946896db8284845c05991c22311dc7b2077ac2c24a7e70dbe6` |
| `backend/billing-worker/billing/core.mjs` | `55c9ab382691bb5f7ade06b08f29552f2d7cc060838d16a792589a11cb7e6045` |
| `backend/billing-worker/billing/provider.mjs` | `29cb11478e4c110959597f67d544824728197c200ab262593c4a829cdb6a40af` |
| `backend/billing-worker/billing/rpc-client.ts` | `de772afc63a5b69a223d149d42f6fa264b8dd5b5844d3fdae2fd230f423b086c` |
| `backend/billing-worker/billing/rpc-edge-host.mjs` | `5687b318e29dff6480ea576f1e07a7b10240e9494dbf9691b7b4a2838d1d00e0` |
| `backend/billing-worker/billing/rpc-store.mjs` | `42f0dfb48632ea0cf6e76201e87e0a937c288b1a77b1d768305605f6b67bdc67` |
| `backend/billing-worker/billing/sandbox-scope.mjs` | `896645e726c1412c0d4e795e4cd73b85af2e15a96e15d45b797c4dc4eaf67eff` |
| `backend/billing-worker/billing/transport.mjs` | `34392c51b8bbbc3b2a33d4e76f8c8c19843dd130ba21ab9d34bbc7f68a07244a` |
| `backend/billing-worker/billing/worker.mjs` | `192a3affa2e23899ae714a6aca0c05d4669f1d0f707061fc95fea63d689fc262` |
| `backend/billing-worker/billing-worker/index.ts` | `6cf0e78c08dbf93bc83f2ae619909373efa1ace4eb57aa34036babb975c92431` |
| `package.json` | `0c1233130a00d59e47f93789cf4adadcb43995e5a623fe45a78d0b6bb0d1da22` |
| `tests/worker-cors.test.mjs` | `6a0a846a6703abf6b518d6150e9fbc6f85b0900618fb97cf7e5b00ab97f2e2dd` |
| `tests/worker-owner.test.mjs` | `eee0d85f7da74bf4d945a03979bd0dba3a606d58c7fb3d7f8322b0d060d99ff0` |
