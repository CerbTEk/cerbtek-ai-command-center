# Gmail intake and approved-send source review

Date: 2026-10-11. Source candidate only; no live mailbox reads, sends, credential access, OAuth grants, deployment, or production SQL execution occurred for this change.

## Implemented boundary

- `mailbox-intake/handler.mjs` returns contract version 2. Provider selection is derived exclusively from `mailbox_intake_authorize`'s frozen `provider`, matched to the organization-scoped OAuth connection. Request bodies cannot supply provider, token, mailbox identity, URL, or message text.
- Google connections use immutable Google `sub` as `external_account_id`, verified `external_account_email`, and exact `gmail.readonly` for intake. Google OIDC `userinfo` and Gmail `profile` must agree with the database identity. Sender headers do not establish sender authenticity or authority.
- Google labels use the existing folder-shaped contract. Discovery exposes at most 50 allowed labels; exact selection must still be in the current bounded choices and match a direct label read. Gmail labels.list has no page-size or pagination parameter, so the response is limited to 256 KiB, allowed choices are sorted by ID, the first 50 are exposed, and `has_more` reports additional choices. SENT, DRAFT, SPAM, TRASH, CHAT and unsupported system labels are excluded.
- Preview lists and reads at most 10 messages from that selected label, never follows page-token URLs, and checks detail IDs, thread IDs and current label membership. Drafts, sent messages and known own-mailbox senders are excluded. It reauthorizes before every request and before returning/capturing the snapshot.
- No attachment endpoint, external URL, rendering engine or HTML execution is used. MIME extraction has depth 8, 64 parts, 64 KiB decoded text and 6,000-character intake bounds. Plain text is preferred over a lossy inert HTML fallback. Attachments and attached messages are flagged and ignored.
- Parsing rejects ambiguous/duplicate routing headers, changed Reply-To/Sender addresses, header control injections, invalid IDs, malformed base64url, unsupported charsets, missing usable text and oversized fields. This intentionally accepts a conservative subset of valid Internet mail; skipped items are counted rather than silently changing recipients or truncating text.

## Shared approved-send contract

`createGmailSendProvider({fetchImpl, authorize, getAccessToken, beforeDispatch}).send({recipient, subject, body})`

The fresh, server-only `authorize()` result must contain:

- `connection`: verified Google connection, including immutable ID, verified email and exact `gmail.send` scope
- `mailbox_id`: the same immutable Google subject
- `account_email`: the connection's verified email
- `approved_binding`: nonempty durable server approval identity/binding
- `payload`: exactly `{recipient, subject, body}` matching the approved input

The helper freezes stable grant/account/credential-slot fields and the exact approval/payload, verifies live OIDC identity, reauthorizes, invokes required `beforeDispatch()` once to record the durable dispatch receipt, then starts one fixed Gmail send POST. The caller owns approval, claim, idempotency and completion persistence. The receipt callback must throw if durable recording is unsuccessful.

`constructMime({from, recipient, subject, body})` builds one-recipient text/plain mail. UTF-8 subject encoded-words are bounded and folded; the exact UTF-8 body is base64 encoded. Extra fields, CC, BCC, attachments, caller sender substitution and subject/address header injection are rejected.

- Valid HTTP 200 with bounded valid message/thread IDs: `{outcome:'accepted', provider_message_id, provider_thread_id}`. This means provider acceptance, not proof of delivery.
- Any failure after starting POST: `{outcome:'unknown', error:'gmail_send_outcome_unknown'}`. Never automatically retry or restore this action to a sendable state, including for rejected HTTP responses or malformed success bodies.
- Pre-dispatch validation, identity, authorization-read, token or receipt failure: typed `GmailSendError` with `outcome:'not_attempted'` and sanitized code.

A send-only connection does not need Gmail read permission; sender verification uses fixed OIDC userinfo. No token refresh or retry occurs after the send POST begins.

## Verification

Synthetic mocked transport and handler tests:

`node --test backend/tests/mailbox-provider.test.mjs backend/tests/mailbox-intake-routes.test.mjs backend/tests/gmail-*.test.mjs`

75 tests passed after the final source changes. These include the unchanged Microsoft provider suite, v2 Microsoft route fixtures, Gmail identity/label/message/MIME limits, cross-account and scope denial, frozen authorization changes, caller injection rejection, exact MIME serialization, durable receipt ordering and every post-dispatch unknown path. This is a focused test result, not a claim of full-system or production verification.

## Sources checked

- https://developers.google.com/identity/openid-connect/openid-connect
- https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile
- https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels/list
- https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list
- https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get
- https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages
- https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send
- https://supabase.com/docs/guides/functions/auth-legacy-jwt
- https://supabase.com/docs/guides/functions/auth-headers

Supabase changelog markdown fetch was attempted and rejected by the browsing renderer as unsupported text/markdown. Current authentication reference documentation was retrieved through the Supabase documentation tool. The existing pinned Supabase 2.58.0 client and request-auth pattern were retained.
