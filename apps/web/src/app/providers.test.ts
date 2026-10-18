import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPublicPath } from '../app/providers';

/**
 * A pagina de snapshot e aberta pelo renderer interno (Chromium) SEM sessao: se
 * o guard de sessao a tratar como privada, o app redireciona para /login e o PNG
 * sai com a tela de login em vez do gráfico.
 */
describe('rotas publicas do app', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('libera login, links publicos e a pagina de snapshot', () => {
    expect(isPublicPath('/login')).toBe(true);
    expect(isPublicPath('/view/map/abc')).toBe(true);
    expect(isPublicPath('/view/noc/abc')).toBe(true);
    expect(isPublicPath('/snapshot/eyJhbGciOi.assinatura')).toBe(true);
  });

  it('mantem o app principal e as areas privadas exigindo sessao', () => {
    expect(isPublicPath('/')).toBe(false);
    expect(isPublicPath('/physical')).toBe(false);
    expect(isPublicPath('/physical/rack-lab')).toBe(false);
    expect(isPublicPath('/snapshot')).toBe(false);
    expect(isPublicPath('/snapshotx/abc')).toBe(false);
  });

  it('mantem o laboratorio MAP-VISUAL-V2 privado fora do ambiente local/preview', () => {
    expect(isPublicPath('/map-visual-preview')).toBe(false);
  });

  it('libera o laboratorio MAP-VISUAL-V2 apenas no preview isolado', () => {
    vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', 'true');
    expect(isPublicPath('/map-visual-preview')).toBe(true);
    expect(isPublicPath('/')).toBe(false);
  });
});
