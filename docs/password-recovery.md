# Kairo password recovery

The sign-in page now offers **Forgot password?**. Requests use Supabase Auth's `resetPasswordForEmail` with the current origin and configured Vite base, followed by `/app/kairo?recovery=1`. The same existing app route receives callbacks; no new server route is needed.

## Deployment prerequisites (verify, do not silently change)

- Supabase project: `suohuogalotxhsnkumvy`.
- The exact production recovery URL is `https://www.cerbtek.com/app/kairo?recovery=1`. It must match the project's allowed Auth Redirect URLs. If serving the apex origin directly rather than redirecting it, `https://cerbtek.com/app/kairo?recovery=1` must also be allowed. A mounted deployment requires the corresponding mounted URL.
- Verify the recovery email template uses Supabase's `{{ .ConfirmationURL }}` (or a compatible verified recovery callback). Arbitrary custom `token_hash` templates are not implemented by this client. Do not change templates or Auth settings as part of this source-only correction.
- Email/password provider and a working recovery email delivery configuration must already exist. Provider rate limits still apply. If CAPTCHA is required, the deployment needs a separately configured supported challenge flow; this correction does not create one or bypass it.
- Default implicit callbacks are supported. The app also supports recovery PKCE callbacks that include a valid stored recovery verifier; opening those in a different browser cannot complete the exchange.

## Security and behavior

- Recovery is checked before mounting the private workspace. Merely adding `?recovery=1`, having an existing session, or supplying a partial callback never authorizes the reset form.
- Capture and replace the callback URL before constructing the Supabase client. Its automatic URL processing is disabled only for recovery callbacks. Credentials are not added to a new history entry, logged, or retained in application state. Ordinary sign-in and signup behavior stays with the existing SDK defaults.
- Supabase validates implicit sessions through `setSession`; PKCE exchanges must report a recovery verifier. The current user is checked again before password update, and account switches/sign-out invalidate the form.
- Passwords require the existing signup strength rules plus matching confirmation. Provider errors are mapped to safe fixed messages. No provider error string or email/account lookup result is displayed.
- Submissions are guarded against double clicks. Account-specific reset-request responses are generic. Operational errors and throttling offer retry guidance.
- Cancel and completion return to sign-in only after local sign-out succeeds. The recovery form does not expose workspace data. Refreshing an already-consumed callback offers a new link rather than trusting a stale session or browser marker.
- No RLS, roles, grants, user records, security settings, Auth templates, or secrets were changed by this patch. Supabase dependencies remain pinned to the existing version.

## Verification

`npm run test:ui -- tests/password-recovery.test.jsx` runs synthetic, mocked UI and callback tests. These tests never send email or change a real account password. `npm run test:ui`, `npm run test:marketing`, and `npm run build` cover regressions and compilation.

Source and mock tests do not establish production Auth redirect allowlisting, email delivery, actual link redemption, or an end-to-end password change. Those require a deliberate user-controlled acceptance run after deployment. The user enters and submits their own credentials.

Official references:
- https://supabase.com/docs/reference/javascript/auth-resetpasswordforemail
- https://supabase.com/docs/reference/javascript/auth-setsession
- https://supabase.com/docs/reference/javascript/auth-exchangecodeforsession
- https://supabase.com/docs/guides/auth/redirect-urls
- https://supabase.com/docs/guides/auth/passwords
