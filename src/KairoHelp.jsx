import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowUpRight, BookOpen, CircleHelp, Search, X } from 'lucide-react'
import { HELP_ARTICLES, HELP_CATEGORIES, HELP_VERSION, getHelpArticle, helpDestination, helpSourceUrl } from './kairo-help-content'
import { buildHelpContext, searchHelp } from './kairo-help-search'
import './kairo-help.css'

// Remount synchronously when identity or section changes. This also closes the
// modal before history navigation moves focus to the new section heading.
export default function KairoHelp({userId,organizationId,...props}) {
  if (!userId || !organizationId) return null
  return <HelpPanel key={JSON.stringify([userId,organizationId,props.section])} {...props}/>
}

function HelpPanel({section,data,ready,onNavigate}) {
  const [open,setOpen]=useState(false)
  const [query,setQuery]=useState('')
  const [articleId,setArticleId]=useState(null)
  const [browseAll,setBrowseAll]=useState(false)
  const triggerRef=useRef(null)
  const dialogRef=useRef(null)
  const searchRef=useRef(null)
  const articleHeadingRef=useRef(null)
  const skipRestore=useRef(false)
  const context=useMemo(()=>buildHelpContext({section,data,ready}),[section,data,ready])
  const results=useMemo(()=>searchHelp(query,context),[query,context])
  const article=getHelpArticle(articleId)

  function close({navigate=false}={}) {
    skipRestore.current=navigate
    setOpen(false);setQuery('');setArticleId(null);setBrowseAll(false)
  }
  function goTo(sectionName) {
    const destination=helpDestination(sectionName)
    if (!destination || typeof onNavigate !== 'function') return
    close({navigate:destination!==section})
    onNavigate(destination)
  }

  useEffect(()=>{
    if(!open) return
    const previousOverflow=document.body.style.overflow
    document.body.style.overflow='hidden'
    searchRef.current?.focus()
    const trigger=triggerRef.current
    return ()=>{
      document.body.style.overflow=previousOverflow
      if(!skipRestore.current && trigger?.isConnected) trigger.focus()
      skipRestore.current=false
    }
  },[open])

  useEffect(()=>{
    if(open && articleId) articleHeadingRef.current?.focus()
  },[open,articleId])

  function onKeyDown(event) {
    if(event.key==='Escape') {event.preventDefault();close();return}
    if(event.key!=='Tab') return
    const elements=[...(dialogRef.current?.querySelectorAll('button:not([disabled]), input:not([disabled]), a[href], [tabindex="0"]')||[])]
      .filter(element=>!element.closest('[hidden]'))
    const first=elements[0], last=elements[elements.length-1]
    if(!first) {event.preventDefault();return}
    if(event.shiftKey && (document.activeElement===first || !elements.includes(document.activeElement))) {event.preventDefault();last.focus()}
    else if(!event.shiftKey && (document.activeElement===last || !elements.includes(document.activeElement))) {event.preventDefault();first.focus()}
  }

  return <>
    <button ref={triggerRef} className="kairo-help-trigger" onClick={()=>setOpen(true)} aria-haspopup="dialog" aria-expanded={open} aria-controls="kairo-help-dialog">
      <CircleHelp size={19} aria-hidden="true"/><span>Help with Kairo</span>
    </button>
    {open&&<div className="kairo-help-overlay" onClick={event=>{if(event.target===event.currentTarget)close()}}>
      <section ref={dialogRef} id="kairo-help-dialog" className="kairo-help-panel" role="dialog" aria-modal="true" aria-labelledby="kairo-help-title" aria-describedby="kairo-help-description" onKeyDown={onKeyDown}>
        <div className="kairo-help-header">
          <div><p className="kairo-help-eyebrow"><BookOpen size={14} aria-hidden="true"/>PRODUCT & TECHNICAL GUIDES</p><h2 id="kairo-help-title">Kairo help</h2></div>
          <button className="kairo-help-icon" aria-label="Close help" onClick={()=>close()}><X size={20} aria-hidden="true"/></button>
        </div>
        <p id="kairo-help-description" className="kairo-help-description">Product instructions and technical references for your team. External implementation guides are labeled separately.</p>
        <div className="kairo-help-search">
          <label htmlFor="kairo-help-query">Search help</label>
          <div className="kairo-help-search-input"><Search size={17} aria-hidden="true"/><input ref={searchRef} id="kairo-help-query" type="search" maxLength={240} placeholder="Try telephony controls, Entra, or approvals" value={query} onChange={event=>{setQuery(event.target.value);setArticleId(null)}} autoComplete="off"/></div>
          <p>Searches stay in your browser. Only this curated guide library is searched.</p>
        </div>
        <div className="kairo-help-body">
          {article?<article className="kairo-help-article">
            <button className="kairo-help-back" onClick={()=>{setArticleId(null);searchRef.current?.focus()}}><ArrowLeft size={15} aria-hidden="true"/>Back to guides</button>
            <p className="kairo-help-section-label">{article.kind==='reference'?'External implementation reference':'Kairo product guide'} · {article.category}</p>
            <h3 ref={articleHeadingRef} tabIndex={-1}>{article.title}</h3>
            <p>{article.summary}</p>
            {!!article.prerequisites.length&&<div className="kairo-help-prerequisites"><h4>Before you begin</h4><ul>{article.prerequisites.map(item=><li key={item}>{item}</li>)}</ul></div>}
            <h4>{article.kind==='reference'?'Implementation checklist':'Steps'}</h4><ol>{article.steps.map(item=><li key={item}>{item}</li>)}</ol>
            {!!article.troubleshooting.length&&<div className="kairo-help-troubleshooting"><h4>Troubleshooting</h4><ul>{article.troubleshooting.map(item=><li key={item}>{item}</li>)}</ul></div>}
            <p className="kairo-help-note">{article.note}</p>
            {article.kind==='platform'&&<><button className="kairo-help-go" onClick={()=>goTo(article.section)}>Open {article.section}<ArrowUpRight size={16} aria-hidden="true"/></button>
            <p className="kairo-help-navigation-note">Opens the screen only. You choose whether to make changes there.</p></>}
            <div className="kairo-help-sources"><h4>Sources and review</h4><p>Reviewed {article.reviewedAt}. Product and provider behavior can change.</p><ul>{article.sources.map(source=><li key={source.label}>{helpSourceUrl(source.url)?<a href={helpSourceUrl(source.url)} target="_blank" rel="noopener noreferrer">{source.label}<span className="kairo-help-source-hint"> (external, new tab)</span></a>:source.label}</li>)}</ul></div>
            {!!article.related.length&&<div className="kairo-help-related"><h4>Related guides</h4>{article.related.map(id=>getHelpArticle(id)).filter(Boolean).map(item=><button key={item.id} onClick={()=>setArticleId(item.id)}>{item.title}<ArrowUpRight size={14} aria-hidden="true"/></button>)}</div>}
          </article>:<>
            <div className="kairo-help-results-heading"><h3>{query.trim()?'Search results':'Related guides'}</h3><span>{query.trim()?`${results.length} shown`:`For ${context.currentSection}`}</span></div>
            {!query.trim()&&<p className="kairo-help-context-note">{context.ready?'Suggestions use this page and your saved setup progress.':'Setup suggestions are unavailable while this company’s information loads. You can still browse the guides.'}</p>}
            {results.length?<div className="kairo-help-results">{results.map(item=><button key={item.id} className="kairo-help-result" onClick={()=>setArticleId(item.id)}>
              <span className="kairo-help-section-label">{item.kind==='reference'?'External reference':item.section} · {item.category}{!query.trim()&&context.ready&&item.id===context.suggestedArticle?' · Suggested setup step':''}</span>
              <strong>{item.title}</strong><span>{item.summary}</span><span className="kairo-help-read">Read guide <ArrowUpRight size={14} aria-hidden="true"/></span>
            </button>)}</div>:<div className="kairo-help-empty" role="status"><BookOpen size={25} aria-hidden="true"/><h4>No matching guide</h4><p>No guide covers all of those search terms yet. Try a specific topic such as “telephony routing,” “Microsoft 403,” or “email approval,” or browse the library below. This search does not inspect your company’s records or invent an answer.</p><button onClick={()=>{setQuery('');searchRef.current?.focus()}}>Show related guides</button></div>}
            <div className="kairo-help-all"><button className="kairo-help-all-toggle" aria-expanded={browseAll} aria-controls="kairo-help-all-list" onClick={()=>setBrowseAll(value=>!value)}>Browse all {HELP_ARTICLES.length} guides</button><div id="kairo-help-all-list" hidden={!browseAll}>{HELP_CATEGORIES.map(category=><section key={category} className="kairo-help-category"><h4>{category}</h4>{HELP_ARTICLES.filter(item=>item.category===category).map(item=><button key={item.id} onClick={()=>setArticleId(item.id)}>{item.title}{item.kind==='reference'&&<span className="kairo-help-reference-tag">External reference</span>}</button>)}</section>)}</div></div>
          </>}
        </div>
        <footer className="kairo-help-footer">Curated Kairo guidance · Version {HELP_VERSION}<span>Help does not run workflows or change your settings.</span></footer>
      </section>
    </div>}
  </>
}
