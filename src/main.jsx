import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Activity, Bot, Building2, FileText, Gauge, LogOut, Plus, Plug, Printer,
  ServerCog, ShieldCheck, Sparkles, Trash2, Users, Workflow
} from 'lucide-react'
import { supabase } from './supabase'
import './styles.css'

const baseNav = [
  ['Overview', Gauge],
  ['AI Readiness', Sparkles],
  ['Systems', ServerCog],
  ['Workflows', Workflow],
  ['Opportunities', Sparkles],
  ['Integrations', Plug],
  ['Agents', Bot],
  ['Governance', ShieldCheck],
  ['Blueprints', FileText],
  ['Audit', Activity],
]

function App() {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [active, setActive] = useState('Overview')
  const [orgs, setOrgs] = useState([])
  const [org, setOrg] = useState(null)
  const [staff, setStaff] = useState(null)
  const [data, setData] = useState({
    systems: [], workflows: [], opps: [], integrations: [], agents: [],
    policies: [], blueprints: [], audit: []
  })

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session) return
    loadStaff()
    loadOrgs()
  }, [session])

  useEffect(() => {
    if (org) loadOrg(org.id)
  }, [org])

  async function loadStaff() {
    const { data } = await supabase.from('staff_accounts').select('*').maybeSingle()
    setStaff(data || null)
  }

  async function loadOrgs() {
    const { data } = await supabase.from('organizations').select('*').order('created_at')
    setOrgs(data || [])
    if (!org && data?.length) setOrg(data[0])
  }

  async function loadOrg(orgId) {
    const [systems, workflows, opps, integrations, agents, policies, blueprints, audit] = await Promise.all([
      supabase.from('systems').select('*').eq('organization_id', orgId).order('created_at', { ascending: false }),
      supabase.from('workflows').select('*').eq('organization_id', orgId).order('created_at', { ascending: false }),
      supabase.from('ai_opportunities').select('*').eq('organization_id', orgId).order('opportunity_score', { ascending: false }),
      supabase.from('integrations').select('*').eq('organization_id', orgId).order('created_at', { ascending: false }),
      supabase.from('ai_agents').select('*').eq('organization_id', orgId).order('created_at', { ascending: false }),
      supabase.from('governance_policies').select('*').eq('organization_id', orgId).order('created_at', { ascending: false }),
      supabase.from('blueprints').select('*').eq('organization_id', orgId).order('created_at', { ascending: false }),
      supabase.from('audit_events').select('*').eq('organization_id', orgId).order('created_at', { ascending: false }).limit(100),
    ])
    setData({
      systems: systems.data || [],
      workflows: workflows.data || [],
      opps: opps.data || [],
      integrations: integrations.data || [],
      agents: agents.data || [],
      policies: policies.data || [],
      blueprints: blueprints.data || [],
      audit: audit.data || []
    })
  }

  if (loading) return <div className="center">Loading CerbTek…</div>
  if (!session) return <Auth />
  if (!orgs.length) return <CreateOrganization session={session} onCreated={loadOrgs} />

  const nav = staff ? [...baseNav, ['CerbTek Staff', Users]] : baseNav

  return <div className="app">
    <aside className="sidebar">
      <div className="brand"><img className="brand-mark" src="/cerberus.svg" alt="CerbTek Cerberus" /><div><strong>CerbTek</strong><span>AI Enablement</span></div></div>
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
        <div className="header-actions">
          {staff && <div className="staff-pill">{staff.role.replaceAll('_',' ')}</div>}
          <div className="tenant-pill"><Building2 size={15}/>{org.name}</div>
        </div>
      </header>
      <section className="content">
        {active === 'Overview' && <Overview data={data} onGo={setActive}/>}
        {active === 'AI Readiness' && <Readiness data={data}/>}
        {active === 'Systems' && <Systems org={org} session={session} rows={data.systems} reload={() => loadOrg(org.id)}/>}
        {active === 'Workflows' && <Workflows org={org} session={session} rows={data.workflows} reload={() => loadOrg(org.id)}/>}
        {active === 'Opportunities' && <Opportunities org={org} session={session} workflows={data.workflows} rows={data.opps} reload={() => loadOrg(org.id)}/>}
        {active === 'Integrations' && <Integrations org={org} session={session} systems={data.systems} rows={data.integrations} reload={() => loadOrg(org.id)}/>}
        {active === 'Agents' && <Agents org={org} session={session} rows={data.agents} integrations={data.integrations} reload={() => loadOrg(org.id)}/>}
        {active === 'Governance' && <Governance org={org} session={session} rows={data.policies} reload={() => loadOrg(org.id)}/>}
        {active === 'Blueprints' && <Blueprints org={org} session={session} data={data} reload={() => loadOrg(org.id)}/>}
        {active === 'Audit' && <Audit rows={data.audit}/>}
        {active === 'CerbTek Staff' && staff && <StaffWorkspace orgs={orgs} current={org} setOrg={setOrg} role={staff.role}/>}
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
      : await supabase.auth.signUp({email,password, options:{ emailRedirectTo: window.location.origin }})
    if (res.error) setMessage(res.error.message)
    else if (mode === 'signup') setMessage('Account created. Check your email if confirmation is enabled.')
  }
  return <div className="auth-shell"><div className="auth-card">
    <div className="brand auth-brand"><img className="brand-mark" src="/cerberus.svg" alt="CerbTek Cerberus" /><div><strong>CerbTek</strong><span>AI Enablement</span></div></div>
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
        <Progress label="Agent controls" done={data.agents.length>0}/>
      </Panel>
      <Panel title="Next best action">
        <p>Map the business before scaling agents. Build enough workflow evidence to generate a defensible AI Enablement Blueprint.</p>
        <button className="secondary" onClick={()=>onGo(!data.systems.length?'Systems':!data.workflows.length?'Workflows':!data.opps.length?'Opportunities':'Blueprints')}>Continue assessment</button>
      </Panel>
    </div>
  </>
}

function Readiness({data}) {
  const score = readinessScore(data)
  return <div className="grid two">
    <Panel title="AI Readiness Score"><div className="score">{score}<span>/100</span></div><p>Score combines mapped systems, workflows, prioritized AI opportunities, governance coverage, and controlled agent readiness.</p></Panel>
    <Panel title="Assessment coverage">
      <Progress label="Technology mapped" done={data.systems.length>=3}/>
      <Progress label="Operational workflows mapped" done={data.workflows.length>=3}/>
      <Progress label="AI use cases scored" done={data.opps.length>=3}/>
      <Progress label="Governance established" done={data.policies.length>=2}/>
      <Progress label="Agent controls established" done={data.agents.length>=1}/>
    </Panel>
  </div>
}

function Systems({org,session,rows,reload}) {
  const [name,setName]=useState('')
  const [vendor,setVendor]=useState('')
  const [classification,setClassification]=useState('Internal')
  async function save(e) {
    e.preventDefault()
    const {error}=await supabase.from('systems').insert({
      organization_id:org.id,name,vendor:vendor||null,data_classification:classification,integration_status:'Not Assessed',created_by:session.user.id
    })
    if(!error){setName('');setVendor('');reload()}
  }
  return <Panel title="Systems inventory">
    <form className="inline-form four" onSubmit={save}>
      <input placeholder="System" value={name} onChange={e=>setName(e.target.value)} required/>
      <input placeholder="Vendor" value={vendor} onChange={e=>setVendor(e.target.value)}/>
      <select value={classification} onChange={e=>setClassification(e.target.value)}><DataClassOptions/></select>
      <button className="primary small">Add</button>
    </form>
    <Rows rows={rows} secondary={r => [r.vendor,r.data_classification,r.integration_status].filter(Boolean).join(' • ')} table="systems" reload={reload}/>
  </Panel>
}

function Workflows({org,session,rows,reload}) {
  const [name,setName]=useState('')
  const [department,setDepartment]=useState('')
  const [risk,setRisk]=useState('Moderate')
  async function save(e) {
    e.preventDefault()
    const {error}=await supabase.from('workflows').insert({
      organization_id:org.id,name,department:department||null,current_risk_level:risk,created_by:session.user.id
    })
    if(!error){setName('');setDepartment('');reload()}
  }
  return <Panel title="Workflow inventory">
    <form className="inline-form four" onSubmit={save}>
      <input placeholder="Workflow" value={name} onChange={e=>setName(e.target.value)} required/>
      <input placeholder="Department" value={department} onChange={e=>setDepartment(e.target.value)}/>
      <select value={risk} onChange={e=>setRisk(e.target.value)}><option>Low</option><option>Moderate</option><option>High</option><option>Critical</option></select>
      <button className="primary small">Add</button>
    </form>
    <Rows rows={rows} secondary={r => [r.department,r.current_risk_level].filter(Boolean).join(' • ')} table="workflows" reload={reload}/>
  </Panel>
}

function Opportunities({org,session,workflows,rows,reload}) {
  const [name,setName]=useState('')
  const [workflow,setWorkflow]=useState('')
  const [value,setValue]=useState(80)
  const [fit,setFit]=useState(80)
  const [risk,setRisk]=useState(25)
  const [control,setControl]=useState('Approve')
  async function save(e) {
    e.preventDefault()
    const {error}=await supabase.from('ai_opportunities').insert({
      organization_id:org.id, workflow_id:workflow||null, name,
      business_value:+value, repeatability:70, data_availability:60, ai_suitability:+fit,
      integration_difficulty:40, risk_score:+risk, implementation_complexity:'Medium',
      human_control_mode:control, created_by:session.user.id
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
      <select value={control} onChange={e=>setControl(e.target.value)}><option>Assist</option><option>Approve</option><option>Autonomous</option></select>
      <button className="primary small">Score</button>
    </form>
    <Rows rows={rows} secondary={r => `Score ${r.opportunity_score}/100 • ${r.human_control_mode}`} score table="ai_opportunities" reload={reload}/>
  </Panel>
}

function Integrations({org,session,systems,rows,reload}) {
  const [name,setName]=useState('')
  const [provider,setProvider]=useState('')
  const [type,setType]=useState('API')
  const [system,setSystem]=useState('')
  const [classification,setClassification]=useState('Internal')
  async function save(e){
    e.preventDefault()
    const {error}=await supabase.from('integrations').insert({
      organization_id:org.id,system_id:system||null,name,provider:provider||null,
      integration_type:type,status:'Planned',data_classification:classification,created_by:session.user.id
    })
    if(!error){setName('');setProvider('');reload()}
  }
  return <Panel title="Integrations">
    <form className="inline-form integration-form" onSubmit={save}>
      <input placeholder="Integration name" value={name} onChange={e=>setName(e.target.value)} required/>
      <input placeholder="Provider" value={provider} onChange={e=>setProvider(e.target.value)}/>
      <select value={type} onChange={e=>setType(e.target.value)}><option>API</option><option>OAuth</option><option>MCP</option><option>Webhook</option><option>Database</option><option>File</option><option>Other</option></select>
      <select value={system} onChange={e=>setSystem(e.target.value)}><option value="">No linked system</option>{systems.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select>
      <select value={classification} onChange={e=>setClassification(e.target.value)}><DataClassOptions/></select>
      <button className="primary small">Add</button>
    </form>
    <Rows rows={rows} secondary={r => [r.provider,r.integration_type,r.status,r.data_classification].filter(Boolean).join(' • ')} table="integrations" reload={reload}/>
  </Panel>
}

function Agents({org,session,rows,integrations,reload}) {
  const [name,setName]=useState('')
  const [purpose,setPurpose]=useState('')
  const [control,setControl]=useState('Assist')
  const [threshold,setThreshold]=useState(85)
  const [allowed,setAllowed]=useState('Read approved business data; draft responses')
  const [prohibited,setProhibited]=useState('Change financial terms; delete records')
  const [integration,setIntegration]=useState('')
  async function save(e){
    e.preventDefault()
    const {data,error}=await supabase.from('ai_agents').insert({
      organization_id:org.id,name,purpose,status:'Draft',human_control_mode:control,
      allowed_data_classifications:['Public','Internal'],
      allowed_actions:allowed.split(';').map(x=>x.trim()).filter(Boolean),
      prohibited_actions:prohibited.split(';').map(x=>x.trim()).filter(Boolean),
      confidence_threshold:+threshold,audit_logging_enabled:true,created_by:session.user.id
    }).select().single()
    if(!error && data){
      if(integration) await supabase.from('agent_integrations').insert({agent_id:data.id,integration_id:integration,access_mode:'Read'})
      setName('');setPurpose('');reload()
    }
  }
  return <>
    <Panel title="Agent Builder">
      <form className="agent-form" onSubmit={save}>
        <label>Agent name<input value={name} onChange={e=>setName(e.target.value)} required/></label>
        <label>Purpose<input value={purpose} onChange={e=>setPurpose(e.target.value)} required placeholder="What business outcome does this agent own?"/></label>
        <label>Human control<select value={control} onChange={e=>setControl(e.target.value)}><option>Assist</option><option>Approve</option><option>Autonomous</option></select></label>
        <label>Confidence threshold<input type="number" min="0" max="100" value={threshold} onChange={e=>setThreshold(e.target.value)}/></label>
        <label className="span-2">Allowed actions<input value={allowed} onChange={e=>setAllowed(e.target.value)} /></label>
        <label className="span-2">Prohibited actions<input value={prohibited} onChange={e=>setProhibited(e.target.value)} /></label>
        <label>Initial integration<select value={integration} onChange={e=>setIntegration(e.target.value)}><option value="">None</option>{integrations.map(i=><option key={i.id} value={i.id}>{i.name}</option>)}</select></label>
        <div className="form-actions"><button className="primary"><Bot size={15}/>Create controlled agent</button></div>
      </form>
    </Panel>
    <Panel title="AI agents">
      <Rows rows={rows} secondary={r => [r.status,r.human_control_mode,r.confidence_threshold!=null?`${r.confidence_threshold}% threshold`:null,r.audit_logging_enabled?'Audit on':'Audit off'].filter(Boolean).join(' • ')} table="ai_agents" reload={reload}/>
    </Panel>
  </>
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
    <Rows rows={rows} secondary={r => `${r.policy_type} • ${r.status}`} table="governance_policies" reload={reload}/>
  </Panel>
}

function Blueprints({org,session,data,reload}) {
  async function create() {
    const maturity = readinessScore(data)
    const recommendations = data.opps.slice(0,5).map(o=>({name:o.name,score:o.opportunity_score,control:o.human_control_mode}))
    const roadmap = [
      {phase:'30 days',focus:'Complete inventory, governance baseline, and top use-case selection'},
      {phase:'60 days',focus:'Implement first governed workflow with human approval and audit logging'},
      {phase:'90 days',focus:'Operationalize monitoring, employee enablement, cost controls, and optimization'}
    ]
    await supabase.from('blueprints').insert({
      organization_id:org.id,title:'AI Enablement Blueprint',maturity_score:maturity,
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

  return <Panel title="AI Enablement Blueprints">
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
  return <>
    <div className="metrics">
      <Metric label="Client tenants" value={orgs.length}/>
      <Metric label="Staff role" value={role.replaceAll('_',' ')}/>
      <Metric label="Current client" value={current?.name || '—'}/>
      <Metric label="Isolation model" value="RLS"/>
    </div>
    <Panel title="Client portfolio">
      <p>Switch into any authorized client tenant to perform assessments, configure integrations, build controlled agents, and review audit events.</p>
      <div className="client-grid">{orgs.map(o=>
        <button key={o.id} className={current?.id===o.id?'client-card selected':'client-card'} onClick={()=>setOrg(o)}>
          <Building2 size={19}/><b>{o.name}</b><span>{o.industry || 'Industry not set'}</span>
        </button>
      )}</div>
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
  const recs=(bp.recommendations||[]).map(x=>`<tr><td>${escapeHtml(x.name)}</td><td>${x.score}</td><td>${escapeHtml(x.control)}</td></tr>`).join('')
  const roadmap=(bp.roadmap||[]).map(x=>`<div class="phase"><b>${escapeHtml(x.phase)}</b><p>${escapeHtml(x.focus)}</p></div>`).join('')
  return `<!doctype html><html><head><title>${escapeHtml(org.name)} AI Enablement Blueprint</title><style>
    body{font-family:Arial,sans-serif;color:#161616;margin:48px;line-height:1.5}.top{border-bottom:3px solid #111;padding-bottom:18px;margin-bottom:28px}
    h1{margin:0;font-size:30px}.ey{font-size:11px;letter-spacing:.15em;color:#666}.score{font-size:56px;font-weight:800}
    .score span{font-size:18px;color:#666}table{width:100%;border-collapse:collapse;margin:18px 0}th,td{border-bottom:1px solid #ddd;padding:10px;text-align:left}
    .phase{border-left:3px solid #111;padding:2px 0 2px 14px;margin:16px 0}.muted{color:#666}@media print{body{margin:.45in}}
  </style></head><body>
    <div class="top"><div class="ey">CERBTEK AI ENABLEMENT BLUEPRINT</div><h1>${escapeHtml(org.name)}</h1><p class="muted">Generated from the CerbTek AI Enablement Command Center</p></div>
    <h2>AI Readiness</h2><div class="score">${bp.maturity_score ?? 0}<span>/100</span></div>
    <h2>Executive Summary</h2><p>${escapeHtml(bp.executive_summary||'')}</p>
    <h2>Priority Opportunities</h2><table><thead><tr><th>Opportunity</th><th>Score</th><th>Control</th></tr></thead><tbody>${recs||'<tr><td colspan="3">No prioritized opportunities yet.</td></tr>'}</tbody></table>
    <h2>30 / 60 / 90 Day Roadmap</h2>${roadmap}
    <h2>Current Environment</h2><p>${data.systems.length} systems • ${data.workflows.length} workflows • ${data.integrations.length} integrations • ${data.agents.length} agents • ${data.policies.length} governance policies</p>
  </body></html>`
}

function escapeHtml(v=''){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
function DataClassOptions(){return <><option>Public</option><option>Internal</option><option>Personal</option><option>Sensitive</option><option>Highly Sensitive</option></>}
function Metric({label,value}) { return <div className="metric"><span>{label}</span><strong>{value}</strong></div> }
function Progress({label,done}) { return <div className="progress-row"><span className={done?'dot done':'dot'}></span><span>{label}</span><b>{done?'Complete':'Pending'}</b></div> }
function Panel({title,children}) { return <div className="panel"><h3>{title}</h3>{children}</div> }

createRoot(document.getElementById('root')).render(<App/>)
