import React, {useEffect,useRef,useState} from 'react'
import {INTEGRATION_PROVIDERS,integrationProvider,integrationPlans,createIntegrationPlan} from './integration-providers'
import './integration-providers.css'

// No provider APIs or credentials. Persistence is an ordinary Planned inventory row.
export default function IntegrationProviderPlanner({rows=[],onSave}) {
  const [selected,setSelected]=useState('')
  const [useCase,setUseCase]=useState('')
  const [message,setMessage]=useState('')
  const [saving,setSaving]=useState(false)
  const pending=useRef(false)
  const [savedKeys,setSavedKeys]=useState([])
  const provider=integrationProvider(selected)
  const plans=integrationPlans(rows)
  useEffect(()=>{
    const persisted=new Set(integrationPlans(rows).map(item=>item.plan.provider+':'+item.plan.useCase))
    setSavedKeys(keys=>{
      const unconfirmed=keys.filter(key=>!persisted.has(key))
      return unconfirmed.length===keys.length?keys:unconfirmed
    })
  },[rows,savedKeys])
  const duplicate=savedKeys.includes(selected+':'+useCase)||plans.some(item=>item.plan.provider===selected&&item.plan.useCase===useCase)
  async function save(event) {
    event.preventDefault()
    if(pending.current||duplicate||!provider||!useCase) return
    pending.current=true;setSaving(true);setMessage('Saving integration plan…')
    try {
      await onSave(createIntegrationPlan({providerId:selected,useCaseId:useCase}))
      setSavedKeys(keys=>[...keys,selected+':'+useCase])
      setMessage('Plan saved. Return to Integrations to review it. No account was connected and no workflow was run.')
    } catch {
      setMessage('Save was not confirmed. Your selection is still here. Refresh the workspace and check for the plan before trying again.')
    } finally {pending.current=false;setSaving(false)}
  }
  return <section className="panel provider-planner" aria-labelledby="provider-planner-heading">
    <p className="eyebrow">YOUR BUSINESS SYSTEMS</p>
    <h3 id="provider-planner-heading">Choose an integration path</h3>
    <p>Plan around the tools your team uses. Microsoft 365, Google Workspace and AWS have different access and setup requirements.</p>
    <div className="provider-catalog">{INTEGRATION_PROVIDERS.map(item=><article className={'provider-card'+(selected===item.id?' selected':'')} key={item.id}>
      <h4>{item.name}</h4><span className="provider-availability">{item.availability}</span><p>{item.summary}</p>
      <button type="button" className="secondary" aria-pressed={selected===item.id} disabled={saving} onClick={()=>{setSelected(item.id);setUseCase(item.cases[0].id);setMessage('')}}>Plan {item.name}</button>
    </article>)}</div>
    {provider&&<form className="provider-plan-form" onSubmit={save}>
      <h4>{provider.name} setup plan</h4><p>{provider.next}</p>
      <label>First use case<select value={useCase} disabled={saving} onChange={event=>{setUseCase(event.target.value);setMessage('')}}>{provider.cases.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
      <p className="provider-note">This saves a planning record only. It does not request permissions, create credentials, or enable execution. Keep passwords, client secrets and access keys out of inventory notes.</p>
      <div className="provider-plan-actions"><button className="primary" disabled={saving||duplicate}>{saving?'Saving…':duplicate?'Plan already saved':'Save integration plan'}</button><button type="button" className="secondary" disabled={saving} onClick={()=>{setSelected('');setUseCase('');setMessage('')}}>Cancel</button></div>
    </form>}
    {message&&<p className="message" role="status" aria-live="polite">{message}</p>}
    {plans.length>0&&<div className="provider-saved-plans"><h4>Saved integration plans</h4><ul>{plans.map(({row,plan},index)=>{
      const item=integrationProvider(plan.provider)
      return <li key={row.id||index}><b>{item.name}: {item.cases.find(value=>value.id===plan.useCase).name}</b><span>{item.availability}</span><p>{item.next}</p></li>
    })}</ul><p>Plans remain available here when you return. A planned inventory entry is not proof of an active connection.</p></div>}
  </section>
}
