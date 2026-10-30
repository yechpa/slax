import { defineConfig, devices } from '@playwright/test'

/**
 * Slax end-to-end suite. Run it with `make e2e`: a fresh Compose stack under APP_ENV=e2e,
 * this suite inside the official Playwright image, sharing the web container's network
 * (the app is http://localhost there). See docker-compose.e2e.yml.
 */
const ci = Boolean(process.env.CI)

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  globalSetup: './support/global-setup.ts',
  // Every test creates its own users and rooms: they run in parallel, in any order.
  fullyParallel: true,
  workers: ci ? 2 : 3,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { outputFolder: './playwright-report', open: 'never' }]],
  use: {
    baseURL: 'http://localhost',
    trace: ci ? 'on-first-retry' : 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 800 },
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }],
})
