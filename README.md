# CerbTek AI Enablement Command Center

Initial MVP for CerbTek's AI Enablement as a Service platform.

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
- AI Enablement Blueprint generation

## Backend
Dedicated Supabase project: CerbTek AI Enablement.

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
