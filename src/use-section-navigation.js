import { useEffect, useState } from 'react'

export const SECTIONS=['Overview','Team Access','Onboarding','AI Readiness','Systems','Workflows','Opportunities','Integrations','Agents','AI Ops','Governance','Blueprints','Audit','CerbTek Staff']
export function sectionFromHash(hash) {
  let value
  try { value=decodeURIComponent(hash.replace(/^#/,'')) } catch { return 'Overview' }
  return SECTIONS.includes(value)?value:'Overview'
}

export function useSectionNavigation() {
  const [active,setActive]=useState(()=>sectionFromHash(window.location.hash))
  useEffect(()=>{
    const sync=()=>setActive(sectionFromHash(window.location.hash))
    window.addEventListener('hashchange',sync)
    window.addEventListener('popstate',sync)
    return ()=>{window.removeEventListener('hashchange',sync);window.removeEventListener('popstate',sync)}
  },[])
  function navigate(section,{replace=false}={}) {
    if(!SECTIONS.includes(section)) return
    setActive(section)
    const hash='#'+encodeURIComponent(section)
    if(window.location.hash!==hash) {
      if(replace) window.history.replaceState({},'',window.location.pathname+window.location.search+hash)
      else window.location.hash=hash
    }
  }
  return [active,navigate]
}
