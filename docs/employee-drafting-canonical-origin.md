# Canonical-origin compatibility correction

The approved employee drafting rollout revealed a pre-existing origin allowlist mismatch: the canonical application is https://www.cerbtek.com/app/kairo, but ai-draft and customer-workflow allowed only https://cerbtek-ai-command-center.webflow.io. Read-only OPTIONS probes returned origin_not_allowed for the canonical origin.

The independently reviewed correction adds exactly https://www.cerbtek.com alongside the existing Webflow origin in those two Edge entrypoints. There is no wildcard, no additional origin, and no change to JWT requirements, handlers, actor authorization, SQL, configuration, activation, credentials, limits, provider calls or email sending. The workflow-installations entrypoint already had both origins and is unchanged.

The focused two-test suite checks canonical and retained legacy OPTIONS, several untrusted or lookalike origins, and missing/invalid authorization. All pass without storage, credential or provider work. The corrected Edge versions are ai-draft v10 and customer-workflow v6, with verify_jwt retained true. Live source and preflight verification results are retained with the deployment receipt.

This is a compatibility fix for the approved workflow path, not a grant of AI activation or outbound email permission. No model or email request was made during verification.
