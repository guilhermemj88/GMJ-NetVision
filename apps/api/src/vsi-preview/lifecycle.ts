/**
 * Ciclo de vida do processo do preview: encerramento SEMPRE anunciado e verificavel.
 *
 * - o watchdog e um timer REFERENCIADO (sem `unref`): enquanto ele existir o laco de eventos nao esvazia, entao o
 *   Node nao sai com codigo 0 em silencio com uma promessa pendente;
 * - mesmo assim, `beforeExit` (laco vazio) anuncia `EVENT_LOOP_DRAINED` e sai com 125;
 * - SIGTERM/SIGINT saem com 143/130; a saida e unica (idempotente) e sempre emite a linha `EXIT`.
 */
export interface LifecycleHost {
  once(event: 'SIGTERM' | 'SIGINT' | 'beforeExit', listener: () => void): unknown;
  pid: number;
}

export interface LifecycleDeps {
  host: LifecycleHost;
  emit: (line: Record<string, unknown>) => void;
  exit: (code: number) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

export const WATCHDOG_GRACE_SECONDS = 3;

export function installLifecycle(deps: LifecycleDeps, maxSeconds: number): { finish: (code: number, reason: string) => void } {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const startedAt = now();
  let done = false;
  const finish = (code: number, reason: string): void => {
    if (done) return;
    done = true;
    deps.emit({ preview: 'EXIT', code, reason, pid: deps.host.pid, durationMs: now() - startedAt, at: new Date(now()).toISOString() });
    deps.exit(code);
  };
  // Referenciado de proposito (sem unref): ver o cabecalho.
  setTimer(() => finish(124, 'WATCHDOG'), (maxSeconds + WATCHDOG_GRACE_SECONDS) * 1000);
  deps.host.once('SIGTERM', () => finish(143, 'SIGTERM'));
  deps.host.once('SIGINT', () => finish(130, 'SIGINT'));
  deps.host.once('beforeExit', () => finish(125, 'EVENT_LOOP_DRAINED'));
  return { finish };
}
