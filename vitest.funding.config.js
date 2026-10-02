import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'jsdom', include: ['tests/funding-*.test.jsx'], clearMocks: true } })
