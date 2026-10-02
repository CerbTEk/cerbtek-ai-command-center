import { describe, expect, it } from 'vitest'
import { canManageFunding, deadlineLabel, emptyOpportunity, officialUrl, opportunityPayload, validateOpportunity } from '../src/funding-model'
const valid = () => ({ ...emptyOpportunity('id'), opportunity: 'Program', provider: 'Provider', official_url: 'https://example.test/program' })
describe('funding data boundaries', () => {
  it('permits only active platform admin with exact session identity', () => { expect(canManageFunding({ user_id:'a', role:'platform_admin', active:true },'a')).toBe(true); for(const s of [null, {user_id:'a',role:'platform_admin',active:false},{user_id:'a',role:'sales',active:true},{user_id:'b',role:'platform_admin',active:true}]) expect(canManageFunding(s,'a')).toBe(false) })
  it('rejects executable, non-HTTPS and credential URLs', () => { for (const url of ['javascript:alert(1)','data:text/html,foo','http://example.test','https://user:pass@example.test','//example.test']) expect(officialUrl(url)).toBe(null) })
  it('preserves unknown dates and terms instead of fabricating them', () => { expect(validateOpportunity(valid())).toBe(''); expect(opportunityPayload(valid())).toMatchObject({ deadline_date:null, last_verified:null, amount_terms:'' }) })
  it('validates fixed deadlines, real dates and verification dates', () => { expect(validateOpportunity({...valid(),deadline_state:'Fixed'})).toContain('needs a date'); expect(validateOpportunity({...valid(),deadline_date:'2026-02-30'})).toContain('valid deadline'); expect(validateOpportunity({...valid(),last_verified:'2026-10-03'},'2026-10-02')).toContain('before today') })
  it('does not send immutable/server fields or obsolete dates', () => { const p=opportunityPayload({...valid(),created_by:'other',version:9,deadline_date:'2026-11-04'}); expect(p).not.toHaveProperty('created_by'); expect(p).not.toHaveProperty('version'); expect(p.deadline_date).toBe(null) })
  it('marks closed and past deadlines honestly', () => { expect(deadlineLabel({deadline_state:'Closed',deadline_date:'2026-08-24'},'2026-10-02')).toContain('Closed'); expect(deadlineLabel({deadline_state:'Fixed',deadline_date:'2026-08-24'},'2026-10-02')).toContain('Past date') })
})
