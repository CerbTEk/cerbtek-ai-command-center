import { appRoute, showUnknownApp } from './app-routing'
import { legacyAppTarget } from './marketing-routing'
let forwarding = false
function forwardLegacyAppLink() {
  const route = appRoute(window.location, import.meta.env.BASE_URL)
  if (route.kind === 'unknown' || route.kind === 'kairo') {
    // A marketing fallback is not an app entry; never self-redirect or load auth.
    showUnknownApp(document, import.meta.env.BASE_URL)
    return
  }
  const target = legacyAppTarget(window.location, import.meta.env.BASE_URL)
  if (target && !forwarding) { forwarding = true; window.location.replace(target) }
}
forwardLegacyAppLink()
window.addEventListener('hashchange', forwardLegacyAppLink)
window.addEventListener('popstate', forwardLegacyAppLink)
