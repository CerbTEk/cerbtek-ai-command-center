import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { legacyAppTarget, LEGACY_SECTIONS } from '../src/marketing-routing.js'

test('all existing product sections retain their exact query and fragment', async () => {
  const source = await readFile(new URL('../src/use-section-navigation.js', import.meta.url), 'utf8')
  const sectionList = source.match(/export const SECTIONS=(\[[^\n]+\])/)[1]
  assert.deepEqual(LEGACY_SECTIONS, JSON.parse(sectionList.replaceAll("'", '"')))
  for (const section of LEGACY_SECTIONS) {
    const hash = '#'+encodeURIComponent(section)
    assert.equal(legacyAppTarget({search:'?campaign=existing',hash}), '/app/?campaign=existing'+hash)
  }
})
test('marketing pages, section anchors and UTM URLs remain public', () => {
  for (const hash of ['', '#main', '#approach', '#setup', '#readiness', '#walkthrough', '#%E0%A4%A']) {
    assert.equal(legacyAppTarget({search:'?utm_source=email&utm_campaign=launch',hash}), null)
  }
})
test('invitations and full workflow links preserve all bytes', () => {
  for (const search of ['?invite=sample%2Bvalue&other=a%20b', '?kairoCompany=company&kairoWorkflow=workflow&kairoRun=run&kairoDays=90','?kairoDays=30']) {
    assert.equal(legacyAppTarget({search,hash:'#AI%20Ops'}), '/app/'+search+'#AI%20Ops')
  }
})
test('existing confirmation, PKCE and callback error URLs are forwarded intact', () => {
  const samples=[
    {search:'',hash:'#access_token=TEST_ONLY&refresh_token=TEST_ONLY&expires_in=3600&token_type=bearer&type=signup'},
    {search:'?code=TEST_ONLY&state=example',hash:''},
    {search:'',hash:'#error=access_denied&error_code=otp_expired&error_description=Sample%20error'},
    {search:'?error=access_denied&error_description=Sample%20error',hash:''},
    {search:'?token_hash=TEST_ONLY&type=signup',hash:''}
  ]
  for(const location of samples) assert.equal(legacyAppTarget(location), '/app/'+location.search+location.hash)
})
test('nested Webflow mounts remain relative to their own root', () => {
  assert.equal(legacyAppTarget({search:'?invite=x',hash:'#Funding'},'/preview/'),'/preview/app/?invite=x#Funding')
  assert.equal(legacyAppTarget({search:'',hash:'#Overview'},'/preview'),'/preview/app/#Overview')
})
