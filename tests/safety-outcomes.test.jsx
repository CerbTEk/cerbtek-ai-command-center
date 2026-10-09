import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const api=vi.hoisted(()=>({invoke:vi.fn(),from:vi.fn()}))
vi.mock('../src/supabase',()=>({supabase:{functions:{invoke:api.invoke},from:api.from}}))
import { Agents, Integrations, Workflows } from '../src/main'

let serial=0
const pending=()=>{let resolve,reject;const promise=new Promise((res,rej)=>{resolve=res;reject=rej});return {promise,resolve,reject}}
function fixture(){
  const suffix=++serial
  const org={id:`org-${suffix}`,name:'Test company'}
  const session={user:{id:`reviewer-${suffix}`}}
  const snapshot={version:1,agent:{id:'agent',name:'Saved agent',human_control_mode:'Approve'},workflow:{id:'workflow',name:'Saved workflow',steps:[{type:'approval.email',to:'recipient@example.test',subject:'Saved subject',message:'Original saved message'}]},workflow_mapping:{execution_mode:'Execute',active:true},policy:{id:'policy',name:'Saved policy',require_approval:true},integration_bindings:[{mapping:{integration_id:'integration',access_mode:'Write'},connection:{id:'connection',external_account_name:'saved-account@example.test',scopes:['Mail.Send']}}],context:{purpose:'Saved context'}}
  const agent={id:'agent',name:'Edited live agent',status:'Active',human_control_mode:'Autonomous'}
  const workflow={id:'workflow',name:'Edited live workflow',status:'Active',steps:[{type:'approval.email',to:'edited@example.test',message:'Changed live message'}]}
  const request={id:'request',organization_id:org.id,agent_id:'agent',workflow_id:'workflow',status:'Approved',requested_by:'requester',approved_by:session.user.id,execution_snapshot:snapshot,created_at:'2026-10-08T00:00:00Z'}
  const email={id:'email',action_type:'send_email',status:'Approved',requested_by:'requester',approved_by:session.user.id,payload:{to:'recipient@example.test',subject:'Test subject',message:'Test message'},created_at:request.created_at}
  const reload=vi.fn()
  return {org,session,request,email,snapshot,agentProps:{org,session,rows:[agent],integrations:[],workflows:[workflow],mappings:[{agent_id:'agent',workflow_id:'workflow',active:true,execution_mode:'Execute'}],requests:[request],runs:[],reload},integrationProps:{org,session,systems:[],rows:[],oauth:[{provider:'microsoft',status:'Connected',oauth_verified_version:1,scopes:['User.Read','Mail.Send']}],runs:[],requests:[email],reload},workflowProps:{org,session,rows:[],definitions:[workflow],runs:[],approvalPolicies:[],schedules:[],reload},reload}
}
afterEach(()=>{cleanup();vi.restoreAllMocks();window.sessionStorage.clear()})
beforeEach(()=>{api.invoke.mockReset();api.from.mockReset()})
const message=()=>screen.queryAllByRole('status').map(node=>node.textContent).join(' ')
const click=label=>fireEvent.click(screen.getByRole('button',{name:label,exact:true}))

function dbResult(result={data:{id:'saved'},error:null}){
  const chain={insert:vi.fn(),upsert:vi.fn(),update:vi.fn(),select:vi.fn(),eq:vi.fn(),single:vi.fn(),then:(resolve,reject)=>Promise.resolve(result).then(resolve,reject)}
  for(const key of ['insert','upsert','update','select','eq']) chain[key].mockReturnValue(chain)
  chain.single.mockResolvedValue(result)
  api.from.mockReturnValue(chain)
  return chain
}

describe('agent human review and immutable plan',()=>{
  it('removes confidence authority and sends only the proposal contract',async()=>{
    const f=fixture();api.invoke.mockResolvedValue({data:{ok:true,status:'Pending',request:{...f.request,status:'Pending'}},error:null})
    render(<Agents {...f.agentProps}/> )
    expect(screen.queryByText(/confidence/i)).toBeNull()
    expect(screen.queryByRole('option',{name:'Autonomous'})).toBeNull()
    click('Request run')
    await waitFor(()=>expect(f.reload).toHaveBeenCalledTimes(1))
    expect(api.invoke).toHaveBeenCalledWith('agent-run',{body:{op:'request',organization_id:f.org.id,agent_id:'agent',workflow_id:'workflow',context:{}}})
    expect(message()).toContain('different authorized person')
  })
  it('creates agents with approval required and no confidence fields',async()=>{
    const f=fixture();const db=dbResult();render(<Agents {...f.agentProps}/> )
    fireEvent.change(screen.getByLabelText('Agent name'),{target:{value:'New controlled agent'}})
    fireEvent.change(screen.getByLabelText('Purpose'),{target:{value:'Read approved data'}})
    click('Create controlled agent')
    await waitFor(()=>expect(f.reload).toHaveBeenCalled())
    const payload=db.insert.mock.calls[0][0]
    expect(payload.human_control_mode).toBe('Approve')
    expect(payload).not.toHaveProperty('confidence_threshold')
    expect(payload).not.toHaveProperty('minimum_execution_confidence')
  })
  it('shows saved proposal content, bindings, policy and context instead of edited live steps',()=>{
    const f=fixture();render(<Agents {...f.agentProps}/> )
    const heading=screen.getByText('Immutable saved plan')
    const plan=heading.closest('.saved-agent-plan')
    expect(plan.textContent).toContain('Original saved message')
    expect(plan.textContent).toContain('recipient@example.test')
    expect(plan.textContent).toContain('Saved policy')
    expect(plan.textContent).toContain('saved-account@example.test')
    expect(plan.textContent).toContain('Saved context')
    expect(plan.textContent).not.toContain('Changed live message')
    expect(plan.textContent).not.toContain('edited@example.test')
    expect(within(plan).queryByRole('textbox')).toBeNull()
  })
  it.each(['self','missing'])('disables agent self approval or unknown requester: %s',kind=>{
    const f=fixture();f.request.status='Pending';f.request.requested_by=kind==='self'?f.session.user.id:null
    render(<Agents {...f.agentProps}/> )
    expect(screen.getByRole('button',{name:'Approve',exact:true}).disabled).toBe(true)
    click('Approve');expect(api.invoke).not.toHaveBeenCalled()
  })
  it.each(['Pending','Approved'])('requires a saved plan before %s can progress',status=>{
    const f=fixture();f.request.status=status;f.request.execution_snapshot=null
    render(<Agents {...f.agentProps}/> )
    expect(screen.getByRole('button',{name:status==='Pending'?'Approve':'Execute',exact:true}).disabled).toBe(true)
    expect(screen.getByText(/saved plan is unavailable/)).toBeTruthy()
  })
  it('confirms approval without claiming execution',async()=>{
    const f=fixture();f.request.status='Pending';api.invoke.mockResolvedValue({data:{ok:true,status:'Approved'},error:null})
    render(<Agents {...f.agentProps}/> );click('Approve')
    await waitFor(()=>expect(f.reload).toHaveBeenCalled())
    expect(message()).toContain('It has not executed')
    expect(screen.queryByText('Executed',{exact:true})).toBeNull()
  })
  it('does not convert malformed review acknowledgements to approval',async()=>{
    const f=fixture();f.request.status='Pending';api.invoke.mockResolvedValue({data:{ok:false,status:'Approved'},error:null})
    render(<Agents {...f.agentProps}/> );click('Approve')
    await waitFor(()=>expect(message()).toContain('review was not confirmed'))
    expect(f.reload).not.toHaveBeenCalled()
  })
})

describe('agent outcomes, repeat clicks and interrupted contexts',()=>{
  it('locks same-tick proposal and execute clicks before the next paint',async()=>{
    const f=fixture();const response=pending();api.invoke.mockReturnValue(response.promise)
    render(<Agents {...f.agentProps}/> )
    const button=screen.getByRole('button',{name:'Execute',exact:true})
    act(()=>{fireEvent.click(button);fireEvent.click(button)})
    expect(api.invoke).toHaveBeenCalledTimes(1)
    expect(button.disabled).toBe(true)
    await act(async()=>response.resolve({data:{ok:true,status:'Executed',workflow_status:'Success'},error:null}))
    expect(message()).toContain('Agent run executed')
  })
  it('keeps a waiting workflow incomplete and prevents another execution',async()=>{
    const f=fixture();api.invoke.mockResolvedValue({data:{ok:true,status:'Approved',workflow_status:'Waiting Approval',workflow_run_id:'run'},error:null})
    render(<Agents {...f.agentProps}/> );click('Execute')
    await waitFor(()=>expect(f.reload).toHaveBeenCalled())
    expect(message()).toContain('not complete')
    expect(screen.queryByText('Executed',{exact:true})).toBeNull()
    expect(screen.getByRole('button',{name:'Execute',exact:true}).disabled).toBe(true)
  })
  it.each(['Waiting Approval','Running','Reconciliation required'])('disables execution of an already linked %s request',status=>{
    const f=fixture();f.request.workflow_run_id='run';f.agentProps.runs=[{id:'run',status}]
    render(<Agents {...f.agentProps}/> )
    expect(screen.getByRole('button',{name:'Execute',exact:true}).disabled).toBe(true)
    expect(screen.getByText(new RegExp(`Workflow: ${status}`))).toBeTruthy()
    click('Execute');expect(api.invoke).not.toHaveBeenCalled()
  })
  it.each([{ok:true,status:'Success',workflow_status:'Success'},{ok:false,status:'Approved',workflow_status:'Reconciliation required',retryable:false},{}])('fails closed for an unconfirmed execute acknowledgement: %j',async data=>{
    const f=fixture();api.invoke.mockResolvedValue({data,error:null})
    render(<Agents {...f.agentProps}/> );click('Execute')
    await waitFor(()=>expect(f.reload).toHaveBeenCalled())
    expect(message()).toContain('needs review')
    expect(screen.queryByText('Executed',{exact:true})).toBeNull()
    expect(screen.getByRole('button',{name:'Execute',exact:true}).disabled).toBe(true)
  })
  it('keeps a lost agent acknowledgement locked after unmount and remount',async()=>{
    const f=fixture();api.invoke.mockRejectedValue(new Error('Network lost'))
    const view=render(<Agents {...f.agentProps}/> );click('Execute')
    await waitFor(()=>expect(message()).toContain('outcome needs review'))
    view.unmount();render(<Agents {...f.agentProps}/> )
    expect(screen.getByRole('button',{name:'Execute',exact:true}).disabled).toBe(true)
    click('Execute');expect(api.invoke).toHaveBeenCalledTimes(1)
  })
  it.each(['account','organization'])('ignores late agent acknowledgements after an %s switch',async kind=>{
    const f=fixture();const response=pending();api.invoke.mockReturnValue(response.promise)
    const view=render(<Agents key="old" {...f.agentProps}/> );click('Execute')
    const next={...f.agentProps,...(kind==='account'?{session:{user:{id:'other-user'}}}:{org:{id:'other-org'}})}
    view.rerender(<Agents key="new" {...next}/> )
    expect(screen.getByRole('button',{name:'Execute',exact:true}).disabled).toBe(false)
    await act(async()=>response.resolve({data:{ok:true,status:'Executed',workflow_status:'Success'},error:null}))
    expect(f.reload).not.toHaveBeenCalled()
    expect(message()).not.toContain('Agent run executed')
  })
})

describe('Microsoft accepted and uncertain sends',()=>{
  it.each(['unknown','provider_accepted_needs_reconciliation','not_dispatched_needs_reconciliation'])('shows 202 %s as needs review without offering resend',async outcome=>{
    const f=fixture();api.invoke.mockResolvedValue({data:{ok:false,status:'Executing',outcome,retryable:false},error:null})
    render(<Integrations {...f.integrationProps}/> );click('Send approved email')
    await waitFor(()=>expect(f.reload).toHaveBeenCalled())
    expect(message()).toContain('needs review')
    expect(message()).toContain('Do not resend')
    expect(screen.getByRole('button',{name:'Send approved email'}).disabled).toBe(true)
    expect(screen.queryByText('Microsoft accepted. Delivery is not confirmed.')).toBeNull()
    click('Send approved email');expect(api.invoke).toHaveBeenCalledTimes(1)
  })
  it('shows provider acceptance without claiming delivery and preserves workflow review',async()=>{
    const f=fixture();api.invoke.mockResolvedValue({data:{ok:true,status:'Executed',outcome:'provider_accepted',delivered:false,workflow_status:'Needs review',summary:'Email delivered!'},error:null})
    render(<Integrations {...f.integrationProps}/> );click('Send approved email')
    await waitFor(()=>expect(f.reload).toHaveBeenCalled())
    expect(message()).toContain('Microsoft accepted')
    expect(message()).toContain('Delivery is not confirmed')
    expect(message()).toContain('linked workflow needs review')
    expect(screen.queryByText('Email delivered!')).toBeNull()
  })
  it.each([{}, {ok:true,status:'Executed'}, {ok:false,status:'Executed',outcome:'provider_accepted'}])('does not treat incomplete send acknowledgement as success: %j',async data=>{
    const f=fixture();api.invoke.mockResolvedValue({data,error:null});render(<Integrations {...f.integrationProps}/> );click('Send approved email')
    await waitFor(()=>expect(f.reload).toHaveBeenCalled())
    expect(message()).toContain('outcome needs review')
    expect(screen.queryByText('Microsoft accepted. Delivery is not confirmed.')).toBeNull()
  })
  it('blocks rapid duplicate sends and persists a lost acknowledgement on remount',async()=>{
    const f=fixture();const response=pending();api.invoke.mockReturnValue(response.promise)
    const view=render(<Integrations {...f.integrationProps}/> );const button=screen.getByRole('button',{name:'Send approved email'})
    act(()=>{fireEvent.click(button);fireEvent.click(button)})
    expect(api.invoke).toHaveBeenCalledTimes(1)
    await act(async()=>response.reject(new Error('Network lost')))
    expect(message()).toContain('outcome needs review')
    view.unmount();render(<Integrations {...f.integrationProps}/> )
    expect(screen.getByRole('button',{name:'Send approved email'}).disabled).toBe(true)
  })
  it('keeps persisted Executing records in review with no send control',()=>{
    const f=fixture();f.email.status='Executing';render(<Integrations {...f.integrationProps}/> )
    expect(message()).toContain('Do not resend')
    expect(screen.queryByRole('button',{name:'Send approved email'})).toBeNull()
  })
  it('disables email self approval and allows an independent reviewer',async()=>{
    const f=fixture();f.email.status='Pending';f.email.requested_by=f.session.user.id
    const view=render(<Integrations {...f.integrationProps}/> )
    expect(screen.getByRole('button',{name:'Approve',exact:true}).disabled).toBe(true)
    f.email.requested_by='requester';view.rerender(<Integrations {...f.integrationProps}/> )
    api.invoke.mockResolvedValue({data:{ok:true,request:{...f.email,status:'Approved'}},error:null})
    click('Approve');await waitFor(()=>expect(f.reload).toHaveBeenCalled())
    expect(message()).toContain('It has not been sent')
  })
  it('preserves the separate manual email proposal without auto sending',async()=>{
    const f=fixture();api.invoke.mockResolvedValue({data:{ok:true,request:{...f.email,status:'Pending'}},error:null})
    render(<Integrations {...f.integrationProps}/> )
    fireEvent.change(screen.getByLabelText('Recipient'),{target:{value:'new@example.test'}})
    fireEvent.change(screen.getByLabelText('Subject'),{target:{value:'New subject'}})
    fireEvent.change(screen.getByLabelText('Message'),{target:{value:'New message'}})
    click('Submit for approval');await waitFor(()=>expect(f.reload).toHaveBeenCalled())
    expect(api.invoke).toHaveBeenCalledTimes(1)
    expect(api.invoke).toHaveBeenCalledWith('microsoft-action',{body:{op:'queue-email',organization_id:f.org.id,to:'new@example.test',subject:'New subject',message:'New message'}})
    expect(message()).toContain('queued for human approval')
  })
  it.each(['account','organization'])('ignores late send acknowledgement after an %s switch',async kind=>{
    const f=fixture();const response=pending();api.invoke.mockReturnValue(response.promise)
    const view=render(<Integrations key="old" {...f.integrationProps}/> );click('Send approved email')
    const next={...f.integrationProps,...(kind==='account'?{session:{user:{id:'another-user'}}}:{org:{id:'another-org'}})}
    view.rerender(<Integrations key="new" {...next}/> )
    expect(screen.getByRole('button',{name:'Send approved email'}).disabled).toBe(false)
    await act(async()=>response.resolve({data:{ok:true,status:'Executed',outcome:'provider_accepted'},error:null}))
    expect(f.reload).not.toHaveBeenCalled()
    expect(message()).not.toContain('Microsoft accepted')
  })
})

describe('separate manual workflows',()=>{
  it.each(['Success','Waiting Approval'])('retains the manual workflow route for %s',async status=>{
    const f=fixture();api.invoke.mockResolvedValue({data:{ok:true,status,run_id:'run'},error:null})
    render(<Workflows {...f.workflowProps}/> );click('Run')
    await waitFor(()=>expect(f.reload).toHaveBeenCalled())
    expect(api.invoke).toHaveBeenCalledWith('workflow-runner',{body:{workflow_id:'workflow',context:{}}})
    expect(message()).toContain(status==='Success'?'Workflow completed':'not complete')
    expect(screen.getByRole('button',{name:'Run',exact:true}).disabled).toBe(false)
  })
  it('locks an unknown manual workflow result across remount',async()=>{
    const f=fixture();api.invoke.mockResolvedValue({data:{ok:false,status:'Reconciliation required',retryable:false},error:null})
    const view=render(<Workflows {...f.workflowProps}/> );const button=screen.getByRole('button',{name:'Run',exact:true})
    act(()=>{fireEvent.click(button);fireEvent.click(button)})
    await waitFor(()=>expect(f.reload).toHaveBeenCalled())
    expect(api.invoke).toHaveBeenCalledTimes(1)
    expect(message()).toContain('outcome needs review')
    view.unmount();render(<Workflows {...f.workflowProps}/> )
    expect(screen.getByRole('button',{name:'Run',exact:true}).disabled).toBe(true)
  })
  it('does not let an obsolete workflow response update the newly selected company',async()=>{
    const f=fixture();const response=pending();api.invoke.mockReturnValue(response.promise)
    const view=render(<Workflows key="old" {...f.workflowProps}/> );click('Run')
    view.rerender(<Workflows key="new" {...f.workflowProps} org={{id:'new-company'}}/> )
    await act(async()=>response.resolve({data:{ok:true,status:'Success',run_id:'run'},error:null}))
    expect(f.reload).not.toHaveBeenCalled()
    expect(message()).not.toContain('Workflow completed')
    expect(screen.getByRole('button',{name:'Run',exact:true}).disabled).toBe(false)
  })
})


describe('renewed Microsoft authorization',()=>{
  it.each([undefined,0])('offers renewed setup for unverified Connected version %s and hides live reads and sends',version=>{
    const f=fixture();f.integrationProps.oauth[0].oauth_verified_version=version
    render(<Integrations {...f.integrationProps}/> )
    expect(screen.getByText(/needs renewed authorization/)).toBeTruthy()
    expect(screen.getByRole('button',{name:'Connect Microsoft 365'})).toBeTruthy()
    expect(screen.queryByRole('button',{name:'Health check'})).toBeNull()
    expect(screen.queryByRole('button',{name:'Send approved email'})).toBeNull()
  })
  it('does not retain a local unknown warning after the saved request confirms acceptance',async()=>{
    const f=fixture();api.invoke.mockRejectedValue(new Error('Network lost'))
    const view=render(<Integrations {...f.integrationProps}/> );click('Send approved email')
    await waitFor(()=>expect(message()).toContain('outcome needs review'))
    f.email.status='Executed';view.rerender(<Integrations {...f.integrationProps}/> )
    expect(screen.queryByText('Email outcome needs review. Do not resend.')).toBeNull()
    expect(screen.getByText('Microsoft accepted. Delivery is not confirmed.')).toBeTruthy()
  })
})


describe('saved email outcomes survive connection changes',()=>{
  it.each(['disabled','missing-scope','unverified','removed'])('keeps Executing history and do-not-resend warning visible when connection is %s',change=>{
    const f=fixture();f.email.status='Executing'
    if(change==='disabled') f.integrationProps.oauth[0].status='Disconnected'
    if(change==='missing-scope') f.integrationProps.oauth[0].scopes=['User.Read']
    if(change==='unverified') f.integrationProps.oauth[0].oauth_verified_version=0
    if(change==='removed') f.integrationProps.oauth=[]
    render(<Integrations {...f.integrationProps}/> )
    expect(screen.getByText('Test subject')).toBeTruthy()
    expect(message()).toContain('Do not resend')
    expect(screen.queryByRole('button',{name:'Send approved email'})).toBeNull()
    expect(screen.queryByRole('button',{name:'Submit for approval'})).toBeNull()
  })
})


describe('invalid saved plans fail closed',()=>{
  it.each([{}, {version:2}, {version:1,workflow:{steps:[]}}])('blocks approval and execution for incompatible saved plan %j',snapshot=>{
    const f=fixture();f.request.execution_snapshot=snapshot;f.request.status='Pending'
    const view=render(<Agents {...f.agentProps}/> )
    expect(screen.getByRole('button',{name:'Approve',exact:true}).disabled).toBe(true)
    f.request.status='Approved';view.rerender(<Agents {...f.agentProps}/> )
    expect(screen.getByRole('button',{name:'Execute',exact:true}).disabled).toBe(true)
    expect(screen.getByText(/saved plan is unavailable or incompatible/)).toBeTruthy()
  })
})
