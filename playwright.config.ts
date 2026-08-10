import { defineConfig, devices } from "@playwright/test";

/**
 * The suite runs against a production build served locally, with the Supabase
 * calls intercepted (see e2e/fake-backend.ts). That means no credentials, no
 * connectivity and no shared database — so it can gate a pull request, and two
 * runs can never interfere with each other.
 *
 * The build uses .env.e2e, which holds deliberately fake values: the client
 * refuses to start without a URL and key, and the interceptor answers before
 * anything leaves the browser.
 */
export default defineConfig({
  testDir: "./e2e",
  // Sales are asserted through a shared fake backend per test, so tests within a
  // file must not interleave.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: "http://localhost:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    {
      name: "till",
      testIgnore: /live\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        // The environment ships Chromium at a fixed path and blocks the
        // download Playwright would otherwise attempt.
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
          : {},
      },
    },
  ],

  webServer: {
    command: "npm run build:e2e && npx vite preview --port 4173",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
