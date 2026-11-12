/**
 * Encerramento ordenado do motor AUTO: nenhum ACTIVATE novo parte, o ja em andamento NAO e abandonado.
 * Deve rodar ANTES de qualquer hook que desconecte o banco/poller (no Fastify os hooks onClose rodam na ordem
 * INVERSA de registro: por isso e registrado POR ULTIMO em routes.ts). O teto existe porque o lock da policy
 * expira em 240 s; esperar alem disso nao protege nada.
 */
export const DEFAULT_SHUTDOWN_SETTLE_MS = 270_000;

export interface SettleEngine {
  beginShutdown(): void;
  settleExecutions(): Promise<void>;
  inFlightProfiles(): string[];
}

export function shutdownSettleCapMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.MITIGATION_SHUTDOWN_SETTLE_MS ?? DEFAULT_SHUTDOWN_SETTLE_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_SHUTDOWN_SETTLE_MS;
}

export async function settleBeforeClose(
  engine: SettleEngine,
  log: {
    warn(obj: object, msg: string): void;
    error(obj: object, msg: string): void;
  },
  capMs: number = shutdownSettleCapMs(),
): Promise<{ timedOut: boolean; pending: string[] }> {
  engine.beginShutdown();
  const pending = engine.inFlightProfiles();
  if (pending.length) log.warn({ pending }, 'encerrando com ACTIVATE em andamento: aguardando');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    engine.settleExecutions().then(
      () => false,
      () => false,
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), capMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  const left = engine.inFlightProfiles();
  if (timedOut)
    log.error(
      { pending: left },
      'SHUTDOWN_SETTLE_TIMEOUT: ACTIVATE ainda em andamento; estado fisico a conferir na reconciliacao',
    );
  return { timedOut, pending: left };
}
