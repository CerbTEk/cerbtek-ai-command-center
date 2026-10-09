import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import TeamRoles from '../src/TeamRoles'

const org = { id: 'org-a', name: 'Example Company' }
const session = { user: { id: 'actor' } }
const members = [
  { user_id: 'actor', email: 'owner@example.test', role: 'owner' },
  { user_id: 'employee', email: 'employee@example.test', role: 'member' },
  { user_id: 'admin', email: 'admin@example.test', role: 'admin' },
]
const invitations = [{ id: 'invite-a', email: 'new@example.test', role: 'member', status: 'Pending', expires_at: '2026-10-16T12:00:00Z' }]
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const readiness = (overrides = {}) => ({ data: { ok: true, version: 1, organization_id: 'org-a', actor_role: 'owner', ...overrides }, error: null })
const responseFor = (name, args) => name === 'kairo_team_access_status' ? readiness({ organization_id: args.p_organization_id }) : ({ data: { ok: true, organization_id: args.p_organization_id, ...(name === 'kairo_revoke_invitation' ? { id: args.p_invitation_id, status: 'Revoked' } : { user_id: args.p_user_id, role: args.p_role }) }, error: null })
const mount = (overrides = {}) => {
  const props = { org, session, members, invitations, client: { rpc: vi.fn().mockImplementation(async (name, args) => responseFor(name, args)), functions: { invoke: vi.fn() } }, reload: vi.fn().mockResolvedValue(), ...overrides }
  return { ...render(<TeamRoles key={`${props.session.user.id}:${props.org.id}`} {...props}/>), props }
}
const setup = async (overrides = {}) => {
  const view = mount(overrides)
  await waitFor(() => expect(screen.getByLabelText('Role for employee@example.test').disabled).toBe(false))
  return view
}
const writes = client => client.rpc.mock.calls.filter(([name]) => name !== 'kairo_team_access_status')
const row = (name = 'employee') => screen.getByRole('article', { name: `Access for ${name}@example.test` })
const edit = () => {
  fireEvent.change(screen.getByLabelText('Role for employee@example.test'), { target: { value: 'viewer' } })
  fireEvent.click(within(row()).getByRole('button', { name: 'Save role' }))
}
const openRemove = (name = 'employee') => {
  const opener = within(row(name)).getByRole('button', { name: 'Remove access' })
  opener.focus()
  fireEvent.click(opener)
  return { opener, dialog: screen.getByRole('alertdialog') }
}
afterEach(cleanup)

describe('independent Team & Roles fault and interruption review', () => {
  for (const [name, data] of [
    ['empty object', {}], ['empty list', []], ['missing object', null], ['false status', { ok: false }],
    ['bare success', { ok: true }],
    ['other organization', { ok: true, organization_id: 'other-org', user_id: 'employee', role: 'viewer' }],
    ['other user', { ok: true, organization_id: 'org-a', user_id: 'other-user', role: 'viewer' }],
    ['other role', { ok: true, organization_id: 'org-a', user_id: 'employee', role: 'admin' }],
  ]) it(`does not claim success with ${name} acknowledgment`, async () => {
    const { props } = await setup()
    props.client.rpc.mockResolvedValue({ data, error: null })
    edit()
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.queryByRole('status')).toBeNull()
    expect(props.reload).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Role for employee@example.test').disabled).toBe(true)
  })

  it('restores removal opener focus on cancellation', async () => {
    await setup()
    const { opener, dialog } = openRemove()
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('traps tab order and returns focus after Escape', async () => {
    await setup()
    const { opener, dialog } = openRemove()
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' })
    const remove = within(dialog).getByRole('button', { name: 'Remove access' })
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(remove)
    fireEvent.keyDown(remove, { key: 'Tab' })
    expect(document.activeElement).toBe(cancel)
    fireEvent.keyDown(cancel, { key: 'Escape' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('keeps pending removal locked against duplicate action or Escape', async () => {
    const { props } = await setup()
    const d = defer()
    props.client.rpc.mockReturnValue(d.promise)
    const { dialog } = openRemove()
    const remove = within(dialog).getByRole('button', { name: 'Remove access' })
    fireEvent.click(remove)
    fireEvent.click(remove)
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(writes(props.client)).toHaveLength(1)
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Cancel' }).disabled).toBe(true)
    await act(async () => d.resolve(responseFor('kairo_remove_member', { p_organization_id: 'org-a', p_user_id: 'employee' })))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('does not apply an old invitation result after account/company remount', async () => {
    const { props, rerender } = await setup()
    const d = defer()
    props.client.functions.invoke.mockReturnValue(d.promise)
    fireEvent.change(screen.getByLabelText('Employee email'), { target: { value: 'new@example.test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create invite' }))
    rerender(<TeamRoles key="other-actor:org-b" {...props} org={{ id: 'org-b', name: 'Other Company' }} session={{ user: { id: 'other-actor' } }} members={[{ user_id: 'other-actor', email: 'other@example.test', role: 'owner' }]}/>)
    await act(async () => d.resolve({ data: { ok: true, invite: { organization_id: 'org-a', email: 'new@example.test', role: 'member', status: 'Pending' }, invite_url: 'https://example.test/app/?invite=synthetic' }, error: null }))
    expect(props.reload).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Secure invitation link')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByLabelText('Employee email').value).toBe('')
  })

  it('rejects a revoke acknowledgment for a different invitation', async () => {
    const { props } = await setup()
    props.client.rpc.mockResolvedValue({ data: { ok: true, organization_id: 'org-a', id: 'other-invite', status: 'Revoked' }, error: null })
    fireEvent.click(screen.getByRole('button', { name: 'Revoke invitation' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Revoke invitation' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(props.reload).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('rejects a successful write followed by a failed refresh as uncertain current state', async () => {
    const { props } = await setup()
    props.reload.mockRejectedValue(new Error('Refresh failed'))
    edit()
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByLabelText('Role for employee@example.test').disabled).toBe(true)
  })

  it('closes a now-disallowed removal when owner is downgraded to admin', async () => {
    const { props, rerender } = await setup()
    openRemove('admin')
    rerender(<TeamRoles key="actor:org-a" {...props} members={members.map(member => member.user_id === 'actor' ? { ...member, role: 'admin' } : member)}/>)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(writes(props.client)).toHaveLength(0)
    await waitFor(() => expect(screen.getByText(/Team access changes are unavailable/)).toBeTruthy())
  })
})

describe('independent backend readiness gate', () => {
  const gated = () => {
    expect(screen.getByLabelText('Role for employee@example.test').disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Create invite' }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Revoke invitation' }).disabled).toBe(true)
    for (const button of screen.getAllByRole('button', { name: 'Remove access' })) expect(button.disabled).toBe(true)
  }
  const clientForStatus = response => ({ rpc: vi.fn().mockImplementation((name, args) => name === 'kairo_team_access_status' ? Promise.resolve(response) : Promise.resolve(responseFor(name, args))), functions: { invoke: vi.fn() } })

  it('does not write while deployment readiness is pending', async () => {
    const d = defer()
    const client = clientForStatus(d.promise)
    mount({ client })
    expect(screen.getByText('Checking team access…')).toBeTruthy()
    gated()
    // The gate must hold in handlers too, including direct form submission.
    fireEvent.submit(screen.getByRole('button', { name: 'Create invite' }).closest('form'))
    edit()
    expect(writes(client)).toHaveLength(0)
    expect(client.functions.invoke).not.toHaveBeenCalled()
    await act(async () => d.resolve(readiness()))
    await waitFor(() => expect(screen.getByLabelText('Role for employee@example.test').disabled).toBe(false))
  })

  for (const [name, response] of [
    ['missing RPC', { data: null, error: { code: 'PGRST202', message: 'Could not find function' } }],
    ['missing response', { data: null, error: null }],
    ['empty object', { data: {}, error: null }],
    ['false acknowledgment', readiness({ ok: false })],
    ['older security version', readiness({ version: 0 })],
    ['unknown security version', readiness({ version: 2 })],
    ['string security version', readiness({ version: '1' })],
    ['other organization', readiness({ organization_id: 'other-org' })],
    ['other actor role', readiness({ actor_role: 'admin' })],
    ['missing actor role', readiness({ actor_role: undefined })],
  ]) it(`keeps mutation controls gated for ${name}`, async () => {
    const client = clientForStatus(response)
    mount({ client })
    await waitFor(() => expect(screen.getByText(/Team access changes are unavailable/)).toBeTruthy())
    gated()
    expect(screen.getByRole('button', { name: 'Retry access check' })).toBeTruthy()
    expect(client.rpc).toHaveBeenCalledWith('kairo_team_access_status', { p_organization_id: 'org-a' })
    expect(writes(client)).toHaveLength(0)
    expect(client.functions.invoke).not.toHaveBeenCalled()
  })

  it('recovers through a successful explicit readiness retry', async () => {
    const client = clientForStatus({ data: null, error: { code: 'PGRST202' } })
    mount({ client })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry access check' })).toBeTruthy())
    const d = defer()
    client.rpc.mockImplementation(name => name === 'kairo_team_access_status' ? d.promise : Promise.reject(new Error('Unexpected mutation')))
    fireEvent.click(screen.getByRole('button', { name: 'Retry access check' }))
    gated()
    expect(screen.getByText('Checking team access…')).toBeTruthy()
    await act(async () => d.resolve(readiness()))
    await waitFor(() => expect(screen.getByLabelText('Role for employee@example.test').disabled).toBe(false))
    expect(screen.queryByText(/Team access changes are unavailable/)).toBeNull()
    expect(writes(client)).toHaveLength(0)
  })

  it('ignores old company readiness while the new company is still pending', async () => {
    const a = defer(), b = defer()
    const client = clientForStatus(a.promise)
    client.rpc.mockImplementation((name, args) => args.p_organization_id === 'org-a' ? a.promise : b.promise)
    const { props, rerender } = mount({ client })
    rerender(<TeamRoles key="actor:org-b" {...props} org={{ id: 'org-b', name: 'Other Company' }}/>)
    await act(async () => a.resolve(readiness()))
    gated()
    expect(screen.getByText('Checking team access…')).toBeTruthy()
    await act(async () => b.resolve(readiness({ organization_id: 'org-b' })))
    await waitFor(() => expect(screen.getByLabelText('Role for employee@example.test').disabled).toBe(false))
    expect(writes(client)).toHaveLength(0)
  })

  it('ignores old account readiness while the new account is still pending', async () => {
    const a = defer(), b = defer()
    const client = clientForStatus(a.promise)
    client.rpc.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
    const { props, rerender } = mount({ client })
    rerender(<TeamRoles key="other-actor:org-a" {...props} session={{ user: { id: 'other-actor' } }} members={[...members, { user_id: 'other-actor', role: 'owner', email: 'other@example.test' }]}/>)
    await act(async () => a.resolve(readiness()))
    gated()
    expect(screen.getByText('Checking team access…')).toBeTruthy()
    await act(async () => b.resolve(readiness()))
    await waitFor(() => expect(screen.getByLabelText('Role for employee@example.test').disabled).toBe(false))
    expect(writes(client)).toHaveLength(0)
  })

  it('rechecks changed actor access and ignores an older elevated readiness response', async () => {
    const owner = defer(), admin = defer()
    const client = clientForStatus(owner.promise)
    client.rpc.mockReturnValueOnce(owner.promise).mockReturnValueOnce(admin.promise)
    const { props, rerender } = mount({ client })
    rerender(<TeamRoles key="actor:org-a" {...props} members={members.map(member => member.user_id === 'actor' ? { ...member, role: 'admin' } : member)}/>)
    await act(async () => owner.resolve(readiness()))
    gated()
    expect(screen.getByText('Checking team access…')).toBeTruthy()
    await act(async () => admin.resolve(readiness({ actor_role: 'admin' })))
    await waitFor(() => expect(screen.getByLabelText('Role for employee@example.test').disabled).toBe(false))
    expect(screen.getByLabelText('Role for admin@example.test').disabled).toBe(true)
    expect(writes(client)).toHaveLength(0)
  })
})
