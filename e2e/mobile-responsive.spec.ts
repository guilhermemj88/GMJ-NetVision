import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Smoke responsivo da fundacao mobile (M1.1/M1.2).
 *
 * Tudo local: API em DEMO_MODE + Next dev. Sem rede externa, sem producao.
 * Screenshots sao evidencia visual, nao gate pixel-perfect.
 */

const SHOTS = join(process.cwd(), 'e2e', 'screenshots');

interface ViewportCase {
  name: string;
  width: number;
  height: number;
  kind: 'phone' | 'tablet' | 'desktop';
}

const VIEWPORTS: ViewportCase[] = [
  { name: '360x800', width: 360, height: 800, kind: 'phone' },
  { name: '390x844', width: 390, height: 844, kind: 'phone' },
  { name: '412x915', width: 412, height: 915, kind: 'phone' },
  { name: '768x1024', width: 768, height: 1024, kind: 'tablet' },
  { name: '1024x768', width: 1024, height: 768, kind: 'tablet' },
  { name: '844x390', width: 844, height: 390, kind: 'phone' },
  { name: '1366x768', width: 1366, height: 768, kind: 'desktop' },
  { name: '1920x1080', width: 1920, height: 1080, kind: 'desktop' },
];

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel(/Usuário ou e-mail/i).fill('admin');
  await page.getByLabel(/^Senha$/i).fill('admin');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.locator('.netvision-app')).toBeVisible({ timeout: 30_000 });
  await hideDevOverlay(page);
}

/**
 * O overlay do "Next.js Dev Tools" e injetado no canto inferior esquerdo em
 * modo dev e intercepta o primeiro item da navegacao inferior. Nao existe em
 * producao, entao o harness o remove para medir o produto e nao o andaime.
 */
async function hideDevOverlay(page: Page) {
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}

/** Mede overflow horizontal global (a pagina nao pode rolar de lado). */
async function horizontalOverflow(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    return {
      docScroll: doc.scrollWidth,
      docClient: doc.clientWidth,
      bodyScroll: body.scrollWidth,
      bodyClient: body.clientWidth,
    };
  });
}

async function shot(page: Page, name: string) {
  // O screenshot e evidencia visual: espera as animacoes de entrada (sheet e
  // drawer usam 220ms) assentarem antes de capturar.
  await page.waitForTimeout(320);
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
}

/**
 * Clica em um nó do mapa que esteja realmente alcançável na área livre do
 * canvas. Devolve o id usado, para o teste falhar com contexto útil quando
 * nenhum nó estiver acessível (ex.: overlay cobrindo o mapa).
 */
async function clickHittableNode(page: Page): Promise<string> {
  const candidates = await reachableNodes(page);
  const target = candidates.find((item) => item.reachable);
  if (!target) {
    throw new Error(
      `nenhum nó alcançável (${candidates.length} nós; overlays cobrindo o canvas?)`,
    );
  }
  await page.mouse.click(target.x, target.y);
  return target.id;
}

/** Nós do mapa com o centro livre de overlays (rail, nav, painéis). */
async function reachableNodes(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.react-flow__node')].map((el) => {
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      const reachable = Boolean(hit && el.contains(hit));
      return { id: el.getAttribute('data-id') ?? '', x, y, reachable };
    }),
  );
}

test.describe('Fundação mobile — shell, navegação e overflow', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name} — shell, nav e ausência de overflow horizontal`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await login(page);

      await expect(page.locator('.netvision-app')).toBeVisible();
      await expect(page.locator('.topbar')).toBeVisible();

      const brand = page.locator('.topbar .brand');
      await expect(brand).toBeVisible();
      const brandBox = await brand.boundingBox();
      expect(brandBox, 'brand deve ter caixa').not.toBeNull();
      expect(brandBox!.x).toBeGreaterThanOrEqual(0);
      expect(brandBox!.x + brandBox!.width).toBeLessThanOrEqual(vp.width + 1);

      const m = await horizontalOverflow(page);
      expect(m.docScroll, `documentElement overflow em ${vp.name}`).toBeLessThanOrEqual(
        m.docClient + 1,
      );
      if (vp.kind === 'phone') {
        // Mede conteudo realmente cortado. Tablet/desktop ficam de fora: a
        // topbar legada ja estoura em 721..1900px antes desta camada mobile
        // (defeito pre-existente, ver test.fixme abaixo).
        expect(m.bodyScroll, `body overflow em ${vp.name}`).toBeLessThanOrEqual(
          m.bodyClient + 1,
        );
      }

      if (vp.kind === 'desktop') {
        await expect(page.locator('.mobile-nav')).toBeHidden();
        await expect(page.locator('.topbar .primary-nav')).toBeVisible();
      } else if (vp.kind === 'tablet') {
        // Tablet: navegacao principal na topbar, sem barra inferior.
        await expect(page.locator('.mobile-nav')).toBeHidden();
        await expect(page.locator('.topbar .primary-nav')).toBeVisible();
        await expect(page.locator('.topbar__mobile-menu')).toBeVisible();
      } else if (vp.kind === 'phone') {
        const nav = page.locator('.mobile-nav');
        await expect(nav).toBeVisible();
        await expect(nav.getByRole('button')).toHaveCount(4);
        const mapa = nav.getByRole('button', { name: /^Mapa$/ });
        await expect(mapa).toHaveAttribute('aria-current', 'page');
        await expect(page.locator('.topbar__mobile-menu')).toBeVisible();
        await expect(page.locator('.topbar .primary-nav')).toBeHidden();
      }

      await shot(page, `mobile-${vp.name}-map`);
    });
  }
});

test.describe('Fundação mobile — troca de view pela barra inferior', () => {
  test('390x844 — Mapa/Hosts/BGP/Físico trocam e preservam o store', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);

    const nav = page.locator('.mobile-nav');

    await nav.getByRole('button', { name: /^Hosts$/ }).click();
    await expect(nav.getByRole('button', { name: /^Hosts$/ })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await nav.getByRole('button', { name: /^BGP$/ }).click();
    await expect(nav.getByRole('button', { name: /^BGP$/ })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await nav.getByRole('button', { name: /^Físico$/ }).click();
    await expect(nav.getByRole('button', { name: /^Físico$/ })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await nav.getByRole('button', { name: /^Mapa$/ }).click();
    await expect(page.locator('.map-workspace')).toBeVisible({ timeout: 15_000 });

    const m = await horizontalOverflow(page);
    expect(m.docScroll).toBeLessThanOrEqual(m.docClient + 1);
  });
});

test.describe('Auditoria de overflow — todos os PHONE, todos os módulos', () => {
  /**
   * `documentElement` e `body` nunca podem rolar na horizontal. Assim como o
   * primeiro teste do arquivo, a medida e sobre o produto, nao sobre o andaime.
   */
  async function expectNoGlobalOverflow(page: Page, label: string): Promise<void> {
    const m = await horizontalOverflow(page);
    expect(m.docScroll, `documentElement overflow em ${label}`).toBeLessThanOrEqual(
      m.docClient + 1,
    );
    expect(m.bodyScroll, `body overflow em ${label}`).toBeLessThanOrEqual(m.bodyClient + 1);
  }

  for (const vp of [
    { name: '360x800', width: 360, height: 800 },
    { name: '390x844', width: 390, height: 844 },
    { name: '412x915', width: 412, height: 915 },
    { name: '844x390', width: 844, height: 390 },
  ]) {
    test(`${vp.name} — Mapa, Hosts, BGP e Físico sem rolagem horizontal`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await login(page);
      const nav = page.locator('.mobile-nav');

      await expect(page.locator('.map-workspace')).toBeVisible({ timeout: 15_000 });
      await expectNoGlobalOverflow(page, `${vp.name} · Mapa`);

      await nav.getByRole('button', { name: /^Hosts$/ }).click();
      await expect(page.locator('.hosts-card').first()).toBeVisible({ timeout: 20_000 });
      await expectNoGlobalOverflow(page, `${vp.name} · Hosts`);

      await openBgp(page);
      await expectNoGlobalOverflow(page, `${vp.name} · BGP`);

      await openPhysical(page);
      await expectNoGlobalOverflow(page, `${vp.name} · Físico`);
    });
  }
});

test.describe('Fundação mobile — mapa, drawer e menu', () => {
  test('390x844 — abrir node vira bottom sheet e fecha', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);

    const node = page.locator('.react-flow__node').first();
    await expect(node).toBeVisible({ timeout: 30_000 });
    const usedNode = await clickHittableNode(page);

    const drawer = page.locator('.context-drawer');
    await expect(drawer, `drawer não abriu para o nó ${usedNode}`).toBeVisible({
      timeout: 15_000,
    });

    // O drawer entra com animação de 220ms; medir durante o transform acusa
    // alguns pixels de overshoot que não existem no estado final.
    const drawerGeometry = async () => {
      const b = await drawer.boundingBox();
      return b ? { x: b.x, width: b.width, bottom: b.y + b.height } : null;
    };
    await expect
      .poll(async () => Math.round((await drawerGeometry())?.bottom ?? -1), {
        message: 'drawer deve terminar dentro da viewport',
      })
      .toBeLessThanOrEqual(844 + 1);

    const box = await drawerGeometry();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(Math.round(box!.width)).toBeLessThanOrEqual(390 + 1);

    const close = drawer.getByRole('button', { name: /fechar|close/i }).first();
    await expect(close).toBeVisible();
    await shot(page, 'mobile-390x844-drawer');

    await close.click();
    await expect(drawer).toBeHidden({ timeout: 10_000 });
    await expect(page.locator('.map-workspace')).toBeVisible();
  });

  test('390x844 — rail de camadas não cobre o mapa e alterna recolhida', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);

    // Regressão: a rail chegou a ocupar 374x772 do canvas e nenhum nó podia
    // ser tocado. No celular ela nasce recolhida.
    await expect(page.locator('.map-rail--collapsed')).toBeVisible();

    const nodes = await reachableNodes(page);
    expect(nodes.length).toBeGreaterThan(0);
    const reached = nodes.filter((node) => node.reachable).length;
    expect(reached, `nós alcançáveis de ${nodes.length}`).toBe(nodes.length);

    await page.getByRole('button', { name: 'Expandir camadas do mapa' }).click();
    const expanded = page.locator('.map-rail:not(.map-rail--collapsed)');
    await expect(expanded).toBeVisible();
    const railBox = await expanded.boundingBox();
    expect(railBox).not.toBeNull();
    // Aberta, ainda sobra mapa utilizável acima dela.
    expect(railBox!.y).toBeGreaterThan(56);

    await page.getByRole('button', { name: 'Recolher camadas do mapa' }).click();
    await expect(page.locator('.map-rail--collapsed')).toBeVisible();
  });

  test('390x844 — MobileActionsSheet abre, lista ações e fecha', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);

    await page.locator('.topbar__mobile-menu').click();
    const sheet = page.locator('.mobile-sheet');
    await expect(sheet).toBeVisible();
    await expect(page.locator('.mobile-sheet__panel')).toHaveCount(1);
    await expect(sheet.getByRole('button', { name: /NOC/i })).toBeVisible();
    await expect(sheet.getByRole('button', { name: /Configurações/i })).toBeVisible();
    await shot(page, 'mobile-390x844-menu');

    const box = await page.locator('.mobile-sheet__panel').boundingBox();
    expect(box!.width).toBeLessThanOrEqual(390 + 1);

    await sheet.getByRole('button', { name: 'Fechar', exact: true }).click();
    await expect(sheet).toBeHidden();
  });

  test('390x844 — busca abre popover dentro da viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);

    const input = page.locator('.topbar .global-interface-search input').first();
    await expect(input).toBeVisible();
    const ibox = await input.boundingBox();
    expect(ibox!.x).toBeGreaterThanOrEqual(0);
    expect(ibox!.x + ibox!.width).toBeLessThanOrEqual(390 + 1);

    await input.fill('ae');
    await page.waitForTimeout(1500);
    const popover = page.locator('.global-interface-search__popover');
    if (await popover.isVisible()) {
      const pbox = await popover.boundingBox();
      expect(pbox!.x).toBeGreaterThanOrEqual(-1);
      expect(pbox!.x + pbox!.width).toBeLessThanOrEqual(390 + 1);
      await shot(page, 'mobile-390x844-search');
      await page.keyboard.press('Escape');
    }
  });
});

test.describe('Fundação mobile — landscape 844x390', () => {
  test('844x390 — sem altura artificial e mapa utilizável', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await login(page);

    const app = await page.locator('.netvision-app').boundingBox();
    expect(app!.height).toBeLessThanOrEqual(390 + 1);

    await expect(page.locator('.map-workspace')).toBeVisible();
    const nav = await page.locator('.mobile-nav').boundingBox();
    const top = await page.locator('.topbar').boundingBox();
    expect(top!.height + nav!.height).toBeLessThan(390 * 0.5);

    await shot(page, 'mobile-844x390-landscape');

    const node = page.locator('.react-flow__node').first();
    await expect(node).toBeVisible({ timeout: 30_000 });
    const usedNode = await clickHittableNode(page);
    const drawer = page.locator('.context-drawer');
    await expect(drawer, `drawer não abriu para o nó ${usedNode}`).toBeVisible({
      timeout: 15_000,
    });
    const dbox = await drawer.boundingBox();
    await expect
      .poll(async () => Math.round((await drawer.boundingBox())?.height ?? -1), {
        message: 'drawer deve caber na altura do landscape',
      })
      .toBeLessThanOrEqual(390 + 1);
    expect(dbox).not.toBeNull();
    await shot(page, 'mobile-844x390-drawer');
  });
});

/**
 * Controles visiveis da topbar que passam da viewport. Cobre o requisito de
 * "nenhum controle cortado silenciosamente": se algo nao couber, tem que ir
 * para o menu "Mais", nao sumir pela borda.
 */
async function topbarOffenders(page: Page, width: number) {
  return page.evaluate((viewportWidth) => {
    const bar = document.querySelector('.topbar');
    if (!bar) return ['sem topbar'] as string[];
    const offenders: string[] = [];
    const targets = bar.querySelectorAll(
      'button, .brand, .primary-nav, .map-selector, .source-status, .freshness, .global-interface-search, .nv-badge, .topbar-user',
    );
    targets.forEach((el) => {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      if (rect.right > viewportWidth + 1 || rect.left < -1) {
        const label =
          (el.getAttribute('aria-label') ?? el.className ?? el.tagName).toString().split(' ')[0];
        offenders.push(`${label} right=${Math.round(rect.right)}`);
      }
    });
    return offenders;
  }, width);
}

test.describe('Topbar adaptativa — tablet e desktop', () => {
  const CASES = [
    { name: '768x1024', width: 768, height: 1024, band: 'tablet' as const },
    { name: '1024x768', width: 1024, height: 768, band: 'tablet' as const },
    { name: '1366x768', width: 1366, height: 768, band: 'dense' as const },
    { name: '1600x900', width: 1600, height: 900, band: 'medium' as const },
    { name: '1920x1080', width: 1920, height: 1080, band: 'wide' as const },
  ];

  for (const vp of CASES) {
    test(`${vp.name} — nenhum controle da topbar é cortado`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await login(page);

      await expect(page.locator('.topbar')).toBeVisible();
      await expect(page.locator('.topbar .primary-nav')).toBeVisible();
      await expect(page.locator('.mobile-nav')).toBeHidden();

      const brand = await page.locator('.topbar .brand').boundingBox();
      expect(brand, 'brand deve ter caixa').not.toBeNull();
      expect(brand!.x).toBeGreaterThanOrEqual(0);
      expect(brand!.x + brand!.width).toBeLessThanOrEqual(vp.width + 1);

      const offenders = await topbarOffenders(page, vp.width);
      expect(offenders, `controles cortados em ${vp.name}`).toEqual([]);

      if (vp.band === 'tablet') {
        await expect(page.locator('.topbar__mobile-menu')).toBeVisible();
        await expect(page.locator('.topbar__more')).toHaveCount(0);
      } else {
        await expect(page.locator('.topbar__mobile-menu')).toBeHidden();
      }

      if (vp.band === 'dense') {
        await expect(page.locator('.topbar__more')).toBeVisible();
        // Acoes que nao cabem nao ficam na barra: vivem no menu.
        await expect(page.locator('.topbar').getByRole('button', { name: 'NOC' })).toHaveCount(0);
      } else if (vp.band !== 'tablet') {
        await expect(page.locator('.topbar__more')).toHaveCount(0);
        await expect(page.locator('.topbar').getByRole('button', { name: /Descobrir/ })).toBeVisible();
      }

      const m = await horizontalOverflow(page);
      expect(m.docScroll).toBeLessThanOrEqual(m.docClient + 1);
      await shot(page, `topbar-${vp.name}`);
    });
  }

  test('1366x768 — menu "Mais" concentra e executa as ações secundárias', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await login(page);

    const more = page.locator('.topbar__more');
    const menu = page.locator('.topbar__more-menu');
    await expect(menu).toHaveCount(0);

    await more.getByRole('button', { name: 'Mais ações' }).click();
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /NOC/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Links públicos/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Usuários/ })).toBeVisible();
    await shot(page, 'topbar-1366x768-mais');

    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    await more.getByRole('button', { name: 'Mais ações' }).click();
    await menu.getByRole('menuitem', { name: /Descobrir/ }).click();
    await expect(menu).toBeHidden();
    await expect(page.locator('.action-panel')).toBeVisible({ timeout: 10_000 });
  });

  test('768x1024 — hambúrguer abre o sheet com as ações do mapa', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await login(page);

    await page.locator('.topbar__mobile-menu').click();
    const sheet = page.locator('.mobile-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('button', { name: /Gerenciar mapas/ })).toBeVisible();
    await expect(sheet.getByRole('button', { name: /NOC/ })).toBeVisible();
    await shot(page, 'tablet-768x1024-sheet');

    await sheet.getByRole('button', { name: 'Fechar', exact: true }).click();
    await expect(sheet).toBeHidden();
  });
});

test.describe('Hosts (M1.3) — cards no celular, tabela no desktop', () => {
  test('390x844 — lista de cards traz o essencial e abre os detalhes', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await page.locator('.mobile-nav').getByRole('button', { name: /^Hosts$/ }).click();

    await expect(page.locator('.hosts-shell')).toBeVisible();
    // A tabela de 9 colunas sai de cena; nada de rolagem horizontal.
    await expect(page.locator('.hosts-table')).toBeHidden();

    const cards = page.locator('.hosts-card');
    await expect(cards.first()).toBeVisible();
    expect(await cards.count()).toBeGreaterThan(0);

    const first = cards.first();
    await expect(first.locator('.hosts-card__top strong')).toBeVisible();
    await expect(first).toContainText(/Gerenciamento/);
    await expect(first).toContainText(/Modelo/);
    await expect(first).toContainText(/Tipo/);
    await expect(first).toContainText(/Última coleta/);

    const m = await horizontalOverflow(page);
    expect(m.docScroll).toBeLessThanOrEqual(m.docClient + 1);
    expect(m.bodyScroll).toBeLessThanOrEqual(m.bodyClient + 1);
    await shot(page, 'hosts-390x844-cards');

    await first.click();
    const detail = page.locator('.host-detail');
    await expect(detail).toBeVisible({ timeout: 15_000 });
    // Bottom sheet: entra animando, entao a geometria e conferida ate assentar.
    await expect
      .poll(
        async () => {
          const box = await detail.boundingBox();
          return box ? Math.round(box.y + box.height) : -1;
        },
        { message: 'detalhes do host devem terminar dentro da viewport' },
      )
      .toBeLessThanOrEqual(844 + 1);
    const detailBox = await detail.boundingBox();
    expect(detailBox!.y).toBeGreaterThanOrEqual(56);
    expect(Math.round(detailBox!.width)).toBeLessThanOrEqual(390 + 1);
    await shot(page, 'hosts-390x844-detail');
  });

  for (const vp of [
    { name: '768x1024', width: 768, height: 1024 },
    { name: '1366x768', width: 1366, height: 768 },
  ]) {
    test(`${vp.name} — tabela de hosts preservada`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await login(page);
      await page.locator('.topbar .primary-nav').getByRole('button', { name: /^Hosts$/ }).click();

      await expect(page.locator('.hosts-table')).toBeVisible();
      await expect(page.locator('.hosts-cards')).toBeHidden();
      await expect(page.locator('.hosts-table tbody tr').first()).toBeVisible();

      const m = await horizontalOverflow(page);
      expect(m.docScroll).toBeLessThanOrEqual(m.docClient + 1);
      await shot(page, `hosts-${vp.name}-table`);
    });
  }
});

/** Abre o BGP pela navegação inferior (celular) ou pela topbar (desktop). */
async function openBgp(page: Page, mode: 'phone' | 'desktop' = 'phone') {
  if (mode === 'phone') {
    await page.locator('.mobile-nav').getByRole('button', { name: /^BGP$/ }).click();
  } else {
    await page.locator('.topbar .primary-nav').getByRole('button', { name: /^BGP$/ }).click();
  }
  await expect(page.locator('.bgp-shell')).toBeVisible();
  if (mode === 'phone') {
    await expect(page.locator('.bgp-card').first()).toBeVisible({ timeout: 20_000 });
  } else {
    await expect(page.locator('.bgp-table--rows tbody tr').first()).toBeVisible({ timeout: 20_000 });
  }
}

test.describe('BGP (M1.5) — cards no celular, tabela no desktop', () => {
  test('390x844 — cards agrupados por equipamento com os campos operacionais', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await openBgp(page);

    // Tabela de oito colunas sai de cena; cards entram no lugar.
    await expect(page.locator('.bgp-table').first()).toBeHidden();
    await expect(page.locator('.bgp-cards').first()).toBeVisible();

    // Agrupamento preservado: um bloco por equipamento, com contagem e refresh.
    const devices = page.locator('.bgp-device');
    await expect(devices).toHaveCount(3);
    const huawei = page.locator('.bgp-device', { hasText: 'NE-8K POP CENTRO' });
    await expect(huawei.locator('.bgp-device__header')).toContainText('3 peer');
    await expect(huawei.locator('.bgp-device__refresh')).toBeVisible();

    // Campos do card: peer, estado, equipamento, ASN, família, rotas, RX/TX, uptime.
    const upCard = huawei.locator('.bgp-card', { hasText: '200.219.0.1' });
    await expect(upCard).toBeVisible();
    // `UP`/`DOWN` é o estado operacional; o estado técnico do BGP (ACTIVE,
    // CONNECT, …) aparece ao lado, sem competir com o DOWN.
    await expect(upCard.locator('.bgp-state')).toHaveText('UP');
    await expect(upCard).toContainText('NE-8K POP CENTRO');
    await expect(upCard).toContainText('ASN 16735');
    await expect(upCard).toContainText('IPv4');
    await expect(upCard).toContainText('1.102.345');
    await expect(upCard).toContainText('532M');
    await expect(upCard).toContainText('224M');
    await expect(upCard).toContainText(/UP há \d+d/);

    // Peer sem interface/RX/TX continua legível, sem métrica inventada.
    const noIface = huawei.locator('.bgp-card', { hasText: '200.219.0.9' });
    await expect(noIface).toContainText('RX/TX');
    await expect(noIface.locator('.bgp-card__metric--empty')).toBeVisible();

    const m = await horizontalOverflow(page);
    expect(m.docScroll).toBeLessThanOrEqual(m.docClient + 1);
    expect(m.bodyScroll).toBeLessThanOrEqual(m.bodyClient + 1);
    await page.locator('.bgp-card').first().scrollIntoViewIfNeeded();
    await shot(page, 'bgp-390x844-cards');
  });

  test('390x844 — peer DOWN fica evidente, com DOWN há e quedas de 48h', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await openBgp(page);

    const down = page.locator('.bgp-card.is-down');
    await expect(down).toHaveCount(1);
    await expect(down).toContainText('200.219.0.5');
    await expect(down.locator('.bgp-state')).toHaveText('DOWN');
    await expect(down.locator('.bgp-card__state-tech')).toHaveText('ACTIVE');
    await expect(down).toContainText(/DOWN há \d+/);
    await expect(down).toContainText('2 quedas / 48h');

    // UP não domina a tela: só o card em DOWN recebe o destaque.
    await expect(page.locator('.bgp-card.is-up')).toHaveCount(4);
    await down.scrollIntoViewIfNeeded();
    await shot(page, 'bgp-390x844-down-peer');
  });

  test('390x844 — peer IPv6 é exibido por inteiro e sem estourar o card', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await openBgp(page);

    const ipv6 = page.locator('.bgp-card', { hasText: '2804:1f0:1:2::1' });
    await expect(ipv6).toBeVisible();
    await expect(ipv6).toContainText('IPv6');
    await expect(ipv6).toContainText('190.233');
    await expect(ipv6).toContainText('ASN 6939');

    const box = await ipv6.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390 + 1);
    await ipv6.scrollIntoViewIfNeeded();
    await shot(page, 'bgp-390x844-ipv6');
  });

  test('390x844 — capability adminActions=false esconde a ação de sessão', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await openBgp(page);

    // Juniper (VIANET-OUROPRETO) é read-only: sem ação administrativa de sessão.
    await page.locator('.bgp-card', { hasText: '167.250.0.1' }).click();
    const juniper = page.locator('.bgp-detail');
    await expect(juniper).toBeVisible({ timeout: 15_000 });
    await expect(juniper.getByRole('button', { name: 'Desabilitar sessão BGP' })).toHaveCount(0);
    await expect(juniper.getByRole('button', { name: 'Reabilitar sessão BGP' })).toHaveCount(0);
    await expect(juniper.locator('.bgp-actions__note')).toContainText('modo somente leitura');
    // Ações read-only continuam disponíveis.
    await expect(juniper.getByRole('button', { name: 'Atualizar agora' })).toBeVisible();
    await expect(juniper.getByRole('tab', { name: /Anúncios/i })).toBeVisible();
    const juniperOverflow = await horizontalOverflow(page);
    expect(juniperOverflow.docScroll).toBeLessThanOrEqual(juniperOverflow.docClient + 1);
    await shot(page, 'bgp-390x844-admin-readonly');
    await juniper.getByRole('button', { name: 'Fechar' }).click();
    await expect(juniper).toBeHidden();

    // Huawei (NE-8K POP CENTRO) mantém a ação administrativa.
    await page.locator('.bgp-card', { hasText: '200.219.0.1' }).click();
    const huawei = page.locator('.bgp-detail');
    await expect(huawei).toBeVisible({ timeout: 15_000 });
    await expect(huawei.getByRole('button', { name: 'Desabilitar sessão BGP' })).toBeVisible();
    await huawei.getByRole('button', { name: 'Fechar' }).click();
    await expect(huawei).toBeHidden();
  });

  test('390x844 — detalhe do peer abre como bottom sheet e rotas anunciadas não estouram', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await openBgp(page);

    await page.locator('.bgp-card', { hasText: '167.250.0.1' }).click();
    const detail = page.locator('.bgp-detail');
    await expect(detail).toBeVisible({ timeout: 15_000 });

    await expect
      .poll(
        async () => {
          const box = await detail.boundingBox();
          return box ? Math.round(box.y + box.height) : -1;
        },
        { message: 'detalhe do peer deve terminar dentro da viewport' },
      )
      .toBeLessThanOrEqual(844 + 1);
    const detailBox = await detail.boundingBox();
    expect(Math.round(detailBox!.width)).toBeLessThanOrEqual(390 + 1);
    expect(detailBox!.y).toBeGreaterThanOrEqual(56);

    // Fechar sempre acessível.
    await expect(detail.getByRole('button', { name: 'Fechar' })).toBeVisible();
    await shot(page, 'bgp-390x844-peer-detail');

    // Aba de anúncios: rolagem fica no container, não no documento.
    const routesTab = detail.getByRole('tab', { name: /Anúncios/i });
    await expect(routesTab).toBeVisible();
    await routesTab.click();
    await expect(routesTab).toHaveAttribute('aria-selected', 'true');
    const m = await horizontalOverflow(page);
    expect(m.docScroll).toBeLessThanOrEqual(m.docClient + 1);
    expect(m.bodyScroll).toBeLessThanOrEqual(m.bodyClient + 1);
    await shot(page, 'bgp-390x844-peer-detail-anuncios');

    await detail.getByRole('button', { name: 'Fechar' }).click();
    await expect(detail).toBeHidden();
  });

  test('390x844 — filtros de estado/família e busca continuam funcionando', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await openBgp(page);

    const stateSelect = page.locator('.bgp-filters .bgp-select').filter({ hasText: 'ESTADO' }).locator('select');
    await stateSelect.selectOption('down');
    await expect(page.locator('.bgp-card')).toHaveCount(1);
    await expect(page.locator('.bgp-card.is-down')).toHaveCount(1);

    await stateSelect.selectOption('all');
    await expect(page.locator('.bgp-card')).toHaveCount(5);

    const familySelect = page
      .locator('.bgp-filters .bgp-select')
      .filter({ hasText: 'FAMÍLIA' })
      .locator('select');
    await familySelect.selectOption('IPV6');
    await expect(page.locator('.bgp-card')).toHaveCount(1);
    await expect(page.locator('.bgp-card')).toContainText('2804:1f0:1:2::1');
    await familySelect.selectOption('all');

    const search = page.locator('.bgp-filters .nv-search input');
    await search.fill('OUROPRETO');
    await expect(page.locator('.bgp-device')).toHaveCount(1);
    await expect(page.locator('.bgp-card')).toHaveCount(1);
    await search.fill('');
    await expect(page.locator('.bgp-card')).toHaveCount(5);

    const m = await horizontalOverflow(page);
    expect(m.docScroll).toBeLessThanOrEqual(m.docClient + 1);
  });

  test('390x844 — refresh do equipamento e refresh global continuam disponíveis', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await openBgp(page);

    const globalRefresh = page.getByRole('button', { name: /Atualizar monitorados/i });
    await expect(globalRefresh).toBeVisible();

    const deviceRefresh = page
      .locator('.bgp-device', { hasText: 'NE-8K POP CENTRO' })
      .locator('.bgp-device__refresh');
    await deviceRefresh.click();

    // Sem host real por trás do fixture, a falha por equipamento aparece e
    // precisa ser legível no celular — nunca escondida.
    const warning = page.locator('.bgp-notice--warning');
    await expect(warning).toBeVisible({ timeout: 20_000 });
    await expect(warning).toContainText('Falhas na última atualização');
    await expect(warning).toContainText(/polling SNMP|discovery SSH/);
    const warnBox = await warning.boundingBox();
    expect(warnBox!.x + warnBox!.width).toBeLessThanOrEqual(390 + 1);

    await warning.getByRole('button', { name: /Limpar/i }).click();
    await expect(warning).toBeHidden();

    await globalRefresh.click();
    await expect(warning).toBeVisible({ timeout: 30_000 });
    // O refresh global percorre todos os equipamentos monitorados.
    await expect(warning.locator('.bgp-notice__list li')).toHaveCount(3);
    await shot(page, 'bgp-390x844-refresh-warning');

    // O clique no refresh do grupo não pode abrir o detalhe do peer.
    await expect(page.locator('.bgp-detail')).toHaveCount(0);
  });

  test('390x844 — equipamento aguardando primeira coleta aparece como linha própria', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await openBgp(page);

    const onboarding = page.locator('.bgp-onboarding');
    await expect(onboarding).toBeVisible();
    await expect(onboarding).toContainText('Aguardando primeira coleta');
    await expect(onboarding.locator('.bgp-onboarding__row')).toHaveCount(1);
    await expect(onboarding.getByRole('button', { name: /Atualizar agora/i })).toBeVisible();

    const box = await onboarding.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(390 + 1);
  });

  for (const vp of [
    { name: '360x800', width: 360, height: 800 },
    { name: '412x915', width: 412, height: 915 },
    { name: '844x390', width: 844, height: 390 },
  ]) {
    test(`${vp.name} — BGP sem overflow horizontal e sem sidebar ao lado`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await login(page);
      await openBgp(page);

      await expect(page.locator('.bgp-table').first()).toBeHidden();
      await expect(page.locator('.bgp-card').first()).toBeVisible();

      const m = await horizontalOverflow(page);
      expect(m.docScroll, `documentElement overflow em ${vp.name}`).toBeLessThanOrEqual(
        m.docClient + 1,
      );
      expect(m.bodyScroll, `body overflow em ${vp.name}`).toBeLessThanOrEqual(m.bodyClient + 1);

      // Alertas do módulo descem para baixo da lista (uma coluna só).
      const layout = page.locator('.bgp-layout');
      const columns = await layout.evaluate(
        (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length,
      );
      expect(columns).toBe(1);

      if (vp.name === '844x390') {
        await shot(page, 'bgp-844x390-landscape');
      }
    });
  }

  for (const vp of [
    { name: '768x1024', width: 768, height: 1024 },
    { name: '1024x768', width: 1024, height: 768 },
    { name: '1366x768', width: 1366, height: 768 },
  ]) {
    test(`${vp.name} — tabela BGP preservada`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await login(page);
      await openBgp(page, 'desktop');

      await expect(page.locator('.bgp-table').first()).toBeVisible();
      await expect(page.locator('.bgp-cards').first()).toBeHidden();
      await expect(page.locator('.bgp-table--rows tbody tr').first()).toBeVisible();

      const m = await horizontalOverflow(page);
      expect(m.docScroll).toBeLessThanOrEqual(m.docClient + 1);
      await shot(page, `bgp-${vp.name}-${vp.name === '1366x768' ? 'desktop' : 'table'}`);
    });
  }
});

/**
 * Físico (M1.7): abre o módulo pela navegação inferior (celular) ou pela
 * topbar (desktop) e espera o rack técnico renderizar.
 */
async function openPhysical(page: Page, mode: 'phone' | 'desktop' = 'phone') {
  if (mode === 'phone') {
    await page.locator('.mobile-nav').getByRole('button', { name: /^Físico$/ }).click();
  } else {
    await page.locator('.topbar .primary-nav').getByRole('button', { name: /^Físico$/ }).click();
  }
  await expect(page.locator('.physical-shell')).toBeVisible();
  await expect(page.locator('[data-asset-id]').first()).toBeVisible({ timeout: 30_000 });
}

test.describe('Físico (M1.7) — navegação, palco e inspetor no celular', () => {
  test('390x844 — rack no palco, sem sidebar fixa e sem overflow global', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await openPhysical(page);

    // A sidebar sai do fluxo: POP/rack/busca vivem no sheet.
    await expect(page.locator('.physical-sidebar')).toBeHidden();
    await expect(page.locator('.physical-nav-trigger')).toBeVisible();

    // O rack continua com largura técnica e rola dentro do palco.
    const scroll = page.locator('.physical-canvas-scroll');
    const dims = await scroll.evaluate((el) => ({
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      overflowX: getComputedStyle(el).overflowX,
    }));
    expect(dims.scrollWidth).toBeGreaterThan(dims.clientWidth);
    expect(dims.overflowX).toBe('auto');

    const m = await horizontalOverflow(page);
    expect(m.docScroll, 'documentElement overflow').toBeLessThanOrEqual(m.docClient + 1);
    expect(m.bodyScroll, 'body overflow').toBeLessThanOrEqual(m.bodyClient + 1);

    await expect(page.locator('[data-asset-id]')).toHaveCount(5);

    // Alvos de toque realmente alcançáveis: uma porta visível precisa estar no
    // topo do hit-test no próprio centro (nada de overlay cobrindo o rack).
    const hittable = await page.evaluate(() => {
      const ports = [...document.querySelectorAll('.physical-port')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.top > 0 && r.bottom < window.innerHeight;
      });
      for (const port of ports.slice(0, 20)) {
        const r = port.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (hit && (port === hit || port.contains(hit))) return true;
      }
      return false;
    });
    expect(hittable, 'porta deve receber o toque').toBe(true);

    await shot(page, 'physical-390x844-rack');
  });

  test('390x844 — sheet POP/Rack troca de rack e fecha', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await openPhysical(page);

    await page.locator('.physical-nav-trigger').click();
    const sheet = page.locator('.physical-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('POP / SITE');
    await expect(sheet).toContainText('RACKS');
    await shot(page, 'physical-390x844-selector');

    await sheet.getByRole('button', { name: /Rack Acesso 02/ }).click();
    await expect(sheet).toBeHidden();
    await expect(page.locator('.physical-nav-trigger')).toContainText('Rack Acesso 02');
    await expect(page.locator('[data-asset-id]')).toHaveCount(1);

    // Troca de POP pelo select mantém a mesma fonte de verdade.
    await page.locator('.physical-nav-trigger').click();
    await sheet.locator('select').selectOption({ label: 'Venda Nova · VN' });
    await expect(sheet).toBeHidden();
    await expect(page.locator('.physical-nav-trigger')).toContainText('Venda Nova');
    await expect(page.locator('[data-asset-id]')).toHaveCount(1);
  });

  test('390x844 — busca por equipamento e por porta mantém POP/Rack', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await openPhysical(page);

    await page.locator('.physical-nav-trigger').click();
    const sheet = page.locator('.physical-sheet');
    const search = sheet.getByLabel('Buscar equipamento ou porta');
    await search.fill('OLT-CENTRO');
    await expect(sheet.locator('.physical-search__results')).toContainText('BHE VTA / Rack Core 01');
    await shot(page, 'physical-390x844-search');

    await sheet.locator('.physical-search__results button').first().click();
    await expect(sheet).toBeHidden();
    const inspector = page.locator('.physical-inspector');
    await expect(inspector).toBeVisible();
    await expect(inspector).toContainText('OLT-CENTRO-01');
    await inspector.getByRole('button', { name: /Fechar/i }).first().click();
    await expect(inspector).toBeHidden();

    // Busca por porta do DIO passivo (48 portas).
    await page.locator('.physical-nav-trigger').click();
    await search.fill('FO12');
    const portResult = sheet.locator('.physical-search__results button.is-port').first();
    await expect(portResult).toBeVisible();
    await portResult.click();
    await expect(sheet).toBeHidden();
    await expect(inspector).toBeVisible();
  });

  test('390x844 — asset abre inspetor em bottom sheet e fecha', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await openPhysical(page);

    await page.locator('[data-asset-id]').first().dispatchEvent('click');
    const inspector = page.locator('.physical-inspector');
    await expect(inspector).toBeVisible();

    await expect
      .poll(
        async () => {
          const box = await inspector.boundingBox();
          return box ? Math.round(box.y + box.height) : -1;
        },
        { message: 'inspetor deve caber na viewport' },
      )
      .toBeLessThanOrEqual(844 + 1);
    const box = await inspector.boundingBox();
    expect(Math.round(box!.width)).toBeLessThanOrEqual(390 + 1);
    expect(box!.y).toBeGreaterThan(56);

    // Nome longo não empurra o botão de fechar.
    const close = inspector.getByRole('button', { name: /Fechar/i }).first();
    await expect(close).toBeVisible();
    const closeBox = await close.boundingBox();
    expect(closeBox!.x + closeBox!.width).toBeLessThanOrEqual(390 + 1);

    const m = await horizontalOverflow(page);
    expect(m.docScroll).toBeLessThanOrEqual(m.docClient + 1);
    await shot(page, 'physical-390x844-asset-detail');

    await close.click();
    await expect(inspector).toBeHidden();
  });

  test('390x844 — porta conectada abre inspetor com o caminho', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await openPhysical(page);

    const connected = page.locator('.physical-port.state-connected').first();
    await expect(connected).toBeVisible();
    await connected.dispatchEvent('click');

    const inspector = page.locator('.physical-inspector');
    await expect(inspector).toBeVisible();
    await expect(inspector.locator('.physical-path')).toBeVisible();
    // Caminho vertical no celular: nada de faixa horizontal gigante.
    const pathDir = await inspector
      .locator('.physical-path')
      .evaluate((el) => getComputedStyle(el).flexDirection);
    expect(pathDir).toBe('column');

    const m = await horizontalOverflow(page);
    expect(m.docScroll).toBeLessThanOrEqual(m.docClient + 1);
    await shot(page, 'physical-390x844-port-detail');
  });

  test('390x844 — conexão confirmada e ghost LLDP abrem o inspetor', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await openPhysical(page);

    // Cabo confirmado (o padrão é "Selecionado"; abrimos "Todas").
    await page.getByTitle('Mostrar todos os cabos').click();
    const cable = page.locator('.physical-cable-hit').first();
    await expect(cable).toBeVisible();
    await cable.dispatchEvent('click');
    const inspector = page.locator('.physical-inspector');
    await expect(inspector).toBeVisible();
    await expect(inspector).toContainText(/CABO CONFIRMADO|Conex/i);
    await shot(page, 'physical-390x844-connection');
    await inspector.getByRole('button', { name: /Fechar/i }).first().click();
    await expect(inspector).toBeHidden();

    // Ghost LLDP PARTIAL (uma ponta só) sempre visível no rack.
    await page
      .getByTitle('Modo opcional: mostrar todas as relações READY e o fallback do mapa neste rack')
      .click();
    const partial = page.locator('.physical-lldp-partial').first();
    await expect(partial).toBeVisible();
    await partial.dispatchEvent('click');
    await expect(inspector).toBeVisible();
    await expect(inspector).toContainText(/LLDP/i);
  });

  test('390x844 — legenda sai do cabeçalho e abre como popover', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await openPhysical(page);

    const legend = page.locator('.physical-legend');
    await expect(legend).toBeHidden();

    await page.locator('.physical-legend-trigger').click();
    await expect(legend).toBeVisible();
    await expect(legend).toContainText('SUGESTÃO LLDP');
    await expect(legend).toContainText('LINK DO MAPA (fallback)');
    await shot(page, 'physical-390x844-legend');

    await page.locator('.physical-legend-trigger').click();
    await expect(legend).toBeHidden();
  });

  test('390x844 — modais de POP, rack e equipamento cabem na tela', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await openPhysical(page);

    const modal = page.locator('.physical-modal__panel');

    await page.locator('.physical-nav-trigger').click();
    await page.getByRole('button', { name: 'Adicionar POP' }).click();
    await expect(modal).toBeVisible();
    const popBox = await modal.boundingBox();
    expect(Math.round(popBox!.width)).toBeLessThanOrEqual(390 + 1);
    expect(popBox!.y + popBox!.height).toBeLessThanOrEqual(844 + 1);
    await shot(page, 'physical-390x844-modal-pop');
    await modal.getByRole('button', { name: 'Cancelar' }).click();
    await expect(modal).toBeHidden();

    await page.locator('.physical-nav-trigger').click();
    await page.getByRole('button', { name: 'Adicionar rack' }).click();
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Unidades U');
    await modal.getByRole('button', { name: 'Cancelar' }).click();
    await expect(modal).toBeHidden();

    await page.getByRole('button', { name: 'Equipamento' }).click();
    await expect(modal).toBeVisible();
    const assetBox = await modal.boundingBox();
    expect(assetBox!.y + assetBox!.height).toBeLessThanOrEqual(844 + 1);
    const m = await horizontalOverflow(page);
    expect(m.docScroll).toBeLessThanOrEqual(m.docClient + 1);
    await modal.getByRole('button', { name: 'Cancelar' }).click();
    await expect(modal).toBeHidden();
  });

  for (const vp of [
    { name: '360x800', width: 360, height: 800 },
    { name: '412x915', width: 412, height: 915 },
    { name: '844x390', width: 844, height: 390 },
  ]) {
    test(`${vp.name} — físico sem overflow global`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await login(page);
      await openPhysical(page);

      await expect(page.locator('.physical-sidebar')).toBeHidden();
      const m = await horizontalOverflow(page);
      expect(m.docScroll, `documentElement overflow em ${vp.name}`).toBeLessThanOrEqual(
        m.docClient + 1,
      );
      expect(m.bodyScroll, `body overflow em ${vp.name}`).toBeLessThanOrEqual(m.bodyClient + 1);

      if (vp.name === '844x390') {
        await shot(page, 'physical-844x390-landscape');
      }
    });
  }

  test('390x844 — VIEWER não vê ações de criação', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);

    // Em DEMO_MODE o backend não cria usuários (a autorização só é aplicada
    // fora do demo). O papel é injetado na resposta de sessão: o que se valida
    // aqui é o gating da UI, não o backend de usuários.
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: {
            id: 'viewer-m17',
            username: 'viewer',
            email: 'viewer@netvision.local',
            name: 'Viewer M17',
            role: 'VIEWER',
          },
        }),
      }),
    );
    await page.reload({ waitUntil: 'load' });
    await expect(page.locator('.mobile-nav')).toBeVisible({ timeout: 30_000 });
    await openPhysical(page);

    // Consulta continua funcionando…
    await expect(page.locator('.physical-nav-trigger')).toBeVisible();
    // …mas nada de criar.
    await expect(page.getByRole('button', { name: 'Equipamento' })).toHaveCount(0);
    await page.locator('.physical-nav-trigger').click();
    await expect(page.getByRole('button', { name: 'Adicionar POP' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Adicionar rack' })).toHaveCount(0);
  });

  for (const vp of [
    { name: '768x1024', width: 768, height: 1024, shot: 'physical-768x1024-tablet' },
    { name: '1024x768', width: 1024, height: 768, shot: null },
    { name: '1366x768', width: 1366, height: 768, shot: 'physical-1366x768-desktop' },
    { name: '1600x900', width: 1600, height: 900, shot: null },
    { name: '1920x1080', width: 1920, height: 1080, shot: null },
  ]) {
    test(`${vp.name} — sidebar e palco preservados`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await login(page);
      await openPhysical(page, 'desktop');

      await expect(page.locator('.physical-sidebar')).toBeVisible();
      await expect(page.locator('.physical-nav-trigger')).toBeHidden();
      await expect(page.locator('[data-asset-id]').first()).toBeVisible();

      const m = await horizontalOverflow(page);
      expect(m.docScroll).toBeLessThanOrEqual(m.docClient + 1);

      if (vp.shot) await shot(page, vp.shot);
    });
  }
});
