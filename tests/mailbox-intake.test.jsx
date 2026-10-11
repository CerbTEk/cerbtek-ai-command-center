import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import MailboxIntake from '../src/MailboxIntake'
import WorkflowInstallations from '../src/WorkflowInstallations'
import { verifyMailboxResponse, validMailboxPreview } from '../src/mailbox-intake-model'
import { emptyInstallation } from '../src/workflow-installation-model'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const org = { id: id(1), name: 'Fixture business' }, session = { user: { id: id(2) } }
const installation = { ...emptyInstallation(), id: id(3), organization_id: org.id, revision: 4, name: 'Customer help', outcome: 'Reviewed customer replies', status: 'configured', readiness: { live_inference_enabled: false, automatic_execution_enabled: false, can_start: true, reasons: [], start_blocker: null } }
const context = { organizationId: org.id, installationId: installation.id, installationRevision: installation.revision }
const envelope = (extra = {}) => ({ ok: true, contract_version: 1, organization_id: org.id, installation_id: installation.id, installation_revision: installation.revision, ...extra })
const source = { id: id(4), revision: 1, folder_id: 'folder-inbox', folder_name: 'Customer requests', mailbox_id: 'mailbox-own' }
const preview = (extra = {}) => ({ id: id(5), expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(), message_id: 'message-immutable', thread_id: 'conversation-1', received_at: '2026-01-01T12:00:00Z', has_attachments: false, intake: { customer_name: 'Fixture customer', customer_email: 'customer@example.test', subject: 'Service question', message: 'Please help with my request.' }, ...extra })
function fixture(options = {}) {
  const data = envelope({ source: options.source === undefined ? source : options.source, capabilities: { mail_read: options.mailRead !== false, mailbox_id: source.mailbox_id, account_name: 'Connected Microsoft account' }, imports: options.imports || [] })
  const previews = options.previews || [preview()]
  const client = { functions: { invoke: vi.fn(async (route, { body }) => {
    if (route !== 'mailbox-intake') throw new Error('Unexpected route')
    if (body.operation === 'load') return { data }
    if (body.operation === 'folders') return { data: envelope({ folders: [{ id: source.folder_id, name: source.folder_name }, { id: 'folder-other', name: 'Other requests' }], has_more: false }) }
    if (body.operation === 'save') return { data: envelope({ source: { ...source, revision: body.expected_source_revision + 1, folder_id: body.folder_id, folder_name: body.folder_id === 'folder-other' ? 'Other requests' : source.folder_name } }) }
    if (body.operation === 'preview') return { data: envelope({ previews, has_more: false, skipped: 0 }) }
    if (body.operation === 'import') return { data: envelope({ workflow_id: id(6), replayed: false }) }
    throw new Error('Unexpected operation')
  }) } }
  return { data, client, previews }
}
const props = f => ({ org, session, installation, client: f.client })
const operations = f => f.client.functions.invoke.mock.calls.map(([, { body }]) => body.operation)
const callFor = (f, operation) => f.client.functions.invoke.mock.calls.filter(([, { body }]) => body.operation === operation)
async function showPreview(f) {
  await screen.findByText('Connected Microsoft account')
  fireEvent.click(screen.getByRole('button', { name: 'Preview messages' }))
  await screen.findByRole('article', { name: 'Preview: Service question' })
}

describe('mailbox response contract', () => {
  it('requires the exact tenant, installation, revision and contract on every operation', () => {
    const f = fixture()
    expect(verifyMailboxResponse(f.data, 'load', context)).toBe(f.data)
    for (const patch of [{ organization_id: id(90) }, { installation_id: id(90) }, { installation_revision: 3 }, { contract_version: 2 }, { ok: false }, { unexpected: true }]) expect(() => verifyMailboxResponse({ ...f.data, ...patch }, 'load', context)).toThrow()
  })
  it('fails closed on mismatched mailbox, malformed capabilities and receipts', () => {
    const f = fixture()
    for (const patch of [{ source: { ...source, mailbox_id: 'another-mailbox' } }, { capabilities: { ...f.data.capabilities, mail_read: 'true' } }, { imports: [{ preview_id: id(5), workflow_id: 'bad', message_id: 'x' }] }, { imports: Array.from({ length: 21 }, (_, n) => ({ preview_id: id(100 + n), workflow_id: id(200 + n), message_id: String(n) })) }]) expect(() => verifyMailboxResponse({ ...f.data, ...patch }, 'load', context)).toThrow()
  })
  it('bounds lists, rejects duplicates and validates save source revision exactly', () => {
    expect(() => verifyMailboxResponse(envelope({ folders: Array.from({ length: 51 }, (_, n) => ({ id: String(n), name: 'Folder' })), has_more: true }), 'folders', context)).toThrow()
    expect(() => verifyMailboxResponse(envelope({ folders: [{ id: 'same', name: 'A' }, { id: 'same', name: 'B' }], has_more: false }), 'folders', context)).toThrow()
    const saveContext = { ...context, mailboxId: source.mailbox_id, sourceRevision: 1, sourceId: source.id, folderId: source.folder_id }
    expect(() => verifyMailboxResponse(envelope({ source }), 'save', saveContext)).toThrow()
    expect(verifyMailboxResponse(envelope({ source: { ...source, revision: 2 } }), 'save', saveContext).source.revision).toBe(2)
  })
  it('requires constrained fixed fields and a short-lived preview', () => {
    expect(validMailboxPreview(preview())).toBe(true)
    for (const p of [preview({ expires_at: 'bad' }), preview({ expires_at: new Date(Date.now() + 3600000).toISOString() }), preview({ thread_id: null }), preview({ intake: { ...preview().intake, subject: 'Header\nInjection' } }), preview({ intake: { ...preview().intake, message: 'x'.repeat(6001) } }), preview({ intake: { ...preview().intake, customer_email: 'not-an-email' } }), preview({ intake: { ...preview().intake, html: '<b>not supported</b>' } })]) expect(validMailboxPreview(p)).toBe(false)
    expect(() => verifyMailboxResponse(envelope({ previews: [preview(), preview()], has_more: false, skipped: 0 }), 'preview', context)).toThrow()
    expect(() => verifyMailboxResponse(envelope({ workflow_id: id(6), replayed: 'yes' }), 'import', context)).toThrow()
  })
})

describe('explicit manager mailbox intake', () => {
  it('opens with metadata load only and sends the exact bound envelope', async () => {
    const f = fixture(); render(<MailboxIntake {...props(f)}/>)
    await screen.findByText('Connected Microsoft account')
    expect(operations(f)).toEqual(['load'])
    expect(f.client.functions.invoke).toHaveBeenCalledWith('mailbox-intake', { body: { operation: 'load', organization_id: org.id, installation_id: installation.id, installation_revision: installation.revision } })
    expect(screen.getByRole('button', { name: 'Preview messages' }).disabled).toBe(false)
    expect(screen.getByText(/no background sync, attachment retrieval/)).toBeTruthy()
  })
  it('separates listing, saving, previewing and individually approved importing', async () => {
    const f = fixture({ source: null }), onImported = vi.fn(), storage = vi.spyOn(Storage.prototype, 'setItem')
    render(<MailboxIntake {...props(f)} onImported={onImported}/>)
    await screen.findByText('Connected Microsoft account')
    expect(screen.getByRole('button', { name: 'Preview messages' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'List available folders' }))
    fireEvent.change(await screen.findByLabelText('Available top-level folder'), { target: { value: source.folder_id } })
    expect(operations(f)).toEqual(['load', 'folders'])
    fireEvent.click(screen.getByRole('button', { name: 'Save folder' }))
    await screen.findByText(/Mailbox folder saved/)
    expect(callFor(f, 'save')[0][1].body).toEqual({ operation: 'save', organization_id: org.id, installation_id: installation.id, installation_revision: 4, expected_source_revision: 0, folder_id: source.folder_id })
    expect(operations(f)).toEqual(['load', 'folders', 'save'])
    await showPreview(f)
    expect(screen.getByRole('button', { name: 'Import this message' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Import this message' }))
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(id(6)))
    expect(callFor(f, 'preview')[0][1].body).toEqual({ operation: 'preview', organization_id: org.id, installation_id: installation.id, installation_revision: 4, source_revision: 1 })
    expect(callFor(f, 'import')[0][1].body).toEqual({ operation: 'import', organization_id: org.id, installation_id: installation.id, installation_revision: 4, source_revision: 1, preview_id: id(5) })
    expect(storage).not.toHaveBeenCalled()
    expect(screen.getByText(/Message imported as an assigned customer request/)).toBeTruthy()
  })
  it('requires separately approved reconsent when Mail.Read is missing', async () => {
    const f = fixture({ mailRead: false }); render(<MailboxIntake {...props(f)}/>)
    await screen.findByText(/Mail.Read permission is missing/)
    expect(screen.getByRole('button', { name: 'List available folders' }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Preview messages' }).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: /grant|consent|connect/i })).toBeNull()
    expect(operations(f)).toEqual(['load'])
  })
  it('renders mailbox text literally and labels provenance and unread attachments', async () => {
    const text = '<img src=x onerror=alert(1)><script>evil()</script>'
    const p = preview({ has_attachments: true, intake: { ...preview().intake, message: text } })
    const f = fixture({ previews: [p] }); const view = render(<MailboxIntake {...props(f)}/>); await showPreview(f)
    expect(screen.getByText(text)).toBeTruthy()
    expect(view.container.querySelector('img, script, iframe')).toBeNull()
    expect(screen.getByText(/Microsoft mailbox source/)).toBeTruthy()
    expect(screen.getByText(/contents are not retrieved or imported/)).toBeTruthy()
  })
  it('rejects unverified previews without rendering their message text', async () => {
    const f = fixture({ previews: [preview({ intake: { ...preview().intake, customer_email: 'invalid' } })] }); render(<MailboxIntake {...props(f)}/>);
    await screen.findByText('Connected Microsoft account'); fireEvent.click(screen.getByRole('button', { name: 'Preview messages' }))
    await screen.findByRole('alert')
    expect(screen.queryByText('Please help with my request.')).toBeNull()
    expect(screen.getByRole('button', { name: 'Preview messages' }).disabled).toBe(true)
  })
  it('does not import expired previews', async () => {
    const f = fixture({ previews: [preview({ expires_at: new Date(Date.now() - 1000).toISOString() })] }); render(<MailboxIntake {...props(f)}/>); await showPreview(f)
    expect(screen.getByRole('checkbox').disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Import this message' }).disabled).toBe(true)
    expect(screen.getByText(/Preview expired/)).toBeTruthy()
    expect(callFor(f, 'import')).toHaveLength(0)
  })
  it('locks repeated clicks, Close and changing selection during an import', async () => {
    const f = fixture(), original = f.client.functions.invoke.getMockImplementation(), onClose = vi.fn(), onBusyChange = vi.fn(); let finish
    f.client.functions.invoke.mockImplementation((route, args) => args.body.operation === 'import' ? new Promise(resolve => { finish = resolve }) : original(route, args))
    render(<MailboxIntake {...props(f)} onClose={onClose} onBusyChange={onBusyChange}/>); await showPreview(f)
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'Import this message' })); fireEvent.click(screen.getByRole('button', { name: 'Import this message' }))
    expect(callFor(f, 'import')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Close mailbox intake' }).disabled).toBe(true)
    expect(screen.getByRole('checkbox').disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Close mailbox intake' })); expect(onClose).not.toHaveBeenCalled()
    expect(onBusyChange).toHaveBeenLastCalledWith(true)
    await act(async () => { finish({ data: envelope({ workflow_id: id(6), replayed: false }) }) })
    expect(onBusyChange).toHaveBeenLastCalledWith(false)
  })
  it('retries an unknown import using the same preview and source revision', async () => {
    const f = fixture(), original = f.client.functions.invoke.getMockImplementation(); let calls = 0
    f.client.functions.invoke.mockImplementation((route, args) => args.body.operation === 'import' && ++calls === 1 ? Promise.reject(new Error('Network unavailable')) : original(route, args))
    render(<MailboxIntake {...props(f)}/>); await showPreview(f); fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'Import this message' }))
    await screen.findByText(/import outcome is unconfirmed/)
    expect(screen.getByRole('button', { name: 'Close mailbox intake' }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Preview messages' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Retry this import safely' }))
    await screen.findByText(/Message imported as an assigned customer request/)
    expect(callFor(f, 'import')).toHaveLength(2)
    expect(callFor(f, 'import')[0][1].body).toEqual(callFor(f, 'import')[1][1].body)
  })
  it('keeps the earlier outcome unknown when a later retry is explicitly rejected', async () => {
    const f = fixture(), original = f.client.functions.invoke.getMockImplementation(); let attempts = 0
    f.client.functions.invoke.mockImplementation((route, args) => {
      if (args.body.operation !== 'import') return original(route, args)
      return ++attempts === 1 ? Promise.reject(new Error('Dropped')) : Promise.resolve({ data: { ok: false, error: 'mailbox_source_changed_or_not_ready', write_outcome: 'not_applied' } })
    })
    render(<MailboxIntake {...props(f)}/>); await showPreview(f); fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'Import this message' }))
    await screen.findByText(/import outcome is unconfirmed/)
    fireEvent.click(screen.getByRole('button', { name: 'Retry this import safely' }))
    await waitFor(() => expect(callFor(f, 'import')).toHaveLength(2))
    await screen.findByText(/import outcome is unconfirmed/)
    expect(screen.getByRole('button', { name: 'Retry this import safely' }).disabled).toBe(false)
    expect(screen.getByRole('button', { name: 'Close mailbox intake' }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Preview messages' }).disabled).toBe(true)
  })
  it('reconciles an unknown import from verified receipt metadata without reimporting', async () => {
    const f = fixture(), original = f.client.functions.invoke.getMockImplementation(), onImported = vi.fn()
    f.client.functions.invoke.mockImplementation((route, args) => args.body.operation === 'import' ? Promise.reject(new Error('Dropped')) : original(route, args))
    render(<MailboxIntake {...props(f)} onImported={onImported}/>); await showPreview(f); fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'Import this message' })); await screen.findByText(/import outcome is unconfirmed/)
    f.data.imports = [{ preview_id: id(5), message_id: preview().message_id, workflow_id: id(6) }]
    fireEvent.click(screen.getByRole('button', { name: 'Refresh intake status' }))
    await screen.findByText(/earlier import is confirmed/)
    expect(onImported).toHaveBeenCalledWith(id(6)); expect(callFor(f, 'import')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Retry this import safely' })).toBeNull()
  })
  it('rejects receipt metadata that matches the preview but names another message', async () => {
    const f = fixture(), original = f.client.functions.invoke.getMockImplementation(), onImported = vi.fn()
    f.client.functions.invoke.mockImplementation((route, args) => args.body.operation === 'import' ? Promise.reject(new Error('Dropped')) : original(route, args))
    render(<MailboxIntake {...props(f)} onImported={onImported}/>); await showPreview(f); fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'Import this message' })); await screen.findByText(/import outcome is unconfirmed/)
    f.data.imports = [{ preview_id: id(5), message_id: 'different-message', workflow_id: id(6) }]
    fireEvent.click(screen.getByRole('button', { name: 'Refresh intake status' }))
    await screen.findByText(/Mailbox intake could not be verified/)
    expect(onImported).not.toHaveBeenCalled()
    expect(screen.queryByText(/earlier import is confirmed/)).toBeNull()
  })
  it('forces a status reload after an uncertain folder save instead of resaving', async () => {
    const f = fixture(), original = f.client.functions.invoke.getMockImplementation()
    f.client.functions.invoke.mockImplementation((route, args) => args.body.operation === 'save' ? Promise.reject(new Error('Dropped')) : original(route, args))
    render(<MailboxIntake {...props(f)}/>); await screen.findByText('Connected Microsoft account'); fireEvent.click(screen.getByRole('button', { name: 'List available folders' }))
    fireEvent.change(await screen.findByLabelText('Available top-level folder'), { target: { value: 'folder-other' } }); fireEvent.click(screen.getByRole('button', { name: 'Save folder' }))
    await screen.findByText(/folder save may have completed/)
    fireEvent.click(screen.getByRole('button', { name: 'Save folder' })); expect(callFor(f, 'save')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Preview messages' }).disabled).toBe(true)
    f.data.source = { ...source, revision: 2, folder_id: 'folder-other', folder_name: 'Other requests' }
    fireEvent.click(screen.getByRole('button', { name: 'Refresh intake status' })); await screen.findByText('Other requests')
    expect(screen.getByRole('button', { name: 'Preview messages' }).disabled).toBe(false)
  })
  it('does not misreport a confirmed import as unknown when parent refresh fails', async () => {
    const f = fixture(), onImported = vi.fn().mockRejectedValue(new Error('Workspace refresh'))
    render(<MailboxIntake {...props(f)} onImported={onImported}/>); await showPreview(f); fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'Import this message' }))
    await screen.findByText(/customer workspace could not be refreshed/)
    expect(screen.queryByRole('button', { name: 'Retry this import safely' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Close mailbox intake' }).disabled).toBe(false)
  })
  it('drops delayed results and callbacks after switching companies', async () => {
    const f = fixture(), original = f.client.functions.invoke.getMockImplementation(), onImported = vi.fn(); let finish
    f.client.functions.invoke.mockImplementation((route, args) => args.body.operation === 'import' ? new Promise(resolve => { finish = resolve }) : original(route, args))
    const view = render(<MailboxIntake {...props(f)} onImported={onImported}/>); await showPreview(f); fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'Import this message' }))
    const next = fixture(); next.data.organization_id = id(70); next.data.source = null
    view.rerender(<MailboxIntake {...props(next)} org={{ id: id(70) }} installation={{ ...installation, organization_id: id(70) }} onImported={onImported}/>)
    await screen.findByText(/No mailbox folder is saved/)
    await act(async () => { finish({ data: envelope({ workflow_id: id(6), replayed: false }) }) })
    expect(onImported).not.toHaveBeenCalled(); expect(screen.queryByText(/Message imported/)).toBeNull()
  })
  it('drops delayed previews after switching installation revision', async () => {
    const f = fixture(), original = f.client.functions.invoke.getMockImplementation(); let finish
    f.client.functions.invoke.mockImplementation((route, args) => args.body.operation === 'preview' ? new Promise(resolve => { finish = resolve }) : original(route, args))
    const view = render(<MailboxIntake {...props(f)}/>); await screen.findByText('Connected Microsoft account'); fireEvent.click(screen.getByRole('button', { name: 'Preview messages' }))
    const next = fixture(); next.data.installation_revision = 5
    view.rerender(<MailboxIntake {...props(next)} installation={{ ...installation, revision: 5 }}/>)
    await screen.findByText(/workflow setup revision 5/)
    await act(async () => { finish({ data: envelope({ previews: [preview()], has_more: false, skipped: 0 }) }) })
    expect(screen.queryByText('Please help with my request.')).toBeNull()
  })
  it('shows a safe empty state and honest truncation/skipped counts', async () => {
    const f = fixture(), original = f.client.functions.invoke.getMockImplementation()
    f.client.functions.invoke.mockImplementation((route, args) => args.body.operation === 'preview' ? Promise.resolve({ data: envelope({ previews: [], skipped: 3, has_more: true }) }) : original(route, args))
    render(<MailboxIntake {...props(f)}/>); await screen.findByText('Connected Microsoft account'); fireEvent.click(screen.getByRole('button', { name: 'Preview messages' }))
    await screen.findByText(/0 message previews · 3 skipped/)
    expect(screen.getByText(/No supported messages/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Import this message' })).toBeNull()
  })
})

function installationFixture(role = 'owner') {
  const mailbox = fixture()
  const data = { ok: true, contract_version: 1, organization_id: org.id, actor: { id: session.user.id, role }, recipes: [{ recipe_key: 'customer_followup', recipe_version: 1 }], installations: [installation], workspace: { actor: { id: session.user.id, role }, people: [{ user_id: session.user.id, role }], context: null, configuration: null, readiness: {} } }
  const original = mailbox.client.functions.invoke.getMockImplementation()
  mailbox.client.functions.invoke.mockImplementation((route, args) => route === 'workflow-installations' ? Promise.resolve({ data }) : original(route, args))
  return mailbox
}
describe('installation integration', () => {
  it.each(['owner', 'admin', 'consultant'])('offers intake to a %s only after verified installation load', async role => {
    const f = installationFixture(role), dirty = vi.fn(), busy = vi.fn()
    render(<WorkflowInstallations org={org} session={session} client={f.client} onDirtyChange={dirty} onBusyChange={busy}/>)
    fireEvent.click(await screen.findByRole('button', { name: 'Mailbox intake: Customer help' }))
    await screen.findByRole('region', { name: 'Manager mailbox intake' })
    await screen.findByText('Connected Microsoft account')
    expect(dirty).toHaveBeenLastCalledWith(true); expect(busy).toHaveBeenLastCalledWith(false)
    fireEvent.click(screen.getByRole('button', { name: 'Close mailbox intake' }))
    await screen.findByRole('button', { name: 'Mailbox intake: Customer help' })
    expect(dirty).toHaveBeenLastCalledWith(false)
  })
  it.each([['member', false], ['viewer', false], ['owner', true], ['admin', true], ['consultant', true]])('never offers mailbox intake to %s in employee=%s mode', async (role, employee) => {
    const f = installationFixture(role)
    render(<WorkflowInstallations org={org} session={session} client={f.client} employee={employee}/>)
    await screen.findByText('Customer help')
    expect(screen.queryByRole('button', { name: 'Mailbox intake: Customer help' })).toBeNull()
    expect(f.client.functions.invoke.mock.calls.every(([route]) => route === 'workflow-installations')).toBe(true)
  })
})
