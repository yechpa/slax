/// <reference types="vitest/config" />
import preact from '@preact/preset-vite'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  // `vite build --mode e2e` (make e2e) is the only build that lets the sign-in follow the
  // end-to-end stack's stand-in for Google back to this origin (VITE_E2E, see SignedOut.tsx).
  // Set anywhere else (environment or .env files), VITE_E2E is refused: it can never reach
  // a production build.
  const e2e = mode === 'e2e'
  if (!e2e && loadEnv(mode, process.cwd(), 'VITE_E2E').VITE_E2E !== undefined) {
    throw new Error(`VITE_E2E is reserved for the end-to-end build (vite build --mode e2e), not mode "${mode}".`)
  }

  return {
    plugins: [preact()],
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
