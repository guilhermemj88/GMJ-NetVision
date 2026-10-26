import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/responsive',
  outputDir: './.artifacts/responsive/results',
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { outputFolder: '.artifacts/responsive/report', open: 'never' }]],
  use: {
    baseURL: 'http://localhost:3413',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'npm exec --workspace @gmj/web -- next dev --turbopack -p 3413',
    url: 'http://localhost:3413/login',
    reuseExistingServer: true,
    timeout: 180_000,
    env: { NETVISION_INSTALLATION_ID: 'IMPLANTAR' },
  },
});
