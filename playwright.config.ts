import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke responsivo do GMJ NetVision.
 *
 * Roda 100% offline/local: a API sobe em DEMO_MODE (repositorios em memoria,
 * sem banco, dados determinísticos) e o Web aponta para ela. Nenhuma conexao
 * com IMPLANTAR, Speedyway, VNT ou Fibinet.
 */
const API_PORT = 3399;
const WEB_PORT = 3400;

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/.results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    // `localhost` (nao `127.0.0.1`): o servidor de dev do Next recusa chunks
    // de origem cruzada, e o Chromium envia Referer de 127.0.0.1 — resultado
    // seria 403 nos chunks tardios e hidratacao quebrada.
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } },
    },
  ],
  webServer: [
    {
      command: 'npm run dev',
      cwd: './apps/api',
      url: `http://127.0.0.1:${API_PORT}/health`,
      timeout: 120_000,
      reuseExistingServer: true,
      env: {
        DEMO_MODE: 'true',
        PORT: String(API_PORT),
        NODE_ENV: 'development',
      },
    },
    {
      command: `npx next dev --turbopack -p ${WEB_PORT}`,
      cwd: './apps/web',
      url: `http://localhost:${WEB_PORT}/login`,
      timeout: 180_000,
      reuseExistingServer: true,
      env: {
        // O browser fala same-origin e o rewrite do Next encaminha /api/* para
        // a API demo. API_INTERNAL_URL e o alvo real do rewrite.
        NEXT_PUBLIC_API_URL: `http://127.0.0.1:${API_PORT}`,
        API_INTERNAL_URL: `http://127.0.0.1:${API_PORT}`,
      },
    },
  ],
});
