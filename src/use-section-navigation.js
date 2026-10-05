import { useEffect, useRef, useState } from 'react'

export const SECTIONS=['Overview','Team Access','Onboarding','AI Readiness','Systems','Workflows','Opportunities','Integrations','Agents','AI Ops','Governance','Blueprints','Audit','CerbTek Staff','Funding']
export function sectionFromHash(hash) {
  let value
  try { value=decodeURIComponent(hash.replace(/^#/,'')) } catch { return 'Overview' }
  return SECTIONS.includes(value)?value:'Overview'
}

export function useSectionNavigation(canNavigate = () => true) {
  const [active,setActive]=useState(()=>sectionFromHash(window.location.hash))
  const currentSection=useRef(active)
  const guard=useRef(canNavigate)
  guard.current=canNavigate
  const headingRef=useRef(null)
  const previousSection=useRef(active)
  const historyIndex=useRef(0)
  const restoring=useRef(null)
  const currentUrl=useRef(window.location.href)
  useEffect(()=>{
    const history=window.history
    const key='__kairoSectionIndex'
    const originalPush=history.pushState
    const originalReplace=history.replaceState
    const stateWithIndex=(state,index)=>({...state,[key]:index})
    const stateWithoutIndex=state=>{const copy={...state};delete copy[key];return copy}
    let positionKnown=true,seenLength=history.length,rejectedUrl=null
    const browserIndex=()=>window.navigation?.currentEntry?.index
    historyIndex.current=Number.isInteger(browserIndex())&&browserIndex()>=0?browserIndex():(Number.isInteger(history.state?.[key])?history.state[key]:0)
    originalReplace.call(history,stateWithIndex(history.state,historyIndex.current),'')
    // Workflow/company navigation also uses these methods. Keep their state and
    // URLs intact while recording positions so a rejected traversal can be undone.
    function push(state,title,url) {
      const index=historyIndex.current+1
      originalPush.call(history,positionKnown?stateWithIndex(state,index):stateWithoutIndex(state),title,url)
      if(positionKnown) historyIndex.current=index
      seenLength=history.length;rejectedUrl=null
      if(sectionFromHash(window.location.hash)===currentSection.current) currentUrl.current=window.location.href
    }
    function replace(state,title,url) {
      originalReplace.call(history,positionKnown?stateWithIndex(state,historyIndex.current):stateWithoutIndex(state),title,url)
      rejectedUrl=null
      if(sectionFromHash(window.location.hash)===currentSection.current) currentUrl.current=window.location.href
    }
    history.pushState=push
    history.replaceState=replace
    const sync=event=>{
      // The Navigation API also identifies entries created before this hook
      // mounted (for example, a Funding deep-link refresh).
      let nextIndex=Number.isInteger(browserIndex())&&browserIndex()>=0?browserIndex():history.state?.[key]
      if(!Number.isInteger(nextIndex)&&positionKnown&&history.length>seenLength) {
        // An increased history length proves this is a newly added hash entry.
        nextIndex=historyIndex.current+1
        originalReplace.call(history,stateWithIndex(history.state,nextIndex),'')
      }
      seenLength=history.length
      if(rejectedUrl===window.location.href) {event.stopImmediatePropagation();return}
      rejectedUrl=null
      if(restoring.current!==null) {
        event.stopImmediatePropagation()
        if(nextIndex===restoring.current) restoring.current=null
        return
      }
      const next=sectionFromHash(window.location.hash)
      if(next!==currentSection.current&&!guard.current(next,currentSection.current)) {
        event.stopImmediatePropagation()
        if(!positionKnown||!Number.isInteger(nextIndex)) {
          // Older browsers cannot locate pre-hook/legacy entries. Keep the
          // draft mounted without guessing a direction or rewriting history.
          // Their address bar may show the attempted destination until the
          // user navigates again; returning to a marked entry restores tracking.
          positionKnown=false;rejectedUrl=window.location.href
          return
        }
        const delta=historyIndex.current-nextIndex
        if(delta) {
          restoring.current=historyIndex.current
          history.go(delta)
        } else {
          // A same-entry replace is not a traversal; restore only that entry.
          originalReplace.call(history,history.state,'',currentUrl.current)
        }
        return
      }
      positionKnown=Number.isInteger(nextIndex)
      if(positionKnown) historyIndex.current=nextIndex
      currentUrl.current=window.location.href
      if(next===currentSection.current) return
      currentSection.current=next
      setActive(next)
    }
    window.addEventListener('hashchange',sync)
    window.addEventListener('popstate',sync)
    return ()=>{
      window.removeEventListener('hashchange',sync);window.removeEventListener('popstate',sync)
      if(history.pushState===push) history.pushState=originalPush
      if(history.replaceState===replace) history.replaceState=originalReplace
    }
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
    if(!SECTIONS.includes(section)||restoring.current!==null) return
    if(section!==currentSection.current&&!guard.current(section,currentSection.current)) return
    currentSection.current=section
    setActive(section)
    const hash='#'+encodeURIComponent(section)
    if(window.location.hash!==hash) {
      if(replace) window.history.replaceState(window.history.state,'',window.location.pathname+window.location.search+hash)
      else window.history.pushState(window.history.state,'',window.location.pathname+window.location.search+hash)
    }
  }
  return [active,navigate,headingRef]
}
