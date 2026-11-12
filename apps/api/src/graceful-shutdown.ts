import { shutdownSettleCapMs } from './worker/mitigation/shutdown-settle';

/**
 * SIGTERM/SIGINT -> app.close() (que aguarda o ACTIVATE fisico em andamento, ate o teto do settle) -> exit(0).
 * Segundo sinal ou o prazo duro (teto + 20 s) encerram de qualquer forma; o estado fisico incerto vira quarentena no
 * proximo boot. Extraido de server.ts para ser ensaiado em laboratorio exatamente como roda em producao.
 */
export function installGracefulShutdown(
  app: { close(): Promise<unknown> },
  options: {
    exit?: (code: number) => never | void;
    onSignal?: (signal: string) => void;
    proc?: Pick<NodeJS.Process, 'on'>;
    capMs?: number;
  } = {},
): void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const proc = options.proc ?? process;
  const capMs = options.capMs ?? shutdownSettleCapMs();
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) {
      exit(1);
      return;
    }
    closing = true;
    options.onSignal?.(signal);
    const hard = setTimeout(() => exit(1), capMs + 20_000);
    hard.unref();
    app.close().then(
      () => exit(0),
      () => exit(1),
    );
  };
  proc.on('SIGTERM', () => shutdown('SIGTERM'));
  proc.on('SIGINT', () => shutdown('SIGINT'));
}

/**
 * Drenagem HTTP no encerramento: depois de `begin()`, toda resposta sai com `Connection: close` e as conexoes ociosas sao
 * fechadas, entao o `server.close()` do Fastify (que roda ANTES dos hooks onClose do usuario) termina assim que a ultima
 * requisicao em voo responde, em vez de esperar o keepAliveTimeout (72 s) de um cliente keep-alive. Registrar ANTES de `ready()`.
 */
export function registerHttpDrain(app: {
  addHook(name: 'onSend', fn: (req: unknown, reply: { header(k: string, v: string): unknown }) => Promise<void>): unknown;
  server?: { closeIdleConnections?: () => void };
}): { begin(): void } {
  let draining = false;
  app.addHook('onSend', async (_req, reply) => {
    if (draining) reply.header('connection', 'close');
  });
  return {
    begin() {
      draining = true;
      app.server?.closeIdleConnections?.();
    },
  };
}
