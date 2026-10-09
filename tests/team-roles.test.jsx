import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import TeamRoles from '../src/TeamRoles'
import { assignableRoles, inviteRoles, roleLabel, canManageTeam } from '../src/team-roles'
import { sectionFromHash } from '../src/use-section-navigation'
const org={id:'company-a',name:'Company A'},session={user:{id:'owner-a'}}
const members=[{user_id:'owner-a',email:'owner@example.test',role:'owner'},{user_id:'admin-a',email:'admin@example.test',role:'admin'},{user_id:'consultant-a',email:'consultant@example.test',role:'consultant'},{user_id:'employee-a',email:'employee@example.test',role:'member'},{user_id:'viewer-a',email:'viewer@example.test',role:'viewer'}]
let client,reload
const fixture=async(props={})=>{
 const actor=(props.members||members).find(m=>m.user_id===(props.session||session).user.id)?.role
 client.rpc.mockImplementationOnce((name,args)=>Promise.resolve({data:{ok:true,version:1,organization_id:args.p_organization_id,actor_role:actor}}))
 const view=render(<TeamRoles org={org} session={session} members={members} invitations={[]} client={client} reload={reload} {...props}/>)
 await waitFor(()=>expect(screen.queryByText('Checking team access…')).toBeNull())
 client.rpc.mockClear()
 return view
}
const row=email=>screen.getByRole('article',{name:`Access for ${email}@example.test`})
beforeEach(()=>{client={rpc:vi.fn().mockImplementation((name,args)=>Promise.resolve({data:{ok:true,version:1,actor_role:'owner',organization_id:args.p_organization_id,user_id:args.p_user_id,role:args.p_role,id:args.p_invitation_id},error:null})),functions:{invoke:vi.fn().mockImplementation((name,{body})=>Promise.resolve({data:{ok:true,invite:{organization_id:body.organization_id,email:body.email.toLowerCase(),role:body.role,status:'Pending'},invite_url:'https://example.test/app/?invite=synthetic'},error:null}))}};reload=vi.fn().mockResolvedValue();})
afterEach(cleanup)

describe('existing company roles and navigation',()=>{
 it('maps Employee to member and excludes platform roles',async()=>{
  expect(roleLabel('member')).toBe('Employee')
  expect(assignableRoles('owner','member').map(r=>r.value)).toEqual(['owner','admin','consultant','member','viewer'])
  expect(assignableRoles('admin','member').map(r=>r.value)).toEqual(['member','viewer'])
  for(const target of ['owner','admin','consultant'])expect(assignableRoles('admin',target)).toEqual([])
  for(const actor of ['consultant','member','viewer','platform_admin',undefined]){expect(canManageTeam(actor)).toBe(false);expect(inviteRoles(actor)).toEqual([]);expect(assignableRoles(actor,'member')).toEqual([])}
  expect(assignableRoles('owner','owner',true)).toEqual([])
  expect(assignableRoles('owner','unexpected')).toEqual([])
 })
 it('preserves legacy and new Team hashes',async()=>{expect(sectionFromHash('#Team%20Access')).toBe('Team Access');expect(sectionFromHash('#Team%20%26%20Roles')).toBe('Team Access')})
})
describe('Team & Roles interaction',()=>{
 it('uses explicit save with exact company, target and expected role, without direct table writes',async()=>{
  await fixture();const employee=row('employee')
  fireEvent.change(within(employee).getByRole('combobox'),{target:{value:'admin'}})
  expect(client.rpc).not.toHaveBeenCalled()
  expect(within(employee).getByText('Unsaved change: Employee → Admin')).toBeTruthy()
  fireEvent.click(within(employee).getByRole('button',{name:'Save role'}))
  await waitFor(()=>expect(client.rpc).toHaveBeenCalledWith('kairo_set_member_role',{p_organization_id:'company-a',p_user_id:'employee-a',p_role:'admin',p_expected_role:'member'}))
  expect(await screen.findByRole('status')).toHaveProperty('textContent','employee@example.test now has the Admin role.')
  expect(reload).toHaveBeenCalledTimes(1)
 })
 it('cancel change restores saved role without a write',async()=>{await fixture();const employee=row('employee');fireEvent.change(within(employee).getByRole('combobox'),{target:{value:'viewer'}});fireEvent.click(within(employee).getByRole('button',{name:'Cancel change'}));expect(within(employee).getByRole('combobox').value).toBe('member');expect(client.rpc).not.toHaveBeenCalled()})
 it('does not allow editing self or any elevated target as admin',async()=>{
  await fixture({session:{user:{id:'admin-a'}}})
  for(const email of ['owner','admin','consultant']){expect(within(row(email)).getByRole('combobox').disabled).toBe(true);expect(within(row(email)).queryByRole('button',{name:'Save role'})).toBeNull()}
  expect(within(row('employee')).getAllByRole('option').map(o=>o.value)).toEqual(['member','viewer'])
  expect(screen.getByLabelText('Invitation role').querySelectorAll('option')).toHaveLength(2)
 })
 for(const role of ['consultant','member','viewer'])it(`keeps ${role} access read-only`,async()=>{await fixture({session:{user:{id:`${role==='member'?'employee':role}-a`}}});expect(screen.queryByRole('button',{name:'Save role'})).toBeNull();expect(screen.queryByRole('button',{name:'Create invite'})).toBeNull();expect(screen.getByText(/Only company owners and admins/)).toBeTruthy()})
 it('unknown or staff-only user gets no management controls',async()=>{await fixture({session:{user:{id:'platform-staff'}}});expect(screen.queryByRole('button',{name:'Save role'})).toBeNull();expect(screen.queryByRole('button',{name:'Create invite'})).toBeNull()})
 it('searches employee identity and friendly role names',async()=>{await fixture();fireEvent.change(screen.getByRole('searchbox'),{target:{value:'Employee'}});expect(screen.getAllByRole('article')).toHaveLength(1);expect(row('employee')).toBeTruthy();fireEvent.change(screen.getByRole('searchbox'),{target:{value:'missing'}});expect(screen.getByText('No employees match your search.')).toBeTruthy()})
 it('blocks duplicate saves and all role actions while a request is pending',async()=>{
  let resolve;client.rpc.mockImplementation(()=>new Promise(res=>{resolve=res}));await fixture();const employee=row('employee');fireEvent.change(within(employee).getByRole('combobox'),{target:{value:'viewer'}});const save=within(employee).getByRole('button',{name:'Save role'});fireEvent.click(save);fireEvent.click(save);expect(client.rpc).toHaveBeenCalledTimes(1);expect(within(row('viewer')).getByRole('combobox').disabled).toBe(true);expect(screen.getByRole('button',{name:'Create invite'}).disabled).toBe(true);await act(async()=>resolve({data:{ok:true}}))
 })
 it('stale expected-role conflict blocks further writes until explicit refresh',async()=>{
  client.rpc.mockResolvedValue({error:{code:'40001',message:'Role conflict'}});await fixture();const employee=row('employee');fireEvent.change(within(employee).getByRole('combobox'),{target:{value:'viewer'}});fireEvent.click(within(employee).getByRole('button',{name:'Save role'}));expect(await screen.findByRole('alert')).toHaveProperty('textContent','This employee’s access changed while you were editing. Refresh the team before trying again.');expect(within(employee).getByRole('combobox').disabled).toBe(true);client.rpc.mockResolvedValueOnce({data:{ok:true,version:1,organization_id:'company-a',actor_role:'owner'}});fireEvent.click(screen.getByRole('button',{name:'Refresh team'}));await waitFor(()=>expect(within(employee).getByRole('combobox').disabled).toBe(false));expect(within(employee).getByRole('combobox').value).toBe('member');expect(reload).toHaveBeenCalledTimes(1)
 })
 it('does not claim success for a missing backend acknowledgment',async()=>{client.rpc.mockResolvedValue({data:null,error:null});await fixture();const employee=row('employee');fireEvent.change(within(employee).getByRole('combobox'),{target:{value:'viewer'}});fireEvent.click(within(employee).getByRole('button',{name:'Save role'}));expect(await screen.findByRole('alert')).toHaveProperty('textContent',expect.stringContaining('could not be confirmed'));expect(reload).not.toHaveBeenCalled()})
 it('requires explicit confirmation to remove access and sends protected RPC',async()=>{
  await fixture();fireEvent.click(within(row('employee')).getByRole('button',{name:'Remove access'}));expect(client.rpc).not.toHaveBeenCalled();fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'Cancel'}));expect(screen.queryByRole('alertdialog')).toBeNull();expect(client.rpc).not.toHaveBeenCalled();fireEvent.click(within(row('employee')).getByRole('button',{name:'Remove access'}));fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'Remove access'}));await waitFor(()=>expect(client.rpc).toHaveBeenCalledWith('kairo_remove_member',{p_organization_id:'company-a',p_user_id:'employee-a',p_expected_role:'member'}));expect(await screen.findByRole('status')).toHaveProperty('textContent','Company access removed for employee@example.test.')
 })
 it('creates an explicit employee invite and accurately describes delivery',async()=>{
  await fixture();fireEvent.change(screen.getByLabelText('Employee email'),{target:{value:'new@example.test'}});fireEvent.click(screen.getByRole('button',{name:'Create invite'}));await waitFor(()=>expect(client.functions.invoke).toHaveBeenCalledWith('organization-invite',{body:{op:'create',organization_id:'company-a',email:'new@example.test',role:'member'}}));expect(await screen.findByRole('status')).toHaveProperty('textContent',expect.stringContaining('No email was sent'));expect(screen.getByLabelText('Secure invitation link').value).toBe('https://example.test/app/?invite=synthetic')
 })
 it('revokes an invitation with company scope and restricts admin invitation controls',async()=>{
  const invitations=[{id:'invite-1',email:'new@example.test',role:'viewer',status:'Pending',expires_at:'2026-10-16T12:00:00Z'},{id:'invite-2',email:'lead@example.test',role:'admin',status:'Pending',expires_at:'2026-10-16T12:00:00Z'}];await fixture({invitations,session:{user:{id:'admin-a'}}});expect(screen.getAllByRole('button',{name:'Revoke invitation'})).toHaveLength(1);fireEvent.click(screen.getByRole('button',{name:'Revoke invitation'}));fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'Revoke invitation'}));await waitFor(()=>expect(client.rpc).toHaveBeenCalledWith('kairo_revoke_invitation',{p_organization_id:'company-a',p_invitation_id:'invite-1'}))
 })
 it('ignores an obsolete response after company/account remount',async()=>{
  let resolve;client.rpc.mockImplementation(()=>new Promise(res=>{resolve=res}));const view=await fixture();fireEvent.change(within(row('employee')).getByRole('combobox'),{target:{value:'viewer'}});fireEvent.click(within(row('employee')).getByRole('button',{name:'Save role'}));view.unmount();await fixture({org:{id:'company-b',name:'Company B'},session:{user:{id:'other-owner'}}});await act(async()=>resolve({data:{ok:true}}));expect(reload).not.toHaveBeenCalled();expect(screen.queryByRole('status')).toBeNull();expect(screen.getByText('Your team at Company B')).toBeTruthy()
 })
 it('preserves draft expected role even when fresh roster props change',async()=>{
  const view=await fixture();fireEvent.change(within(row('employee')).getByRole('combobox'),{target:{value:'admin'}});view.rerender(<TeamRoles org={org} session={session} members={members.map(m=>m.user_id==='employee-a'?{...m,role:'viewer'}:m)} invitations={[]} client={client} reload={reload}/>);fireEvent.click(within(row('employee')).getByRole('button',{name:'Save role'}));await waitFor(()=>expect(client.rpc.mock.calls[0][1].p_expected_role).toBe('member'))
 })
})
