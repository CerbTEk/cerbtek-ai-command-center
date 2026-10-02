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

## Investor information and private funding workspace (draft)

- `/investors/` is a public, backend-free investor/partner overview. Its build entry is separate from the authenticated command center. It contains no opportunity records or funding applications.
- The sign-in page links to the public overview. Existing client authentication remains the app's default route.
- Active `platform_admin` staff can open **Funding**. The funding pipeline is company-wide and intentionally unrelated to the selected client organization. Tenant owners/admins, other staff roles and inactive staff cannot access it.
- The tracker records official sources, venture, category, eligibility/readiness, deadline, verified amount/terms, status, next action, owner, private notes and last verification date. It does not submit applications or contact funders.
- Unknown amounts stay unknown. A closed intake remains visibly closed. Date notes preserve the program's published time zone and timing qualifications.
- Updates use a row version to prevent overwriting a newer edit. Repeated save clicks are suppressed. The UI retains a draft on error; records are never saved in localStorage/sessionStorage.

### Checks

```sh
npm ci
npm run test:funding
npm run test:funding-db
npm run build
```

`test:funding-db` uses an isolated, synthetic PGlite PostgreSQL database. It never contacts Supabase. Hosted authorization tests are also required before release.

`docs/funding-schema-draft.sql` is a reviewable schema draft, not an applied migration. It grants only SELECT and field-limited INSERT/UPDATE to authenticated users, then limits all rows to active platform administrators through the existing private staff helper. It grants no anonymous or DELETE access. Review it, generate a proper migration with the Supabase CLI and verify against a dedicated non-production project before enabling the feature.

Keep real opportunity research, contact notes, seed records and application information out of this repository and all browser bundles. Add approved research only through the authenticated private workspace or a separately approved import. Do not include the table in client-tenant exports or public views.
