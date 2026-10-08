export interface RenderQueue {
  run<T>(task: () => Promise<T>): Promise<T>;
  pending(): number;
  active(): number;
}

/**
 * Fila single-flight: um Chromium, uma pagina por vez (o PNG tem 1200x720 e a
 * fila evita pico de RAM quando varios alarmes chegam juntos). Tarefas
 * excedentes entram na fila; a contagem permite recusar com 503 quando a fila
 * passa do limite.
 */
export function createRenderQueue(options: { concurrency?: number } = {}): RenderQueue {
  const concurrency = Math.max(1, options.concurrency ?? 1);
  type Job = { task: () => Promise<unknown>; resolve: (value: unknown) => void; reject: (error: unknown) => void };
  const waiting: Job[] = [];
  let running = 0;

  const next = (): void => {
    if (running >= concurrency) return;
    const job = waiting.shift();
    if (!job) return;
    running += 1;
    void job
      .task()
      .then(job.resolve, job.reject)
      .finally(() => {
        running -= 1;
        next();
      });
  };

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        waiting.push({
          task: task as () => Promise<unknown>,
          resolve: resolve as (value: unknown) => void,
          reject,
        });
        next();
      });
    },
    pending: () => waiting.length,
    active: () => running,
  };
}
