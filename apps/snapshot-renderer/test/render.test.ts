import { describe, expect, it, vi } from 'vitest';
import type { BrowserHandle } from '../src/browser.js';
import { createRenderer } from '../src/render.js';

const PNG = Buffer.from([137, 80, 78, 71]);

function fakeBrowser() {
  const page = {
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    goto: vi.fn(async () => undefined),
    waitForFunction: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => PNG),
  };
  const context = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  };
  const browser = {
    newContext: vi.fn(async () => context),
    isConnected: () => true,
  };
  const handle = {
    get: vi.fn(async () => browser),
    close: vi.fn(async () => undefined),
    version: () => '156.0',
  };
  return { handle, browser, context };
}

function request() {
  return { url: 'http://127.0.0.1:3000/snapshot/token-de-teste-123456', width: 1200, height: 720, timeoutMs: 5_000 };
}

describe('renderer do snapshot', () => {
  it('cria o contexto do Chromium no fuso configurado', async () => {
    const fake = fakeBrowser();
    const render = createRenderer(fake.handle as unknown as BrowserHandle, {
      navTimeoutMs: 5_000,
      timeZone: 'America/Sao_Paulo',
    });

    await expect(render(request())).resolves.toEqual(PNG);
    expect(fake.browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({ timezoneId: 'America/Sao_Paulo' }),
    );
    expect(fake.context.close).toHaveBeenCalledTimes(1);
  });

  it('repassa o fuso customizado sem reescrever o valor', async () => {
    const fake = fakeBrowser();
    const render = createRenderer(fake.handle as unknown as BrowserHandle, {
      navTimeoutMs: 5_000,
      timeZone: 'America/Manaus',
    });

    await render(request());
    expect(fake.browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({ timezoneId: 'America/Manaus' }),
    );
  });

  it('fecha o contexto e conta a falha quando o render quebra', async () => {
    const fake = fakeBrowser();
    fake.context.newPage.mockRejectedValue(new Error('chrome morreu'));
    const render = createRenderer(fake.handle as unknown as BrowserHandle, {
      navTimeoutMs: 5_000,
      timeZone: 'America/Sao_Paulo',
    });

    await expect(render(request())).rejects.toThrow('chrome morreu');
    expect(fake.context.close).toHaveBeenCalledTimes(1);
    expect(render.stats().failures).toBe(1);
  });
});
