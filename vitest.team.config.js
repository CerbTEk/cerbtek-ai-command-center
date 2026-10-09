import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'jsdom', include: ['tests/team-*.test.jsx'], clearMocks: true } })
