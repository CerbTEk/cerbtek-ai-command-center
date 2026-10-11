# Company email OAuth candidate

Reviewed source, October 11, 2026. Hosted SQL/Edge deployment was subsequently authorized; see the release review and deployment receipt. No provider credentials, grants, mailbox reads or external sends were performed by this release. Synthetic provider responses and PGlite tests are not evidence that a real Google/Microsoft app is registered, verified or configured.

## Deployment prerequisites

1. Verify the already-deployed OAuth setup/refresh contracts and their function signatures. On an empty synthetic/staging database install those dependencies first; do not rerun their non-idempotent DDL against production. The production candidate adds `company-email-oauth-contract.sql`, followed by the separately reviewed `company-email-workflow-contract.sql`. The named live `oauth_connections_provider_check` is verified before widening only from Microsoft to Microsoft/Google. Missing or unexpected definitions stop the migration. Existing status checks remain unchanged, and disconnect writes `Disabled`. Existing encrypted Vault wrappers (`edge_store_secret`, `edge_read_secret`, `edge_update_secret`) must be service-only, available, transactional, and support clearing a value to the empty string. Read-only production inspection confirmed wrapper signatures and service-only ACLs; real encrypted Vault write/clear behavior remains a required approved staging check before live provider use. `edge_update_secret(uuid,text)` has the production `void` return contract; exact read-backs establish durable success. Secret deletion privileges are not introduced.
2. Configure CerbTek-owned confidential applications and server-only environment variables:
   - `KAIRO_MICROSOFT_CLIENT_ID`, `KAIRO_MICROSOFT_CLIENT_SECRET`; optional `KAIRO_MICROSOFT_TENANT_ID`, default `organizations`.
   - `KAIRO_GOOGLE_CLIENT_ID`, `KAIRO_GOOGLE_CLIENT_SECRET`.
   - Existing Supabase URL/service credentials stay server-only.
3. Register exact provider callbacks: `{SUPABASE_URL}/functions/v1/microsoft-oauth-callback` and `{SUPABASE_URL}/functions/v1/google-oauth-callback`. Callbacks are public GET endpoints authenticated by single-use state; disable gateway JWT checking only for these callbacks. Start/list/finalize/disconnect authenticate the actual user JWT inside the handler.
4. The separately authorized `company-email-cleanup-schedule.sql` installs `public.cleanup_expired_company_email_oauth_setups(100)` every five minutes with bounded 30-second statement/2-second lock timeouts. It verifies the local postgres target and refuses duplicate or mismatched existing jobs. Monitor run failures and backlog; any additional draining remains bounded. Installation metadata was verified; scheduled execution evidence is recorded in the release receipt. Live-token tombstone read-backs still require approved provider staging acceptance.
5. Google Gmail API must be enabled and the application consent/verification process completed as applicable. `gmail.readonly` is restricted; storage/transmission can require an independent security assessment. Google Workspace administrators may block or require app access approval. Microsoft business tenants can require administrator consent even when delegated permissions are supported. Those setup/consent steps remain separate actions.
6. End-to-end staging test with approved real test accounts is still required, including consent denial, partial consent, enterprise restrictions, reconnect, expiry, callback browser binding, refresh and cleanup. No production account is connected by the source or tests.

## User/API contract

- One signed-in provider account per provider per company. Current company owner/admin/consultant membership can manage the company binding. Other company members can read sanitized status. Global staff alone cannot connect a company.
- POST `microsoft-connect` or `google-connect`: `{organization_id,intent,browser_challenge,connection_id?,expected_revision?}`. Intent is exactly `read`, `send` or `read_send`; there is no default permission. Browser challenge is lowercase hex SHA-256 of a separately generated 32-byte random base64url verifier retained in sessionStorage. Reconnect requires the existing UUID and exact revision.
- Customer-supplied client ID, client secret, tenant, raw scopes, mailbox address, actor ID and return URL are rejected.
- Connect responds with `{authorize_url,connection_id,redirect_uri}`. `redirect_uri` is the Supabase callback, not the app page. Browser stores its proof bound to original company, actor, provider and state before leaving.
- The callback verifies the provider grant and identity, stores encrypted token references in a private unusable staging record, and returns to the allowlisted canonical app `https://www.cerbtek.com/app/kairo`. The query is `?google=consent_returned` or Microsoft equivalent; fragment fields are `email_oauth_state`, `email_oauth_provider`, `email_oauth_completion`. No application `Connected` state is established yet.
- The completion secret is independently generated by the callback, never appears in the provider URL or list/start responses, and is stored only as a hash server-side. The app consumes and strips this fragment before Supabase initialization and checks the stored original browser/actor/company proof.
- POST `company-email-connections` with `{organization_id,action:'finalize',state,browser_verifier,completion_secret}`. Authenticated original actor, both proofs, unchanged company authority, and unexpired staging are required. Returns `{ok:true,connected:true,organization_id,provider,connection_id,state}` only after atomic commit. It is single-use; unknown responses must not be automatically retried.
- List: `{organization_id,action:'list'}`. Returns `ok`, `contract_version:1`, `organization_id`, `can_manage`, configured booleans per provider and explicit sanitized connection fields: `id`, `integration_id`, `provider`, `status`, `account_email`, `account_name`, actual `scopes`, `capabilities.mail_read/mail_send`, `connected_by`, `is_own_connection`, `oauth_revision`. No credentials, Vault IDs, state/proofs, client ID or refresh metadata are returned. `configured` checks the presence/shape of server app settings; it does not claim provider verification or functioning credentials.
- Disconnect: `{organization_id,action:'disconnect',connection_id,expected_revision}`. All current company managers may explicitly disconnect/replace the company binding. It sets the existing `Disabled` status, erases stored credential bytes, clears live/staged references, invalidates pending callbacks and rotates authority. It does not revoke the provider's overall app consent. Provider revocation can affect other companies/accounts under the same app and must be handled separately.

## Permissions, identity and invalidation

Microsoft requests `openid profile offline_access User.Read` plus only the explicit `Mail.Read`/`Mail.Send` intents. The default `organizations` endpoint supports work/school accounts where the app registration allows them; personal Microsoft accounts, application permissions and shared-mailbox impersonation are not claimed.

Google requests `openid email profile` plus only `https://www.googleapis.com/auth/gmail.readonly` and/or `https://www.googleapis.com/auth/gmail.send`. It deliberately sets `include_granted_scopes=false`. Provider-returned grants are mandatory and compared exactly after documented identity-scope alias normalization. Missing, expanded or narrowed scopes fail closed. A Gmail label only limits Kairo's intake selection; it does not narrow provider consent. Send-only does not acquire read permission or call Gmail getProfile, which does not accept `gmail.send` by itself.

Identity comes from fixed authenticated provider APIs: Microsoft Graph `/me`, Google OpenID userinfo with `email_verified=true`. Google `external_account_id` is immutable `sub`; `external_account_email` is the verified email, protected in the Google approval fingerprint. No caller mailbox override, service-account impersonation or shared-mailbox delegation is supported.

State is provider, company, actor, connection and integration-revision bound, expires after ten minutes and is claimed once before code exchange. Staging must be finalized within five minutes and within the original expiry. Sharing the provider authorization URL cannot complete the connection: the initiator does not receive the callback-only completion secret, and the other browser lacks the initiating verifier.

Reconnect immediately invalidates the previous grant even if the new consent is denied. Disconnect/reconnect/failed current setup atomically tombstone affected current and staged Vault secret values and verify the resulting empty value before reporting success. Orphaned expired staging is cleared by the required periodic cleanup. No provider revocation call is made automatically.

Refresh revalidates current authority, account identity, actual grants and immutable fingerprint, then commits with a compare-and-swap refresh revision. A losing refresh cannot return an uncommitted token. Refresh cannot resurrect a disconnected/replaced account or widen permissions. New bindings require the connecting manager to remain an authorized company manager; listing presents `Reconnect Required` and false capabilities after that authority changes. Legacy Microsoft fingerprints remain byte-shape-compatible.

## Verification

- `node --test backend/tests/oauth-routes.test.mjs` preserves 41 existing route/helper/execute assertions, updating only the deliberate onboarding contract.
- `node --test backend/tests/company-email-oauth-routes.test.mjs` exercises real TypeScript handlers with synthetic providers, strict request shape, narrow scopes, no inferred grant, fixed returns, the two-proof finalize API, sanitized projections, bounded provider JSON and refresh races.
- `node --test --test-concurrency=1 backend/tests/company-email-oauth-sql.test.mjs` executes the real legacy and new contracts in PGlite with SELECT-only membership access. It tests state lifecycle, actor/company boundaries, staging, both proofs, expiry/replay, disconnect/reconnect, live authority, grants, refresh CAS, ACLs, guarded fields, physical secret tombstones/rollback, and expired cleanup. Its synthetic Vault wrapper is a test double; production Vault encryption is an existing deployment dependency, not emulated encryption evidence.

## Sources checked

- [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Gmail API scopes and verification](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Gmail getProfile accepted scopes](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile)
- [Microsoft authorization-code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
- [Microsoft consent](https://learn.microsoft.com/en-us/entra/identity-platform/permissions-consent-overview)
- [Supabase server data security](https://supabase.com/docs/guides/database/secure-data)
- [Supabase changelog](https://supabase.com/changelog)
