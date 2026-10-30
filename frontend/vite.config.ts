/// <reference types="vitest/config" />
import preact from '@preact/preset-vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [preact()],
  build: {
    rolldownOptions: {
      input: {
        main: 'index.html',
        // Kitchen sink of the design system (/design-system.html): not linked from the app.
        designSystem: 'design-system.html',
      },
    },
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
})
