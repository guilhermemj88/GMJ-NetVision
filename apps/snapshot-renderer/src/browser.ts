import { chromium, type Browser } from 'playwright';

export interface BrowserHandle {
  get(): Promise<Browser>;
  close(): Promise<void>;
  version(): string | null;
}

/**
 * Um Chromium por processo, reutilizado entre renderizacoes (ligar/desligar
 * browser custa ~1,3 s por PNG). O SANDBOX fica LIGADO: nenhum
 * `--no-sandbox`, e o usuario do servico e sem privilegios.
 */
export function createBrowserHandle(): BrowserHandle {
  let browser: Browser | null = null;
  let launching: Promise<Browser> | null = null;
  let version: string | null = null;

  const launch = async (): Promise<Browser> => {
    const instance = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      // /dev/shm do container e pequeno; usar /tmp (PrivateTmp do systemd).
      args: ['--disable-dev-shm-usage', '--force-color-profile=srgb'],
    });
    instance.on('disconnected', () => {
      browser = null;
    });
    version = instance.version();
    return instance;
  };

  return {
    async get(): Promise<Browser> {
      if (browser?.isConnected()) return browser;
      launching ??= launch().finally(() => {
        launching = null;
      });
      browser = await launching;
      return browser;
    },
    async close(): Promise<void> {
      const instance = browser;
      browser = null;
      await instance?.close().catch(() => undefined);
    },
    version: () => version,
  };
}
