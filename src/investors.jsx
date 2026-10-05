import React from 'react'
import { createRoot } from 'react-dom/client'
import { ArrowUpRight, Layers, Route, Search, Target } from 'lucide-react'
import './styles.css'
import './investment.css'

// Webflow mount paths may omit the trailing slash.
const APP_BASE = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/`

export function InvestorPage() {
  return <div className="investor-page">
    <a className="skip-link" href="#investment-overview">Skip to content</a>
    <header className="investor-nav">
      <a href={APP_BASE} className="brand investor-brand" aria-label="Kairo home"><img className="brand-mark" src={`${APP_BASE}kairo-mark.svg`} alt="" width="42" height="42"/><div><strong>Kairo</strong><span>By CerbTEK LLC</span></div></a>
      <nav aria-label="Investor page"><a href="#approach">Our approach</a><a href="#stage">Stage & evidence</a><a href={`${APP_BASE}app/`}>Client sign-in <ArrowUpRight size={14}/></a></nav>
    </header>
    <main id="investment-overview">
      <section className="investor-hero">
        <div><p className="eyebrow">INVESTORS & STRATEGIC PARTNERS</p><h1>From AI ambition<br/>to a practical<br/><em>operating plan.</em></h1><p className="investor-lede">Kairo brings systems, workflows, readiness and AI opportunities into one command center, helping teams decide what to improve and how to move forward.</p><div className="investor-actions"><a className="primary" href="mailto:info@cerbtek.com?subject=Kairo%20investment%20conversation">Start a conversation <ArrowUpRight size={17}/></a><a className="secondary" href="#stage">Explore the opportunity</a></div><p className="investor-caption">An early-stage product operated by CerbTEK LLC.</p></div>
        <aside className="investor-thesis" aria-label="Product thesis"><span className="eyebrow">THE PRODUCT THESIS</span><h2>One view.<br/>A clearer next step.</h2><ol><li><span>01</span><div><b>Understand the starting point</b><p>Inventory systems and workflows. Assess readiness.</p></div></li><li><span>02</span><div><b>Prioritize the opportunity</b><p>Compare use cases and document assumptions.</p></div></li><li><span>03</span><div><b>Plan the path forward</b><p>Turn findings into a blueprint for delivery.</p></div></li></ol><div className="thesis-foot">Product workflow illustration. No customer data.</div></aside>
      </section>
      <section className="investor-section investor-problem" id="approach"><div><p className="eyebrow">THE PROBLEM WE ARE ADDRESSING</p><h2>Choosing the right AI work<br/>comes before scaling it.</h2></div><p>Organizations need a clear picture of their systems, data and everyday processes before choosing AI use cases. Kairo’s approach connects that discovery work to prioritization, delivery planning and ongoing operational oversight.</p></section>
      <section className="investor-section"><p className="eyebrow">A CONNECTED ENABLEMENT WORKFLOW</p><div className="investor-grid">
        <article><Search size={24}/><h3>Discover</h3><p>Build a shared inventory of systems and workflows, then capture readiness across technology, data, workforce and governance.</p></article>
        <article><Target size={24}/><h3>Prioritize</h3><p>Organize AI opportunities around business value, suitability and data availability. Keep estimated benefits distinct from measured outcomes.</p></article>
        <article><Route size={24}/><h3>Plan & operate</h3><p>Create enablement blueprints and coordinate implementation through a command center for integrations, agents and AI operations.</p></article>
      </div></section>
      <section className="investor-section investor-evidence" id="stage"><div><p className="eyebrow">STAGE & EVIDENCE</p><h2>A working foundation.<br/>A focused validation path.</h2><p>CerbTEK LLC is developing an AI Enablement as a Service offering around its command-center MVP. Investment and partnership conversations can support the next stage of product and customer validation.</p></div><div className="evidence-list"><article><span>01 / TODAY</span><h3>Command-center MVP</h3><p>The product includes organization workspaces, readiness assessments, system and workflow inventories, opportunity scoring and blueprint generation.</p></article><article><span>02 / NEXT MILESTONES</span><h3>Evidence-led development</h3><p>Priorities include validating use cases with prospective customers, documenting delivery outcomes and continuing product and operational assurance work.</p></article><article><span>03 / DUE DILIGENCE</span><h3>Facts before forecasts</h3><p>Customer traction, revenue, funding targets and investment terms are not represented on this page. Current evidence and any proposed terms should be reviewed directly with CerbTEK LLC.</p></article></div></section>
      <section className="investor-contact"><Layers size={30}/><p className="eyebrow">BUILD THE NEXT STAGE WITH US</p><h2>Let’s discuss the fit.</h2><p>For investment, strategic partnerships or a product conversation, contact CerbTEK LLC.</p><a href="mailto:info@cerbtek.com?subject=Kairo%20investment%20conversation" className="primary">info@cerbtek.com <ArrowUpRight size={17}/></a></section>
    </main>
    <footer className="investor-footer"><span>Kairo · Operated by CerbTEK LLC</span><p>Company and product information for discussion only. This page is not an offer to sell securities or a solicitation to invest. No investment returns or funding availability are promised.</p><a href={`${APP_BASE}app/`}>Client sign-in</a></footer>
  </div>
}
if (document.getElementById('investor-root')) createRoot(document.getElementById('investor-root')).render(<InvestorPage />)


