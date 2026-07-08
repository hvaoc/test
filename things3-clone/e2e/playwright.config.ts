import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the Things3-clone WEB build (Expo / React Native Web).
 *
 * The app is offline-first: a FRESH browser context loads straight into an
 * empty workspace (no login wall, no server session required). See README.md
 * for the auth/offline path and the per-test reset strategy.
 *
 * baseURL comes from PLAYWRIGHT_BASE_URL (default http://localhost:8088, the
 * Metro dev server we author against). Override it in CI to point at a served
 * static export.
 */
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:8088';

export default defineConfig({
  testDir: './tests',
  // Each spec seeds its own data in a fresh context, so files are independent
  // and safe to parallelize.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',

  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    // Trace is captured on the first retry so CI failures are debuggable
    // without slowing down green runs.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 900 } },
    },
  ],

  /**
   * CI portability. We AUTHOR against the already-running Metro server on :8088
   * (reuseExistingServer keeps that fast), but in CI you want Playwright to boot
   * the app itself. Two documented options — uncomment ONE and set
   * PLAYWRIGHT_BASE_URL to match:
   *
   *   A) Serve the static web export (fast, production-like):
   *        # cd .. && npm run web:export        # builds ../dist-web
   *        webServer: {
   *          command: 'npx serve -s ../dist-web -l 8088',
   *          url: 'http://localhost:8088',
   *          reuseExistingServer: !process.env.CI,
   *          timeout: 120_000,
   *        },
   *
   *   B) Run the Expo web dev server (matches local authoring):
   *        webServer: {
   *          command: 'cd .. && npx expo start --web --port 8088',
   *          url: 'http://localhost:8088',
   *          reuseExistingServer: !process.env.CI,
   *          timeout: 180_000,
   *        },
   */
  // webServer: {
  //   command: 'npx serve -s ../dist-web -l 8088',
  //   url: BASE_URL,
  //   reuseExistingServer: true,
  //   timeout: 120_000,
  // },
});
