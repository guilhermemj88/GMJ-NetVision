import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { offlineApi } from './offline-api';

const viewports = [
  [360, 800],
  [390, 844],
  [412, 915],
  [844, 390],
  [768, 1024],
  [820, 1180],
  [1024, 768],
  [1366, 768],
  [1920, 1080],
] as const;
const shots = join(process.cwd(), '.artifacts/responsive/screenshots');
mkdirSync(shots, { recursive: true });

async function start(page: Page, width: number, height: number, view = '', running = false) {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await offlineApi(page, { running });
  await page.goto(`/${view ? `?view=${view}` : ''}`);
  await expect(page.locator('.topbar--responsive')).toBeVisible();
  // The development overlay is not part of the product.
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important }' });
}

async function noGlobalOverflow(page: Page) {
  const sizes = await page.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    app: document.querySelector('.netvision-app')!.getBoundingClientRect().width,
  }));
  if (sizes.body > sizes.viewport + 1) {
    console.log(
      await page.evaluate(() =>
        [...document.querySelectorAll('body *')]
          .filter((el) => el.getBoundingClientRect().right > innerWidth + 1)
          .slice(-25)
          .map((el) => ({
            tag: el.tagName,
            className: el.className,
            width: el.getBoundingClientRect().width,
            right: el.getBoundingClientRect().right,
          })),
      ),
    );
  }
  expect(sizes.document).toBeLessThanOrEqual(sizes.viewport + 1);
  expect(sizes.body).toBeLessThanOrEqual(sizes.viewport + 1);
  expect(sizes.app).toBeLessThanOrEqual(sizes.viewport + 1);
}

async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

async function inViewport(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  expect(box, selector).not.toBeNull();
  const vp = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height + 1);
}

for (const [width, height] of viewports) {
  test(`${width}x${height} mapa: faixa completa, navegação, canvas e busca`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await start(page, width, height);
    await expect(page.locator('.react-flow__node').first()).toBeVisible();
    await page.getByRole('button', { name: 'Enquadrar mapa', exact: true }).click();
    await page.waitForTimeout(600); // React Flow fitView animation.
    if (height <= 500) {
      const alarm = (await page.locator('.alarm-panel').boundingBox())!;
      const status = (await page
        .getByRole('button', { name: 'Status do mapa', exact: true })
        .boundingBox())!;
      expect(alarm.y + alarm.height).toBeLessThanOrEqual(status.y);
    }
    const scroll = page.locator('.topbar__map-scroll .horizontal-scroll__viewport');
    for (const [part, fraction] of [
      ['inicio', 0],
      ['meio', 0.5],
      ['fim', 1],
    ] as const) {
      await scroll.evaluate((el, f) => {
        el.scrollLeft = (el.scrollWidth - el.clientWidth) * f;
      }, fraction);
      await expect.poll(() => scroll.evaluate((el) => el.scrollLeft)).toBeGreaterThanOrEqual(0);
      await screenshot(page, `mapa-${width}x${height}-${part}`);
    }
    for (const name of [
      'NOC',
      'Editar mapa',
      'Descobrir',
      'Links públicos',
      'Configurações',
      'Usuários e senhas',
      'Sair',
    ]) {
      const button = page.locator('.topbar').getByRole('button', { name, exact: true });
      await button.scrollIntoViewIfNeeded();
      await button.click({ trial: true });
    }
    // Focus navigation and the keyboard scroll region must reach the far edge too.
    await scroll.focus();
    await page.keyboard.press('Home');
    await expect.poll(() => scroll.evaluate((el) => el.scrollLeft)).toBe(0);
    await page.keyboard.press('End');
    await expect
      .poll(() =>
        scroll.evaluate((el) => Math.abs(el.scrollWidth - el.clientWidth - el.scrollLeft)),
      )
      .toBeLessThanOrEqual(1);
    const nav = page.locator('.primary-nav');
    for (const name of ['Físico', 'Mapa', 'Hosts', 'BGP', 'Alertas', 'Diagnóstico']) {
      const button = nav.getByRole('button', {
        name: name === 'Alertas' ? /^Alertas/ : name,
        exact: true,
      });
      await button.scrollIntoViewIfNeeded();
      await button.click({ trial: true });
    }
    const geometry = await page.evaluate(() => ({
      headerBottom: document.querySelector('.topbar')!.getBoundingClientRect().bottom,
      canvasTop: document.querySelector('.map-workspace')!.getBoundingClientRect().top,
      canvasBottom: document.querySelector('.map-workspace')!.getBoundingClientRect().bottom,
      height: innerHeight,
    }));
    expect(Math.abs(geometry.canvasTop - geometry.headerBottom)).toBeLessThanOrEqual(1);
    expect(geometry.canvasBottom).toBeLessThanOrEqual(geometry.height);
    writeFileSync(
      join(shots, `mapa-${width}x${height}-geometry.json`),
      JSON.stringify(
        {
          ...geometry,
          width,
          height,
          toolbar: await scroll.evaluate((el) => ({
            clientWidth: el.clientWidth,
            scrollWidth: el.scrollWidth,
          })),
        },
        null,
        2,
      ),
    );
    const search = page.getByRole('textbox', { name: 'Buscar interfaces no inventário' });
    await search.scrollIntoViewIfNeeded();
    await search.fill('UPLINK');
    const popover = page.getByRole('dialog', { name: 'Resultados da busca de interfaces' });
    await expect(popover.getByText('100GE0/0/1', { exact: true })).toBeVisible();
    expect(await popover.evaluate((el) => el.parentElement === document.body)).toBe(true);
    await inViewport(page, '.global-interface-search__popover');
    await screenshot(page, `mapa-${width}x${height}-busca`);
    await popover.getByRole('button', { name: 'Abrir no mapa atual' }).click({ trial: true });
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await noGlobalOverflow(page);
    if (width <= 720 || height <= 500) {
      await page.getByRole('button', { name: 'Status do mapa', exact: true }).click();
      await inViewport(page, '.map-statusbar');
      await screenshot(page, `mapa-${width}x${height}-status`);
      await page.getByRole('button', { name: 'Fechar status', exact: true }).click();
      await page.getByRole('button', { name: 'Legenda dos enlaces', exact: true }).click();
      await inViewport(page, '.map-v2-legend');
      await page.getByRole('button', { name: 'Fechar legenda', exact: true }).click();
    }
    expect(errors).toEqual([]);
  });
}

for (const [width, height] of viewports) {
  for (const view of ['hosts', 'bgp', 'mitigation', 'alerts', 'diagnostics', 'physical']) {
    test(`${width}x${height} ${view}: conteúdo e painéis`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => {
        errors.push(error.message);
        console.log(error.message);
      });
      await start(page, width, height, view === 'mitigation' ? 'bgp' : view);
      if (view === 'hosts' || view === 'bgp') {
        const field = page.locator('.nv-search').first();
        await expect(field).toBeVisible();
        const icon = (await field.locator('.nv-search__icon').boundingBox())!;
        const input = (await field.locator('input').boundingBox())!;
        expect(icon.x + icon.width).toBeLessThanOrEqual(input.x + 1);
        expect(Math.abs(icon.y + icon.height / 2 - input.y - input.height / 2)).toBeLessThanOrEqual(
          4,
        );
      }
      if (view === 'hosts') {
        await expect(page.getByRole('heading', { name: 'Hosts', exact: true })).toBeVisible();
        const compact = width <= 720 || height <= 500;
        const row = compact
          ? page.locator('.hosts-card').first()
          : page.locator('.hosts-table tbody tr').first();
        await expect(row).toBeVisible();
        await screenshot(page, `${view}-${width}x${height}`);
        await row.click();
        await expect(page.locator('.host-detail')).toBeVisible();
        await inViewport(page, '.host-detail');
      } else if (view === 'bgp') {
        const compact = width <= 720 || height <= 500;
        const row = compact
          ? page.locator('.bgp-card').first()
          : page.locator('.bgp-device tbody tr').first();
        await expect(row).toBeVisible();
        await screenshot(page, `${view}-${width}x${height}`);
        await row.click();
        await expect(page.locator('.bgp-detail')).toBeVisible();
        await inViewport(page, '.bgp-detail');
      } else if (view === 'mitigation') {
        await page.getByRole('tab', { name: /MITIGAÇÃO DDoS/i }).click();
        await expect(page.locator('.mitigation-table')).toContainText('HORIZONTE_IP');
        await expect(page.locator('.mitigation-table')).toContainText('Eth-Trunk1.3011');
        await expect(page.locator('.mitigation-table')).toContainText('1,879');
        if (width <= 1100) {
          expect(
            await page
              .locator('.mitigation-table')
              .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
          ).toBe(true);
        }
        await page
          .locator('.mitigation-table')
          .evaluate((el) => el.scrollIntoView({ block: 'start' }));
        await screenshot(page, `${view}-${width}x${height}`);
        if (width <= 1100) {
          await page
            .locator('.mitigation-table tbody tr')
            .first()
            .locator('[data-label="Tráfego"]')
            .scrollIntoViewIfNeeded();
          await screenshot(page, `${view}-${width}x${height}-trafego`);
        }
        await page.getByRole('button', { name: 'DETALHES', exact: true }).first().click();
        await expect(page.locator('.mitigation-drawer')).toBeVisible();
        await inViewport(page, '.mitigation-drawer');
      } else if (view === 'alerts') {
        await expect(page.locator('.alerts-workspace')).toContainText('LINK DOWN');
        await screenshot(page, `${view}-${width}x${height}`);
        const item = page.locator('.alerts-card:visible, .alerts-table tbody tr:visible').first();
        await item.click();
        await expect(page.locator('.alerts-drawer')).toBeVisible();
        await inViewport(page, '.alerts-drawer');
      } else if (view === 'diagnostics') {
        await page.getByLabel('Equipamento', { exact: true }).selectOption({ index: 1 });
        await page.getByLabel('VSI', { exact: true }).selectOption('vsi-1809-local');
        await page.getByRole('button', { name: 'Preparar janela', exact: true }).click();
        await page.getByRole('button', { name: 'Diagnosticar', exact: true }).click();
        await expect(page.getByText('Contexto de execução', { exact: true })).toBeVisible();
        await page
          .getByRole('article', { name: 'Resultado do diagnóstico' })
          .evaluate((el) => el.scrollIntoView({ block: 'start' }));
        await screenshot(page, `${view}-${width}x${height}`);
        await page.locator('summary').filter({ hasText: 'Contexto de execução' }).click();
        await page.locator('summary').filter({ hasText: 'Evidências e comandos' }).click();
      } else {
        await expect(page.locator('.physical-stage')).toContainText('CORE-RESPONSIVE-S6730');
        await screenshot(page, `${view}-${width}x${height}`);
        await page.locator('[data-asset-id="asset-responsive"]').click();
        await expect(
          page.locator('.physical-inspector:not(.physical-inspector--empty)'),
        ).toBeVisible();
        await inViewport(page, '.physical-inspector:not(.physical-inspector--empty)');
      }
      await noGlobalOverflow(page);
      await screenshot(page, `${view}-${width}x${height}-detalhes`);
      expect(errors).toEqual([]);
    });
  }
}

test('390x844 diagnóstico RUNNING preserva stepper e contexto', async ({ page }) => {
  await start(page, 390, 844, 'diagnostics', true);
  await page.getByLabel('Equipamento', { exact: true }).selectOption({ index: 1 });
  await page.getByLabel('VSI', { exact: true }).selectOption('vsi-1809-local');
  await page.getByRole('button', { name: 'Preparar janela', exact: true }).click();
  await page.getByRole('button', { name: 'Diagnosticar', exact: true }).click();
  await expect(page.getByText('Diagnóstico em andamento', { exact: true })).toBeVisible();
  await noGlobalOverflow(page);
  await screenshot(page, 'diagnostico-390x844-running');
});

test('390x844 mapa: mouse, roda horizontal, barra persistente e zoom/pan', async ({ page }) => {
  await start(page, 390, 844);
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  const scroll = page.locator('.topbar__map-scroll .horizontal-scroll__viewport');
  const box = (await scroll.boundingBox())!;
  await page.mouse.move(box.x + 260, box.y + 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 2, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => scroll.evaluate((el) => el.scrollLeft)).toBeGreaterThan(80);
  const previous = await scroll.evaluate((el) => el.scrollLeft);
  await scroll.hover();
  await page.mouse.wheel(250, 0);
  await expect.poll(() => scroll.evaluate((el) => el.scrollLeft)).toBeGreaterThan(previous);
  const bar = page.locator('.topbar__map-scroll input[type="range"]');
  await expect(bar).toBeVisible();
  await bar.focus();
  await page.keyboard.press('Home');
  await expect.poll(() => scroll.evaluate((el) => el.scrollLeft)).toBe(0);
  await page.keyboard.press('End');
  await expect
    .poll(() => scroll.evaluate((el) => Math.abs(el.scrollWidth - el.clientWidth - el.scrollLeft)))
    .toBeLessThanOrEqual(1);
  const canvas = page.locator('.react-flow__viewport');
  const before = await canvas.getAttribute('style');
  await page.getByRole('button', { name: 'Aumentar zoom', exact: true }).click();
  await expect.poll(() => canvas.getAttribute('style')).not.toBe(before);
  await page.getByRole('button', { name: 'Ocultar painel de alertas', exact: true }).click();
  await page.getByRole('button', { name: 'Enquadrar mapa', exact: true }).click();
  await page.waitForTimeout(700);
  const geometry = await page.evaluate(() => ({
    transform: document.querySelector('.react-flow__viewport')!.getAttribute('style'),
    nodes: [...document.querySelectorAll('.react-flow__node')]
      .slice(0, 3)
      .map((el) => el.getBoundingClientRect().toJSON()),
    canvas: document.querySelector('.react-flow')!.getBoundingClientRect().toJSON(),
  }));
  console.log('map geometry', geometry);
  await screenshot(page, 'mapa-390x844-canvas');
  await noGlobalOverflow(page);
});

test('390x844 mapa: gesto touch nativo mantém o canvas independente', async ({ page }) => {
  await start(page, 390, 844);
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  const scroll = page.locator('.topbar__map-scroll .horizontal-scroll__viewport');
  const bounds = (await scroll.boundingBox())!;
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 300, y: bounds.y + 4 }],
  });
  for (const x of [270, 230, 180, 130, 80]) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: bounds.y + 4 }],
    });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => scroll.evaluate((el) => el.scrollLeft)).toBeGreaterThan(40);
  await scroll.focus();
  await page.keyboard.press('Home');
  await expect.poll(() => scroll.evaluate((el) => el.scrollLeft)).toBe(0);
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 320, y: 650 }],
  });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: 180, y: 650 }],
  });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  expect(await scroll.evaluate((el) => el.scrollLeft)).toBe(0);
  await session.detach();
});

for (const [width, height] of [
  [360, 800],
  [844, 390],
  [768, 1024],
] as const) {
  test(`${width}x${height} mapa: painéis operacionais e fechamento`, async ({ page }) => {
    await start(page, width, height);
    await expect(page.locator('.topbar__map-scroll')).toBeVisible();
    for (const name of [
      'NOC',
      'Descobrir',
      'Links públicos',
      'Configurações',
      'Usuários e senhas',
    ]) {
      const button = page.locator('.topbar').getByRole('button', { name, exact: true });
      await button.scrollIntoViewIfNeeded();
      await button.click();
      await expect(page.locator('.action-panel')).toBeVisible();
      await inViewport(page, '.action-panel');
      await screenshot(page, `mapa-${width}x${height}-painel-${name.split(' ')[0]}`);
      await page.locator('.action-panel > header button').last().click();
      await expect(page.locator('.action-panel')).toBeHidden();
    }
    await noGlobalOverflow(page);
  });
  test(`${width}x${height} alertas: modal e cancelamento`, async ({ page }) => {
    await start(page, width, height, 'alerts');
    await page.locator('.alerts-table tbody tr').first().click();
    await page.getByRole('button', { name: 'RETIRAR / SUPRIMIR' }).click();
    await expect(page.getByRole('dialog', { name: 'Retirar alarme' })).toBeVisible();
    await inViewport(page, '.alerts-modal__card');
    await screenshot(page, `alertas-${width}x${height}-modal`);
    await page.getByRole('button', { name: 'CANCELAR', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Retirar alarme' })).toBeHidden();
    await noGlobalOverflow(page);
  });
}
