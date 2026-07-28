import { defineConfig } from '@playwright/test';

const port = Number(process.env.LOOPKIT_BROWSER_PORT ?? 4173);

export default defineConfig({
  testDir: './packages/console/test/browser',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  outputDir: 'test-results',
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: 'chromium',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'desktop',
      use: {
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'mobile',
      use: {
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
  webServer: {
    command: 'node packages/console/dist-test/test/browser-server.js',
    url: `http://127.0.0.1:${port}/command`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: {
      LOOPKIT_BROWSER_PORT: String(port),
    },
  },
});
