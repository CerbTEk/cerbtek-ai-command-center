# Kairo Command Center

Kairo is CerbTek's AI Enablement and Workflow Orchestration platform.

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
