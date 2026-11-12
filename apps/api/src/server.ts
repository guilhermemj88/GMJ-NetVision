import { buildApp } from './app';
import { shutdownSettleCapMs } from './worker/mitigation/shutdown-settle';
import { config } from './config';

/**
 * Checkpoints de bootstrap — diagnostico de boot silencioso.
 *
 * Um `await` que nunca resolve nao mantem o processo vivo: o Node encerra com
 * exit code 0 e sem stack. Durante o diagnostico um keep-alive mantem o processo
 * aberto e o watchdog (unref) imprime a ULTIMA fase alcancada, distinguindo
 * promise pendente de excecao real.
 */
const WATCHDOG_MS = 30_000;
let phase = 'MAIN_START';

function checkpoint(next: string, extra?: Record<string, unknown>): void {
  phase = next;
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ bootstrap: next, at: new Date().toISOString(), ...(extra ?? {}) }));
}

function fail(error: unknown): void {
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({
      bootstrap: 'MAIN_ERROR',
      lastPhase: phase,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
    }),
  );
}

const watchdog = setTimeout(() => {
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({
      bootstrap: 'WATCHDOG',
      lastPhase: phase,
      hint: 'promise pendente: o processo sobrevive apenas ao keep-alive',
      pid: process.pid,
    }),
  );
}, WATCHDOG_MS);
watchdog.unref?.();

process.on('beforeExit', (code) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ bootstrap: 'BEFORE_EXIT', lastPhase: phase, code }));
});

process.on('exit', (code) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ bootstrap: 'EXIT', lastPhase: phase, code }));
});

process.on('uncaughtExceptionMonitor', (error) => fail(error));

// Mantem o processo vivo durante o diagnostico (liberado apos o listen).
const keepAlive = setInterval(() => undefined, 5_000);

async function main(): Promise<void> {
  checkpoint('MAIN_START', { port: config.PORT, host: config.HOST });
  try {
    checkpoint('BUILD_APP_START');
    const app = await buildApp();
    checkpoint('BUILD_APP_DONE');

    checkpoint('APP_READY_START');
    await app.ready();
    checkpoint('APP_READY_DONE');

    checkpoint('LISTEN_START');
    await app.listen({ port: config.PORT, host: config.HOST });
    checkpoint('LISTEN_DONE', { port: config.PORT, host: config.HOST });
    clearInterval(keepAlive);
    // Encerramento gracioso: app.close() aguarda o ACTIVATE fisico em andamento (ate o teto do settle) antes de
    // liberar banco/lease. Sem isto o SIGTERM do systemd matava o processo no meio da operacao. Segundo sinal ou o
    // prazo duro encerram de qualquer forma; o estado fisico incerto vira quarentena no proximo boot.
    let closing = false;
    const shutdown = (signal: string) => {
      if (closing) process.exit(1);
      closing = true;
      checkpoint('SHUTDOWN_SIGNAL', { signal });
      const hard = setTimeout(() => process.exit(1), shutdownSettleCapMs() + 20_000);
      hard.unref();
      app.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    fail(error);
    clearInterval(keepAlive);
    process.exit(1);
  }
}

void main().catch((error: unknown) => {
  fail(error);
  clearInterval(keepAlive);
  process.exit(1);
});
