import { readFile, readdir } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
const base=process.env.EXPECTED_BASE || '/'
const out=new URL('../dist/',import.meta.url)
const root=await readFile(new URL('index.html',out),'utf8')
const doc=new JSDOM(root).window.document
assert.equal(doc.querySelectorAll('h1').length,1)
assert.ok(doc.title.includes('Put AI to work'))
assert.ok(doc.querySelector('meta[name="description"]').content.length>70)
assert.equal(doc.querySelectorAll('form').length,0,'No unconnected forms or fake lead storage')
for(const link of doc.querySelectorAll('a[href^="#"]')) assert.ok(doc.getElementById(link.hash.slice(1)),link.hash)
for(const link of doc.querySelectorAll('a[href^="mailto:"]')) assert.equal(new URL(link.href).pathname,'tim.gill@cerbtek.com')
assert.ok([...doc.querySelectorAll('a')].some(a=>a.getAttribute('href')===base+'app/'))
assert.ok([...doc.querySelectorAll('a')].some(a=>a.getAttribute('href')===base+'investors/'))
assert.ok(!root.includes('%BASE_URL%'))
const seen=new Set()
async function checkModule(path){
 if(seen.has(path))return;seen.add(path)
 const source=await readFile(new URL('assets/'+path.split('/').at(-1),out),'utf8')
 assert.doesNotMatch(source,/supabase|suohuogalotxhsnkumvy|sb_publishable|cerbtek_funding_opportunities|staff_accounts|Cofounders Capital|Veteran Fund|NSF 26-510/)
 for(const m of source.matchAll(/(?:from\s*|import\s*)["'](\.\/[^"']+\.js)["']/g))await checkModule(m[1])
}
for(const script of doc.querySelectorAll('script[src],link[rel="modulepreload"]')) await checkModule(script.getAttribute('src')||script.getAttribute('href'))
const app=await readFile(new URL('app/index.html',out),'utf8')
assert.match(app,/Client sign-in/);assert.match(app,/name="robots" content="noindex"/)
const investor=await readFile(new URL('investors/index.html',out),'utf8')
assert.match(investor,/Investors/)
for(const img of doc.querySelectorAll('img')){const src=img.getAttribute('src');assert.ok(src.startsWith(base));await readFile(new URL(src.slice(base.length),out))}
assert.match(root,/monthly or annual billing/);assert.match(root,/separate implementation fee/);assert.match(root,/local prototype, not a live phone service/)
console.log('PASS marketing metadata, real email CTA, assets, navigation and backend-free public dependency graph; app and investors retained at '+base)
