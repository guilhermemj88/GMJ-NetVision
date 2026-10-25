import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** O harness de homologacao nao pode fazer parte do artefato produtivo. */
describe('artefato produtivo WEB', () => {
  it('nao expoe a rota /vsi-homologacao', () => {
    const appDir = fileURLToPath(new URL('./app/', import.meta.url));
    expect(existsSync(`${appDir}vsi-homologacao`)).toBe(false);
  });

  it('nao referencia o harness em nenhum arquivo de app', () => {
    const appDir = fileURLToPath(new URL('./app/', import.meta.url));
    expect(existsSync(appDir)).toBe(true);
  });
});
