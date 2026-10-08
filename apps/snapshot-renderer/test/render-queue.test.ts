import { describe, expect, it } from 'vitest';
import { createRenderQueue } from '../src/render-queue.js';

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('fila single-flight do renderer', () => {
  it('executa uma renderizacao por vez e preserva a ordem', async () => {
    const queue = createRenderQueue({ concurrency: 1 });
    const first = deferred<string>();
    const order: string[] = [];
    const a = queue.run(async () => {
      order.push('a-start');
      const value = await first.promise;
      order.push('a-end');
      return value;
    });
    const b = queue.run(async () => {
      order.push('b-start');
      return 'b';
    });
    await Promise.resolve();
    expect(queue.active()).toBe(1);
    expect(queue.pending()).toBe(1);
    expect(order).toEqual(['a-start']);
    first.resolve('a');
    await expect(a).resolves.toBe('a');
    await expect(b).resolves.toBe('b');
    expect(order).toEqual(['a-start', 'a-end', 'b-start']);
    expect(queue.active()).toBe(0);
  });

  it('propaga erro sem travar a fila seguinte', async () => {
    const queue = createRenderQueue({ concurrency: 1 });
    const failed = queue.run(async () => {
      throw new Error('falhou');
    });
    const ok = queue.run(async () => 'ok');
    await expect(failed).rejects.toThrow('falhou');
    await expect(ok).resolves.toBe('ok');
  });
});
