/// <reference types="vitest/config" />
import preact from '@preact/preset-vite'
import { defineConfig, type Plugin } from 'vite'
import { serviceWorker } from './plugins/service-worker.ts'

/**
 * `vite build --mode e2e` (make e2e) is the only build that lets the sign-in follow the
 * end-to-end stack's stand-in for Google back to this origin (VITE_E2E, see SignedOut.tsx).
 * Set anywhere else (environment or .env files), VITE_E2E is refused: it can never reach a
 * production build. Checked on the resolved config: the environment Vite actually loaded,
 * from its own envDir (the project root by default, whatever the working directory).
 */
function e2eOnly(): Plugin {
  return {
    name: 'slax:e2e-only',
    configResolved(config) {
      if (config.mode !== 'e2e' && config.env.VITE_E2E !== undefined) {
        throw new Error(`VITE_E2E is reserved for the end-to-end build (vite build --mode e2e), not mode "${config.mode}".`)
      }
    },
  }
}

export default defineConfig(({ mode }) => {
  const e2e = mode === 'e2e'

  return {
    plugins: [preact(), e2eOnly(), serviceWorker()],
    define: e2e ? { 'import.meta.env.VITE_E2E': JSON.stringify('true') } : undefined,
    // The design-system kitchen sink (design-system.html) and the app preview
    // (app-preview.html) are served by the dev server like any page, but a
    // production build ships the app only. Their own build exists for
    // `make screenshots`: `vite build --mode design-system`.
    build: {
      outDir: mode === 'design-system' ? 'dist-design-system' : e2e ? 'dist-e2e' : 'dist',
      // The design-system build also carries app-preview.html: the real app on fixtures, for screenshots.
      rolldownOptions: { input: mode === 'design-system' ? ['design-system.html', 'app-preview.html'] : 'index.html' },
    },
    server: {
      // In Docker the browser reaches Vite through the nginx proxy, not port 5173.
      hmr: process.env.HMR_CLIENT_PORT
        ? { clientPort: Number(process.env.HMR_CLIENT_PORT) }
        : undefined,
    },
    test: {
      environment: 'happy-dom',
      include: ['src/**/*.test.{ts,tsx}'],
    },
  }
})
