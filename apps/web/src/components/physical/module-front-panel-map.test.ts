import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { connectorTally, frontPanelAnchorPx } from './front-panel-image-map';
import {
  MODULE_FRONT_PANEL_MAPS,
  moduleFrontPanelAspectRatio,
  moduleFrontPanelImageMap,
  moduleFrontPanelMapByKey,
  moduleFrontPanelMapFor,
  modulePortAnchor,
  overlappingModulePortPairs,
  validateModuleFrontPanelMap,
} from './module-front-panel-map';

/**
 * Mapas das placas das OLTs Huawei.
 *
 * São mapas **declarados**: a posição veio das imagens fornecidas (medição na
 * faixa de portas), por isso nunca são FRONT_EXACT. Nenhum template de módulo é
 * criado aqui — o hotspot só resolve quando o catálogo declarar a placa.
 */

const GPFD = 'huawei-gpfd-16';
const XGSPON = 'huawei-xgspon-16';
const H901 = 'huawei-h901mpsc';
const H902 = 'huawei-h902mpla';
const SCUN = 'huawei-scun';
const PAC = 'huawei-pac600s12-cb';

describe('mapa de painel das placas (OLT Huawei)', () => {
  it('declara as seis placas do pacote, todas válidas e sem overlap', () => {
    expect(MODULE_FRONT_PANEL_MAPS.map((map) => map.moduleKey).sort()).toEqual(
      [GPFD, H901, H902, PAC, SCUN, XGSPON].sort(),
    );

    for (const map of MODULE_FRONT_PANEL_MAPS) {
      expect(validateModuleFrontPanelMap(map)).toEqual([]);
      expect(overlappingModulePortPairs(map)).toEqual([]);
      expect(map.ports).toHaveLength(map.expectedPortCount);
      // imagem fornecida/gerada: nunca tratada como exata
      expect(map.imageStatus).toBe('GENERATED');
      expect(map.mappingMode).toBe('FRONT_APPROX');
      for (const port of map.ports) {
        expect(port.bbox.width).toBeGreaterThan(0);
        expect(port.bbox.height).toBeGreaterThan(0);
        expect(port.bbox.x + port.bbox.width).toBeLessThanOrEqual(1);
        expect(port.bbox.y + port.bbox.height).toBeLessThanOrEqual(1);
      }
    }
  });

  it('cada imagem existe em public/ com as dimensões declaradas no mapa', () => {
    const publicDir = fileURLToPath(new URL('../../../public', import.meta.url));
    for (const map of MODULE_FRONT_PANEL_MAPS) {
      expect(map.image.startsWith('/physical-panels/huawei/')).toBe(true);
      const file = join(publicDir, map.image.replace(/^\//, ''));
      expect(existsSync(file)).toBe(true);
      const header = readFileSync(file).subarray(0, 24);
      expect(header.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(header.readUInt32BE(16)).toBe(map.naturalWidth);
      expect(header.readUInt32BE(20)).toBe(map.naturalHeight);
    }
  });

  it('reconhece a placa por moduleKey, partNumber ou model (tolerante a sufixo)', () => {
    expect(moduleFrontPanelMapFor({ moduleKey: H901 })?.moduleKey).toBe(H901);
    expect(moduleFrontPanelMapFor({ partNumber: 'H901MPSC' })?.moduleKey).toBe(H901);
    expect(moduleFrontPanelMapFor({ model: 'H901MPSC', name: 'controle MA5800' })?.moduleKey).toBe(
      H901,
    );
    expect(moduleFrontPanelMapFor({ partNumber: 'GPFD' })?.moduleKey).toBe(GPFD);
    expect(moduleFrontPanelMapFor({ model: 'H802GPFD' })?.moduleKey).toBe(GPFD);
    expect(moduleFrontPanelMapFor({ model: 'PAC600S12-CB' })?.moduleKey).toBe(PAC);
    expect(moduleFrontPanelMapFor({ partNumber: 'H801SCUN' })?.moduleKey).toBe(SCUN);
    // nada é adivinhado para placa desconhecida
    expect(moduleFrontPanelMapFor({ model: 'PLACA-DESCONHECIDA' })).toBeNull();
    expect(moduleFrontPanelMapFor({})).toBeNull();
    expect(moduleFrontPanelMapFor(null)).toBeNull();
    expect(moduleFrontPanelMapByKey('nao-existe')).toBeNull();
  });

  it('a contagem por conector bate com o silk impresso na imagem', () => {
    expect(connectorTally(moduleFrontPanelMapByKey(GPFD)!)).toEqual(new Map([['SFP', 16]]));
    expect(connectorTally(moduleFrontPanelMapByKey(XGSPON)!)).toEqual(new Map([['SFP_PLUS', 16]]));
    expect(connectorTally(moduleFrontPanelMapByKey(H901)!)).toEqual(
      new Map([
        ['RJ45', 2],
        ['USB', 1],
        ['SFP_PLUS', 2],
        ['SFP', 2],
      ]),
    );
    expect(connectorTally(moduleFrontPanelMapByKey(SCUN)!)).toEqual(
      new Map([
        ['RJ45', 3],
        ['USB', 1],
      ]),
    );
    // fonte não tem porta de dados declarada
    expect(moduleFrontPanelMapByKey(PAC)!.ports).toEqual([]);
  });

  it('a família do conector do H902MPLA não é inventada (UNKNOWN + nota)', () => {
    const map = moduleFrontPanelMapByKey(H902)!;
    expect(map.ports).toHaveLength(4);
    expect(map.ports.every((port) => port.connector === 'UNKNOWN')).toBe(true);
    expect(map.note ?? '').toContain('UNKNOWN');
  });

  it('o hotspot da placa é o centro do bbox e o adapter casa com o painel por imagem', () => {
    const map = moduleFrontPanelMapByKey(GPFD)!;
    const hotspot = map.ports.find((port) => port.portName === 'GPON-1')!;
    const center = modulePortAnchor(map, 'GPON-1')!;

    expect(center.x).toBeCloseTo(hotspot.bbox.x + hotspot.bbox.width / 2, 10);
    expect(center.y).toBeCloseTo(hotspot.bbox.y + hotspot.bbox.height / 2, 10);
    expect(modulePortAnchor(map, 'nao-existe')).toBeNull();

    const adapted = moduleFrontPanelImageMap(map);
    expect(adapted.catalogKey).toBe(`module:${GPFD}`);
    expect(adapted.status).toBe('ACTIVE_TEST');
    expect(adapted.imageStatus).toBe('GENERATED');
    expect(adapted.ports).toEqual(map.ports);

    const box = { left: 10, top: 4, width: 300, height: 60 };
    const anchor = frontPanelAnchorPx(adapted, 'GPON-1', box)!;
    expect(anchor.x).toBeCloseTo(box.left + center.x * box.width, 10);
    expect(moduleFrontPanelAspectRatio(map)).toBeCloseTo(1438 / 255, 5);
  });

  it('o nome da porta segue o rótulo do silk, nunca um nome CLI', () => {
    const serialized = JSON.stringify(MODULE_FRONT_PANEL_MAPS);
    expect(serialized).not.toContain('gpon-0/');
    expect(serialized).not.toContain('0/1/0');
    expect(moduleFrontPanelMapByKey(GPFD)!.ports[0]!.portName).toBe('GPON-1');
    expect(moduleFrontPanelMapByKey(SCUN)!.ports.map((port) => port.portName)).toEqual([
      'ETH0',
      'ETH1',
      'CONSOLE',
      'USB',
    ]);
  });
});
