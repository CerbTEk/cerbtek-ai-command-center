import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
const api=vi.hoisted(()=>({invoke:vi.fn(),from:vi.fn(),getSession:vi.fn(),onAuthStateChange:vi.fn()}))
vi.mock('../src/supabase',()=>({supabase:{functions:{invoke:api.invoke},from:api.from,auth:{getSession:api.getSession,onAuthStateChange:api.onAuthStateChange,signOut:vi.fn()}}}))
import { App } from '../src/main'
let emit,serial=0
const tables={
  organizations:[{id:'company-a',name:'Company A'},{id:'company-b',name:'Company B'}],
  ai_agents:[{id:'agent',name:'Test agent',status:'Active'}],
  workflow_definitions:[{id:'workflow',name:'Test workflow',status:'Active',steps:[{type:'microsoft.health'}]}],
  agent_workflows:[{agent_id:'agent',workflow_id:'workflow',active:true,execution_mode:'Execute'}],
  oauth_connections:[{id:'connection',provider:'microsoft',status:'Connected',oauth_verified_version:1,scopes:['Mail.Send']}],
}
beforeEach(()=>{
  serial++
  api.from.mockReset();api.invoke.mockReset()
  api.getSession.mockResolvedValue({data:{session:{user:{id:`user-${serial}`},access_token:'synthetic'}}})
  api.onAuthStateChange.mockImplementation(callback=>{emit=callback;return {data:{subscription:{unsubscribe:vi.fn()}}}})
  api.invoke.mockImplementation(name=>Promise.resolve({data:name==='ai-draft'?{configuration:null,catalog:[],runs:[],unresolved_count:0,readiness:{live_enabled:false,credential_configured:false,status:'live_inference_disabled'}}:{members:[]},error:null}))
  api.from.mockImplementation(table=>{
    let single=false
    const result=()=>({data:single?null:tables[table]||[],error:null})
    const chain={select:()=>chain,eq:()=>chain,order:()=>chain,limit:()=>chain,maybeSingle:()=>{single=true;return Promise.resolve(result())},then:(resolve,reject)=>Promise.resolve(result()).then(resolve,reject)}
    return chain
  })
})
afterEach(()=>{cleanup();window.history.replaceState({},'','/');window.sessionStorage.clear()})

const fields={'AI Setup':()=>screen.getByLabelText('Business context'),Agents:()=>screen.getByLabelText('Agent name'),Workflows:()=>screen.getByPlaceholderText('Workflow'),Integrations:()=>screen.getByLabelText('Recipient')}
describe('actual command center section context boundaries',()=>{
  for(const section of Object.keys(fields)){
    it(`remounts ${section} fields when the selected organization changes`,async()=>{
      window.history.replaceState({},'',`/app/#${section}`)
      const view=render(<App/> )
      await waitFor(()=>expect(fields[section]()).toBeTruthy())
      fireEvent.change(fields[section](),{target:{value:section==='Integrations'?'private@example.test':'Private draft'}})
      fireEvent.change(view.container.querySelector('.org-switcher select'),{target:{value:'company-b'}})
      await waitFor(()=>expect(fields[section]().value).toBe(''))
      expect(view.container.querySelector('.tenant-pill').textContent).toBe('Company B')
      expect(window.location.search).toContain('kairoCompany=company-b')
    })
    it(`remounts ${section} on account change and preserves it on token refresh`,async()=>{
      window.history.replaceState({},'',`/app/#${section}`)
      render(<App/> )
      await waitFor(()=>expect(fields[section]()).toBeTruthy())
      const value=section==='Integrations'?'private@example.test':'Private draft'
      fireEvent.change(fields[section](),{target:{value}})
      await act(async()=>emit('TOKEN_REFRESHED',{user:{id:`user-${serial}`},access_token:'replacement'}))
      expect(fields[section]().value).toBe(value)
      await act(async()=>emit('SIGNED_IN',{user:{id:`other-user-${serial}`},access_token:'other'}))
      await waitFor(()=>expect(fields[section]().value).toBe(''))
    })
  }
  it('does not reload or surface an obsolete agent request result after an actual company switch',async()=>{
    window.history.replaceState({},'','/app/#Agents')
    let resolve
    const pending=new Promise(res=>{resolve=res})
    api.invoke.mockImplementation((name)=>name==='agent-run'?pending:Promise.resolve({data:{members:[]},error:null}))
    const view=render(<App/> )
    await waitFor(()=>expect(screen.getByRole('button',{name:'Request run'})).toBeTruthy())
    fireEvent.click(screen.getByRole('button',{name:'Request run'}))
    fireEvent.change(view.container.querySelector('.org-switcher select'),{target:{value:'company-b'}})
    await waitFor(()=>expect(fields.Agents()).toBeTruthy())
    const reads=api.from.mock.calls.length
    await act(async()=>resolve({data:{ok:true,status:'Pending'},error:null}))
    expect(api.from.mock.calls.length).toBe(reads)
    expect(screen.queryByText(/Agent proposal saved/)).toBeNull()
  })
})
