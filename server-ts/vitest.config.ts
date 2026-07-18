import { defineConfig } from 'vitest/config'

// Without a local config, vitest walks up and resolves the sweeos workspace
// config (include: sense/shared/packages globs) — zero files match here and
// the suite silently never runs. Scope explicitly to this package. (2026-07-18)
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
})
