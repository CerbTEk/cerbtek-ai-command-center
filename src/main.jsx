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
  ['Onboarding', Building2],
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
    policies: [], blueprints: [], audit: [], onboarding: null, readiness: null
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
    const [systems, workflows, opps, integrations, agents, policies, blueprints, audit, onboarding, readiness] = await Promise.all([
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
    ])
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
      readiness: readiness.data || null
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
        {active === 'Onboarding' && <Onboarding org={org} session={session} current={data.onboarding} reload={() => loadOrg(org.id)}/>}
        {active === 'AI Readiness' && <Readiness org={org} session={session} data={data} reload={() => loadOrg(org.id)}/>}
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
    <div className="brand auth-brand"><img className="brand-mark" src="/cerberus.svg" alt="CerbTek Cerberus" /><div><strong>CerbTek</strong><span>AI Enablement</span></div></div>
    <h1>{mode === 'signin' ? 'Sign in' : 'Create account'}</h1>
    <p>Secure access to the AI Enablement Command Center.</p>
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
      <Panel title="Next best action">
        <p>Map the business before scaling agents. Build enough workflow evidence to generate a defensible AI Enablement Blueprint.</p>
        <button className="secondary" onClick={()=>onGo(!data.onboarding?'Onboarding':!data.readiness?'AI Readiness':!data.systems.length?'Systems':!data.workflows.length?'Workflows':!data.opps.length?'Opportunities':'Blueprints')}>Continue assessment</button>
      </Panel>
    </div>
  </>
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

function Onboarding({org,session,current,reload}) {
  const [form,setForm]=useState({
    primary_contact_name:'',primary_contact_email:'',business_goals:'',operational_pain_points:'',
    ai_goals:'',current_ai_tools:'',target_outcomes:'',desired_timeline:'',budget_band:'',data_sensitivity:''
  })
  const [saved,setSaved]=useState('')
  useEffect(()=>{ if(current) setForm(x=>({...x,...current})) },[current?.organization_id])
  function field(k,v){setForm({...form,[k]:v})}
  async function save(e){
    e.preventDefault()
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
    setSaved(error?error.message:'Onboarding saved')
    if(!error) reload()
  }
  return <Panel title="Client onboarding">
    <p>Capture the business context CerbTek needs before scoring AI opportunities or designing agents.</p>
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
      <div className="span-2 onboarding-actions"><div><b>{current?.completion_percent||0}% complete</b><span>{current?.status||'Not Started'}</span></div><button className="primary">Save onboarding</button></div>
    </form>
    {saved && <div className="message">{saved}</div>}
  </Panel>
}

function Readiness({org,session,data,reload}) {
  const existing=data.readiness
  const [answers,setAnswers]=useState({})
  const [saved,setSaved]=useState('')
  useEffect(()=>setAnswers(existing?.answers||{}),[existing?.id])
  const dimensions=['technology','workflow','data','governance','workforce','integration']
  function dimensionScore(dim,source=answers){
    const qs=readinessQuestions.filter(q=>q[0]===dim)
    const vals=qs.map(q=>Number(source[q[1]]||0)).filter(Boolean)
    return vals.length===qs.length ? Math.round(vals.reduce((a,b)=>a+b,0)/vals.length*20) : 0
  }
  const scores=Object.fromEntries(dimensions.map(d=>[d,dimensionScore(d)]))
  const answered=Object.keys(answers).filter(k=>answers[k]).length
  async function save(complete=false){
    const payload={
      organization_id:org.id,status:complete?'Complete':'Draft',answers,
      technology_score:scores.technology,workflow_score:scores.workflow,data_score:scores.data,
      governance_score:scores.governance,workforce_score:scores.workforce,integration_score:scores.integration,
      completed_at:complete?new Date().toISOString():null,created_by:session.user.id
    }
    let error
    if(existing?.id) ({error}=await supabase.from('readiness_assessments').update(payload).eq('id',existing.id))
    else ({error}=await supabase.from('readiness_assessments').insert(payload))
    setSaved(error?error.message:(complete?'Assessment completed':'Draft saved'))
    if(!error) reload()
  }
  const overall=existing?.overall_score ?? Math.round(
    scores.technology*.18+scores.workflow*.18+scores.data*.18+scores.governance*.18+scores.workforce*.14+scores.integration*.14
  )
  return <>
    <div className="readiness-top">
      <Panel title="AI Readiness Score"><div className="score">{overall}<span>/100</span></div><p>{answered} of {readinessQuestions.length} assessment questions answered.</p></Panel>
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
        <button className="secondary" onClick={()=>save(false)}>Save draft</button>
        <button className="primary" disabled={answered<readinessQuestions.length} onClick={()=>save(true)}>Complete assessment</button>
      </div>
      {saved && <div className="message">{saved}</div>}
    </Panel>
  </>
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
  return `<!doctype html><html><head><title>${escapeHtml(org.name)} AI Enablement Blueprint</title><style>
    body{font-family:Arial,sans-serif;color:#161616;margin:48px;line-height:1.5}.top{border-bottom:3px solid #111;padding-bottom:18px;margin-bottom:28px}
    h1{margin:0;font-size:30px}.ey{font-size:11px;letter-spacing:.15em;color:#666}.score{font-size:56px;font-weight:800}
    .score span{font-size:18px;color:#666}table{width:100%;border-collapse:collapse;margin:18px 0}th,td{border-bottom:1px solid #ddd;padding:10px;text-align:left}
    .phase{border-left:3px solid #111;padding:2px 0 2px 14px;margin:16px 0}.muted{color:#666}@media print{body{margin:.45in}}
  </style></head><body>
    <div class="top"><div class="ey">CERBTEK AI ENABLEMENT BLUEPRINT</div><h1>${escapeHtml(org.name)}</h1><p class="muted">Generated from the CerbTek AI Enablement Command Center</p></div>
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
