import { legacyAppTarget } from './marketing-routing'
let forwarding = false
function forwardLegacyAppLink() {
  const target = legacyAppTarget(window.location, import.meta.env.BASE_URL)
  if (target && !forwarding) { forwarding = true; window.location.replace(target) }
}
forwardLegacyAppLink()
window.addEventListener('hashchange', forwardLegacyAppLink)
window.addEventListener('popstate', forwardLegacyAppLink)
