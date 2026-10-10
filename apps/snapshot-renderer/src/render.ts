import type { BrowserHandle } from './browser.js';

export interface RenderRequest {
  url: string;
  width: number;
  height: number;
  timeoutMs: number;
}

export interface RenderStats {
  renders: number;
  failures: number;
  lastDurationMs: number | null;
  maxDurationMs: number | null;
}

export interface Renderer {
  (request: RenderRequest): Promise<Buffer>;
  stats(): RenderStats;
}

/** O snapshot page marca este global quando os gráficos terminaram de pintar. */
export const READY_FLAG = 'window.__netvisionSnapshotReady === true';

export function createRenderer(
  browserHandle: BrowserHandle,
  options: { navTimeoutMs: number; timeZone: string },
): Renderer {
  const stats: RenderStats = { renders: 0, failures: 0, lastDurationMs: null, maxDurationMs: null };

  const render = async (request: RenderRequest): Promise<Buffer> => {
    const startedAt = Date.now();
    const browser = await browserHandle.get();
    const context = await browser.newContext({
      viewport: { width: request.width, height: request.height },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
      // Fuso operacional no proprio Chromium: corrige EVENTO/RECUPERACAO e eixos.
      timezoneId: options.timeZone,
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(request.timeoutMs);
      page.setDefaultNavigationTimeout(Math.min(options.navTimeoutMs, request.timeoutMs));
      await page.goto(request.url, { waitUntil: 'load' });
      await page
        .waitForFunction(READY_FLAG, undefined, { timeout: request.timeoutMs })
        .catch(() => undefined);
      const png = await page.screenshot({ type: 'png', animations: 'disabled' });
      stats.renders += 1;
      stats.lastDurationMs = Date.now() - startedAt;
      stats.maxDurationMs = Math.max(stats.maxDurationMs ?? 0, stats.lastDurationMs);
      return Buffer.from(png);
    } catch (error) {
      stats.failures += 1;
      throw error;
    } finally {
      await context.close().catch(() => undefined);
    }
  };

  return Object.assign(render, { stats: () => ({ ...stats }) });
}
