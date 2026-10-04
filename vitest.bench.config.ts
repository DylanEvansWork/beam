import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['bench/**/*.bench.ts'], environment: 'node', testTimeout: 3_600_000, reporters: ['verbose'] },
})
