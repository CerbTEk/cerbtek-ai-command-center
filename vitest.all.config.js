import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'jsdom', include: ['tests/*.test.jsx'], clearMocks: true, maxWorkers: 2 } })
