import { readFile, readdir } from 'node:fs/promises'
import assert from 'node:assert/strict'
const base=process.env.EXPECTED_BASE || '/'
const html=await readFile(new URL('../dist/investors/index.html',import.meta.url),'utf8')
assert.match(html,/<html lang="en">/)
assert.match(html,/Investors &amp; Partners|Investors & Partners/)
const scripts=[...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map(m=>m[1])
assert.ok(scripts.length)
for(const name of scripts){assert.ok(name.startsWith(base+'assets/'),'Investor assets remain under the deployment mount');const source=await readFile(new URL(`../dist/${name.slice(base.length)}`,import.meta.url),'utf8');assert.doesNotMatch(source,/cerbtek_funding_opportunities|suohuogalotxhsnkumvy|sb_publishable|staff_accounts|Funding opportunities|Cofounders Capital|Veteran Fund|NSF 26-510/)}
const appSource=await readFile(new URL('../src/main.jsx',import.meta.url),'utf8')
assert.ok(appSource.includes('APP_BASE}investors/'))
assert.ok(appSource.includes("import.meta.env.BASE_URL.replace(/\\/$/, '')"))
assert.match(appSource,/canManageFunding\(staff, session.user.id\)/)
assert.match(appSource,/\.eq\('user_id', userId\)\.eq\('active', true\)/)
const publicFiles=await readdir(new URL('../public/',import.meta.url))
assert.ok(!publicFiles.some(name=>/funding|seed|tracker/i.test(name)))
console.log('PASS public entry has no backend/private imports, links are integrated and no seed assets are public at '+base)


