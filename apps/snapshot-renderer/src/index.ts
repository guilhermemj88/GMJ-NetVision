import { loadConfig } from './config.js';
import { createBrowserHandle } from './browser.js';
import { createRenderer } from './render.js';
import { createSnapshotServer } from './server.js';

const config = loadConfig();
const browser = createBrowserHandle();
const render = createRenderer(browser, {
  navTimeoutMs: config.navTimeoutMs,
  timeZone: config.timeZone,
});
const server = createSnapshotServer({
  config,
  render,
  browserVersion: () => browser.version(),
});

server.listen(config.port, config.host, () => {
  console.log(
    `netvision-alarm-snapshot renderer em http://${config.host}:${config.port} ` +
      `(origem ${config.allowedOrigin}, cache ${config.cacheDir}, fuso ${config.timeZone})`,
  );
});

const shutdown = (signal: string): void => {
  console.log(`encerrando (${signal})`);
  server.close(() => {
    void browser.close().finally(() => process.exit(0));
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
