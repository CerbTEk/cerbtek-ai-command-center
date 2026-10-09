// Route only the explicitly supported Kairo entry. Other future CerbTEK apps
// must never be captured by Kairo's bookmark or authentication forwarding.
export function appRoute({ pathname = '', search = '', hash = '' }, base = '/') {
  const prefix = base.replace(/\/$/, '')
  const legacy = `${prefix}/app`
  const canonical = `${legacy}/kairo`
  if ([legacy, `${legacy}/`, `${legacy}/index.html`].includes(pathname)) {
    return { kind: 'legacy', target: `${canonical}${search}${hash}` }
  }
  if ([canonical, `${canonical}/`, `${canonical}/index.html`].includes(pathname)) {
    return { kind: 'kairo', target: null }
  }
  let decodedPath = pathname
  try { decodedPath = decodeURIComponent(pathname) } catch { /* keep malformed paths literal */ }
  if (pathname.startsWith(`${legacy}/`) || decodedPath === legacy ||
      decodedPath.startsWith(`${legacy}/`) || decodedPath.startsWith(`${legacy}\\`) ||
      decodedPath.toLowerCase().startsWith(`${legacy.toLowerCase()}%2f`)) {
    return { kind: 'unknown', target: null }
  }
  return { kind: 'outside', target: null }
}

export function showUnknownApp(document, base = '/') {
  document.title = 'App not found | CerbTEK'
  let robots = document.querySelector('meta[name="robots"]')
  if (!robots) { robots = document.createElement('meta'); robots.name = 'robots'; document.head.append(robots) }
  robots.content = 'noindex'
  for (const element of document.querySelectorAll('link[rel="canonical"], meta[property^="og:"]')) element.remove()
  const main = document.createElement('main')
  main.style.cssText = 'max-width:40rem;margin:15vh auto;padding:2rem;font-family:system-ui,sans-serif'
  const heading = document.createElement('h1')
  heading.textContent = 'This app isn’t available at this address.'
  const message = document.createElement('p')
  message.textContent = 'Check the link or return to CerbTEK.'
  const link = document.createElement('a')
  link.href = `${base.replace(/\/$/, '')}/`
  link.textContent = 'Return to CerbTEK'
  main.append(heading, message, link)
  document.body.replaceChildren(main)
}

export function startKairoApp({ location, document }, base, loadApp) {
  const route = appRoute(location, base)
  if (route.kind === 'legacy') {
    // Navigation finishes before the auth client is imported.
    location.replace(route.target)
  } else if (route.kind === 'kairo') {
    return loadApp()
  } else {
    showUnknownApp(document, base)
  }
}
