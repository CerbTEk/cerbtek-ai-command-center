import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
const api=vi.hoisted(()=>({invoke:vi.fn(),from:vi.fn(),rpc:vi.fn(),getSession:vi.fn(),onAuthStateChange:vi.fn()}))
vi.mock('../src/supabase',()=>({supabase:{functions:{invoke:api.invoke},from:api.from,rpc:api.rpc,auth:{getSession:api.getSession,onAuthStateChange:api.onAuthStateChange,signOut:vi.fn()}}}))
import { App } from '../src/main'
let emit
const employee=()=>screen.getByRole('article',{name:'Access for employee@example.test'})
beforeEach(()=>{
 window.history.replaceState({},'','/app/#Team%20Access')
 api.from.mockReset();api.invoke.mockReset();api.rpc.mockReset()
 api.rpc.mockImplementation((name,args)=>Promise.resolve({data:{ok:true,version:1,organization_id:args.p_organization_id,actor_role:'owner'}}))
 api.getSession.mockResolvedValue({data:{session:{user:{id:'owner-a'},access_token:'synthetic'}}})
 api.onAuthStateChange.mockImplementation(callback=>{emit=callback;return {data:{subscription:{unsubscribe:vi.fn()}}}})
 api.invoke.mockImplementation(()=>Promise.resolve({data:{members:[{user_id:'owner-a',email:'owner-a@example.test',role:'owner'},{user_id:'owner-b',email:'owner-b@example.test',role:'owner'},{user_id:'employee',email:'employee@example.test',role:'member'}]},error:null}))
 api.from.mockImplementation(table=>{
  let single=false
  const result=()=>({data:table==='organizations'?[{id:'company-a',name:'Company A'},{id:'company-b',name:'Company B'}]:single?null:[],error:null})
  const chain={select:()=>chain,eq:()=>chain,order:()=>chain,limit:()=>chain,maybeSingle:()=>{single=true;return Promise.resolve(result())},then:(resolve,reject)=>Promise.resolve(result()).then(resolve,reject)}
  return chain
 })
})
afterEach(()=>{cleanup();window.history.replaceState({},'','/');window.sessionStorage.clear()})
it('displays Team & Roles for legacy links and retains staff/funding visibility rules',async()=>{
 render(<App/>);expect(await screen.findByRole('heading',{level:1,name:'Team & Roles'})).toBeTruthy();expect(screen.getByRole('button',{name:'Team & Roles'})).toBeTruthy();expect(screen.queryByRole('button',{name:'Funding'})).toBeNull();expect(screen.queryByRole('button',{name:'CerbTEK LLC Staff'})).toBeNull()
})
it('remounts company role drafts when company selection changes',async()=>{
 const view=render(<App/>);await waitFor(()=>expect(within(employee()).getByRole('combobox').disabled).toBe(false));fireEvent.change(within(employee()).getByRole('combobox'),{target:{value:'viewer'}});fireEvent.change(view.container.querySelector('.org-switcher select'),{target:{value:'company-b'}});await waitFor(()=>expect(screen.getByText('Your team at Company B')).toBeTruthy());expect(within(employee()).getByRole('combobox').value).toBe('member');expect(api.rpc.mock.calls.every(([name])=>name==='kairo_team_access_status')).toBe(true)
})
it('preserves role draft on token refresh and resets it on account change',async()=>{
 render(<App/>);await waitFor(()=>expect(within(employee()).getByRole('combobox').disabled).toBe(false));fireEvent.change(within(employee()).getByRole('combobox'),{target:{value:'viewer'}});await act(async()=>emit('TOKEN_REFRESHED',{user:{id:'owner-a'},access_token:'new'}));expect(within(employee()).getByRole('combobox').value).toBe('viewer');await act(async()=>emit('SIGNED_IN',{user:{id:'owner-b'},access_token:'other'}));await waitFor(()=>expect(within(employee()).getByRole('combobox').value).toBe('member'))
})
it('ignores old company save completion without refreshing the new company',async()=>{
 let resolve;api.rpc.mockImplementation((name,args)=>name==='kairo_team_access_status'?Promise.resolve({data:{ok:true,version:1,organization_id:args.p_organization_id,actor_role:'owner'}}):new Promise(res=>{resolve=res}));const view=render(<App/>);await waitFor(()=>expect(within(employee()).getByRole('combobox').disabled).toBe(false));fireEvent.change(within(employee()).getByRole('combobox'),{target:{value:'viewer'}});fireEvent.click(within(employee()).getByRole('button',{name:'Save role'}));fireEvent.change(view.container.querySelector('.org-switcher select'),{target:{value:'company-b'}});await waitFor(()=>expect(screen.getByText('Your team at Company B')).toBeTruthy());const reads=api.from.mock.calls.length;await act(async()=>resolve({data:{ok:true,organization_id:'company-a',user_id:'employee',role:'viewer'}}));expect(api.from.mock.calls.length).toBe(reads);expect(screen.queryByText(/now has the Viewer role/)).toBeNull()
})
