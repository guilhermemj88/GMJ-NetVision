import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { PhysicalCatalogPort } from '@gmj/shared';
import { describe, expect, it } from 'vitest';
import {
  FRONT_PANEL_MAPS,
  connectorTally,
  frontPanelAnchorPx,
  frontPanelImageMap,
  frontPanelMapStatus,
  frontPanelPortMapFor,
  normalizedPortAnchor,
  overlappingMapPairs,
  resolveMappedPhysicalPort,
  resolvedMapPorts,
  validateFrontPanelMap,
} from './front-panel-image-map';

/**
 * O mapa é a **única** verdade de posição do painel por imagem. Estes testes
 * garantem que os hotspots dos S6730 conferem com o catálogo antes de a tela
 * usar a imagem: contagem, nomes estáveis, limites normalizados e zero overlap.
 */

const H48 = 'huawei-s6730-h48x6c';
const H24 = 'huawei-s6730-h24x6c';

/** Portas do template como o loader do catálogo as materializa. */
function catalogPorts(count10ge: number, countQsfp = 6): PhysicalCatalogPort[] {
  const ports: PhysicalCatalogPort[] = [];
  let order = 0;
  for (let index = 1; index <= count10ge; index += 1) {
    order += 1;
    ports.push({
      name: `10GE-${index}`,
      label: `10GE-${index}`,
      order,
      side: 'DEVICE',
      type: 'SFP_PLUS',
      connector: 'SFP_PLUS',
      portFunction: 'SERVICE',
      groupKey: 'sfpplus-10g',
    });
  }
  for (let index = 1; index <= countQsfp; index += 1) {
    order += 1;
    ports.push({
      name: `QSFP28-${index}`,
      label: `QSFP28-${index}`,
      order,
      side: 'DEVICE',
      type: 'QSFP',
      connector: 'QSFP28',
      portFunction: 'UPLINK',
      groupKey: 'qsfp28-uplink',
    });
  }
  return ports;
}

describe('mapa do painel frontal (S6730)', () => {
  it('H48X6C: 54 hotspots (48 SFP+ e 6 QSFP28), sem duplicata, dentro da imagem', () => {
    const map = frontPanelImageMap(H48);
    expect(map).not.toBeNull();
    expect(map!.status).toBe('ACTIVE_TEST');
    expect(map!.ports).toHaveLength(54);
    expect(map!.ports.filter((port) => port.portName.startsWith('10GE-'))).toHaveLength(48);
    expect(map!.ports.filter((port) => port.portName.startsWith('QSFP28-'))).toHaveLength(6);
    expect(new Set(map!.ports.map((port) => port.portName)).size).toBe(54);
    expect(validateFrontPanelMap(map!)).toEqual([]);
    expect(overlappingMapPairs(map!)).toEqual([]);
  });

  it('H24X6C: 30 hotspots (24 SFP+ e 6 QSFP28), sem duplicata, dentro da imagem', () => {
    const map = frontPanelImageMap(H24);
    expect(map).not.toBeNull();
    expect(map!.ports).toHaveLength(30);
    expect(map!.ports.filter((port) => port.portName.startsWith('10GE-'))).toHaveLength(24);
    expect(map!.ports.filter((port) => port.portName.startsWith('QSFP28-'))).toHaveLength(6);
    expect(new Set(map!.ports.map((port) => port.portName)).size).toBe(30);
    expect(validateFrontPanelMap(map!)).toEqual([]);
    expect(overlappingMapPairs(map!)).toEqual([]);
    // nenhum bbox é degenerado nem sai do quadro normalizado
    for (const port of map!.ports) {
      const { x, y, width, height } = port.bbox;
      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + width).toBeLessThanOrEqual(1);
      expect(y + height).toBeLessThanOrEqual(1);
    }
  });

  it('a imagem declarada existe em public/ com as dimensões naturais do mapa', () => {
    for (const key of [H48, H24]) {
      const map = frontPanelImageMap(key)!;
      expect(map.image?.startsWith('/physical-panels/huawei/')).toBe(true);
      const publicDir = fileURLToPath(new URL('../../../public', import.meta.url));
      const file = join(publicDir, map.image!.replace(/^\//, ''));
      expect(existsSync(file)).toBe(true);
      const header = readFileSync(file).subarray(0, 24);
      // PNG: assinatura + IHDR (largura e altura em big-endian)
      expect(header.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(header.readUInt32BE(16)).toBe(map.naturalWidth);
      expect(header.readUInt32BE(20)).toBe(map.naturalHeight);
    }
  });

  it('os conectores do mapa batem com as famílias declaradas', () => {
    expect(connectorTally(frontPanelImageMap(H48)!)).toEqual(
      new Map([
        ['SFP_PLUS', 48],
        ['QSFP28', 6],
      ]),
    );
    expect(connectorTally(frontPanelImageMap(H24)!)).toEqual(
      new Map([
        ['SFP_PLUS', 24],
        ['QSFP28', 6],
      ]),
    );
  });

  it('V2 continua AWAITING_APPROVED_IMAGE e não herda a imagem do modelo não-V2', () => {
    expect(frontPanelMapStatus(`${H48}-v2`)).toBe('AWAITING_APPROVED_IMAGE');
    expect(frontPanelMapStatus(`${H24}-v2`)).toBe('AWAITING_APPROVED_IMAGE');
    expect(frontPanelImageMap(`${H48}-v2`)).toBeNull();
    expect(frontPanelImageMap(`${H24}-v2`)).toBeNull();
    expect(frontPanelImageMap(`${H48}-v2`)).not.toEqual(frontPanelImageMap(H48));
    // catálogo key desconhecido nunca ganha imagem
    expect(frontPanelImageMap('huawei-s6730-h')).toBeNull();
    expect(frontPanelImageMap(null)).toBeNull();
  });

  it('todo mapa ativo é válido e tem portas esperadas = portas declaradas', () => {
    const active = FRONT_PANEL_MAPS.filter((map) => map.status === 'ACTIVE_TEST');
    expect(active.map((map) => map.catalogKey).sort()).toEqual([H24, H48].sort());
    for (const map of active) {
      expect(validateFrontPanelMap(map)).toEqual([]);
      expect(map.ports).toHaveLength(map.expectedPortCount);
    }
  });
});

describe('hotspot → PhysicalPort (identidade estável do catálogo)', () => {
  const h48 = frontPanelImageMap(H48)!;

  it('resolver o hotspot QSFP28-1 encontra o PhysicalPort QSFP28-1', () => {
    const ports = catalogPorts(48);
    const hotspot = h48.ports.find((port) => port.portName === 'QSFP28-1')!;
    const resolved = resolveMappedPhysicalPort(ports, hotspot);
    expect(resolved?.name).toBe('QSFP28-1');
    // o nome CLI nunca aparece no mapa
    expect(JSON.stringify(h48)).not.toContain('100GE0/0/');
    expect(JSON.stringify(h48)).not.toContain('10GE0/0/');
  });

  it('as 54 portas do template S6730-H48X6C são resolvidas pelo mapa', () => {
    const ports = catalogPorts(48);
    const resolved = resolvedMapPorts({ ports }, h48);
    expect(resolved).toHaveLength(54);
    expect(resolved.every((item) => item.port.name === item.mapped.portName)).toBe(true);
  });

  it('porta ausente no template não é inventada', () => {
    const ports = catalogPorts(24, 0);
    const resolved = resolvedMapPorts({ ports }, h48);
    expect(resolved).toHaveLength(24);
    const missing = h48.ports.filter(
      (port) => !ports.some((candidate) => candidate.name === port.portName),
    );
    expect(missing).toHaveLength(30);
  });

  it('tolera diferenças de separador do catálogo sem mudar o mapa', () => {
    const ports = catalogPorts(48).map((port) =>
      port.name === 'QSFP28-1' ? { ...port, name: 'qsfp28 1' } : port,
    );
    const hotspot = h48.ports.find((port) => port.portName === 'QSFP28-1')!;
    expect(resolveMappedPhysicalPort(ports, hotspot)?.name).toBe('qsfp28 1');
    expect(hotspot.portName).toBe('QSFP28-1');
  });
});

describe('mappedInterface e âncora do cabo', () => {
  const h48 = frontPanelImageMap(H48)!;

  it('a interface real vem do PhysicalPort, sem tocar no mapa', () => {
    const port = {
      name: 'QSFP28-1',
      label: 'QSFP28-1',
      mappedInterface: { name: '100GE0/0/4' },
    };
    const hotspot = frontPanelPortMapFor(h48, port)!;
    expect(hotspot.portName).toBe('QSFP28-1');
    expect(resolveMappedPhysicalPort([port], hotspot)?.mappedInterface?.name).toBe('100GE0/0/4');
    expect(hotspot.bbox).toEqual(h48.ports.find((item) => item.portName === 'QSFP28-1')!.bbox);
  });

  it('o anchor é o centro do MESMO bbox usado pelo clique', () => {
    const hotspot = h48.ports.find((port) => port.portName === 'QSFP28-1')!;
    const anchor = normalizedPortAnchor(hotspot.bbox);
    expect(anchor.x).toBeCloseTo(hotspot.bbox.x + hotspot.bbox.width / 2, 10);
    expect(anchor.y).toBeCloseTo(hotspot.bbox.y + hotspot.bbox.height / 2, 10);

    const boxes = [
      { left: 62, top: 30, width: 828, height: 114 },
      { left: 12, top: 100, width: 414, height: 57 },
    ];
    for (const box of boxes) {
      const px = frontPanelAnchorPx(h48, 'QSFP28-1', box)!;
      // a âncora em pixels é a mesma posição normalizada em qualquer tamanho
      expect((px.x - box.left) / box.width).toBeCloseTo(anchor.x, 10);
      expect((px.y - box.top) / box.height).toBeCloseTo(anchor.y, 10);
    }
    const [big, small] = boxes;
    const bigAnchor = frontPanelAnchorPx(h48, 'QSFP28-1', big!)!;
    const smallAnchor = frontPanelAnchorPx(h48, 'QSFP28-1', small!)!;
    expect((bigAnchor.x - big!.left) / (smallAnchor.x - small!.left)).toBeCloseTo(
      big!.width / small!.width,
      5,
    );
    expect(frontPanelAnchorPx(h48, 'nao-existe', big!)).toBeNull();
  });

  it('redimensionar mantém o anchor na mesma porta (nunca em pixels absolutos)', () => {
    const bbox = h48.ports.find((port) => port.portName === '10GE-48')!.bbox;
    const anchor = normalizedPortAnchor(bbox);
    // duas renderizações: 828px e 1840px de largura
    for (const width of [828, 1840]) {
      const height = width / 7.2456;
      const px = frontPanelAnchorPx(h48, '10GE-48', { left: 0, top: 0, width, height })!;
      expect(px.x / width).toBeCloseTo(anchor.x, 10);
      expect(px.y / height).toBeCloseTo(anchor.y, 10);
      // a porta continua sendo a mesma (mesmo índice no mapa)
      expect(h48.ports.findIndex((port) => port.portName === '10GE-48')).toBe(47);
    }
  });
});
