import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Building2, FileText, Gauge, LogOut, Plus, ServerCog, ShieldCheck, Sparkles, Workflow } from 'lucide-react'
import { supabase } from './supabase'
import './styles.css'

const nav = [
  ['Overview', Gauge],
  ['AI Readiness', Sparkles],
  ['Systems', ServerCog],
  ['Workflows', Workflow],
  ['Opportunities', Sparkles],
  ['Integrations', ServerCog],
  ['Agents', Sparkles],
  ['Governance', ShieldCheck],
  ['Blueprints', FileText],
]

function App() {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [active, setActive] = useState('Overview')
  const [orgs, setOrgs] = useState([])
  const [org, setOrg] = useState(null)
  const [data, setData] = useState({systems:[], workflows:[], opps:[], integrations:[], agents:[], policies:[], blueprints:[]})

  useEffect(() => {
    supabase.auth.getSession().then(({data}) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => { if (session) loadOrgs() }, [session])
  useEffect(() => { if (org) loadOrg(org.id) }, [org])

  async function loadOrgs() {
    const { data } = await supabase.from('organizations').select('*').order('created_at')
    setOrgs(data || [])
    if (!org && data?.length) setOrg(data[0])
  }

  async function loadOrg(orgId) {
    const [systems, workflows, opps, integrations, agents, policies, blueprints] = await Promise.all([
      supabase.from('systems').select('*').eq('organization_id', orgId).order('created_at', {ascending:false}),
      supabase.from('workflows').select('*').eq('organization_id', orgId).order('created_at', {ascending:false}),
      supabase.from('ai_opportunities').select('*').eq('organization_id', orgId).order('opportunity_score', {ascending:false}),
      supabase.from('integrations').select('*').eq('organization_id', orgId).order('created_at', {ascending:false}),
      supabase.from('ai_agents').select('*').eq('organization_id', orgId).order('created_at', {ascending:false}),
      supabase.from('governance_policies').select('*').eq('organization_id', orgId).order('created_at', {ascending:false}),
      supabase.from('blueprints').select('*').eq('organization_id', orgId).order('created_at', {ascending:false}),
    ])
    setData({
      systems: systems.data || [],
      workflows: workflows.data || [],
      opps: opps.data || [],
      integrations: integrations.data || [],
      agents: agents.data || [],
      policies: policies.data || [],
      blueprints: blueprints.data || [],
    })
  }

  if (loading) return <div className="center">Loading CerbTek…</div>
  if (!session) return <Auth />
  if (!orgs.length) return <CreateOrganization session={session} onCreated={loadOrgs} />

  return <div className="app">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">C</div><div><strong>CerbTek</strong><span>AI Enablement</span></div></div>
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
        <div><p className="eyebrow">AI ENABLEMENT COMMAND CENTER</p><h1>{active}</h1></div>
        <div className="tenant-pill"><Building2 size={15}/>{org.name}</div>
      </header>
      <section className="content">
        {active === 'Overview' && <Overview data={data} onGo={setActive}/>}
        {active === 'AI Readiness' && <Readiness data={data}/>}
        {active === 'Systems' && <Systems org={org} session={session} rows={data.systems} reload={() => loadOrg(org.id)}/>}
        {active === 'Workflows' && <Workflows org={org} session={session} rows={data.workflows} reload={() => loadOrg(org.id)}/>}
        {active === 'Opportunities' && <Opportunities org={org} session={session} workflows={data.workflows} rows={data.opps} reload={() => loadOrg(org.id)}/>}
        {active === 'Integrations' && <SimpleList title="Integrations" rows={data.integrations} secondary="status"/>}
        {active === 'Agents' && <SimpleList title="AI Agents" rows={data.agents} secondary="human_control_mode"/>}
        {active === 'Governance' && <Governance org={org} session={session} rows={data.policies} reload={() => loadOrg(org.id)}/>}
        {active === 'Blueprints' && <Blueprints org={org} session={session} data={data} reload={() => loadOrg(org.id)}/>}
      </section>
    </main>
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
    const res = mode === 'signin'
      ? await supabase.auth.signInWithPassword({email,password})
      : await supabase.auth.signUp({email,password})
    if (res.error) setMessage(res.error.message)
    else if (mode === 'signup') setMessage('Account created. Check your email if confirmation is enabled.')
  }
  return <div className="auth-shell"><div className="auth-card">
    <div className="brand auth-brand"><div className="brand-mark">C</div><div><strong>CerbTek</strong><span>AI Enablement</span></div></div>
    <h1>{mode === 'signin' ? 'Sign in' : 'Create account'}</h1>
    <p>Secure access to the AI Enablement Command Center.</p>
    <form onSubmit={submit}>
      <label>Email<input type="email" value={email} onChange={e=>setEmail(e.target.value)} required/></label>
      <label>Password<input type="password" value={password} onChange={e=>setPassword(e.target.value)} required minLength="8"/></label>
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
    <div className="metrics">
      <Metric label="Systems mapped" value={data.systems.length}/>
      <Metric label="Workflows mapped" value={data.workflows.length}/>
      <Metric label="AI opportunities" value={data.opps.length}/>
      <Metric label="Avg. opportunity score" value={avg}/>
    </div>
    <div className="grid two">
      <Panel title="Enablement progress">
        <Progress label="Systems inventory" done={data.systems.length>0}/>
        <Progress label="Workflow inventory" done={data.workflows.length>0}/>
        <Progress label="Opportunity scoring" done={data.opps.length>0}/>
        <Progress label="Governance baseline" done={data.policies.length>0}/>
      </Panel>
      <Panel title="Next best action">
        <p>Map the business before deploying agents. Build enough workflow evidence to generate a defensible AI Enablement Blueprint.</p>
        <button className="secondary" onClick={()=>onGo(!data.systems.length?'Systems':!data.workflows.length?'Workflows':'Opportunities')}>Continue assessment</button>
      </Panel>
    </div>
  </>
}

function Readiness({data}) {
  const score = Math.min(100, Math.round(
    (Math.min(data.systems.length,5)/5*25) +
    (Math.min(data.workflows.length,8)/8*30) +
    (Math.min(data.opps.length,5)/5*30) +
    (Math.min(data.policies.length,4)/4*15)
  ))
  return <Panel title="AI Readiness Score"><div className="score">{score}<span>/100</span></div><p>Score is based on systems, workflows, prioritized opportunities, and governance coverage.</p></Panel>
}

function Systems({org,session,rows,reload}) {
  const [name,setName]=useState('')
  const [vendor,setVendor]=useState('')
  async function save(e) {
    e.preventDefault()
    const {error}=await supabase.from('systems').insert({
      organization_id:org.id,name,vendor:vendor||null,data_classification:'Internal',integration_status:'Not Assessed',created_by:session.user.id
    })
    if(!error){setName('');setVendor('');reload()}
  }
  return <Panel title="Systems inventory">
    <form className="inline-form" onSubmit={save}><input placeholder="System" value={name} onChange={e=>setName(e.target.value)} required/><input placeholder="Vendor" value={vendor} onChange={e=>setVendor(e.target.value)}/><button className="primary small">Add</button></form>
    <Rows rows={rows} secondary={r => [r.vendor,r.data_classification,r.integration_status].filter(Boolean).join(' • ')}/>
  </Panel>
}

function Workflows({org,session,rows,reload}) {
  const [name,setName]=useState('')
  const [department,setDepartment]=useState('')
  async function save(e) {
    e.preventDefault()
    const {error}=await supabase.from('workflows').insert({
      organization_id:org.id,name,department:department||null,created_by:session.user.id
    })
    if(!error){setName('');setDepartment('');reload()}
  }
  return <Panel title="Workflow inventory">
    <form className="inline-form" onSubmit={save}><input placeholder="Workflow" value={name} onChange={e=>setName(e.target.value)} required/><input placeholder="Department" value={department} onChange={e=>setDepartment(e.target.value)}/><button className="primary small">Add</button></form>
    <Rows rows={rows} secondary={r => r.department || 'Department not set'}/>
  </Panel>
}

function Opportunities({org,session,workflows,rows,reload}) {
  const [name,setName]=useState('')
  const [workflow,setWorkflow]=useState('')
  const [value,setValue]=useState(80)
  const [fit,setFit]=useState(80)
  const [risk,setRisk]=useState(25)
  async function save(e) {
    e.preventDefault()
    const {error}=await supabase.from('ai_opportunities').insert({
      organization_id:org.id,
      workflow_id:workflow||null,
      name,
      business_value:+value,
      repeatability:70,
      data_availability:60,
      ai_suitability:+fit,
      integration_difficulty:40,
      risk_score:+risk,
      implementation_complexity:'Medium',
      human_control_mode:'Approve',
      created_by:session.user.id
    })
    if(!error){setName('');reload()}
  }
  return <Panel title="AI opportunities">
    <form className="inline-form opportunity-form" onSubmit={save}>
      <input placeholder="Opportunity" value={name} onChange={e=>setName(e.target.value)} required/>
      <select value={workflow} onChange={e=>setWorkflow(e.target.value)}><option value="">No workflow linked</option>{workflows.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select>
      <input type="number" min="0" max="100" value={value} onChange={e=>setValue(e.target.value)} title="Business value"/>
      <input type="number" min="0" max="100" value={fit} onChange={e=>setFit(e.target.value)} title="AI suitability"/>
      <input type="number" min="0" max="100" value={risk} onChange={e=>setRisk(e.target.value)} title="Risk"/>
      <button className="primary small">Score</button>
    </form>
    <Rows rows={rows} secondary={r => `Score ${r.opportunity_score}/100 • ${r.human_control_mode}`} score/>
  </Panel>
}

function Governance({org,session,rows,reload}) {
  const [name,setName]=useState('')
  const [type,setType]=useState('Data Access')
  async function save(e) {
    e.preventDefault()
    const {error}=await supabase.from('governance_policies').insert({
      organization_id:org.id,name,policy_type:type,status:'Draft',created_by:session.user.id
    })
    if(!error){setName('');reload()}
  }
  return <Panel title="Governance policies">
    <form className="inline-form" onSubmit={save}>
      <input placeholder="Policy name" value={name} onChange={e=>setName(e.target.value)} required/>
      <select value={type} onChange={e=>setType(e.target.value)}><option>Data Access</option><option>Human Approval</option><option>Model Use</option><option>Retention</option><option>Security</option><option>Acceptable Use</option><option>Other</option></select>
      <button className="primary small">Add policy</button>
    </form>
    <Rows rows={rows} secondary={r => `${r.policy_type} • ${r.status}`}/>
  </Panel>
}

function Blueprints({org,session,data,reload}) {
  async function create() {
    const maturity = Math.min(100,Math.round(
      (Math.min(data.systems.length,5)/5*25)+(Math.min(data.workflows.length,8)/8*30)+(Math.min(data.opps.length,5)/5*30)+(Math.min(data.policies.length,4)/4*15)
    ))
    const recommendations = data.opps.slice(0,5).map(o=>({name:o.name,score:o.opportunity_score,control:o.human_control_mode}))
    const roadmap = [
      {phase:'30 days',focus:'Complete inventory and prioritize workflows'},
      {phase:'60 days',focus:'Implement first governed AI workflow'},
      {phase:'90 days',focus:'Operationalize monitoring, training, and optimization'}
    ]
    await supabase.from('blueprints').insert({
      organization_id:org.id,
      title:'AI Enablement Blueprint',
      maturity_score:maturity,
      executive_summary:`Current assessment includes ${data.systems.length} systems, ${data.workflows.length} workflows, ${data.opps.length} AI opportunities, and ${data.policies.length} governance policies.`,
      recommendations,roadmap,status:'Draft',created_by:session.user.id
    })
    reload()
  }
  return <Panel title="AI Enablement Blueprints">
    <div className="panel-head"><span>{data.blueprints.length} generated</span><button className="secondary" onClick={create}><Plus size={15}/>Generate draft</button></div>
    <Rows rows={data.blueprints} secondary={r => `Maturity ${r.maturity_score ?? '—'}/100 • ${r.status}`}/>
  </Panel>
}

function SimpleList({title,rows,secondary}) {
  return <Panel title={title}><Rows rows={rows} secondary={r => r[secondary] || ''}/></Panel>
}

function Rows({rows,secondary,score=false}) {
  return <div className="list">{rows.length ? rows.map(r =>
    <div className="list-row" key={r.id}><div><b>{r.name || r.title}</b><span>{secondary(r)}</span>{score && <em className="score-pill">{r.opportunity_score}</em>}</div></div>
  ) : <div className="empty">Nothing configured yet.</div>}</div>
}

function Metric({label,value}) { return <div className="metric"><span>{label}</span><strong>{value}</strong></div> }
function Progress({label,done}) { return <div className="progress-row"><span className={done?'dot done':'dot'}></span><span>{label}</span><b>{done?'Complete':'Pending'}</b></div> }
function Panel({title,children}) { return <div className="panel"><h3>{title}</h3>{children}</div> }

createRoot(document.getElementById('root')).render(<App/>)
