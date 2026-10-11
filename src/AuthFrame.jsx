import React from 'react'
import './auth.css'

const base = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/`

export default function AuthFrame({ children }) {
  return <main className="auth-shell kairo-auth-shell">
    <section className="auth-card kairo-auth-card" aria-label="Kairo account access">
      <div className="auth-brand">
        <img className="brand-banner" src={`${base}kairo-banner.png`} alt="Kairo by CerbTEK" width="2048" height="683"/>
      </div>
      <div className="auth-content">{children}</div>
      <footer className="auth-footer">
        <a className="auth-investor-link" href={`${base}investors/`}>Investors & strategic partners</a>
      </footer>
    </section>
  </main>
}
