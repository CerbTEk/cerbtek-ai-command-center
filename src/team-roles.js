// These are the existing organization roles. CerbTEK staff roles are separate.
export const TEAM_ROLES = Object.freeze([
  { value: 'owner', label: 'Owner', description: 'Manage company access, including administrators and other owners. Manage company setup and eligible workflow approvals.' },
  { value: 'admin', label: 'Admin', description: 'Manage company setup and eligible workflow approvals. Assign Employee or Viewer access to employees below the Admin and Consultant roles.' },
  { value: 'consultant', label: 'Consultant', description: 'Manage company setup and eligible workflow approvals. Cannot manage employee roles or invitations.' },
  { value: 'member', label: 'Employee', description: 'Contribute to company records. Cannot manage employee access or make privileged workflow approvals.' },
  { value: 'viewer', label: 'Viewer', description: 'Read the company records available to the team. Cannot edit company records or manage employee access.' },
])
export const roleLabel = value => TEAM_ROLES.find(role => role.value === value)?.label || 'Unrecognized role'
export const roleDescription = value => TEAM_ROLES.find(role => role.value === value)?.description || 'Ask a company owner to review this role.'
export const canManageTeam = role => role === 'owner' || role === 'admin'
export function assignableRoles(actorRole, targetRole, isSelf = false) {
  if (isSelf || !TEAM_ROLES.some(role => role.value === targetRole)) return []
  if (actorRole === 'owner') return TEAM_ROLES
  if (actorRole === 'admin' && ['member', 'viewer'].includes(targetRole)) return TEAM_ROLES.filter(role => ['member', 'viewer'].includes(role.value))
  return []
}
export const inviteRoles = actorRole => TEAM_ROLES.filter(role => actorRole === 'owner' ? role.value !== 'owner' : actorRole === 'admin' && ['member', 'viewer'].includes(role.value))
export const canRevokeInvite = (actorRole, inviteRole) => actorRole === 'owner' || (actorRole === 'admin' && ['member', 'viewer'].includes(inviteRole))
export function teamError(error) {
  const code = String(error?.code || '')
  const message = String(error?.message || '')
  if (code === '40001' || /changed|stale|conflict|refresh/i.test(message)) return 'This employee’s access changed while you were editing. Refresh the team before trying again.'
  if (/last owner/i.test(message)) return 'The company must keep at least one owner. Ask another owner to review this change.'
  if (code === '42501' || /not authorized|permission|access denied|self/i.test(message)) return 'You no longer have permission to make this change. Refresh the team to check your current access.'
  return 'The change could not be confirmed. Refresh the team to check the current access before trying again.'
}
