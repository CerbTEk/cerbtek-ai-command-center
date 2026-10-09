# Kairo Command Center

Kairo is CerbTEK LLC's AI Enablement and Workflow Orchestration platform.

## Included
- Supabase Auth sign-in/sign-up
- Tenant organization creation
- Tenant switcher
- Overview and readiness dashboard
- Systems inventory
- Workflow inventory
- AI opportunity scoring
- Integrations and AI agent data model
- Governance policies
- Kairo AI Enablement Blueprint generation

## Backend
Dedicated Supabase project for Kairo (project ref: `suohuogalotxhsnkumvy`).

Tenant authorization is enforced with Row Level Security (RLS). Never use a service-role key in the browser.

## Run
```bash
npm install
npm run dev
```

## Build
```bash
npm run build
```


## Investor overview and private funding workspace

`/investors/` is a public, backend-free overview of Kairo, operated by CerbTEK LLC.

Funding is a company-wide workspace for active platform administrators, separate from client tenants. The stored venture identifiers are unchanged; the AI enablement venture is displayed as Kairo. Real opportunity research is stored only in the private database, never bundled in this repository or public assets.

Run `npm run check:funding` for UI/model tests, isolated database policy tests, the production build and public-bundle checks. `docs/funding-schema-draft.sql` records the reviewed funding schema; it is not executed by the frontend build.

## Public marketing and client access

The root page is the public, backend-free Kairo marketing website. `/app/` is the client command-center entry and `/investors/` remains the public investor overview. Legacy root section hashes, invitations, workflow links and existing auth return parameters are forwarded intact to `/app/` using history replacement. Campaign parameters and marketing anchors remain on the public page.

The walkthrough CTA opens an email to the established CerbTEK contact. There is no contact-form receiver, lead database, checkout or fabricated submission confirmation. Prices and implementation availability must be confirmed directly.

Run `npm run check:marketing` alongside `npm run check:funding`. The public build test supports mounted deployments with `EXPECTED_BASE=/mount/`.

## AI provider and model selection

AI Setup supports OpenAI, Anthropic Claude, and Google Gemini. Users choose a provider and a named model from a dropdown. Available choices are the intersection of account model discovery and the deployment administrator’s approved model/pricing catalog. Discovery alone does not establish structured-output compatibility. Unsupported, retired, unapproved, or unavailable models cannot be saved or run.

This prelaunch release keeps paid inference hard-disabled. No provider accounts or credentials are created by selecting a provider or saving a configuration. There is no API-key form in the browser. A connection must be approved and provisioned separately through secure server settings by the Kairo deployment administrator.

Server setup contract, after the required account and data-use approvals:
- Keep credentials organization-specific. The Edge runtime looks up `KAIRO_AI_<PROVIDER>_<ORGANIZATION_UUID_WITHOUT_HYPHENS_UPPERCASE>_KEY`, with provider `OPENAI`, `ANTHROPIC`, or `GEMINI`. Do not put secret values in source, browser environment variables, model catalogs, screenshots, logs, or backups.
- Anthropic currently requires a workspace-scoped API key. Credentials spanning multiple workspaces need an additional explicit server-side workspace binding that this release does not implement.
- `KAIRO_AI_MODEL_CATALOG` is a server-side JSON array. Each approved entry needs `provider` (`openai`, `anthropic`, or `gemini`), exact `model`, a friendly `label`, `structured_outputs: true`, and conservative positive integer `input_microusd_per_token` / `output_microusd_per_token` ceilings. Optional `max_output_tokens` bounds a model more tightly; `enabled: false` removes a model. Verify the provider’s current schema capability and pricing before adding an entry. No default prices or model IDs are supplied.
- Refresh models in AI Setup after provisioning. The server verifies membership before resolving an organization’s credential and fetching its models. Discovery failures clear the dropdown rather than reusing an unverified list.
- Enabling inference is a separate approved release with exact-payload acceptance tests. The reserved allowance is an admission control, not a guaranteed provider invoice cap. Unknown outcomes retain their reservation and block replacement requests.

Provider setup references: [OpenAI](https://developers.openai.com/api/docs/quickstart), [Anthropic](https://platform.claude.com/docs/en/get-api-key), [Google Gemini](https://ai.google.dev/gemini-api/docs/api-key).

`npm run check:ai` covers provider adapters with synthetic responses, model selection, organization isolation, SQL versioning, quotas, request inspection and the production build. It does not make paid API calls or prove that a production credential works. Existing installations use the narrowly scoped `backend/deployment/ai-provider-model-selection.sql` patch after review; it preserves the existing save function’s other checks and grants.
