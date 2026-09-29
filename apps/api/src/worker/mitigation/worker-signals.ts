import { toSafeError } from './worker-health';

/**
 * Encerramento gracioso do worker: SIGTERM/SIGINT fecham a sessão SSH e deixam
 * o processo sair sozinho (sem `process.exit` abrupto que perderia o flush).
 */

export type WorkerSignal = 'SIGTERM' | 'SIGINT';

export interface WorkerSignalSource {
  on(event: WorkerSignal, listener: () => void): unknown;
  off?(event: WorkerSignal, listener: () => void): unknown;
}

export interface WorkerSignalOptions {
  source?: WorkerSignalSource;
  logger?: (message: string) => void;
  /** Injetável para teste; por padrão apenas marca o `exitCode`. */
  onExit?: (code: number) => void;
}

export interface Stoppable {
  stop(): Promise<void>;
}

export function installWorkerSignalHandlers(
  worker: Stoppable,
  options: WorkerSignalOptions = {},
): () => void {
  const source = options.source ?? (process as unknown as WorkerSignalSource);
  const onExit =
    options.onExit ??
    ((code: number) => {
      process.exitCode = code;
    });
  let shuttingDown = false;

  const shutdown = (signal: WorkerSignal): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    options.logger?.(`recebido ${signal}; encerrando sessão graciosamente`);
    void worker
      .stop()
      .catch((error: unknown) => {
        options.logger?.(`falha ao encerrar sessão: ${toSafeError(error)}`);
      })
      .finally(() => onExit(0));
  };

  const onTerm = (): void => shutdown('SIGTERM');
  const onInt = (): void => shutdown('SIGINT');
  source.on('SIGTERM', onTerm);
  source.on('SIGINT', onInt);

  return () => {
    source.off?.('SIGTERM', onTerm);
    source.off?.('SIGINT', onInt);
  };
}
