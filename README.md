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
