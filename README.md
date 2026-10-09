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

## Team & Roles

The company workspace now includes a searchable employee roster with explicit role saves, descriptions, and guarded removal/invitation controls. Mutation controls stay disabled until an authenticated readiness check confirms the installed security contract, company and actor role. Existing `#Team%20Access` links continue to work; `#Team%20%26%20Roles` is also accepted. The displayed Employee role is the existing `member` database role, not a new access tier.

- Owner: manage other employees, including other owners and administrators. Self-changes are blocked and the company must retain an owner.
- Admin: manage Employee and Viewer memberships and invitations only.
- Consultant: retains existing business setup and eligible approval permissions, without employee-access administration.
- Employee (`member`): existing company contribution access.
- Viewer: existing company read access.

Company roles never grant CerbTEK staff or Funding access. Workflow approval policies remain authoritative. Team changes use fresh database authorization, a company transaction lock, expected-role conflict checks, and same-transaction audit records. Invitations cannot overwrite an existing membership; acceptance requires the invited verified email and an inviter who still has sufficient authority. Role demotion/removal invalidates affected outstanding invitations.

The source-only candidate SQL is `backend/candidate/sql/team-roles-contract.sql`. Installing it changes security grants and requires explicit deployment approval. It closes direct membership/invitation writes, including legacy service-role writes. Deploy it together with `backend/candidate/edge/organization-invite/`, then release the UI. An older frontend or invitation function will fail closed during the coordinated cutover. Existing memberships are not rewritten by installation. Previously issued invitations from consultants or staff without a current company Owner/Admin membership require an authorized owner/admin to reissue them.

Run `npm run check:team` for synthetic UI and database/Edge tests and the production build. No test changes real employee access, sends email, or invokes paid inference. PGlite exercises the SQL and role checks; it does not establish multi-session production lock timing. Browser pixel verification and authenticated production acceptance are separate from these synthetic tests.

## Connected customer follow-up

Customer Follow-up brings the earlier employee inquiry prototype's daily queue, assignment, revision checks and review layout into the current application. It uses the existing company memberships, AI draft reservations, immutable Microsoft action requests and one-time dispatcher. The prototype's synthetic phone, billing and separate role database are not installed by this feature.

The connected path is:
1. An employee captures a customer request and verified recipient inside their company workspace.
2. An owner, admin or consultant saves explicitly approved company reply guidance as an immutable version. These manually maintained facts are separate from the broader onboarding profile. Customer email addresses are excluded from model input.
3. A current owner, admin or consultant prepares the inquiry's exact saved context and generates through the existing AI provider pipeline when inference is separately enabled. The browser cannot replace the bound context, author or request key.
4. A human checks and accepts the draft. An employee queues its exact recipient, subject and body into the existing Microsoft approval system.
5. A different current company owner, admin or consultant approves the exact email, then an authorized sender uses the separate send action. Requester, draft author and assignee cannot approve that email.
6. The queue shows the durable AI and Microsoft records. Microsoft acceptance is not delivery or customer resolution. Unknown/claimed outcomes never offer a replacement send.

Employees see their assigned requests; company managers and viewers retain role-appropriate visibility. Staff status alone does not grant this customer-workflow authority. Every write checks fresh company membership and the expected saved revision. Company guidance, AI configuration, assignment and approval lineage are checked again before later steps. Changing guidance does not silently rewrite an existing draft. A prepared AI key with no recorded run stays pinned: resume that same request, or explicitly cancel a stale preparation and start a new intake. Reservations with unknown outcomes remain unresolved and continue to block replacement inference.

The UI fails closed if the versioned backend contract is absent or does not match the current company/account. Saving context or intake does not call an AI provider or send mail. This release preserves the existing hard-disabled paid inference gate and does not configure credentials, grant Microsoft access, ingest an inbox or documents, or activate phone service.

Deployment order for an existing installation:
- Verify the current AI draft, Microsoft approval/claim, reconciliation/receipt, OAuth and Team & Roles contracts are installed.
- Review and apply `backend/candidate/sql/customer-workflow-contract.sql` as a standalone transaction through the supported deployment flow. The Supabase CLI is unavailable in the current implementation environment, so this is not an invented migration-history filename.
- Deploy the new `customer-workflow` Edge endpoint together with the updated `ai-draft` and `microsoft-action` endpoints, retaining JWT checks and the existing disabled inference gate.
- Deploy the frontend and verify authenticated company-role journeys before treating the feature as customer-pilot ready.

The SQL creates private-to-the-browser context/workflow storage, exposes only authenticated Edge-mediated service RPCs, adds a tenant-bound link to existing actions, and installs guards for linked AI reservations, approvals and dispatch receipts. Linked action visibility is narrowed to the same employee assignment rules; ordinary manual Microsoft actions retain their existing behavior. No existing memberships, credentials, provider grants or approval records are rewritten. Review exact grants and the new linked-action read policy before installation.

Run `npm run check:customer` for synthetic UI, Node and PGlite checks plus the production build. These checks do not contact providers or change real company data. PGlite is not proof of simultaneous hosted-session lock timing. Authenticated live-provider acceptance and browser pixel/mobile-screen verification are separate, unrun stages in this implementation environment.

## Company Knowledge

Company Knowledge stores short text/Markdown source material in immutable versions with SHA-256 content/chunk hashes, a review deadline and explicit publication. It is a separate reference library: this release does not automatically feed these documents into AI drafts. The existing draft source remains manually saved reply guidance until a versioned multi-source citation adapter is implemented.

Company owners and admins manage sources and history. New drafts default to “Company admins only.” Publishing requires an explicit review of the exact version and audience; “All company members” allows current consultants, employees and viewers to read that published version. Private publication remains limited to owners/admins. Saving a replacement unpublishes the previous version pending a new review. Archived, draft, superseded and overdue sources are excluded from retrieval. Archiving preserves source history and removes it from search.

The first slice supports up to 200 documents per company, 100 versions per document and 32 KiB UTF-8 per source. Search returns up to 10 keyword/phrase excerpts with immutable document, version, chunk and content-hash references. It does not fetch URLs, extract PDFs, create embeddings, infer permissions, or share sources with an AI provider.

Install the separately reviewed `backend/candidate/sql/company-knowledge-contract.sql`, deploy `backend/candidate/edge/company-knowledge/` with verified user JWT forwarding and no service-role credential, then deploy the UI. All new tables enable RLS and deny direct application-role reads/writes; a narrow authenticated RPC rechecks current company membership, audience, freshness, revision and replay key. Existing memberships, staff access, provider credentials and AI configuration are untouched. Run `npm run check:knowledge` for local SQL/Edge/DOM and isolated bundle checks. Live authenticated access, hosted simultaneous sessions and browser pixels remain separate acceptance work.

`npm run check:all` runs the complete local backend and UI regression suites, funding RLS checks, marketing routing checks, production build, public-bundle checks and Company Knowledge bundle validation. It requires no provider credentials and performs no live sends or hosted database writes.
