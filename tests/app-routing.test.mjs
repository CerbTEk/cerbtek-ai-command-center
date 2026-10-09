import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { appRoute, startKairoApp, showUnknownApp } from '../src/app-routing.js'
import { legacyAppTarget } from '../src/marketing-routing.js'

test('canonical Kairo entries load without navigation or loops at root and nested mounts', () => {
  for (const base of ['/', '/preview/', '/preview']) {
    const prefix = base.replace(/\/$/, '')
    for (const suffix of ['', '/', '/index.html']) {
      const location = { pathname: `${prefix}/app/kairo${suffix}`, search: '?invite=x%2By', hash: '#Customer%20Setup', replace: () => assert.fail('Canonical entry must not redirect') }
      let loads = 0
      startKairoApp({ location }, base, () => loads++)
      assert.equal(loads, 1)
      assert.equal(appRoute(location, base).kind, 'kairo')
    }
  }
})

test('old app URLs replace history before auth loads and preserve every query/hash byte', () => {
  const samples = [
    { search: '?invite=x%2By&extra=a%20b', hash: '#Team%20Access' },
    { search: '?kairoCompany=a&kairoCustomerRequest=r&kairoCustomerDays=7&kairoReport=customer', hash: '#AI%20Ops' },
    { search: '?code=TEST_ONLY&state=sample', hash: '' },
    { search: '', hash: '#access_token=TEST_ONLY&refresh_token=TEST_ONLY&type=signup' },
    { search: '?error=access_denied&error_description=Sample%20error', hash: '' },
    { search: '', hash: '#Company%20Knowledge' },
    { search: '', hash: '' }
  ]
  for (const base of ['/', '/preview/']) for (const suffix of ['', '/', '/index.html']) for (const sample of samples) {
    const prefix = base.replace(/\/$/, '')
    const targets = []
    const location = { pathname: `${prefix}/app${suffix}`, ...sample, replace: target => targets.push(target) }
    startKairoApp({ location }, base, () => assert.fail('Do not initialize auth before legacy redirect'))
    assert.deepEqual(targets, [`${prefix}/app/kairo${sample.search}${sample.hash}`])
  }
})

test('future app routes are never redirected or loaded as Kairo, even with Kairo parameters', () => {
  for (const base of ['/', '/preview/']) {
    const prefix = base.replace(/\/$/, '')
    for (const path of ['/app/other', '/app/other/', '/app/forgecif', '/app/kairo/unknown', '/app/Kairo', '/app/kairo-other', '/%61pp/other', '/app%2fother', '/app%252fother']) {
      const document = new JSDOM('<html><head><title>Kairo</title><link rel="canonical" href="https://www.cerbtek.com/products/kairo"><meta property="og:url" content="https://www.cerbtek.com/products/kairo"></head><body><div id="root"></div></body></html>').window.document
      const location = { pathname: prefix + path, search: '?invite=x&kairoCompany=a', hash: '#Overview', replace: () => assert.fail('Other app route must not redirect') }
      startKairoApp({ location, document }, base, () => assert.fail('Other app must not load Kairo or auth'))
      assert.equal(appRoute(location, base).kind, 'unknown')
      assert.equal(legacyAppTarget(location, base), null)
      assert.equal(document.title, 'App not found | CerbTEK')
      assert.equal(document.querySelector('meta[name="robots"]').content, 'noindex')
      assert.equal(document.querySelector('link[rel="canonical"],meta[property^="og:"]'), null)
      assert.equal(document.querySelector('#root'), null)
      assert.equal(document.querySelector('a').getAttribute('href'), prefix + '/')
    }
  }
})

test('root callbacks and reporting bookmarks use the new app entry on the same origin', () => {
  for (const search of ['?kairoReport=customer', '?kairoCustomerRequest=request-a', '?kairoCustomerDays=7', '?code=TEST_ONLY', '?token_hash=TEST_ONLY&type=signup']) {
    assert.equal(legacyAppTarget({ pathname: '/', search, hash: '' }), `/app/kairo${search}`)
  }
  assert.equal(appRoute({ pathname: '/products/kairo' }).kind, 'outside')
  assert.equal(legacyAppTarget({ pathname: '/products/kairo', search: '?utm_source=launch', hash: '#platform' }), null)
  assert.equal(legacyAppTarget({ pathname: '/app/kairo', search: '?code=TEST_ONLY', hash: '' }), null, 'A missing canonical app entry cannot self-redirect in the public fallback')
  assert.equal(legacyAppTarget({ pathname: '/other', search: '?invite=x', hash: '#Overview' }), null, 'Unrecognized public paths cannot redirect to Kairo')
})

test('unknown-app fallback is safe to render repeatedly and does not expose the supplied path', () => {
  const document = new JSDOM('<html><head></head><body></body></html>').window.document
  showUnknownApp(document)
  showUnknownApp(document)
  assert.equal(document.querySelectorAll('main').length, 1)
  assert.equal(document.querySelectorAll('meta[name="robots"]').length, 1)
})
