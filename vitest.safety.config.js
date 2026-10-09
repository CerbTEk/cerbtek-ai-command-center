import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'jsdom', include: ['tests/safety-*.test.jsx'], clearMocks: true } })
