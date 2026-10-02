import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
export default defineConfig({
  build: { rollupOptions: { input: { app: fileURLToPath(new URL('./index.html', import.meta.url)), investors: fileURLToPath(new URL('./investors/index.html', import.meta.url)) } } }
})
