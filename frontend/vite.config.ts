/// <reference types="vitest/config" />
import preact from '@preact/preset-vite'
import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => ({
  plugins: [preact()],
  // The design-system kitchen sink (design-system.html) is served by the dev
  // server like any page, but a production build ships the app only. Its own
  // build exists for `make screenshots`: `vite build --mode design-system`.
  build: {
    outDir: mode === 'design-system' ? 'dist-design-system' : 'dist',
    rolldownOptions: { input: mode === 'design-system' ? 'design-system.html' : 'index.html' },
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
}))
