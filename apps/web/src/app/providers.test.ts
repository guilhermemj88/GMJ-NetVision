import { describe, expect, it } from 'vitest';
import { isPublicPath } from '../app/providers';

/**
 * A pagina de snapshot e aberta pelo renderer interno (Chromium) SEM sessao: se
 * o guard de sessao a tratar como privada, o app redireciona para /login e o PNG
 * sai com a tela de login em vez do gráfico.
 */
describe('rotas publicas do app', () => {
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
});
