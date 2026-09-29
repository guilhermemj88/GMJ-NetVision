import {
  createMitigationWorkerFromEnv,
  type MitigationWorker,
} from './worker/mitigation/mitigation-worker';
import { toSafeError } from './worker/mitigation/worker-health';
import { installWorkerSignalHandlers } from './worker/mitigation/worker-signals';

/**
 * Entrypoint do processo do worker de mitigação (SIMULATION_ONLY, READ-ONLY).
 *
 * Nesta fase ele apenas: sobe a sessão SSH persistente, mantém health em memória
 * e responde a SIGTERM/SIGINT fechando a sessão graciosamente. O loop real de
 * mitigação não é ligado aqui ainda.
 *
 * Uso: `node dist/mitigation-worker-main.cjs` (ou `tsx src/mitigation-worker-main.ts`).
 */

async function main(): Promise<void> {
  const logger = (message: string): void => {
    console.log(`[mitigation-worker] ${message}`);
  };

  let worker: MitigationWorker;
  try {
    worker = createMitigationWorkerFromEnv(process.env);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'configuração inválida';
    console.error(`[mitigation-worker] configuração inválida: ${message}`);
    process.exitCode = 2;
    return;
  }

  installWorkerSignalHandlers(worker, { logger });

  await worker.start();
  logger(`sessão persistente pronta (health=${worker.getHealth().state})`);
}

void main().catch((error: unknown) => {
  console.error(`[mitigation-worker] falha ao iniciar: ${toSafeError(error)}`);
  process.exitCode = 1;
});
