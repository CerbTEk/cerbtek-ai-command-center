import IntegrationProviderPlanner from './IntegrationProviderPlanner'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Activity, Bot, Building2, FileText, Gauge, LogOut, Plus, Plug, Printer,
  ServerCog, ShieldCheck, Sparkles, Trash2, Users, Workflow
} from 'lucide-react'
import { supabase } from './supabase'
import { assessmentComplete, deriveNextStep, onboardingComplete } from './first-use-guidance'
import { useSectionNavigation } from './use-section-navigation'
import KairoHelp from './KairoHelp'
import './styles.css'

const baseNav = [
  ['Overview', Gauge],
  ['Team Access', Users],
  ['Onboarding', Building2],
  ['AI Readiness', Sparkles],
  ['Systems', ServerCog],
  ['Workflows', Workflow],
  ['Opportunities', Sparkles],
  ['Integrations', Plug],
  ['Agents', Bot],
  ['AI Ops', Activity],
  ['Governance', ShieldCheck],
  ['Blueprints', FileText],
  ['Audit', Activity],
]

function App() {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [active, setActive, sectionHeadingRef] = useSectionNavigation()
  const [orgs, setOrgs] = useState([])
  const [org, setOrg] = useState(null)
  const [staff, setStaff] = useState(null)
  const [staffLoading,setStaffLoading]=useState(true)
  const [orgsLoading,setOrgsLoading]=useState(true)
  const [orgsError,setOrgsError]=useState('')
  const [orgsUserId,setOrgsUserId]=useState(null)
  const [dataLoading,setDataLoading]=useState(false)
  const [dataError,setDataError]=useState('')
  const [loadedOrgId,setLoadedOrgId]=useState(null)
  const [loadedUserId,setLoadedUserId]=useState(null)
  const orgLoadRequest=useRef(0)
  const orgsLoadRequest=useRef(0)
  const staffLoadRequest=useRef(0)
  const currentContext=useRef({userId:null,orgId:null})
  currentContext.current={userId:session?.user?.id||null,orgId:org?.id||null}
  const [data, setData] = useState({
    systems: [], workflows: [], opps: [], integrations: [], agents: [],
    policies: [], blueprints: [], audit: [], onboarding: null, readiness: null, oauth: [], integrationRuns: [], actionRequests: [],
    workflowDefinitions: [], workflowRuns: [], approvalPolicies: [], agentWorkflows: [], agentRunRequests: [],
    workflowSchedules: [], opsAlerts: [], members: [], invitations: [], dataPolicy: null
  })

  useEffect(() => {
    let disposed=false,authEventSeen=false
    supabase.auth.getSession().then(({ data }) => {
      if(disposed||authEventSeen) return
      setSession(data.session)
      setLoading(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => {
      if(disposed) return
      authEventSeen=true;setSession(s);setLoading(false)
    })
    return () => {disposed=true;subscription.unsubscribe()}
  }, [])

  useEffect(() => {
    // Token refreshes for the same user must not remount an in-progress form.
    orgLoadRequest.current++;orgsLoadRequest.current++;staffLoadRequest.current++
    setStaff(null)
    if (!session) return
    const userId=session.user.id
    loadStaff(userId)
    const invite=new URLSearchParams(window.location.search).get('invite')
    if(invite){
      supabase.functions.invoke('organization-invite',{body:{op:'accept',token:invite}}).then(({data,error})=>{
        if(currentContext.current.userId!==userId) return
        if(!error && !data?.error) window.history.replaceState({},'',window.location.pathname)
        loadOrgs(userId)
      })
    } else loadOrgs(userId)
  }, [session?.user?.id])

  useEffect(() => {
    if (org && session?.user?.id && orgsUserId===session.user.id && !orgsLoading) loadOrg(org.id)
  }, [org?.id,session?.user?.id,orgsUserId,orgsLoading])

  useEffect(()=>{
    if(active==='CerbTek Staff'&&!staffLoading&&!staff) setActive('Overview',{replace:true})
  },[active,staff,staffLoading])

  async function loadStaff(userId=session?.user?.id) {
    if(!userId||currentContext.current.userId!==userId) return
    const request=++staffLoadRequest.current
    const isCurrent=()=>request===staffLoadRequest.current&&currentContext.current.userId===userId
    setStaffLoading(true)
    try {
      const {data}=await supabase.from('staff_accounts').select('*').maybeSingle()
      if(isCurrent()) setStaff(data||null)
    } catch {
      if(isCurrent()) setStaff(null)
    } finally {
      if(isCurrent()) setStaffLoading(false)
    }
  }

  async function loadOrgs(userId=session?.user?.id) {
    if(!userId||currentContext.current.userId!==userId) return
    const request=++orgsLoadRequest.current
    const isCurrent=()=>request===orgsLoadRequest.current&&currentContext.current.userId===userId
    setOrgsUserId(userId);setOrgsLoading(true);setOrgsError('')
    try {
      const {data,error}=await supabase.from('organizations').select('*').order('created_at')
      if(!isCurrent()) return
      if(error) throw error
      setOrgs(data||[])
      setOrg(current=>(data||[]).find(item=>item.id===current?.id)||data?.[0]||null)
    } catch(error) {
      if(isCurrent()) setOrgsError('Your companies could not be loaded. Please try again before creating a workspace.')
    } finally { if(isCurrent()) setOrgsLoading(false) }
  }

  async function loadOrg(orgId,userId=session?.user?.id) {
    // A completed save may call a reload captured before a company/user switch.
    if(!userId||currentContext.current.userId!==userId||currentContext.current.orgId!==orgId) return
    const request=++orgLoadRequest.current
    const isCurrent=()=>request===orgLoadRequest.current&&currentContext.current.userId===userId&&currentContext.current.orgId===orgId
    setDataLoading(true);setDataError('')
    try {
    const [systems, workflows, opps, integrations, agents, policies, blueprints, audit, onboarding, readiness, oauth, integrationRuns, actionRequests, workflowDefinitions, workflowRuns, approvalPolicies, agentWorkflows, agentRunRequests, workflowSchedules, opsAlerts, members, invitations, dataPolicy] = await Promise.all([
      supabase.from('systems').select('*').eq('organization_id', orgId).order('created_at', { ascending: false }),
      supabase.from('workflows').select('*').eq('organization_id', orgId).order('created_at', { ascending: false }),
      supabase.from('ai_opportunities').select('*').eq('organization_id', orgId).order('opportunity_score', { ascending: false }),
      supabase.from('integrations').select('*').eq('organization_id', orgId).order('created_at', { ascending: false }),
      supabase.from('ai_agents').select('*').eq('organization_id', orgId).order('created_at', { ascending: false }),
      supabase.from('governance_policies').select('*').eq('organization_id', orgId).order('created_at', { ascending: false }),
      supabase.from('blueprints').select('*').eq('organization_id', orgId).order('created_at', { ascending: false }),
      supabase.from('audit_events').select('*').eq('organization_id', orgId).order('created_at', { ascending: false }).limit(100),
      supabase.from('organization_onboarding').select('*').eq('organization_id', orgId).maybeSingle(),
      supabase.from('readiness_assessments').select('*').eq('organization_id', orgId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('oauth_connections').select('*').eq('organization_id', orgId),
      supabase.from('integration_runs').select('*').eq('organization_id', orgId).order('created_at',{ascending:false}).limit(20),
      supabase.from('action_requests').select('*').eq('organization_id', orgId).order('created_at',{ascending:false}).limit(20),
      supabase.from('workflow_definitions').select('*').eq('organization_id', orgId).order('created_at',{ascending:false}),
      supabase.from('workflow_runs').select('*').eq('organization_id', orgId).order('created_at',{ascending:false}).limit(30),
      supabase.from('approval_policies').select('*').eq('organization_id', orgId).order('created_at',{ascending:false}),
      supabase.from('agent_workflows').select('*'),
      supabase.from('agent_run_requests').select('*').eq('organization_id', orgId).order('created_at',{ascending:false}).limit(30),
      supabase.from('workflow_schedules').select('*').eq('organization_id', orgId).order('created_at',{ascending:false}),
      supabase.from('ops_alerts').select('*').eq('organization_id', orgId).order('created_at',{ascending:false}).limit(50),
      supabase.functions.invoke('organization-members',{body:{organization_id:orgId}}),
      supabase.from('organization_invitations').select('*').eq('organization_id',orgId).order('created_at',{ascending:false}),
      supabase.from('organization_data_policies').select('*').eq('organization_id',orgId).maybeSingle(),
    ])
    if(!isCurrent()) return
    const responses=[systems,workflows,opps,integrations,agents,policies,blueprints,audit,onboarding,readiness,oauth,integrationRuns,actionRequests,workflowDefinitions,workflowRuns,approvalPolicies,agentWorkflows,agentRunRequests,workflowSchedules,opsAlerts,members,invitations,dataPolicy]
    if(responses.some(result=>result.error||result.data?.error)) throw new Error('Workspace information could not be loaded.')
    setData({
      systems: systems.data || [],
      workflows: workflows.data || [],
      opps: opps.data || [],
      integrations: integrations.data || [],
      agents: agents.data || [],
      policies: policies.data || [],
      blueprints: blueprints.data || [],
      audit: audit.data || [],
      onboarding: onboarding.data || null,
      readiness: readiness.data || null,
      oauth: oauth.data || [],
      integrationRuns: integrationRuns.data || [],
      actionRequests: actionRequests.data || [],
      workflowDefinitions: workflowDefinitions.data || [],
      workflowRuns: workflowRuns.data || [],
      approvalPolicies: approvalPolicies.data || [],
      agentWorkflows: agentWorkflows.data || [],
      agentRunRequests: agentRunRequests.data || [],
      workflowSchedules: workflowSchedules.data || [],
      opsAlerts: opsAlerts.data || [],
      members: members.data?.members || [],
      invitations: invitations.data || [],
      dataPolicy: dataPolicy.data || null
    })
    setLoadedOrgId(orgId)
    setLoadedUserId(userId)
    } catch(error) {
      if(isCurrent()) setDataError('Some workspace information could not be loaded. Refresh it before continuing setup; your saved work has not been reset.')
    } finally {
      if(isCurrent()) setDataLoading(false)
    }
  }

  if (loading) return <div className="center">Loading Kairo…</div>
  if (!session) return <Auth />
  if (orgsLoading||orgsUserId!==session.user.id) return <div className="center" role="status">Loading your companies…</div>
  if (orgsError) return <div className="auth-shell"><div className="auth-card"><h1>Could not load your companies</h1><p role="alert">{orgsError}</p><button className="primary" onClick={()=>loadOrgs()}>Try again</button></div></div>
  if (!orgs.length) return <CreateOrganization session={session} onCreated={loadOrgs} />

  const nav = staff ? [...baseNav, ['CerbTek Staff', Users]] : baseNav

  return <div className="app">
    <aside className="sidebar">
      <div className="brand"><img className="brand-mark" src="/kairo-mark.svg" alt="Kairo" width="42" height="42" /><div><strong>Kairo</strong><span>AI Enablement by CerbTek</span></div></div>
      <div className="org-switcher">
        <span>Client organization</span>
        <select value={org?.id || ''} onChange={e => setOrg(orgs.find(x => x.id === e.target.value))}>
          {orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </div>
      <nav>{nav.map(([label, Icon]) =>
        <button key={label} className={active === label ? 'active' : ''} onClick={() => setActive(label)}>
          <Icon size={17}/>{label}
        </button>
      )}</nav>
      <button className="signout" onClick={() => supabase.auth.signOut()}><LogOut size={16}/>Sign out</button>
    </aside>

    <main>
      <header>
        <div><p className="eyebrow">KAIRO COMMAND CENTER</p><h1 ref={sectionHeadingRef} tabIndex={-1}>{active}</h1></div>
        <div className="header-actions">
          {staff && <div className="staff-pill">{staff.role.replaceAll('_',' ')}</div>}
          <div className="tenant-pill"><Building2 size={15}/>{org.name}</div>
        </div>
      </header>
      <section className="content" aria-busy={dataLoading}>
        {dataLoading&&loadedOrgId===org.id&&loadedUserId===session.user.id&&!dataError&&<p role="status">Refreshing workspace…</p>}
        {dataError?<Panel title="Workspace information unavailable"><p role="alert">{dataError}</p><button className="primary" onClick={()=>loadOrg(org.id)}>Refresh workspace</button></Panel>:loadedOrgId!==org.id||loadedUserId!==session.user.id?<p role="status">Loading workspace…</p>:<>
        {active === 'Overview' && <Overview data={data} onGo={setActive}/>}
        {active === 'Team Access' && <TeamAccess org={org} session={session} members={data.members} invitations={data.invitations} reload={() => loadOrg(org.id)}/>}
        {active === 'Onboarding' && <Onboarding org={org} session={session} current={data.onboarding} reload={() => loadOrg(org.id)} onGo={setActive}/>}
        {active === 'AI Readiness' && <Readiness org={org} session={session} data={data} reload={() => loadOrg(org.id)} onGo={setActive}/>}
        {active === 'Systems' && <Systems org={org} session={session} rows={data.systems} reload={() => loadOrg(org.id)}/>}
        {active === 'Workflows' && <Workflows org={org} session={session} rows={data.workflows} definitions={data.workflowDefinitions} runs={data.workflowRuns} approvalPolicies={data.approvalPolicies} schedules={data.workflowSchedules} reload={() => loadOrg(org.id)}/>} 
        {active === 'Opportunities' && <Opportunities org={org} session={session} workflows={data.workflows} rows={data.opps} reload={() => loadOrg(org.id)}/>}
        {active === 'Integrations' && <Integrations org={org} session={session} systems={data.systems} rows={data.integrations} oauth={data.oauth} runs={data.integrationRuns} requests={data.actionRequests} reload={() => loadOrg(org.id)}/>}
        {active === 'Agents' && <Agents org={org} session={session} rows={data.agents} integrations={data.integrations} workflows={data.workflowDefinitions} mappings={data.agentWorkflows} requests={data.agentRunRequests} reload={() => loadOrg(org.id)}/>}
        {active === 'AI Ops' && <AIOps data={data} reload={() => loadOrg(org.id)}/>}
        {active === 'Governance' && <Governance org={org} session={session} rows={data.policies} dataPolicy={data.dataPolicy} reload={() => loadOrg(org.id)}/>} 
        {active === 'Blueprints' && <Blueprints org={org} session={session} data={data} reload={() => loadOrg(org.id)}/>}
        {active === 'Audit' && <Audit rows={data.audit}/>}
        {active === 'CerbTek Staff' && staff && <StaffWorkspace orgs={orgs} current={org} setOrg={setOrg} role={staff.role}/>}
        {active === 'CerbTek Staff' && staffLoading && <p role="status">Checking staff access…</p>}
        </>}
      </section>
    </main>
    <KairoHelp userId={session.user.id} organizationId={org.id} section={active} data={data} ready={!dataLoading&&!dataError&&loadedOrgId===org.id&&loadedUserId===session.user.id} onNavigate={setActive}/>
  </div>
}

function Auth() {
  const [email,setEmail] = useState('')
  const [password,setPassword] = useState('')
  const [mode,setMode] = useState('signin')
  const [message,setMessage] = useState('')
  async function submit(e) {
    e.preventDefault()
    setMessage('')
    if(mode === 'signup'){
      const strong = password.length >= 12 && /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password) && /[^A-Za-z0-9]/.test(password)
      if(!strong){
        setMessage('Use at least 12 characters with uppercase, lowercase, a number, and a symbol.')
        return
      }
    }
    const res = mode === 'signin'
      ? await supabase.auth.signInWithPassword({email,password})
      : await supabase.auth.signUp({email,password, options:{ emailRedirectTo: window.location.origin }})
    if (res.error) setMessage(res.error.message)
    else if (mode === 'signup') setMessage('Account created. Check your email if confirmation is enabled.')
  }
  return <div className="auth-shell"><div className="auth-card">
    <div className="auth-brand"><img className="brand-banner" src="/kairo-banner.png" alt="Kairo — AI Enablement by CerbTek. Connect, Automate, Empower." width="2048" height="683" /></div>
    <h1>{mode === 'signin' ? 'Sign in' : 'Create account'}</h1>
    <p>Secure access to Kairo Command Center.</p>
    <form onSubmit={submit}>
      <label>Email<input type="email" value={email} onChange={e=>setEmail(e.target.value)} required/></label>
      <label>Password<input type="password" value={password} onChange={e=>setPassword(e.target.value)} required minLength={mode==='signup'?12:8}/>{mode==='signup' && <small className="password-hint">12+ characters • upper & lowercase • number • symbol</small>}</label>
      <button className="primary">{mode === 'signin' ? 'Sign in' : 'Create account'}</button>
    </form>
    {message && <div className="message">{message}</div>}
    <button className="link" onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}>
      {mode === 'signin' ? 'Need an account? Create one' : 'Already have an account? Sign in'}
    </button>
  </div></div>
}

function CreateOrganization({session,onCreated}) {
  const [name,setName] = useState('')
  const [industry,setIndustry] = useState('')
  const [employees,setEmployees] = useState('')
  const [error,setError] = useState('')
  async function submit(e) {
    e.preventDefault()
    const { error } = await supabase.from('organizations').insert({
      name,
      industry: industry || null,
      employee_count: employees ? Number(employees) : null,
      created_by: session.user.id
    })
    if (error) setError(error.message)
    else onCreated()
  }
  return <div className="auth-shell"><div className="auth-card wide">
    <p className="eyebrow">FIRST WORKSPACE</p><h1>Create a client organization</h1>
    <p>Each company is isolated as its own tenant.</p>
    <form onSubmit={submit}>
      <label>Organization name<input value={name} onChange={e=>setName(e.target.value)} required/></label>
      <label>Industry<input value={industry} onChange={e=>setIndustry(e.target.value)}/></label>
      <label>Employee count<input type="number" min="0" value={employees} onChange={e=>setEmployees(e.target.value)}/></label>
      <button className="primary">Create workspace</button>
    </form>
    {error && <div className="message">{error}</div>}
  </div></div>
}

function Overview({data,onGo}) {
  const avg = data.opps.length ? Math.round(data.opps.reduce((a,b)=>a+(b.opportunity_score||0),0)/data.opps.length) : 0
  return <>
    <NextStepCard data={data} onGo={onGo}/>
    <div className="metrics">
      <Metric label="Systems mapped" value={data.systems.length}/>
      <Metric label="Workflows mapped" value={data.workflows.length}/>
      <Metric label="AI opportunities" value={data.opps.length}/>
      <Metric label="Avg. opportunity score" value={avg}/>
    </div>
    <div className="grid two">
      <Panel title="Enablement progress">
        <Progress label="Client onboarding" done={data.onboarding?.status === 'Complete' || data.onboarding?.status === 'Ready for Assessment'}/>
        <Progress label="AI readiness assessment" done={data.readiness?.status === 'Complete'}/>
        <Progress label="Systems inventory" done={data.systems.length>0}/>
        <Progress label="Workflow inventory" done={data.workflows.length>0}/>
        <Progress label="Opportunity scoring" done={data.opps.length>0}/>
        <Progress label="Governance baseline" done={data.policies.length>0}/>
        <Progress label="Agent controls" done={data.agents.length>0}/>
      </Panel>
      <Panel title="Your assessment and plan">
        <p>{assessmentComplete(data.readiness)?'Your saved readiness score summarizes your assessment answers. Use it with the mapped systems and business cases to choose what to investigate next.':'Complete the company profile and readiness assessment first. The next-step guide above will show where to continue.'}</p>
        {assessmentComplete(data.readiness)&&<button className="secondary" onClick={()=>onGo('AI Readiness')}>Review assessment results</button>}
      </Panel>
    </div>
  </>
}

function NextStepCard({data,onGo}) {
  const next=deriveNextStep(data)
  return <section className="panel next-step" aria-labelledby="next-step-title">
    <p className="eyebrow">YOUR NEXT STEP</p>
    <h2 id="next-step-title">{next.title}</h2>
    <p>{next.detail}</p>
    {next.blocked&&<p className="next-step-blocker">{next.blocked}</p>}
    {next.opportunity&&<p className="next-step-context">Highest recorded opportunity score: <b>{next.opportunity.name}</b> ({next.opportunity.opportunity_score}/100). Review the assumptions before choosing your pilot. <button type="button" className="link" onClick={()=>onGo('Opportunities')}>Review business cases</button></p>}
    <ol className="setup-progress" aria-label="Setup progress">{next.steps.map(step=><li key={step.label}><span aria-hidden="true">{step.complete?'✓':'○'}</span><span>{step.label}</span><b>{step.complete?'Complete':'To do'}</b></li>)}</ol>
    <button type="button" className="primary" onClick={()=>onGo(next.section)}>{next.action}</button>
  </section>
}


const readinessQuestions = [
  ['technology','tech_systems','Core business systems are documented and owned.'],
  ['technology','tech_security','Identity, access, and endpoint security are centrally managed.'],
  ['technology','tech_cloud','The technology environment supports modern APIs, cloud services, or automation.'],
  ['workflow','wf_documented','Key business workflows are documented end to end.'],
  ['workflow','wf_metrics','Workflow owners, volumes, cycle times, and service expectations are known.'],
  ['workflow','wf_repeatable','High-volume repetitive work has been identified for automation.'],
  ['data','data_quality','Operational data is sufficiently accurate and consistent for automation.'],
  ['data','data_classification','Sensitive data is classified with clear handling requirements.'],
  ['data','data_access','Approved data sources can be accessed programmatically when needed.'],
  ['governance','gov_policy','The organization has defined acceptable-use expectations for AI.'],
  ['governance','gov_approval','High-impact automated actions have explicit human approval boundaries.'],
  ['governance','gov_audit','AI and automation activity can be audited and investigated.'],
  ['workforce','people_training','Employees receive role-specific training for AI-enabled work.'],
  ['workforce','people_adoption','Leaders actively manage adoption, resistance, and process change.'],
  ['workforce','people_owner','The organization has accountable owners for AI-enabled processes.'],
  ['integration','int_api','Priority business applications expose usable APIs or supported connectors.'],
  ['integration','int_identity','Integrations can use controlled authentication and least-privilege access.'],
  ['integration','int_monitoring','Integration failures can be monitored, alerted, and remediated.'],
]
const readinessLabels = {technology:'Technology',workflow:'Workflow',data:'Data',governance:'Governance',workforce:'Workforce',integration:'Integration'}
function TeamAccess({org,session,members,invitations,reload}) {
  const [email,setEmail]=useState('')
  const [role,setRole]=useState('member')
  const [inviteLink,setInviteLink]=useState('')
  const [message,setMessage]=useState('')

  async function createInvite(e){
    e.preventDefault()
    setMessage('Creating secure invitation…')
    const {data,error}=await supabase.functions.invoke('organization-invite',{body:{
      op:'create',organization_id:org.id,email,role
    }})
    if(error) setMessage(error.message)
    else if(data?.error) setMessage(data.error)
    else{
      setInviteLink(data.invite_url||'')
      setMessage('Invitation created')
      setEmail('')
      reload()
    }
  }

  async function updateRole(userId,newRole){
    const {error}=await supabase.from('organization_members').update({role:newRole}).eq('organization_id',org.id).eq('user_id',userId)
    setMessage(error?error.message:'Member role updated')
    if(!error) reload()
  }

  async function revokeMember(userId){
    const member=members.find(m=>m.user_id===userId)
    if(member?.role==='owner'){setMessage('The organization owner cannot be removed here.');return}
    const {error}=await supabase.from('organization_members').delete().eq('organization_id',org.id).eq('user_id',userId)
    setMessage(error?error.message:'Member access removed')
    if(!error) reload()
  }

  async function revokeInvite(id){
    const {error}=await supabase.from('organization_invitations').update({status:'Revoked'}).eq('id',id)
    setMessage(error?error.message:'Invitation revoked')
    if(!error) reload()
  }

  async function copyInvite(){
    if(!inviteLink)return
    try{await navigator.clipboard.writeText(inviteLink);setMessage('Invite link copied')}catch{setMessage('Copy the invitation link shown below')}
  }

  return <>
    <div className="metrics">
      <Metric label="Team members" value={members.length}/>
      <Metric label="Pending invites" value={invitations.filter(i=>i.status==='Pending').length}/>
      <Metric label="Admins" value={members.filter(m=>m.role==='owner'||m.role==='admin').length}/>
      <Metric label="Tenant isolation" value="RLS"/>
    </div>

    <Panel title="Invite team member">
      <p>Create a seven-day tenant invitation. The recipient must sign in using the invited email address before access is granted.</p>
      <form className="team-invite-form" onSubmit={createInvite}>
        <label>Email<input type="email" value={email} onChange={e=>setEmail(e.target.value)} required/></label>
        <label>Role<select value={role} onChange={e=>setRole(e.target.value)}><option value="admin">Admin</option><option value="consultant">Consultant</option><option value="member">Member</option><option value="viewer">Viewer</option></select></label>
        <button className="primary">Create secure invite</button>
      </form>
      {inviteLink&&<div className="invite-link-box"><input value={inviteLink} readOnly/><button className="secondary" onClick={copyInvite}>Copy link</button></div>}
      {message&&<div className="message">{message}</div>}
    </Panel>

    <Panel title="Organization members">
      <div className="member-list">{members.length?members.map(m=>
        <div className="member-row" key={m.user_id}>
          <div><b>{m.email}</b><span>Joined {new Date(m.created_at).toLocaleDateString()}</span></div>
          <select value={m.role} disabled={m.role==='owner'} onChange={e=>updateRole(m.user_id,e.target.value)}>
            {m.role==='owner'&&<option value="owner">Owner</option>}
            <option value="admin">Admin</option><option value="consultant">Consultant</option><option value="member">Member</option><option value="viewer">Viewer</option>
          </select>
          <button className="secondary" disabled={m.role==='owner'} onClick={()=>revokeMember(m.user_id)}>Remove</button>
        </div>
      ):<div className="empty">No team members yet.</div>}</div>
    </Panel>

    <Panel title="Invitations">
      <div className="member-list">{invitations.length?invitations.map(i=>
        <div className="member-row" key={i.id}>
          <div><b>{i.email}</b><span>{i.role} • {i.status} • expires {new Date(i.expires_at).toLocaleString()}</span></div>
          <span className="status-text">{i.status}</span>
          {i.status==='Pending'?<button className="secondary" onClick={()=>revokeInvite(i.id)}>Revoke</button>:<span></span>}
        </div>
      ):<div className="empty">No invitations yet.</div>}</div>
    </Panel>
  </>
}


function Onboarding({org,session,current,reload,onGo}) {
  const [form,setForm]=useState({
    primary_contact_name:'',primary_contact_email:'',business_goals:'',operational_pain_points:'',
    ai_goals:'',current_ai_tools:'',target_outcomes:'',desired_timeline:'',budget_band:'',data_sensitivity:''
  })
  const [saved,setSaved]=useState('')
  const [saving,setSaving]=useState(false)
  const [changed,setChanged]=useState(false)
  useEffect(()=>{ if(current) setForm(x=>({...x,...current}));setChanged(false) },[current])
  function field(k,v){setForm({...form,[k]:v});setChanged(true)}
  async function save(e){
    e.preventDefault()
    if(saving) return
    setSaving(true);setSaved('Saving company profile…')
    try {
    const required=['primary_contact_name','primary_contact_email','business_goals','operational_pain_points','ai_goals','target_outcomes']
    const complete=required.filter(k=>String(form[k]||'').trim()).length
    const pct=Math.round(complete/required.length*100)
    const status=pct===100?'Ready for Assessment':pct>0?'In Progress':'Not Started'
    const {error}=await supabase.from('organization_onboarding').upsert({
      organization_id:org.id,
      primary_contact_name:form.primary_contact_name||null,
      primary_contact_email:form.primary_contact_email||null,
      business_goals:form.business_goals||null,
      operational_pain_points:form.operational_pain_points||null,
      ai_goals:form.ai_goals||null,
      current_ai_tools:form.current_ai_tools||null,
      target_outcomes:form.target_outcomes||null,
      desired_timeline:form.desired_timeline||null,
      budget_band:form.budget_band||null,
      data_sensitivity:form.data_sensitivity||null,
      completion_percent:pct,
      status,
      updated_by:session.user.id
    })
    if(error) throw error
    setChanged(false);setSaved('Company profile saved.');await reload()
    } catch(error) { setSaved('Save was not confirmed. Your entries are still here. '+(error.message||'Check your connection.')) }
    finally { setSaving(false) }
  }
  return <Panel title="Client onboarding">
    <p>Capture the business context needed before scoring AI opportunities or designing agents.</p>
    <form className="onboarding-form" onSubmit={save}>
      <label>Primary contact<input value={form.primary_contact_name||''} onChange={e=>field('primary_contact_name',e.target.value)} /></label>
      <label>Contact email<input type="email" value={form.primary_contact_email||''} onChange={e=>field('primary_contact_email',e.target.value)} /></label>
      <label className="span-2">Business goals<textarea value={form.business_goals||''} onChange={e=>field('business_goals',e.target.value)} placeholder="What must the business improve, protect, or scale?"/></label>
      <label className="span-2">Operational pain points<textarea value={form.operational_pain_points||''} onChange={e=>field('operational_pain_points',e.target.value)} placeholder="Where are people losing time, quality, or visibility?"/></label>
      <label className="span-2">AI goals<textarea value={form.ai_goals||''} onChange={e=>field('ai_goals',e.target.value)} placeholder="What does leadership expect AI to change?"/></label>
      <label>Current AI tools<input value={form.current_ai_tools||''} onChange={e=>field('current_ai_tools',e.target.value)} placeholder="ChatGPT, Copilot, Gemini, etc."/></label>
      <label>Desired timeline<input value={form.desired_timeline||''} onChange={e=>field('desired_timeline',e.target.value)} placeholder="e.g. first production workflow in 60 days"/></label>
      <label className="span-2">Target outcomes<textarea value={form.target_outcomes||''} onChange={e=>field('target_outcomes',e.target.value)} placeholder="Hours saved, revenue, service quality, risk reduction..."/></label>
      <label>Budget band<select value={form.budget_band||''} onChange={e=>field('budget_band',e.target.value)}><option value="">Not set</option><option>Under $10k</option><option>$10k–$25k</option><option>$25k–$75k</option><option>$75k+</option></select></label>
      <label>Highest data sensitivity<select value={form.data_sensitivity||''} onChange={e=>field('data_sensitivity',e.target.value)}><option value="">Not set</option><DataClassOptions/></select></label>
      <div className="span-2 onboarding-actions"><div><b>Saved completion: {current?.completion_percent||0}%</b><span>{current?.status||'Not Started'}{changed?' · Unsaved changes':''}</span></div><button className="primary" disabled={saving}>{saving?'Saving…':'Save onboarding'}</button></div>
    </form>
    {saved && <div className="message" role="status">{saved}</div>}
    {onboardingComplete(current)&&!changed&&onGo&&<div className="saved-next-step"><p>Company profile complete. Next, assess your current readiness for AI-enabled work.</p><button className="primary" onClick={()=>onGo('AI Readiness')}>Next: readiness assessment</button></div>}
  </Panel>
}

function Readiness({org,session,data,reload,onGo}) {
  const existing=data.readiness
  const [answers,setAnswers]=useState({})
  const [saved,setSaved]=useState('')
  const [saving,setSaving]=useState(false)
  useEffect(()=>setAnswers(existing?.answers||{}),[existing?.id])
  const dimensions=['technology','workflow','data','governance','workforce','integration']
  function dimensionScore(dim,source=answers){
    const qs=readinessQuestions.filter(q=>q[0]===dim)
    const vals=qs.map(q=>Number(source[q[1]]||0)).filter(Boolean)
    return vals.length===qs.length ? Math.round(vals.reduce((a,b)=>a+b,0)/vals.length*20) : 0
  }
  const scores=Object.fromEntries(dimensions.map(d=>[d,dimensionScore(d)]))
  const answered=Object.keys(answers).filter(k=>answers[k]).length
  const answersMatchSaved=readinessQuestions.every(([,key])=>Number(answers[key]||0)===Number(existing?.answers?.[key]||0))
  const savedComplete=assessmentComplete(existing)&&answersMatchSaved
  const next=savedComplete?deriveNextStep(data):null
  async function save(complete=false){
    if(saving) return
    setSaving(true);setSaved('Saving assessment…')
    try {
    const payload={
      organization_id:org.id,status:complete?'Complete':'Draft',answers,
      technology_score:scores.technology,workflow_score:scores.workflow,data_score:scores.data,
      governance_score:scores.governance,workforce_score:scores.workforce,integration_score:scores.integration,
      completed_at:complete?new Date().toISOString():null,created_by:session.user.id
    }
    let error
    if(existing?.id) {
      const result=await supabase.from('readiness_assessments').update(payload).eq('id',existing.id).select('id,status').maybeSingle()
      error=result.error||(!result.data||result.data.status!==payload.status?new Error('No assessment was updated. Check your access and refresh before continuing.'):null)
    }
    else ({error}=await supabase.from('readiness_assessments').insert(payload))
    if(error) throw error
    setSaved(complete?'Assessment completed':'Draft saved');await reload()
    } catch(error) { setSaved('Save was not confirmed. Your answers are still here. '+(error.message||'Check your connection.')) }
    finally { setSaving(false) }
  }
  const overall=existing?.overall_score ?? Math.round(
    scores.technology*.18+scores.workflow*.18+scores.data*.18+scores.governance*.18+scores.workforce*.14+scores.integration*.14
  )
  return <>
    {savedComplete&&onGo&&<><p className="assessment-meaning">Assessment complete. The saved scores summarize your answers; they do not by themselves confirm that an automation is ready for production.</p><NextStepCard data={data} onGo={onGo}/></>}
    <div className="readiness-top">
      <Panel title={existing?.overall_score!=null?'Saved AI readiness score':'AI readiness score preview'}><div className="score">{overall}<span>/100</span></div><p>{answered} of {readinessQuestions.length} assessment questions answered. Category scores reflect your current answers.</p>{existing?.overall_score!=null&&!answersMatchSaved&&<p>Save your draft or complete the assessment to update the saved score.</p>}</Panel>
      <div className="dimension-grid">{dimensions.map(d=><div className="dimension-card" key={d}><span>{readinessLabels[d]}</span><b>{scores[d]}</b><em>/100</em></div>)}</div>
    </div>
    <Panel title="Readiness assessment">
      <p>Rate each statement from 1 (not established) to 5 (operationalized and consistently used).</p>
      <div className="question-list">{readinessQuestions.map(([dim,key,label])=>
        <div className="question-row" key={key}>
          <div><span>{readinessLabels[dim]}</span><b>{label}</b></div>
          <div className="rating">{[1,2,3,4,5].map(v=><button type="button" key={v} className={Number(answers[key])===v?'selected':''} onClick={()=>setAnswers({...answers,[key]:v})}>{v}</button>)}</div>
        </div>
      )}</div>
      <div className="assessment-actions">
        <button className="secondary" disabled={saving} onClick={()=>save(false)}>Save draft</button>
        <button className="primary" disabled={saving||answered<readinessQuestions.length} onClick={()=>save(true)}>{saving?'Saving…':'Complete assessment'}</button>
      </div>
      {saved && <div className="message" role="status">{saved}</div>}
      {savedComplete&&onGo&&<div className="saved-next-step"><p>Your completed assessment is saved. Continue with the next setup step.</p><button className="primary" onClick={()=>onGo(next.section)}>{next.action}</button></div>}
    </Panel>
  </>
}

function Systems({org,session,rows,reload}) {
  const [name,setName]=useState('')
  const [vendor,setVendor]=useState('')
  const [classification,setClassification]=useState('Internal')
  const [saveMessage,setSaveMessage]=useState('')
  const [saving,setSaving]=useState(false)
  async function save(e) {
    e.preventDefault()
    if(saving) return
    setSaving(true);setSaveMessage('Saving system…')
    try {
      const {error}=await supabase.from('systems').insert({
        organization_id:org.id,name,vendor:vendor||null,data_classification:classification,integration_status:'Not Assessed',created_by:session.user.id
      })
      if(error) throw error
      setName('');setVendor('');setSaveMessage('System saved.');reload()
    } catch(error) {
      setSaveMessage('Save was not confirmed. Your entries are still here. '+(error.message||'Check your connection before trying again.'))
    } finally { setSaving(false) }
  }
  return <Panel title="Systems inventory">
    <p>Record the tools your company uses. New entries start as Not Assessed; adding a system does not confirm that it is connected or ready for automation.</p>
    <form className="inline-form four systems-inventory-form" onSubmit={save}>
      <label>System name<input placeholder="System" value={name} onChange={e=>setName(e.target.value)} required/></label>
      <label>Vendor (optional)<input placeholder="Vendor" value={vendor} onChange={e=>setVendor(e.target.value)}/></label>
      <label>Data sensitivity<select value={classification} onChange={e=>setClassification(e.target.value)}><DataClassOptions/></select></label>
      <button className="primary small" disabled={saving}>{saving?'Saving…':'Add'}</button>
    </form>
    {saveMessage&&<div className="message" role="status" aria-live="polite">{saveMessage}</div>}
    <Rows rows={rows} secondary={r => [r.vendor,r.data_classification,r.integration_status].filter(Boolean).join(' • ')} table="systems" reload={reload}/>
  </Panel>
}

function Workflows({org,session,rows,definitions,runs,approvalPolicies,schedules,reload}) {
  const [name,setName]=useState('')
  const [department,setDepartment]=useState('')
  const [risk,setRisk]=useState('Moderate')
  const [inventoryMessage,setInventoryMessage]=useState('')
  const [savingInventory,setSavingInventory]=useState(false)
  const [automationName,setAutomationName]=useState('')
  const [automationDescription,setAutomationDescription]=useState('')
  const [stepType,setStepType]=useState('microsoft.health')
  const [emailTo,setEmailTo]=useState('')
  const [emailSubject,setEmailSubject]=useState('')
  const [emailMessage,setEmailMessage]=useState('')
  const [workflowMessage,setWorkflowMessage]=useState('')
  const [policyName,setPolicyName]=useState('')
  const [autoExecute,setAutoExecute]=useState(false)
  const [scheduleWorkflow,setScheduleWorkflow]=useState('')
  const [scheduleName,setScheduleName]=useState('')
  const [scheduleCadence,setScheduleCadence]=useState('hourly')
  const [firstRun,setFirstRun]=useState('')

  async function save(e) {
    e.preventDefault()
    if(savingInventory) return
    setSavingInventory(true);setInventoryMessage('Saving workflow…')
    try {
      const {error}=await supabase.from('workflows').insert({
        organization_id:org.id,name,department:department||null,current_risk_level:risk,created_by:session.user.id
      })
      if(error) throw error
      setName('');setDepartment('');setInventoryMessage('Business workflow saved.');reload()
    } catch(error) {
      setInventoryMessage('Save was not confirmed. Your entries are still here. '+(error.message||'Check your connection before trying again.'))
    } finally { setSavingInventory(false) }
  }

  async function savePolicy(e){
    e.preventDefault()
    const {error}=await supabase.from('approval_policies').insert({
      organization_id:org.id,
      name:policyName,
      action_type:'send_email',
      required_roles:['owner','admin','consultant'],
      require_approval:true,
      auto_execute_after_approval:autoExecute,
      active:true,
      created_by:session.user.id
    })
    setWorkflowMessage(error?error.message:'Approval policy created')
    if(!error){setPolicyName('');reload()}
  }

  async function createAutomation(e){
    e.preventDefault()
    const steps=[]
    if(stepType==='microsoft.health') steps.push({type:'microsoft.health'})
    if(stepType==='microsoft.profile') steps.push({type:'microsoft.profile'})
    if(stepType==='microsoft.inbox-status') steps.push({type:'microsoft.inbox-status'})
    if(stepType==='microsoft.calendar-next') steps.push({type:'microsoft.calendar-next'})
    if(stepType==='approval.email') steps.push({type:'approval.email',to:emailTo,subject:emailSubject,message:emailMessage})
    const {error}=await supabase.from('workflow_definitions').insert({
      organization_id:org.id,
      name:automationName,
      description:automationDescription||null,
      status:'Draft',
      trigger_type:'Manual',
      steps,
      default_approval_policy_id:approvalPolicies.find(p=>p.action_type==='send_email'&&p.active)?.id||null,
      created_by:session.user.id
    })
    setWorkflowMessage(error?error.message:'Workflow created as draft')
    if(!error){
      setAutomationName('');setAutomationDescription('');setEmailTo('');setEmailSubject('');setEmailMessage('')
      reload()
    }
  }

  function cadenceCron(cadence){
    if(cadence==='daily') return '0 13 * * *'
    if(cadence==='weekly') return '0 13 * * 1'
    return '0 * * * *'
  }

  async function createSchedule(e){
    e.preventDefault()
    const workflow=definitions.find(w=>w.id===scheduleWorkflow)
    if(!workflow){setWorkflowMessage('Select an active workflow');return}
    const next=firstRun?new Date(firstRun).toISOString():new Date(Date.now()+3600000).toISOString()
    const {error}=await supabase.from('workflow_schedules').insert({
      organization_id:org.id,
      workflow_id:scheduleWorkflow,
      name:scheduleName||workflow.name+' schedule',
      cron_expression:cadenceCron(scheduleCadence),
      timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC',
      active:true,
      next_run_at:next,
      created_by:session.user.id
    })
    setWorkflowMessage(error?error.message:'Schedule created')
    if(!error){setScheduleName('');setFirstRun('');reload()}
  }

  async function toggleSchedule(id,active){
    const {error}=await supabase.from('workflow_schedules').update({active}).eq('id',id)
    setWorkflowMessage(error?error.message:(active?'Schedule resumed':'Schedule paused'))
    if(!error) reload()
  }

  async function setWorkflowStatus(id,status){
    const {error}=await supabase.from('workflow_definitions').update({status}).eq('id',id)
    setWorkflowMessage(error?error.message:('Workflow '+status.toLowerCase()))
    if(!error) reload()
  }

  async function runWorkflow(id){
    setWorkflowMessage('Running workflow…')
    const {data,error}=await supabase.functions.invoke('workflow-runner',{body:{workflow_id:id,context:{}}})
    if(error) setWorkflowMessage(error.message)
    else if(data?.error) setWorkflowMessage(data.error)
    else setWorkflowMessage(data?.status==='Waiting Approval'?'Workflow paused for approval':'Workflow completed')
    reload()
  }

  return <>
    <Panel title="Business workflow inventory">
      <p>Describe work your team does here. Adding it to this inventory does not create or run an automation. After comparing its business case, use Workflow builder below to create a runnable draft.</p>
      <form className="inline-form four" onSubmit={save}>
        <input placeholder="Workflow" value={name} onChange={e=>setName(e.target.value)} required/>
        <input placeholder="Department" value={department} onChange={e=>setDepartment(e.target.value)}/>
        <select value={risk} onChange={e=>setRisk(e.target.value)}><option>Low</option><option>Moderate</option><option>High</option><option>Critical</option></select>
        <button className="primary small" disabled={savingInventory}>{savingInventory?'Saving…':'Add'}</button>
      </form>
      {inventoryMessage&&<div className="message" role="status" aria-live="polite">{inventoryMessage}</div>}
      <Rows rows={rows} secondary={r => [r.department,r.current_risk_level].filter(Boolean).join(' • ')} table="workflows" reload={reload}/>
    </Panel>

    <div className="grid two">
      <Panel title="Approval policies">
        <p>Define reusable human-control rules for high-impact workflow actions.</p>
        <form className="policy-form" onSubmit={savePolicy}>
          <label>Policy name<input value={policyName} onChange={e=>setPolicyName(e.target.value)} placeholder="Outbound communication approval" required/></label>
          <label className="toggle-line"><input type="checkbox" checked={autoExecute} onChange={e=>setAutoExecute(e.target.checked)}/><span>Execute automatically after approval</span></label>
          <button className="primary small">Create policy</button>
        </form>
        <div className="compact-list">{approvalPolicies.length?approvalPolicies.map(p=>
          <div className="compact-row" key={p.id}><div><b>{p.name}</b><span>{p.action_type.replaceAll('_',' ')} • {p.require_approval?'Approval required':'No approval'} • {p.active?'Active':'Inactive'}</span></div></div>
        ):<div className="empty">No approval policies yet.</div>}</div>
      </Panel>

      <Panel title="Workflow builder">
        <p>Build a governed automation from safe Microsoft actions or an approval-gated outbound email.</p>
        <form className="workflow-builder" onSubmit={createAutomation}>
          <label>Name<input value={automationName} onChange={e=>setAutomationName(e.target.value)} required/></label>
          <label>Description<input value={automationDescription} onChange={e=>setAutomationDescription(e.target.value)}/></label>
          <label>First step<select value={stepType} onChange={e=>setStepType(e.target.value)}>
            <option value="microsoft.health">Microsoft health check</option>
            <option value="microsoft.profile">Verify Microsoft profile</option>
            <option value="microsoft.inbox-status">Read inbox status</option>
            <option value="microsoft.calendar-next">Read upcoming calendar</option>
            <option value="approval.email">Approval-gated email</option>
          </select></label>
          {stepType==='approval.email' && <>
            <label>Recipient<input type="email" value={emailTo} onChange={e=>setEmailTo(e.target.value)} required/></label>
            <label>Subject<input value={emailSubject} onChange={e=>setEmailSubject(e.target.value)} required/></label>
            <label className="span-2">Message<textarea value={emailMessage} onChange={e=>setEmailMessage(e.target.value)} required/></label>
          </>}
          <div className="span-2 workflow-builder-actions"><span role={workflowMessage?'status':undefined}>{workflowMessage}</span><button className="primary">Save draft automation</button></div>
        </form>
      </Panel>
    </div>

    <Panel title="Orchestrated workflows">
      <p>Activate makes a draft available to run. Run uses your real connected account; it is not a sandbox. Email steps request human review before sending. A schedule is a separate choice below.</p>
      <div className="orchestration-list">{definitions.length?definitions.map(w=>{
        const latest=runs.find(r=>r.workflow_id===w.id)
        return <div className="orchestration-row" key={w.id}>
          <div><b>{w.name}</b><span>{w.description||'No description'} • {Array.isArray(w.steps)?w.steps.length:0} step(s)</span></div>
          <div className="orchestration-status"><span className={'workflow-state '+w.status.toLowerCase().replace(' ','-')}>{w.status}</span>{latest&&<em>Last: {latest.status}</em>}</div>
          <div className="orchestration-actions">
            {w.status==='Draft' && <button className="secondary" onClick={()=>setWorkflowStatus(w.id,'Active')}>Activate</button>}
            {w.status==='Active' && <><button className="primary small" onClick={()=>runWorkflow(w.id)}>Run</button><button className="secondary" onClick={()=>setWorkflowStatus(w.id,'Paused')}>Pause</button></>}
            {w.status==='Paused' && <button className="secondary" onClick={()=>setWorkflowStatus(w.id,'Active')}>Resume</button>}
          </div>
        </div>
      }):<div className="empty">No orchestrated workflows yet.</div>}</div>
    </Panel>

    <Panel title="Workflow schedules">
      <p>Run active workflows automatically. Scheduled approval steps still pause for a human before any write action executes.</p>
      <form className="schedule-form" onSubmit={createSchedule}>
        <label>Workflow<select value={scheduleWorkflow} onChange={e=>setScheduleWorkflow(e.target.value)} required><option value="">Select active workflow</option>{definitions.filter(w=>w.status==='Active').map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
        <label>Schedule name<input value={scheduleName} onChange={e=>setScheduleName(e.target.value)} placeholder="Daily operations check"/></label>
        <label>Cadence<select value={scheduleCadence} onChange={e=>setScheduleCadence(e.target.value)}><option value="hourly">Hourly</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label>
        <label>First run<input type="datetime-local" value={firstRun} onChange={e=>setFirstRun(e.target.value)}/></label>
        <button className="primary small">Create schedule</button>
      </form>
      <div className="schedule-list">{schedules.length?schedules.map(s=>
        <div className="schedule-row" key={s.id}>
          <div><b>{s.name}</b><span>{definitions.find(w=>w.id===s.workflow_id)?.name||'Workflow'} • {s.active?'Active':'Paused'}</span></div>
          <div><span>Next run</span><b>{s.next_run_at?new Date(s.next_run_at).toLocaleString():'Not scheduled'}</b></div>
          <button className="secondary" onClick={()=>toggleSchedule(s.id,!s.active)}>{s.active?'Pause':'Resume'}</button>
        </div>
      ):<div className="empty">No workflow schedules yet.</div>}</div>
    </Panel>

    <Panel title="Workflow run history">
      <div className="run-list">{runs.length?runs.map(r=>
        <div className="run-row" key={r.id}>
          <span className={r.status==='Success'?'run-dot success':r.status==='Error'?'run-dot error':'run-dot'}></span>
          <div><b>{definitions.find(w=>w.id===r.workflow_id)?.name||'Workflow'}</b><span>{r.summary||r.error_message||r.status} • {new Date(r.created_at).toLocaleString()}</span></div>
          <em>{r.status}</em>
        </div>
      ):<div className="empty">No workflow runs yet.</div>}</div>
    </Panel>
  </>
}

function Opportunities({org,session,workflows,rows,reload}) {
  const [name,setName]=useState('')
  const [workflow,setWorkflow]=useState('')
  const [value,setValue]=useState(80)
  const [fit,setFit]=useState(80)
  const [risk,setRisk]=useState(25)
  const [control,setControl]=useState('Approve')
  const [hours,setHours]=useState(500)
  const [hourly,setHourly]=useState(45)
  const [revenue,setRevenue]=useState(0)
  const [avoidance,setAvoidance]=useState(0)
  const [implementation,setImplementation]=useState(15000)
  const [recurring,setRecurring]=useState(6000)
  const [ttv,setTtv]=useState(8)
  const [change,setChange]=useState('Medium')
  async function save(e) {
    e.preventDefault()
    const {error}=await supabase.from('ai_opportunities').insert({
      organization_id:org.id, workflow_id:workflow||null, name,
      business_value:+value, repeatability:70, data_availability:60, ai_suitability:+fit,
      integration_difficulty:40, risk_score:+risk, implementation_complexity:'Medium',
      human_control_mode:control,
      annual_hours_saved:+hours,
      blended_hourly_cost:+hourly,
      annual_revenue_impact:+revenue,
      annual_risk_avoidance:+avoidance,
      implementation_cost:+implementation,
      recurring_annual_cost:+recurring,
      time_to_value_weeks:+ttv,
      change_management_effort:change,
      created_by:session.user.id
    })
    if(!error){setName('');reload()}
  }
  return <>
    <Panel title="AI opportunity business case">
      <p>The starting values are example estimates. Replace them with your own assumptions before creating a business case. The projected benefits, costs and returns depend on these inputs.</p>
      <p>Use a 0–100 scale: higher business value and AI suitability mean stronger potential; higher risk means greater risk. Estimate hours saved over one year, hourly cost in dollars, implementation cost once, and recurring costs per year.</p>
      <form className="opportunity-business-form" onSubmit={save}>
        <label>Opportunity<input placeholder="Opportunity" value={name} onChange={e=>setName(e.target.value)} required/></label>
        <label>Linked workflow<select value={workflow} onChange={e=>setWorkflow(e.target.value)}><option value="">No workflow linked</option>{workflows.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
        <label>Business value<input type="number" min="0" max="100" value={value} onChange={e=>setValue(e.target.value)}/></label>
        <label>AI suitability<input type="number" min="0" max="100" value={fit} onChange={e=>setFit(e.target.value)}/></label>
        <label>Risk<input type="number" min="0" max="100" value={risk} onChange={e=>setRisk(e.target.value)}/></label>
        <label>Human control<select value={control} onChange={e=>setControl(e.target.value)}><option>Assist</option><option>Approve</option><option>Autonomous</option></select></label>

        <label>Annual hours saved<input type="number" min="0" value={hours} onChange={e=>setHours(e.target.value)}/></label>
        <label>Blended hourly cost ($)<input type="number" min="0" step="0.01" value={hourly} onChange={e=>setHourly(e.target.value)}/></label>
        <label>Annual revenue impact ($)<input type="number" min="0" step="0.01" value={revenue} onChange={e=>setRevenue(e.target.value)}/></label>
        <label>Annual risk avoidance ($)<input type="number" min="0" step="0.01" value={avoidance} onChange={e=>setAvoidance(e.target.value)}/></label>
        <label>Implementation cost ($)<input type="number" min="0" step="0.01" value={implementation} onChange={e=>setImplementation(e.target.value)}/></label>
        <label>Recurring annual cost ($)<input type="number" min="0" step="0.01" value={recurring} onChange={e=>setRecurring(e.target.value)}/></label>
        <label>Time to value (weeks)<input type="number" min="0" value={ttv} onChange={e=>setTtv(e.target.value)}/></label>
        <label>Change management<select value={change} onChange={e=>setChange(e.target.value)}><option>Low</option><option>Medium</option><option>High</option></select></label>
        <div className="business-form-actions"><button className="primary">Create business case</button></div>
      </form>
    </Panel>
    <Panel title="Prioritized AI opportunities">
      <div className="business-case-list">{rows.length ? rows.map(r=>
        <div className="business-case-card" key={r.id}>
          <div className="business-case-head">
            <div><b>{r.name}</b><span>Score {r.opportunity_score}/100 • {r.human_control_mode} • {r.change_management_effort||'Change effort not set'}</span></div>
            <em className="score-pill">{r.opportunity_score}</em>
          </div>
          <div className="business-case-metrics">
            <MiniMetric label="First-year benefit" value={money(r.first_year_benefit)}/>
            <MiniMetric label="Net value" value={money(r.first_year_net_value)}/>
            <MiniMetric label="ROI" value={r.first_year_roi_percent==null?'—':Math.round(r.first_year_roi_percent)+'%'}/>
            <MiniMetric label="Payback" value={r.payback_months==null?'—':r.payback_months.toFixed(1)+' mo'}/>
            <MiniMetric label="Time to value" value={r.time_to_value_weeks==null?'—':r.time_to_value_weeks+' wk'}/>
          </div>
          <button className="icon-btn danger" title="Delete" onClick={async()=>{const {error}=await supabase.from('ai_opportunities').delete().eq('id',r.id);if(!error)reload()}}><Trash2 size={15}/></button>
        </div>
      ) : <div className="empty">No AI business cases yet.</div>}</div>
    </Panel>
  </>
}

function Integrations({org,session,systems,rows,oauth,runs,requests,reload}) {
  async function saveProviderPlan(plan) {
    const {error}=await supabase.from('integrations').insert({...plan,organization_id:org.id,created_by:session.user.id})
    if(error) throw error
    reload()
  }

  const [name,setName]=useState('')
  const [provider,setProvider]=useState('')
  const [type,setType]=useState('API')
  const [system,setSystem]=useState('')
  const [classification,setClassification]=useState('Internal')
  const [inventoryMessage,setInventoryMessage]=useState('')
  const [savingInventory,setSavingInventory]=useState(false)
  const [tenantId,setTenantId]=useState('organizations')
  const [clientId,setClientId]=useState('')
  const [clientSecret,setClientSecret]=useState('')
  const [scopeFlags,setScopeFlags]=useState({mail:false,sendMail:false,calendar:false,files:false})
  const [connectMessage,setConnectMessage]=useState('')
  const [runMessage,setRunMessage]=useState('')
  const [runningAction,setRunningAction]=useState('')
  const microsoft=oauth.find(x=>x.provider==='microsoft')

  async function save(e){
    e.preventDefault()
    if(savingInventory) return
    setSavingInventory(true);setInventoryMessage('Saving integration…')
    try {
      const {error}=await supabase.from('integrations').insert({
        organization_id:org.id,system_id:system||null,name,provider:provider||null,
        integration_type:type,status:'Planned',data_classification:classification,created_by:session.user.id
      })
      if(error) throw error
      setName('');setProvider('');setInventoryMessage('Integration saved.');reload()
    } catch(error) {
      setInventoryMessage('Save was not confirmed. Your entries are still here. '+(error.message||'Check your connection before trying again.'))
    } finally { setSavingInventory(false) }
  }

  async function connectMicrosoft(e){
    e.preventDefault()
    setConnectMessage('Preparing Microsoft consent…')
    const scopes=['openid','profile','offline_access','User.Read']
    if(scopeFlags.mail) scopes.push('Mail.Read')
    if(scopeFlags.sendMail) scopes.push('Mail.Send')
    if(scopeFlags.calendar) scopes.push('Calendars.Read')
    if(scopeFlags.files) scopes.push('Files.Read.All')
    const {data,error}=await supabase.functions.invoke('microsoft-connect',{
      body:{organization_id:org.id,tenant_id:tenantId,client_id:clientId,client_secret:clientSecret,scopes}
    })
    if(error){setConnectMessage(error.message);return}
    if(data?.error){setConnectMessage(data.error);return}
    if(data?.authorize_url) window.location.assign(data.authorize_url)
  }

  const [emailTo,setEmailTo]=useState('')
  const [emailSubject,setEmailSubject]=useState('')
  const [emailMessage,setEmailMessage]=useState('')
  const [approvalMessage,setApprovalMessage]=useState('')

  async function queueEmail(e){
    e.preventDefault()
    setApprovalMessage('Submitting for approval…')
    const {data,error}=await supabase.functions.invoke('microsoft-action',{body:{
      op:'queue-email',organization_id:org.id,to:emailTo,subject:emailSubject,message:emailMessage
    }})
    if(error) setApprovalMessage(error.message)
    else if(data?.error) setApprovalMessage(data.error)
    else {
      setApprovalMessage('Email queued for human approval')
      setEmailTo('');setEmailSubject('');setEmailMessage('')
      reload()
    }
  }

  async function actOnRequest(op,requestId){
    setApprovalMessage(op==='execute'?'Executing approved action…':(op==='approve'?'Approving…':'Rejecting…'))
    const {data,error}=await supabase.functions.invoke('microsoft-action',{body:{op,request_id:requestId}})
    if(error) setApprovalMessage(error.message)
    else if(data?.error) setApprovalMessage(data.error)
    else setApprovalMessage(data?.summary||('Request '+op+'d'))
    reload()
  }

  async function executeMicrosoft(action){
    setRunningAction(action)
    setRunMessage('Running '+action.replaceAll('-',' ')+'…')
    const {data,error}=await supabase.functions.invoke('microsoft-execute',{body:{organization_id:org.id,action}})
    if(error) setRunMessage(error.message)
    else if(data?.error) setRunMessage(data.error)
    else setRunMessage(data?.summary||'Execution completed')
    setRunningAction('')
    reload()
  }

  return <>
    <IntegrationProviderPlanner key={session.user.id+':'+org.id} rows={rows} onSave={saveProviderPlan}/>
    <Panel title="Microsoft 365 / Graph">
      <div className="integration-hero">
        <div>
          <p className="eyebrow">FIRST PRODUCTION CONNECTOR</p>
          <h4>Microsoft 365</h4>
          <p>Connect an authorized Microsoft Entra application using OAuth 2.0. Client secrets and refresh tokens are stored server-side in Supabase Vault, never in the browser database.</p>
          {microsoft?.status!=='Connected'&&<p><b>Microsoft administrator setup:</b> ask your Microsoft 365 administrator for the approved app registration details below. Choose only the access the planned workflow needs. Your connection uses ongoing access so Kairo can run authorized actions later.</p>}
        </div>
        <div className={microsoft?.status==='Connected'?'connection-badge connected':'connection-badge'}>{microsoft?.status||'Not Connected'}</div>
      </div>
      {microsoft?.status==='Connected' ? <>
      <div className="connected-details">
        <div><span>Account</span><b>{microsoft.external_account_name||'Microsoft account connected'}</b></div>
        <div><span>Scopes</span><b>{(microsoft.scopes||[]).join(', ')}</b></div>
        <div><span>Connected</span><b>{microsoft.last_connected_at?new Date(microsoft.last_connected_at).toLocaleString():'—'}</b></div>
      </div>
      <div className="execution-strip">
        <div><span>Safe live actions</span><b>Read-only Microsoft Graph execution</b></div>
        <div className="execution-actions">
          <button className="secondary" disabled={!!runningAction} onClick={()=>executeMicrosoft('health')}>Health check</button>
          <button className="secondary" disabled={!!runningAction} onClick={()=>executeMicrosoft('profile')}>Verify profile</button>
          <button className="secondary" disabled={!!runningAction || !(microsoft.scopes||[]).includes('Mail.Read')} onClick={()=>executeMicrosoft('inbox-status')}>Inbox status</button>
          <button className="secondary" disabled={!!runningAction || !(microsoft.scopes||[]).includes('Calendars.Read')} onClick={()=>executeMicrosoft('calendar-next')}>Upcoming calendar</button>
        </div>
      </div>
      {!(microsoft.scopes||[]).includes('Mail.Read')&&<p className="permission-help">Inbox status needs Mail.Read permission. Ask your Microsoft 365 administrator to review access if this workflow needs it.</p>}
      {!(microsoft.scopes||[]).includes('Calendars.Read')&&<p className="permission-help">Upcoming calendar needs Calendars.Read permission.</p>}
      {runMessage && <div className="message">{runMessage}</div>}
      </> :
      <form className="microsoft-form" onSubmit={connectMicrosoft}>
        <label>Tenant ID or domain<input value={tenantId} onChange={e=>setTenantId(e.target.value)} placeholder="organizations or tenant GUID"/></label>
        <label>Application (client) ID<input value={clientId} onChange={e=>setClientId(e.target.value)} required/></label>
        <label className="span-2">Client secret<input type="password" value={clientSecret} onChange={e=>setClientSecret(e.target.value)} required autoComplete="off"/></label>
        <div className="span-2 permission-grid">
          <label className="permission locked"><input type="checkbox" checked readOnly/><span><b>Profile</b><em>User.Read</em><small>Read the connected account's profile.</small></span></label>
          <label className="permission"><input type="checkbox" checked={scopeFlags.mail} onChange={e=>setScopeFlags({...scopeFlags,mail:e.target.checked})}/><span><b>Email read</b><em>Mail.Read</em><small>Read mail, including inbox status.</small></span></label>
          <label className="permission"><input type="checkbox" checked={scopeFlags.sendMail} onChange={e=>setScopeFlags({...scopeFlags,sendMail:e.target.checked})}/><span><b>Email send</b><em>Mail.Send</em><small>Send mail through the existing review and send controls.</small></span></label>
          <label className="permission"><input type="checkbox" checked={scopeFlags.calendar} onChange={e=>setScopeFlags({...scopeFlags,calendar:e.target.checked})}/><span><b>Calendar read</b><em>Calendars.Read</em><small>Read calendar events.</small></span></label>
          <label className="permission"><input type="checkbox" checked={scopeFlags.files} onChange={e=>setScopeFlags({...scopeFlags,files:e.target.checked})}/><span><b>Files read</b><em>Files.Read.All</em><small>Read files the connected account can access.</small></span></label>
        </div>
        <div className="span-2 connect-actions"><span>{connectMessage}</span><button className="primary">Connect Microsoft 365</button></div>
      </form>}
    </Panel>

    {microsoft?.status==='Connected' && (microsoft.scopes||[]).includes('Mail.Send') && <Panel title="Controlled Microsoft email">
      <p>Create an email action, require human approval, then execute it through Microsoft Graph. Nothing is sent at request time.</p>
      <form className="approval-email-form" onSubmit={queueEmail}>
        <label>Recipient<input type="email" value={emailTo} onChange={e=>setEmailTo(e.target.value)} required/></label>
        <label>Subject<input value={emailSubject} onChange={e=>setEmailSubject(e.target.value)} required/></label>
        <label className="span-2">Message<textarea value={emailMessage} onChange={e=>setEmailMessage(e.target.value)} required/></label>
        <div className="span-2 connect-actions"><span>{approvalMessage}</span><button className="primary">Submit for approval</button></div>
      </form>
      <div className="approval-list">{requests?.length ? requests.filter(r=>r.action_type==='send_email').map(r=>
        <div className="approval-row" key={r.id}>
          <div className="approval-preview"><b>{r.payload?.subject||r.title}</b><span>To {r.payload?.to||'—'} • {r.status} • {new Date(r.created_at).toLocaleString()}</span><span className="approval-preview-label">Message to be sent</span><p className="approval-message">{r.payload?.message||'Message preview unavailable. Review the original request before approving.'}</p>{r.error_message&&<span role="status">Last action: {r.error_message}</span>}</div>
          <div className="approval-actions">
            {r.status==='Pending' && <><button className="secondary" disabled={!r.payload?.message} onClick={()=>actOnRequest('approve',r.id)}>Approve</button><button className="secondary" onClick={()=>actOnRequest('reject',r.id)}>Reject</button></>}
            {r.status==='Approved' && <button className="primary small" disabled={!r.payload?.message} onClick={()=>actOnRequest('execute',r.id)}>Send approved email</button>}
            {r.status==='Executed' && <span className="status-text">Executed</span>}
            {r.status==='Failed' && <span className="status-text">Failed</span>}
          </div>
        </div>
      ) : <div className="empty">No controlled email actions yet.</div>}</div>
    </Panel>}

    <Panel title="Recent integration runs">
      <div className="run-list">{runs?.length ? runs.map(r=>
        <div className="run-row" key={r.id}>
          <span className={r.status==='Success'?'run-dot success':'run-dot error'}></span>
          <div><b>{r.action.replaceAll('-',' ')}</b><span>{r.summary||r.error_message||'No summary'} • {new Date(r.created_at).toLocaleString()}</span></div>
          <em>{r.duration_ms==null?'—':r.duration_ms+' ms'}</em>
        </div>
      ) : <div className="empty">No integration runs yet.</div>}</div>
    </Panel>

    <Panel title="Integration inventory">
      <form className="inline-form integration-form" onSubmit={save}>
        <input placeholder="Integration name" value={name} onChange={e=>setName(e.target.value)} required/>
        <input placeholder="Provider" value={provider} onChange={e=>setProvider(e.target.value)}/>
        <select value={type} onChange={e=>setType(e.target.value)}><option>API</option><option>OAuth</option><option>MCP</option><option>Webhook</option><option>Database</option><option>File</option><option>Other</option></select>
        <select value={system} onChange={e=>setSystem(e.target.value)}><option value="">No linked system</option>{systems.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <select value={classification} onChange={e=>setClassification(e.target.value)}><DataClassOptions/></select>
        <button className="primary small" disabled={savingInventory}>{savingInventory?'Saving…':'Add'}</button>
      </form>
      {inventoryMessage&&<div className="message" role="status" aria-live="polite">{inventoryMessage}</div>}
      <Rows rows={rows} secondary={r => [r.provider,r.integration_type,r.status,r.data_classification].filter(Boolean).join(' • ')} table="integrations" reload={reload}/>
    </Panel>
  </>
}

function Agents({org,session,rows,integrations,workflows,mappings,requests,reload}) {
  const [name,setName]=useState('')
  const [purpose,setPurpose]=useState('')
  const [control,setControl]=useState('Assist')
  const [threshold,setThreshold]=useState(85)
  const [dailyLimit,setDailyLimit]=useState(25)
  const [allowed,setAllowed]=useState('Read approved business data; draft responses')
  const [prohibited,setProhibited]=useState('Change financial terms; delete records')
  const [integration,setIntegration]=useState('')
  const [selectedAgent,setSelectedAgent]=useState('')
  const [selectedWorkflow,setSelectedWorkflow]=useState('')
  const [executionMode,setExecutionMode]=useState('Propose')
  const [confidence,setConfidence]=useState(90)
  const [agentMessage,setAgentMessage]=useState('')

  async function save(e){
    e.preventDefault()
    const {data,error}=await supabase.from('ai_agents').insert({
      organization_id:org.id,name,purpose,status:'Draft',human_control_mode:control,
      allowed_data_classifications:['Public','Internal'],
      allowed_actions:allowed.split(';').map(x=>x.trim()).filter(Boolean),
      prohibited_actions:prohibited.split(';').map(x=>x.trim()).filter(Boolean),
      confidence_threshold:+threshold,
      minimum_execution_confidence:+threshold,
      max_daily_runs:+dailyLimit,
      audit_logging_enabled:true,created_by:session.user.id
    }).select().single()
    if(!error && data){
      if(integration) await supabase.from('agent_integrations').insert({agent_id:data.id,integration_id:integration,access_mode:'Read'})
      setName('');setPurpose('');reload()
    } else if(error) setAgentMessage(error.message)
  }

  async function mapWorkflow(e){
    e.preventDefault()
    const {error}=await supabase.from('agent_workflows').upsert({
      agent_id:selectedAgent,workflow_id:selectedWorkflow,execution_mode:executionMode,active:true
    })
    setAgentMessage(error?error.message:'Workflow permission saved')
    if(!error) reload()
  }

  async function setAgentStatus(id,status){
    const {error}=await supabase.from('ai_agents').update({status}).eq('id',id)
    setAgentMessage(error?error.message:('Agent '+status.toLowerCase()))
    if(!error) reload()
  }

  async function requestRun(agentId,workflowId){
    setAgentMessage('Submitting agent run…')
    const {data,error}=await supabase.functions.invoke('agent-run',{body:{
      op:'request',organization_id:org.id,agent_id:agentId,workflow_id:workflowId,confidence:+confidence,context:{}
    }})
    if(error) setAgentMessage(error.message)
    else if(data?.error) setAgentMessage(data.error)
    else setAgentMessage(data?.status==='Pending'?'Agent run waiting for approval':('Agent run '+String(data?.status||'submitted').toLowerCase()))
    reload()
  }

  async function actOnAgentRequest(op,id){
    setAgentMessage(op==='execute'?'Executing agent run…':(op==='approve'?'Approving agent run…':'Rejecting agent run…'))
    const {data,error}=await supabase.functions.invoke('agent-run',{body:{op,request_id:id}})
    if(error) setAgentMessage(error.message)
    else if(data?.error) setAgentMessage(data.error)
    else setAgentMessage('Agent run '+(op==='approve'?'approved':op==='reject'?'rejected':'executed'))
    reload()
  }

  return <>
    <Panel title="Agent Builder">
      <form className="agent-form" onSubmit={save}>
        <label>Agent name<input value={name} onChange={e=>setName(e.target.value)} required/></label>
        <label>Purpose<input value={purpose} onChange={e=>setPurpose(e.target.value)} required placeholder="What business outcome does this agent own?"/></label>
        <label>Human control<select value={control} onChange={e=>setControl(e.target.value)}><option>Assist</option><option>Approve</option><option>Autonomous</option></select></label>
        <label>Confidence threshold<input type="number" min="0" max="100" value={threshold} onChange={e=>setThreshold(e.target.value)}/></label>
        <label>Daily run limit<input type="number" min="1" value={dailyLimit} onChange={e=>setDailyLimit(e.target.value)}/></label>
        <label>Initial integration<select value={integration} onChange={e=>setIntegration(e.target.value)}><option value="">None</option>{integrations.map(i=><option key={i.id} value={i.id}>{i.name}</option>)}</select></label>
        <label className="span-2">Allowed actions<input value={allowed} onChange={e=>setAllowed(e.target.value)} /></label>
        <label className="span-2">Prohibited actions<input value={prohibited} onChange={e=>setProhibited(e.target.value)} /></label>
        <div className="form-actions"><button className="primary"><Bot size={15}/>Create controlled agent</button></div>
      </form>
    </Panel>

    <div className="grid two">
      <Panel title="Workflow permissions">
        <p>Agents can only access workflows explicitly assigned here.</p>
        <form className="agent-permission-form" onSubmit={mapWorkflow}>
          <label>Agent<select value={selectedAgent} onChange={e=>setSelectedAgent(e.target.value)} required><option value="">Select agent</option>{rows.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
          <label>Workflow<select value={selectedWorkflow} onChange={e=>setSelectedWorkflow(e.target.value)} required><option value="">Select active workflow</option>{workflows.filter(w=>w.status==='Active').map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
          <label>Execution mode<select value={executionMode} onChange={e=>setExecutionMode(e.target.value)}><option>Propose</option><option>Execute</option></select></label>
          <button className="primary small">Allow workflow</button>
        </form>
        <div className="compact-list">{mappings.length?mappings.map(m=>{
          const a=rows.find(x=>x.id===m.agent_id); const w=workflows.find(x=>x.id===m.workflow_id)
          return <div className="compact-row" key={m.agent_id+'-'+m.workflow_id}><div><b>{a?.name||'Agent'} → {w?.name||'Workflow'}</b><span>{m.execution_mode} • {m.active?'Active':'Inactive'}</span></div></div>
        }):<div className="empty">No agent workflow permissions yet.</div>}</div>
      </Panel>

      <Panel title="Agent execution controls">
        <p>Test the same request path the agent runtime uses, including confidence thresholds and approval gates.</p>
        <label className="confidence-control">Execution confidence<input type="number" min="0" max="100" value={confidence} onChange={e=>setConfidence(e.target.value)}/></label>
        <div className="agent-exec-list">{mappings.filter(m=>m.active).map(m=>{
          const a=rows.find(x=>x.id===m.agent_id); const w=workflows.find(x=>x.id===m.workflow_id)
          if(!a||!w)return null
          return <div className="agent-exec-row" key={m.agent_id+'-'+m.workflow_id}>
            <div><b>{a.name}</b><span>{w.name} • {m.execution_mode} • {a.human_control_mode}</span></div>
            <button className="secondary" disabled={a.status!=='Active'} onClick={()=>requestRun(a.id,w.id)}>Request run</button>
          </div>
        })}</div>
      </Panel>
    </div>

    <Panel title="AI agents">
      <div className="agent-card-list">{rows.length?rows.map(r=>
        <div className="agent-card" key={r.id}>
          <div><b>{r.name}</b><span>{r.purpose}</span></div>
          <div className="agent-stats">
            <MiniMetric label="Status" value={r.status}/>
            <MiniMetric label="Control" value={r.human_control_mode}/>
            <MiniMetric label="Confidence" value={(r.minimum_execution_confidence??r.confidence_threshold??0)+'%'}/>
            <MiniMetric label="Daily limit" value={r.max_daily_runs??'—'}/>
          </div>
          <div className="agent-card-actions">
            {r.status==='Draft'&&<button className="secondary" onClick={()=>setAgentStatus(r.id,'Testing')}>Start testing</button>}
            {r.status==='Testing'&&<button className="primary small" onClick={()=>setAgentStatus(r.id,'Active')}>Activate</button>}
            {r.status==='Active'&&<button className="secondary" onClick={()=>setAgentStatus(r.id,'Paused')}>Pause</button>}
            {r.status==='Paused'&&<button className="secondary" onClick={()=>setAgentStatus(r.id,'Active')}>Resume</button>}
          </div>
        </div>
      ):<div className="empty">No AI agents yet.</div>}</div>
    </Panel>

    <Panel title="Agent run approvals">
      <div className="approval-list">{requests.length?requests.map(r=>{
        const a=rows.find(x=>x.id===r.agent_id); const w=workflows.find(x=>x.id===r.workflow_id)
        return <div className="approval-row" key={r.id}>
          <div><b>{a?.name||'Agent'} → {w?.name||'Workflow'}</b><span>{r.status} • Confidence {r.confidence??'—'}% • {new Date(r.created_at).toLocaleString()}</span></div>
          <div className="approval-actions">
            {r.status==='Pending'&&<><button className="secondary" onClick={()=>actOnAgentRequest('approve',r.id)}>Approve</button><button className="secondary" onClick={()=>actOnAgentRequest('reject',r.id)}>Reject</button></>}
            {r.status==='Approved'&&<button className="primary small" onClick={()=>actOnAgentRequest('execute',r.id)}>Execute</button>}
            {r.status==='Executed'&&<span className="status-text">Executed</span>}
            {r.status==='Failed'&&<span className="status-text">Failed</span>}
          </div>
        </div>
      }):<div className="empty">No agent run requests yet.</div>}</div>
      {agentMessage&&<div className="message">{agentMessage}</div>}
    </Panel>
  </>
}

function AIOps({data,reload}) {
  const [alertMessage,setAlertMessage]=useState('')
  const [updatingAlert,setUpdatingAlert]=useState(null)
  async function updateAlert(id,status){
    if(updatingAlert) return
    setUpdatingAlert(id);setAlertMessage('Updating alert…')
    try {
      const at=new Date().toISOString()
      let patch={status,resolved_at:at}
      if(status==='Acknowledged') {
        const {data:userData,error:userError}=await supabase.auth.getUser()
        if(userError) throw userError
        patch={status,acknowledged_by:userData.user?.id||null,acknowledged_at:at}
      }
      const {data:updated,error}=await supabase.from('ops_alerts').update(patch).eq('id',id).select('id,status').maybeSingle()
      if(error) throw error
      if(!updated||updated.status!==status) throw new Error('No alert was updated. Check your access and refresh the alert.')
      setAlertMessage(status==='Acknowledged'?'Alert acknowledged.':'Alert resolved.')
      await reload()
    } catch(error) {
      setAlertMessage('Could not confirm the alert status. '+(error.message||'Refresh the page before trying again.'))
    } finally { setUpdatingAlert(null) }
  }
  const totalIntegrationRuns=data.integrationRuns.length
  const integrationErrors=data.integrationRuns.filter(r=>r.status==='Error').length
  const workflowTotal=data.workflowRuns.length
  const workflowSuccess=data.workflowRuns.filter(r=>r.status==='Success').length
  const workflowRate=workflowTotal?Math.round(workflowSuccess/workflowTotal*100):0
  const pendingActions=data.actionRequests.filter(r=>r.status==='Pending'||r.status==='Approved').length
    + data.agentRunRequests.filter(r=>r.status==='Pending'||r.status==='Approved').length
  const degraded=data.integrations.filter(i=>i.status==='Degraded'||i.status==='Blocked').length
  const activeAgents=data.agents.filter(a=>a.status==='Active').length
  const openAlerts=data.opsAlerts.filter(a=>a.status==='Open')
  const criticalAlerts=openAlerts.filter(a=>a.severity==='Critical').length
  const recentFailures=[
    ...data.integrationRuns.filter(r=>r.status==='Error').map(r=>({kind:'Integration',label:r.action,detail:r.error_message||r.summary,at:r.created_at})),
    ...data.workflowRuns.filter(r=>r.status==='Error').map(r=>({kind:'Workflow',label:data.workflowDefinitions.find(w=>w.id===r.workflow_id)?.name||'Workflow',detail:r.error_message||r.summary,at:r.created_at})),
    ...data.agentRunRequests.filter(r=>r.status==='Failed').map(r=>({kind:'Agent',label:data.agents.find(a=>a.id===r.agent_id)?.name||'Agent',detail:r.error_message||'Agent execution failed',at:r.created_at}))
  ].sort((a,b)=>new Date(b.at)-new Date(a.at)).slice(0,10)

  return <>
    <div className="metrics">
      <Metric label="Workflow success" value={workflowRate+'%'}/>
      <Metric label="Active agents" value={activeAgents}/>
      <Metric label="Pending approvals" value={pendingActions}/>
      <Metric label="Degraded integrations" value={degraded}/>
      <Metric label="Open alerts" value={openAlerts.length}/>
    </div>

    <div className="grid two">
      <Panel title="Integration health">
        <div className="ops-health-list">{data.integrations.length?data.integrations.map(i=>
          <div className="ops-health-row" key={i.id}>
            <span className={'ops-status '+String(i.status||'unknown').toLowerCase().replaceAll(' ','-')}></span>
            <div><b>{i.name}</b><span>{i.provider||'Provider not set'} • {i.status}</span></div>
            <em>{i.last_health_check_at?new Date(i.last_health_check_at).toLocaleString():'Never checked'}</em>
          </div>
        ):<div className="empty">No integrations configured.</div>}</div>
      </Panel>

      <Panel title="Agent operations">
        <div className="ops-health-list">{data.agents.length?data.agents.map(a=>
          <div className="ops-health-row" key={a.id}>
            <span className={'ops-status '+String(a.status||'unknown').toLowerCase()}></span>
            <div><b>{a.name}</b><span>{a.human_control_mode} • threshold {a.minimum_execution_confidence??a.confidence_threshold??'—'}%</span></div>
            <em>{a.max_daily_runs?('Limit '+a.max_daily_runs+'/day'):'No daily limit'}</em>
          </div>
        ):<div className="empty">No agents configured.</div>}</div>
      </Panel>
    </div>

    <Panel title="Operations summary">
      <div className="ops-summary-grid">
        <MiniMetric label="Integration runs" value={totalIntegrationRuns}/>
        <MiniMetric label="Integration errors" value={integrationErrors}/>
        <MiniMetric label="Workflow runs" value={workflowTotal}/>
        <MiniMetric label="Workflow successes" value={workflowSuccess}/>
        <MiniMetric label="Open approvals" value={pendingActions}/>
      </div>
    </Panel>

    <Panel title="Operations alerts">
      {alertMessage&&<div className="message" role="status" aria-live="polite">{alertMessage}</div>}
      <div className="alert-list">{data.opsAlerts.length?data.opsAlerts.map(a=>
        <div className={'alert-row '+a.severity.toLowerCase()} key={a.id}>
          <div><b>{a.title}</b><span>{a.message} • {new Date(a.created_at).toLocaleString()}</span></div>
          <div className="alert-actions">
            <em>{a.severity}</em>
            {a.status==='Open'&&<button className="secondary" disabled={!!updatingAlert} onClick={()=>updateAlert(a.id,'Acknowledged')}>Acknowledge</button>}
            {a.status!=='Resolved'&&<button className="secondary" disabled={!!updatingAlert} onClick={()=>updateAlert(a.id,'Resolved')}>Resolve</button>}
          </div>
        </div>
      ):<div className="empty">No operations alerts.</div>}</div>
    </Panel>

    <Panel title="Recent failures">
      <div className="run-list">{recentFailures.length?recentFailures.map((f,i)=>
        <div className="run-row" key={f.kind+'-'+i+'-'+f.at}>
          <span className="run-dot error"></span>
          <div><b>{f.kind}: {f.label}</b><span>{f.detail||'No error detail'} • {new Date(f.at).toLocaleString()}</span></div>
          <em>Needs attention</em>
        </div>
      ):<div className="empty">No recent operational failures.</div>}</div>
    </Panel>
  </>
}

function Governance({org,session,rows,dataPolicy,reload}) {
  const [name,setName]=useState('')
  const [type,setType]=useState('Data Access')
  const [auditDays,setAuditDays]=useState(365)
  const [executionDays,setExecutionDays]=useState(180)
  const [approvalDays,setApprovalDays]=useState(365)
  const [exportEnabled,setExportEnabled]=useState(true)
  const [deletionApproval,setDeletionApproval]=useState(true)
  const [govMessage,setGovMessage]=useState('')

  useEffect(()=>{
    if(dataPolicy){
      setAuditDays(dataPolicy.audit_retention_days)
      setExecutionDays(dataPolicy.execution_retention_days)
      setApprovalDays(dataPolicy.approval_retention_days)
      setExportEnabled(dataPolicy.export_enabled)
      setDeletionApproval(dataPolicy.deletion_requires_approval)
    }
  },[dataPolicy?.organization_id])

  async function save(e) {
    e.preventDefault()
    const {error}=await supabase.from('governance_policies').insert({
      organization_id:org.id,name,policy_type:type,status:'Draft',created_by:session.user.id
    })
    if(!error){setName('');reload()}
    else setGovMessage(error.message)
  }

  async function saveDataPolicy(e){
    e.preventDefault()
    const {error}=await supabase.from('organization_data_policies').upsert({
      organization_id:org.id,
      audit_retention_days:+auditDays,
      execution_retention_days:+executionDays,
      approval_retention_days:+approvalDays,
      export_enabled:exportEnabled,
      deletion_requires_approval:deletionApproval,
      updated_by:session.user.id
    })
    setGovMessage(error?error.message:'Data governance settings saved')
    if(!error) reload()
  }

  async function exportTenant(){
    setGovMessage('Generating secure tenant export…')
    const {data,error}=await supabase.functions.invoke('tenant-export',{body:{organization_id:org.id}})
    if(error){setGovMessage(error.message);return}
    if(data?.error){setGovMessage(data.error);return}
    const blob=new Blob([JSON.stringify(data.export,null,2)],{type:'application/json'})
    const url=URL.createObjectURL(blob)
    const a=document.createElement('a')
    a.href=url
    a.download=(org.name||'kairo-tenant').replace(/[^a-z0-9]+/gi,'-').toLowerCase()+'-export.json'
    document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url)
    setGovMessage('Tenant export generated. Secrets and OAuth tokens were excluded.')
    reload()
  }

  return <>
    <Panel title="Governance policies">
      <form className="inline-form" onSubmit={save}>
        <input placeholder="Policy name" value={name} onChange={e=>setName(e.target.value)} required/>
        <select value={type} onChange={e=>setType(e.target.value)}><option>Data Access</option><option>Human Approval</option><option>Model Use</option><option>Retention</option><option>Security</option><option>Acceptable Use</option><option>Other</option></select>
        <button className="primary small">Add policy</button>
      </form>
      <Rows rows={rows} secondary={r => `${r.policy_type} • ${r.status}`} table="governance_policies" reload={reload}/>
    </Panel>

    <Panel title="Tenant data controls">
      <p>Set retention expectations and control whether authorized tenant admins can export their data.</p>
      <form className="data-policy-form" onSubmit={saveDataPolicy}>
        <label>Audit retention (days)<input type="number" min="30" max="3650" value={auditDays} onChange={e=>setAuditDays(e.target.value)}/></label>
        <label>Execution retention (days)<input type="number" min="30" max="3650" value={executionDays} onChange={e=>setExecutionDays(e.target.value)}/></label>
        <label>Approval retention (days)<input type="number" min="30" max="3650" value={approvalDays} onChange={e=>setApprovalDays(e.target.value)}/></label>
        <label className="toggle-line"><input type="checkbox" checked={exportEnabled} onChange={e=>setExportEnabled(e.target.checked)}/><span>Allow tenant export</span></label>
        <label className="toggle-line"><input type="checkbox" checked={deletionApproval} onChange={e=>setDeletionApproval(e.target.checked)}/><span>Require approval before destructive data actions</span></label>
        <div className="data-policy-actions"><button className="primary">Save data controls</button><button type="button" className="secondary" disabled={!exportEnabled} onClick={exportTenant}>Export tenant data</button></div>
      </form>
      <p className="data-policy-note">Tenant exports exclude Microsoft client secrets, access tokens, refresh tokens, and all Supabase Vault contents.</p>
      {govMessage&&<div className="message">{govMessage}</div>}
    </Panel>
  </>
}

function Blueprints({org,session,data,reload}) {
  async function create() {
    const maturity = readinessScore(data)
    const recommendations = data.opps.slice(0,5).map(o=>({
      name:o.name,score:o.opportunity_score,control:o.human_control_mode,
      first_year_benefit:o.first_year_benefit,first_year_net_value:o.first_year_net_value,
      roi:o.first_year_roi_percent,payback_months:o.payback_months,time_to_value_weeks:o.time_to_value_weeks
    }))
    const roadmap = [
      {phase:'30 days',focus:'Complete inventory, governance baseline, and top use-case selection'},
      {phase:'60 days',focus:'Implement first governed workflow with human approval and audit logging'},
      {phase:'90 days',focus:'Operationalize monitoring, employee enablement, cost controls, and optimization'}
    ]
    await supabase.from('blueprints').insert({
      organization_id:org.id,title:'Kairo AI Enablement Blueprint',maturity_score:maturity,
      executive_summary:`Current assessment includes ${data.systems.length} systems, ${data.workflows.length} workflows, ${data.opps.length} AI opportunities, ${data.integrations.length} integrations, ${data.agents.length} agents, and ${data.policies.length} governance policies.`,
      recommendations,roadmap,status:'Draft',created_by:session.user.id
    })
    reload()
  }

  function printBlueprint(bp){
    const html = blueprintHtml(org,bp,data)
    const w = window.open('', '_blank')
    w.document.write(html)
    w.document.close()
    w.focus()
    setTimeout(()=>w.print(),250)
  }

  return <Panel title="Kairo AI Enablement Blueprints">
    <div className="panel-head"><span>{data.blueprints.length} generated</span><button className="secondary" onClick={create}><Plus size={15}/>Generate draft</button></div>
    <div className="list">{data.blueprints.length ? data.blueprints.map(bp =>
      <div className="list-row blueprint-row" key={bp.id}>
        <div><b>{bp.title}</b><span>Maturity {bp.maturity_score ?? '—'}/100 • {bp.status}</span></div>
        <button className="icon-btn print-btn" onClick={()=>printBlueprint(bp)} title="Print / Save PDF"><Printer size={16}/></button>
      </div>
    ) : <div className="empty">No blueprint generated yet.</div>}</div>
  </Panel>
}

function Audit({rows}) {
  return <Panel title="Audit events">
    <div className="audit-list">{rows.length ? rows.map(r =>
      <div className="audit-row" key={r.id}>
        <div className="audit-icon"><Activity size={15}/></div>
        <div><b>{r.summary}</b><span>{r.entity_type || 'platform'} • {new Date(r.created_at).toLocaleString()}</span></div>
        <em>{r.event_type}</em>
      </div>
    ) : <div className="empty">No audited changes yet.</div>}</div>
  </Panel>
}

function StaffWorkspace({orgs,current,setOrg,role}) {
  const [engagements,setEngagements]=useState([])
  const [onboarding,setOnboarding]=useState([])
  const [assessments,setAssessments]=useState([])
  useEffect(()=>{load()},[orgs.length])
  async function load(){
    const [e,o,a]=await Promise.all([
      supabase.from('client_engagements').select('*'),
      supabase.from('organization_onboarding').select('*'),
      supabase.from('readiness_assessments').select('*').order('created_at',{ascending:false})
    ])
    setEngagements(e.data||[]);setOnboarding(o.data||[]);setAssessments(a.data||[])
  }
  async function updateEngagement(orgId,patch){
    const existing=engagements.find(x=>x.organization_id===orgId)
    const payload={organization_id:orgId,stage:'Discovery',health:'On Track',assessment_status:'Not Started',blueprint_status:'Not Started',implementation_status:'Not Started',...(existing||{}),...patch}
    delete payload.created_at;delete payload.updated_at
    await supabase.from('client_engagements').upsert(payload)
    load()
  }
  const completed=assessments.filter(a=>a.status==='Complete').length
  const atRisk=engagements.filter(e=>e.health==='At Risk').length
  return <>
    <div className="metrics">
      <Metric label="Client tenants" value={orgs.length}/>
      <Metric label="Assessments complete" value={completed}/>
      <Metric label="At-risk accounts" value={atRisk}/>
      <Metric label="Staff role" value={role.replaceAll('_',' ')}/>
    </div>
    <Panel title="Client portfolio">
      <p>Manage the CerbTek delivery pipeline, then open the tenant to perform the work.</p>
      <div className="portfolio-table">
        <div className="portfolio-head"><span>Client</span><span>Stage</span><span>Health</span><span>Onboarding</span><span>Readiness</span><span>Next action</span><span></span></div>
        {orgs.map(o=>{
          const e=engagements.find(x=>x.organization_id===o.id)||{}
          const ob=onboarding.find(x=>x.organization_id===o.id)
          const a=assessments.find(x=>x.organization_id===o.id && x.status==='Complete')
          return <div className={current?.id===o.id?'portfolio-row current':'portfolio-row'} key={o.id}>
            <div><b>{o.name}</b><span>{o.industry||'Industry not set'}</span></div>
            <select value={e.stage||'Discovery'} onChange={x=>updateEngagement(o.id,{stage:x.target.value})}><option>Discovery</option><option>Assessment</option><option>Blueprint</option><option>Implementation</option><option>AI Ops</option><option>Paused</option></select>
            <select value={e.health||'On Track'} onChange={x=>updateEngagement(o.id,{health:x.target.value})}><option>On Track</option><option>Needs Attention</option><option>At Risk</option></select>
            <span className="status-text">{ob?.status||'Not Started'}</span>
            <span className="status-text">{a ? (a.overall_score + '/100') : 'Not Complete'}</span>
            <input value={e.next_action||''} onChange={x=>updateEngagement(o.id,{next_action:x.target.value})} placeholder="Next action"/>
            <button className="secondary" onClick={()=>setOrg(o)}>Open tenant</button>
          </div>
        })}</div>
    </Panel>
  </>
}

function Rows({rows,secondary,score=false,table,reload}) {
  async function remove(id){
    if(!table) return
    const {error}=await supabase.from(table).delete().eq('id',id)
    if(!error && reload) reload()
  }
  return <div className="list">{rows.length ? rows.map(r =>
    <div className="list-row" key={r.id}>
      <div><b>{r.name || r.title}</b><span>{secondary(r)}</span>{score && <em className="score-pill">{r.opportunity_score}</em>}</div>
      {table && <button className="icon-btn danger" title="Delete" onClick={()=>remove(r.id)}><Trash2 size={15}/></button>}
    </div>
  ) : <div className="empty">Nothing configured yet.</div>}</div>
}

function readinessScore(data) {
  if(data.readiness?.status === 'Complete') return data.readiness.overall_score || 0
  return Math.min(100, Math.round(
    (Math.min(data.systems.length,5)/5*20) +
    (Math.min(data.workflows.length,8)/8*25) +
    (Math.min(data.opps.length,5)/5*25) +
    (Math.min(data.policies.length,4)/4*15) +
    (Math.min(data.integrations.length,3)/3*8) +
    (Math.min(data.agents.length,2)/2*7)
  ))
}

function blueprintHtml(org,bp,data){
  const recs=(bp.recommendations||[]).map(x=>'<tr><td>'+escapeHtml(x.name)+'</td><td>'+x.score+'</td><td>'+escapeHtml(x.control)+'</td><td>'+money(x.first_year_benefit)+'</td><td>'+money(x.first_year_net_value)+'</td><td>'+(x.roi==null?'—':Math.round(x.roi)+'%')+'</td><td>'+(x.payback_months==null?'—':Number(x.payback_months).toFixed(1)+' mo')+'</td></tr>').join('')
  const roadmap=(bp.roadmap||[]).map(x=>`<div class="phase"><b>${escapeHtml(x.phase)}</b><p>${escapeHtml(x.focus)}</p></div>`).join('')
  return `<!doctype html><html><head><title>${escapeHtml(org.name)} Kairo AI Enablement Blueprint</title><style>
    .report-brand{display:block;width:100%;max-width:520px;height:auto;margin-bottom:20px}body{font-family:Arial,sans-serif;color:#161616;margin:48px;line-height:1.5}.top{border-bottom:3px solid #ff9f0a;padding-bottom:18px;margin-bottom:28px}
    h1{margin:0;font-size:30px}.ey{font-size:11px;letter-spacing:.15em;color:#f06a00;font-weight:800}.score{font-size:56px;font-weight:800;color:#f06a00}
    .score span{font-size:18px;color:#666}table{width:100%;border-collapse:collapse;margin:18px 0}th{background:#fff7eb}th,td{border-bottom:1px solid #ddd;padding:10px;text-align:left}
    .phase{border-left:3px solid #ff9f0a;padding:2px 0 2px 14px;margin:16px 0}.muted{color:#666}@media print{body{margin:.45in}}
  </style></head><body>
    <div class="top"><img class="report-brand" src="${window.location.origin}/kairo-banner.png" alt="Kairo — AI Enablement by CerbTek"/><div class="ey">KAIRO AI ENABLEMENT BLUEPRINT</div><h1>${escapeHtml(org.name)}</h1><p class="muted">Generated by Kairo — AI Enablement by CerbTek</p></div>
    <h2>AI Readiness</h2><div class="score">${bp.maturity_score ?? 0}<span>/100</span></div>
    <h2>Executive Summary</h2><p>${escapeHtml(bp.executive_summary||'')}</p>
    <h2>Priority Opportunities & Business Case</h2><table><thead><tr><th>Opportunity</th><th>Score</th><th>Control</th><th>Benefit</th><th>Net Value</th><th>ROI</th><th>Payback</th></tr></thead><tbody>${recs||'<tr><td colspan="7">No prioritized opportunities yet.</td></tr>'}</tbody></table>
    <h2>30 / 60 / 90 Day Roadmap</h2>${roadmap}
    <h2>Current Environment</h2><p>${data.systems.length} systems • ${data.workflows.length} workflows • ${data.integrations.length} integrations • ${data.agents.length} agents • ${data.policies.length} governance policies</p>
  </body></html>`
}

function escapeHtml(v=''){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
function DataClassOptions(){return <><option>Public</option><option>Internal</option><option>Personal</option><option>Sensitive</option><option>Highly Sensitive</option></>}
function money(v){ if(v==null || Number.isNaN(Number(v))) return '—'; return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(Number(v)) }
function MiniMetric({label,value}) { return <div className="mini-metric"><span>{label}</span><b>{value}</b></div> }
function Metric({label,value}) { return <div className="metric"><span>{label}</span><strong>{value}</strong></div> }
function Progress({label,done}) { return <div className="progress-row"><span className={done?'dot done':'dot'}></span><span>{label}</span><b>{done?'Complete':'Pending'}</b></div> }
function Panel({title,children}) { return <div className="panel"><h3>{title}</h3>{children}</div> }

createRoot(document.getElementById('root')).render(<App/>)

