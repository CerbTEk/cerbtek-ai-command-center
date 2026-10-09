import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

let publicBase = '/'

// HTML entries belong only to the browser build. Webflow adds its own worker
// environment; sharing HTML inputs with that SSR build makes Rollup fail.
export default defineConfig({
  plugins: [{
    name: 'kairo-public-mount-base',
    configResolved(config) { publicBase = `${config.base.replace(/\/$/, '')}/` },
    transformIndexHtml: {
      order: 'pre',
      handler(html) { return html.replaceAll('%KAIRO_BASE%', publicBase) }
    }
  }],
  environments: {
    client: {
      build: {
        rollupOptions: {
          input: {
            marketing: fileURLToPath(new URL('./index.html', import.meta.url)),
            product: fileURLToPath(new URL('./products/kairo/index.html', import.meta.url)),
            app: fileURLToPath(new URL('./app/index.html', import.meta.url)),
            kairo: fileURLToPath(new URL('./app/kairo/index.html', import.meta.url)),
            investors: fileURLToPath(new URL('./investors/index.html', import.meta.url))
          }
        }
      }
    }
  }
})

