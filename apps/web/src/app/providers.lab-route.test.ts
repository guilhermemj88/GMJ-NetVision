import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPublicPath } from '../app/providers';

/**
 * MAP-VISUAL-V2: o laboratorio (`/map-visual-preview`) so e publico quando o
 * ambiente e local/isolado. Em producao a rota responde 404 e o guard de sessao
 * trata o caminho como privado — a politica da VNT (login + /view/*) nao muda.
 */
describe('guard de sessao x laboratorio MAP-VISUAL-V2', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('mantem o laboratorio privado fora do ambiente local/preview', () => {
    expect(isPublicPath('/map-visual-preview')).toBe(false);
  });

  it('libera o laboratorio apenas no preview isolado', () => {
    vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', 'true');
    expect(isPublicPath('/map-visual-preview')).toBe(true);
    expect(isPublicPath('/login')).toBe(true);
    expect(isPublicPath('/')).toBe(false);
  });
});
