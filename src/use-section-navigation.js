import { useEffect, useRef, useState } from 'react'

export const SECTIONS=['Overview','Team Access','Onboarding','AI Readiness','Systems','Workflows','Opportunities','Integrations','Agents','AI Ops','Governance','Blueprints','Audit','CerbTek Staff']
export function sectionFromHash(hash) {
  let value
  try { value=decodeURIComponent(hash.replace(/^#/,'')) } catch { return 'Overview' }
  return SECTIONS.includes(value)?value:'Overview'
}

export function useSectionNavigation() {
  const [active,setActive]=useState(()=>sectionFromHash(window.location.hash))
  const headingRef=useRef(null)
  const previousSection=useRef(active)
  useEffect(()=>{
    const sync=()=>setActive(sectionFromHash(window.location.hash))
    window.addEventListener('hashchange',sync)
    window.addEventListener('popstate',sync)
    return ()=>{window.removeEventListener('hashchange',sync);window.removeEventListener('popstate',sync)}
  },[])
  useEffect(()=>{
    if(previousSection.current===active) return
    previousSection.current=active
    // Run after history scroll restoration, but leave initial page refresh alone.
    const frame=window.requestAnimationFrame(()=>{
      const heading=headingRef.current
      if(!heading) return
      heading.focus({preventScroll:true})
      heading.scrollIntoView?.({block:'start',behavior:'instant'})
    })
    return ()=>window.cancelAnimationFrame(frame)
  },[active])
  function navigate(section,{replace=false}={}) {
    if(!SECTIONS.includes(section)) return
    setActive(section)
    const hash='#'+encodeURIComponent(section)
    if(window.location.hash!==hash) {
      if(replace) window.history.replaceState({},'',window.location.pathname+window.location.search+hash)
      else window.location.hash=hash
    }
  }
  return [active,navigate,headingRef]
}
