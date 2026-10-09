import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'jsdom', include: ['tests/company-knowledge*.test.jsx'], clearMocks: true } })
