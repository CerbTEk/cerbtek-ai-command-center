import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

// HTML entries belong only to the browser build. Webflow adds its own worker
// environment; sharing HTML inputs with that SSR build makes Rollup fail.
export default defineConfig({
  environments: {
    client: {
      build: {
        rollupOptions: {
          input: {
            app: fileURLToPath(new URL('./index.html', import.meta.url)),
            investors: fileURLToPath(new URL('./investors/index.html', import.meta.url))
          }
        }
      }
    }
  }
})
