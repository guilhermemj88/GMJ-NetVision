import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MOBILE_NAV_ITEMS } from './mobile-nav';

/**
 * A MobileNav e um componente de apresentacao puro sobre o `useMapStore`.
 * Estes testes cobrem o contrato que importa para o celular: quais areas
 * existem, a ordem (Mapa primeiro), a fonte de verdade unica e o rotulo curto.
 */
describe('MobileNav — contrato de navegacao mobile', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('cobre exatamente as areas que existem no store', async () => {
    const views = MOBILE_NAV_ITEMS.map((item) => item.view);
    expect(views).toEqual(['MAP', 'HOSTS', 'BGP', 'PHYSICAL']);
    // Sem duplicatas: cada area aparece uma unica vez na barra.
    expect(new Set(views).size).toBe(views.length);
  });

  it('prioriza o mapa no primeiro slot', () => {
    expect(MOBILE_NAV_ITEMS[0]?.view).toBe('MAP');
  });

  it('usa rotulos curtos, sem texto longo que quebre a barra', () => {
    for (const item of MOBILE_NAV_ITEMS) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.label.length).toBeLessThanOrEqual(8);
    }
    expect(MOBILE_NAV_ITEMS.map((item) => item.label)).toEqual([
      'Mapa',
      'Hosts',
      'BGP',
      'Físico',
    ]);
  });

  it('cada item tem um icone', () => {
    for (const item of MOBILE_NAV_ITEMS) {
      expect(item.Icon).toBeTruthy();
    }
  });

  it('renderiza a barra com aria-label e sem controles de escrita', async () => {
    const { MobileNav } = await import('./mobile-nav');
    const html = renderToStaticMarkup(<MobileNav />);
    expect(html).toContain('aria-label="Navegação principal"');
    expect(html).toContain('class="mobile-nav"');
    // A barra e navegacao pura: nenhum botao de acao administrativa.
    expect(html).not.toContain('Editar mapa');
    expect(html).not.toContain('Descobrir');
  });
});
