import { startKairoApp } from './app-routing'

// The route gate preserves same-origin bookmarks before loading authentication.
startKairoApp(window, import.meta.env.BASE_URL, () => import('./main.jsx'))
