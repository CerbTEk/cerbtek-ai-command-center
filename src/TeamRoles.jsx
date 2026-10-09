import React, { useEffect, useRef, useState } from 'react'
import { TEAM_ROLES, roleLabel, roleDescription, canManageTeam, assignableRoles, inviteRoles, canRevokeInvite, teamError } from './team-roles'
import './team-roles.css'

export default function TeamRoles({ org, session, members = [], invitations = [], reload, client, refreshing = false }) {
  const context = `${session.user.id}:${org.id}`
  // App keys this component by company + account. Also ignore all obsolete promises.
  const live = useRef({ context, mounted: true })
  live.current.context = context
  useEffect(() => { live.current.mounted = true; return () => { live.current.mounted = false } }, [])
  const [drafts, setDrafts] = useState({})
  const [busy, setBusy] = useState('')
  const inFlight = useRef(false)
  const [feedback, setFeedback] = useState(null)
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [backendState, setBackendState] = useState(null)
  const accessRequest = useRef(0)
  const [query, setQuery] = useState('')
  const [email, setEmail] = useState('')
  const [inviteRole, setInviteRole] = useState('member')
  const [inviteLink, setInviteLink] = useState('')
  const [confirm, setConfirm] = useState(null)
  const dialogRef = useRef(null)
  useEffect(() => {
    if (!confirm) return
    const previous = document.activeElement
    const dialog = dialogRef.current
    if (typeof dialog?.showModal === 'function') dialog.showModal()
    else dialog?.setAttribute('open', '')
    dialog?.querySelector('button')?.focus()
    return () => {
      if (typeof dialog?.close === 'function') dialog.close()
      if (previous?.isConnected) previous.focus()
    }
  }, [confirm])
  const actorRole = members.find(member => member.user_id === session.user.id)?.role
  const managed = canManageTeam(actorRole)
  const allowedInvites = inviteRoles(actorRole)
  const backendReady = backendState?.status === 'ready' && backendState.context === context && backendState.role === actorRole
  const blocked = Boolean(busy || refreshing || needsRefresh || !backendReady)
  const displayName = member => member.email || member.name || `Account ${member.user_id}`
  const filtered = members.filter(member => `${displayName(member)} ${roleLabel(member.role)}`.toLowerCase().includes(query.trim().toLowerCase()))
  const current = () => live.current.mounted && live.current.context === context
  useEffect(() => {
    if (!allowedInvites.some(role => role.value === inviteRole)) setInviteRole('member')
    setDrafts({}); setInviteLink(''); setConfirm(null)
  }, [actorRole])

  async function checkTeamAccess() {
    const request = ++accessRequest.current
    if (!managed) { setBackendState(null); return }
    setBackendState({ status: 'checking', context, role: actorRole })
    try {
      const { data, error } = await client.rpc('kairo_team_access_status', { p_organization_id: org.id })
      if (!current() || request !== accessRequest.current) return
      if (error || data?.ok !== true || data.version !== 1 || data.organization_id !== org.id || data.actor_role !== actorRole) throw new Error('Team access not verified')
      setBackendState({ status: 'ready', context, role: actorRole })
    } catch {
      if (current() && request === accessRequest.current) setBackendState({ status: 'unavailable', context, role: actorRole })
    }
  }
  useEffect(() => {
    checkTeamAccess()
    return () => { accessRequest.current++ }
  }, [context, actorRole])

  async function refreshTeam() {
    if (inFlight.current) return
    inFlight.current = true; setBusy('refresh'); setFeedback(null)
    try {
      await reload()
      if (!current()) return
      setDrafts({}); setNeedsRefresh(false); setConfirm(null)
      await checkTeamAccess()
    } catch {
      if (current()) setFeedback({ error: true, text: 'The team could not be refreshed. Try again before making changes.' })
    } finally { if (current()) { inFlight.current = false; setBusy('') } }
  }

  async function mutate(key, request, success) {
    if (inFlight.current || refreshing || needsRefresh || !backendReady) return
    inFlight.current = true; setBusy(key); setFeedback(null)
    try {
      const result = await request()
      if (!current()) return
      if (result.error || result.data?.error) throw result.error || result.data.error
      // A failed/malformed response is never evidence that the write succeeded.
      if (!result.data || result.data.ok !== true) throw new Error('Missing confirmation')
      success(result.data)
      setConfirm(null)
      await reload()
    } catch (error) {
      if (current()) { setNeedsRefresh(true); setFeedback({ error: true, text: teamError(error) }) }
    } finally { if (current()) { inFlight.current = false; setBusy('') } }
  }

  function saveRole(member) {
    const role = drafts[member.user_id]?.value
    const expected = drafts[member.user_id]?.expected
    if (!assignableRoles(actorRole, member.role, member.user_id === session.user.id).some(option => option.value === role) || role === member.role) return
    return mutate(member.user_id, () => client.rpc('kairo_set_member_role', {
      p_organization_id: org.id, p_user_id: member.user_id, p_role: role, p_expected_role: expected,
    }), data => {
      if (data.organization_id !== org.id || data.user_id !== member.user_id || data.role !== role) throw new Error('Mismatched confirmation')
      setDrafts(values => { const next = { ...values }; delete next[member.user_id]; return next })
      setFeedback({ text: `${displayName(member)} now has the ${roleLabel(role)} role.` })
    })
  }

  function createInvite(event) {
    event.preventDefault()
    if (!allowedInvites.some(role => role.value === inviteRole)) return
    setInviteLink('')
    return mutate('invite', () => client.functions.invoke('organization-invite', { body: { op: 'create', organization_id: org.id, email: email.trim(), role: inviteRole } }), data => {
      if (!data.invite_url || data.invite?.organization_id !== org.id || data.invite?.email !== email.trim().toLowerCase() || data.invite?.role !== inviteRole || data.invite?.status !== 'Pending') throw new Error('Missing invitation confirmation')
      setInviteLink(data.invite_url); setEmail('')
      setFeedback({ text: 'Invitation created. Copy the secure link and share it with the invited employee. No email was sent.' })
    })
  }

  function confirmAction() {
    if (!confirm) return
    if (confirm.type === 'member') {
      const member = confirm.item
      return mutate(`remove:${member.user_id}`, () => client.rpc('kairo_remove_member', { p_organization_id: org.id, p_user_id: member.user_id, p_expected_role: member.role }), data => {
        if (data.organization_id !== org.id || data.user_id !== member.user_id) throw new Error('Mismatched confirmation')
        setFeedback({ text: `Company access removed for ${displayName(member)}.` })
      })
    }
    const invite = confirm.item
    return mutate(`revoke:${invite.id}`, () => client.rpc('kairo_revoke_invitation', { p_organization_id: org.id, p_invitation_id: invite.id }), data => {
      if (data.organization_id !== org.id || data.id !== invite.id) throw new Error('Mismatched confirmation')
      setFeedback({ text: `Invitation revoked for ${invite.email}.` })
    })
  }

  async function copyInvite() {
    try { await navigator.clipboard.writeText(inviteLink); if (current()) setFeedback({ text: 'Invitation link copied.' }) }
    catch { if (current()) setFeedback({ error: true, text: 'Copy the invitation link from the field below.' }) }
  }

  return <div className="team-roles">
    <section className="panel team-intro" aria-labelledby="team-company-heading">
      <div><p className="eyebrow">COMPANY ACCESS</p><h2 id="team-company-heading">Your team at {org.name}</h2><p>Choose what each employee can do in this company. Your role: <b>{roleLabel(actorRole)}</b>.</p></div>
      <button type="button" className="secondary" disabled={Boolean(busy || refreshing)} onClick={refreshTeam}>{busy === 'refresh' ? 'Refreshing…' : 'Refresh team'}</button>
      {!managed && <p className="team-access-note">Only company owners and admins can manage employee access. Ask an owner if a role needs changing.</p>}
      {actorRole === 'admin' && <p className="team-access-note">You can manage Employee and Viewer access. An owner manages Admin, Consultant, and Owner roles.</p>}
      <p className="team-access-note">Company roles apply only to this company. CerbTEK staff and internal Funding access are managed separately. Workflow approvals still follow each workflow’s policy.</p>
    </section>

    {managed && !backendReady && <div className="team-feedback team-feedback-error" role={backendState?.status === 'checking' ? 'status' : 'alert'}>{backendState?.status === 'checking' ? 'Checking team access…' : <>Team access changes are unavailable until the security update is installed and your access is verified. <button type="button" className="secondary" disabled={Boolean(busy || refreshing)} onClick={checkTeamAccess}>Retry access check</button></>}</div>}

    {feedback && <div className={`team-feedback ${feedback.error ? 'team-feedback-error' : ''}`} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</div>}
    {needsRefresh && <p className="team-access-note">Refresh the team to see the latest saved roles and unlock further changes.</p>}

    <section className="panel" aria-labelledby="employee-roster-heading">
      <div className="team-section-heading"><div><h2 id="employee-roster-heading">Employees & access</h2><p>{members.length} {members.length === 1 ? 'member' : 'members'} · {members.filter(member => member.role === 'owner').length} owners</p></div><label className="team-search">Find an employee<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Email or role"/></label></div>
      <div className="team-member-list">{filtered.map(member => {
        const self = member.user_id === session.user.id
        const choices = assignableRoles(actorRole, member.role, self)
        const draft = drafts[member.user_id]
        const selected = draft?.value || member.role
        const changed = selected !== member.role
        const editable = choices.length > 0
        const name = displayName(member)
        return <article className="team-member" key={member.user_id} aria-label={`Access for ${name}`}>
          <div className="team-member-person"><strong>{name}</strong><span>{self ? 'You · ' : ''}{roleLabel(member.role)}{member.created_at && !Number.isNaN(Date.parse(member.created_at)) ? ` · Joined ${new Date(member.created_at).toLocaleDateString()}` : ''}</span></div>
          <div className="team-member-control"><label>Company role<select aria-label={`Role for ${name}`} value={selected} disabled={!editable || blocked} onChange={event => setDrafts(values => ({ ...values, [member.user_id]: { value: event.target.value, expected: values[member.user_id]?.expected || member.role } }))}>
            {(editable ? choices : TEAM_ROLES.filter(role => role.value === member.role)).map(role => <option key={role.value} value={role.value}>{role.label}</option>)}
            {!TEAM_ROLES.some(role => role.value === member.role) && <option value={member.role}>Unrecognized role</option>}
          </select></label><p>{roleDescription(selected)}</p>{self && managed && <small>Your own role is protected. Ask another owner to change it.</small>}
          {editable && changed && <p className="team-role-change">Unsaved change: {roleLabel(member.role)} → {roleLabel(selected)}</p>}</div>
          {editable && <div className="team-member-actions"><button className="primary" type="button" disabled={!changed || blocked} onClick={() => saveRole(member)}>{busy === member.user_id ? 'Saving…' : 'Save role'}</button>{changed && <button className="secondary" type="button" disabled={blocked} onClick={() => setDrafts(values => { const next = { ...values }; delete next[member.user_id]; return next })}>Cancel change</button>}<button className="team-remove" type="button" disabled={blocked} onClick={() => setConfirm({ type: 'member', item: member })}>Remove access</button></div>}
        </article>
      })}</div>
      {!filtered.length && <p className="empty">{members.length ? 'No employees match your search.' : 'No company memberships are available. Refresh the team to check your access.'}</p>}
    </section>

    <details className="panel team-role-guide"><summary>What each role can do</summary><dl>{TEAM_ROLES.map(role => <div key={role.value}><dt>{role.label}{role.value === 'member' && <span> (stored as Member)</span>}</dt><dd>{role.description}</dd></div>)}</dl></details>

    {managed && <section className="panel" aria-labelledby="invite-employee-heading">
      <h2 id="invite-employee-heading">Invite an employee</h2><p>Create a seven-day invitation for this company. The employee must sign in with the invited email address. You share the secure link yourself.</p>
      <form className="team-invite-form" onSubmit={createInvite}><label>Employee email<input type="email" value={email} maxLength={254} onChange={event => setEmail(event.target.value)} required disabled={blocked}/></label><label>Invitation role<select value={inviteRole} onChange={event => setInviteRole(event.target.value)} disabled={blocked}>{allowedInvites.map(role => <option key={role.value} value={role.value}>{role.label}</option>)}</select></label><button className="primary" type="submit" disabled={blocked}>{busy === 'invite' ? 'Creating…' : 'Create invite'}</button></form>
      <p className="team-access-note">{roleDescription(inviteRole)}</p>
      {inviteLink && <div className="invite-link-box"><label>Secure invitation link<input value={inviteLink} readOnly onFocus={event => event.target.select()}/></label><button className="secondary" type="button" onClick={copyInvite}>Copy link</button></div>}
    </section>}

    {managed && <section className="panel" aria-labelledby="team-invitations-heading"><h2 id="team-invitations-heading">Invitations</h2><div className="member-list">{invitations.map(invite => <div className="member-row" key={invite.id}><div><b>{invite.email}</b><span>{roleLabel(invite.role)} · {invite.status} · Expires {new Date(invite.expires_at).toLocaleString()}</span></div>{invite.status === 'Pending' && canRevokeInvite(actorRole, invite.role) && <button type="button" className="secondary" disabled={blocked} onClick={() => setConfirm({ type: 'invite', item: invite })}>Revoke invitation</button>}</div>)}</div>{!invitations.length && <p className="empty">No invitations yet.</p>}</section>}

    {confirm && <dialog ref={dialogRef} role="alertdialog" aria-modal="true" aria-labelledby="team-confirm-title" aria-describedby="team-confirm-detail" className="panel team-confirm" onCancel={event => { event.preventDefault(); if (!busy) setConfirm(null) }} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); if (!busy) setConfirm(null) }
      if (event.key === 'Tab') {
        const buttons = [...event.currentTarget.querySelectorAll('button:not(:disabled)')]
        if (!buttons.length) { event.preventDefault(); return }
        const first = buttons[0], last = buttons.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
    }}>
      <h2 id="team-confirm-title">{confirm.type === 'member' ? 'Remove company access?' : 'Revoke this invitation?'}</h2><p id="team-confirm-detail">{confirm.type === 'member' ? `${displayName(confirm.item)} will lose access to ${org.name}. Their account and existing work will remain.` : `${confirm.item.email} will no longer be able to join ${org.name} using this invitation.`}</p><div className="team-confirm-actions"><button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => setConfirm(null)}>Cancel</button><button type="button" className="primary" disabled={blocked} onClick={confirmAction}>{busy ? 'Saving…' : confirm.type === 'member' ? 'Remove access' : 'Revoke invitation'}</button></div>
    </dialog>}
  </div>
}
