import { describe, expect, it } from 'vitest';
import {
  MODULAR_CHASSIS_MAPS,
  MODULE_SLOT_INSET,
  chassisAnchorPx,
  chassisAspectRatio,
  chassisRenderMode,
  chassisSlotBoxPx,
  chassisSlotCount,
  chassisSlotMapFor,
  mappedCatalogSlots,
  moduleImageBoxInSlot,
  modulePanelBoxInSlot,
  modulePanelPlacementInSlot,
  modulePortAnchorPx,
  modularChassisMap,
  overlappingChassisSlotPairs,
  slotOrientation,
  validateModularChassisMap,
  VERTICAL_BOARD_MAX_STRETCH,
} from './modular-chassis-map';
import { catalogEntry } from './physical-fixtures';

/**
 * Mapa de slots dos chassis modulares Huawei.
 *
 * O mapa é a verdade de posição dos slots. Ele NUNCA declara porta de serviço:
 * conectores só existem quando há placa instalada (e a placa vem do catálogo).
 */

const M4 = 'huawei-ne8000-m4';

describe('chassi modular NE8000 M4', () => {
  it('declara 4 slots, sem duplicata, dentro de 0..1 e sem overlap', () => {
    const map = modularChassisMap(M4)!;

    expect(map.serviceSlotCount).toBe(4);
    expect(map.slots).toHaveLength(4);
    expect(new Set(map.slots.map((slot) => slot.slotKey)).size).toBe(4);
    expect(new Set(map.slots.map((slot) => slot.ordinal)).size).toBe(4);
    expect(map.slots.map((slot) => slot.ordinal).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(map.slots.map((slot) => slot.slotKey)).toEqual([
      'service-1',
      'service-2',
      'service-3',
      'service-4',
    ]);

    for (const slot of map.slots) {
      const b = slot.bbox;
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.width).toBeGreaterThan(0);
      expect(b.height).toBeGreaterThan(0);
      expect(b.x + b.width).toBeLessThanOrEqual(1);
      expect(b.y + b.height).toBeLessThanOrEqual(1);
    }

    expect(overlappingChassisSlotPairs(map)).toEqual([]);
    expect(validateModularChassisMap(map)).toEqual([]);
  });

  it('o M4 continua LOGICAL: imagem gerada não vira FRONT_EXACT', () => {
    const map = modularChassisMap(M4)!;

    expect(map.mappingMode).toBe('LOGICAL');
    expect(map.imageStatus).toBe('GENERATED');
    expect(map.image).toBe('/physical-panels/huawei/ne8000-m4-front.png');
    expect(chassisRenderMode(map)).toBe('FRONT_APPROX');
    expect(chassisAspectRatio(map)).toBeCloseTo(2172 / 724, 5);
  });

  it('todos os chassis declarados (NE8000 + OLTs) são válidos', () => {
    expect(MODULAR_CHASSIS_MAPS).toHaveLength(15);
    for (const map of MODULAR_CHASSIS_MAPS) {
      expect(validateModularChassisMap(map)).toEqual([]);
      expect(overlappingChassisSlotPairs(map)).toEqual([]);
      expect(map.slots).toHaveLength(chassisSlotCount(map));
    }
  });

  it('M8 DC e M8 AC não compartilham layout nem imagem', () => {
    const dc = modularChassisMap('huawei-ne8000-m8-dc')!;
    const ac = modularChassisMap('huawei-ne8000-m8-ac')!;

    expect(dc.serviceSlotCount).toBe(8);
    expect(ac.serviceSlotCount).toBe(6);
    expect(dc.image).toBeUndefined();
    expect(ac.image).toBeUndefined();
    expect(chassisRenderMode(dc)).toBe('LOGICAL');
    expect(chassisRenderMode(ac)).toBe('LOGICAL');
    expect(dc.slots).not.toEqual(ac.slots);
  });

  it('NE40E fica em LOGICAL (sem imagem frontal aprovada) e mantém a contagem de LPU', () => {
    const expected: Record<string, number> = {
      'huawei-ne40e-x3-dc': 3,
      'huawei-ne40e-x3-ac': 3,
      'huawei-ne40e-x3a': 3,
      'huawei-ne40e-x8': 8,
      'huawei-ne40e-x8a': 8,
      'huawei-ne40e-x16': 16,
      'huawei-ne40e-x16a': 16,
    };

    for (const [catalogKey, slotCount] of Object.entries(expected)) {
      const map = modularChassisMap(catalogKey)!;
      expect(map.serviceSlotCount).toBe(slotCount);
      expect(map.image).toBeUndefined();
      expect(chassisRenderMode(map)).toBe('LOGICAL');
    }
  });

  it('chassi sem mapa cai no renderer atual (PANEL_LAYOUT)', () => {
    expect(chassisRenderMode(modularChassisMap('chassi-sem-mapa'))).toBe('PANEL_LAYOUT');
    expect(chassisRenderMode(modularChassisMap(null))).toBe('PANEL_LAYOUT');
    expect(modularChassisMap('huawei-s6730-h48x6c')).toBeNull();
  });

  it('um mapa FRONT_EXACT só é exato com imagem APROVADA', () => {
    const base = modularChassisMap(M4)!;

    expect(
      chassisRenderMode({ ...base, mappingMode: 'FRONT_EXACT', imageStatus: 'APPROVED' }),
    ).toBe('FRONT_EXACT');
    expect(
      chassisRenderMode({ ...base, mappingMode: 'FRONT_EXACT', imageStatus: 'GENERATED' }),
    ).toBe('FRONT_APPROX');

    const { image: _image, ...semImagem } = base;
    expect(chassisRenderMode(semImagem)).toBe('LOGICAL');
  });
});

describe('geometria dos slots (resize e âncora)', () => {
  const map = modularChassisMap(M4)!;

  it('o slot fica na mesma posição normalizada em qualquer tamanho de painel', () => {
    const boxes = [
      { left: 78, top: 40, width: 828, height: 276 },
      { left: 12, top: 100, width: 414, height: 138 },
    ];

    for (const box of boxes) {
      const slotBox = chassisSlotBoxPx(map, { index: 3 }, box)!;
      const mapped = chassisSlotMapFor(map, { index: 3 })!;

      expect((slotBox.left - box.left) / box.width).toBeCloseTo(mapped.bbox.x, 10);
      expect((slotBox.top - box.top) / box.height).toBeCloseTo(mapped.bbox.y, 10);
      expect(slotBox.width / box.width).toBeCloseTo(mapped.bbox.width, 10);
      expect(slotBox.height / box.height).toBeCloseTo(mapped.bbox.height, 10);

      const anchor = chassisAnchorPx(mapped.bbox, box);
      expect((anchor.x - box.left) / box.width).toBeCloseTo(
        mapped.bbox.x + mapped.bbox.width / 2,
        10,
      );
      expect((anchor.y - box.top) / box.height).toBeCloseTo(
        mapped.bbox.y + mapped.bbox.height / 2,
        10,
      );
    }
  });

  it('casa o slot do catalogo com o slot do mapa pelo ordinal', () => {
    const entry = catalogEntry({
      catalogKey: M4,
      layoutType: 'MODULAR',
      heightU: 2,
      slots: [1, 2, 3, 4].map((index) => ({
        index,
        label: `Slot ${index}`,
        description: '',
        moduleKeys: [],
      })),
    });

    expect(mappedCatalogSlots(entry, map).map((slot) => slot.slotKey)).toEqual([
      'service-1',
      'service-2',
      'service-3',
      'service-4',
    ]);
    expect(chassisSlotMapFor(map, { index: 9 })).toBeNull();
  });

  it('a placa cabe no slot e a âncora da porta é o centro do conector', () => {
    const slotBox = chassisSlotBoxPx(
      map,
      { index: 1 },
      {
        left: 78,
        top: 40,
        width: 828,
        height: 276,
      },
    )!;
    const layout = { width: 8, gridHeight: 3 };
    const moduleBox = modulePanelBoxInSlot(slotBox, layout);

    // nunca sai do slot
    expect(moduleBox.width).toBeLessThanOrEqual(slotBox.width);
    expect(moduleBox.height).toBeLessThanOrEqual(slotBox.height);

    const placed = { x: 2, y: 1, shape: { width: 3.2, height: 2.2 } };
    const anchor = modulePortAnchorPx(moduleBox, placed);

    expect(anchor.x).toBeCloseTo(moduleBox.left + (2 + 1.6) * moduleBox.scale, 10);
    expect(anchor.y).toBeCloseTo(moduleBox.top + (1 + 1.1) * moduleBox.scale, 10);
    // o mesmo cálculo em pixels diferentes continua no centro do conector
    expect((anchor.x - moduleBox.left) / moduleBox.scale).toBeCloseTo(3.6, 10);
  });
});

describe('chassis OLT Huawei (imagem + slots)', () => {
  const OLT_KEYS = [
    'huawei-ma5683t',
    'huawei-ma5800-x2',
    'huawei-ma5800-x7',
    'huawei-ma5800-x15',
    'huawei-ma5800-x17',
  ];
  const COM_SLOTS = [
    'huawei-ma5800-x2',
    'huawei-ma5800-x7',
    'huawei-ma5800-x15',
    'huawei-ma5800-x17',
  ];

  it('as cinco OLTs têm imagem declarada e nunca viram FRONT_EXACT', () => {
    for (const key of OLT_KEYS) {
      const map = modularChassisMap(key)!;
      expect(map.image).toBe(`/physical-panels/huawei/${key}-front.png`);
      expect(map.imageStatus).toBe('GENERATED');
      expect(map.mappingMode).toBe('LOGICAL');
      expect(chassisRenderMode(map)).toBe('FRONT_APPROX');
      expect(validateModularChassisMap(map)).toEqual([]);
      expect(overlappingChassisSlotPairs(map)).toEqual([]);
    }
  });

  it('a quantidade de baías vem da imagem fornecida: X2=3, X7=6, X15=15, X17=14', () => {
    expect(chassisSlotCount(modularChassisMap('huawei-ma5800-x2')!)).toBe(3);
    expect(chassisSlotCount(modularChassisMap('huawei-ma5800-x7')!)).toBe(6);
    expect(chassisSlotCount(modularChassisMap('huawei-ma5800-x15')!)).toBe(15);
    expect(chassisSlotCount(modularChassisMap('huawei-ma5800-x17')!)).toBe(14);
  });

  it('os ordinais são contíguos e sem repetição', () => {
    for (const key of COM_SLOTS) {
      const map = modularChassisMap(key)!;
      const ordinals = map.slots.map((slot) => slot.ordinal);
      expect(new Set(ordinals).size).toBe(map.slots.length);
      expect(Math.max(...ordinals)).toBeLessThan(map.slots.length + 1);
      for (const slot of map.slots) {
        expect(slot.bbox.x + slot.bbox.width).toBeLessThanOrEqual(1);
        expect(slot.bbox.y + slot.bbox.height).toBeLessThanOrEqual(1);
      }
    }
    // o MA5800-X2 tem energia no slot 0: as baías visuais começam no slot 1
    expect(modularChassisMap('huawei-ma5800-x2')!.slots.map((slot) => slot.ordinal)).toEqual([
      1, 2, 3,
    ]);
    // X7/X15/X17 têm slot universal 0 declarado no catálogo
    expect(modularChassisMap('huawei-ma5800-x7')!.slots.map((slot) => slot.ordinal)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
  });

  it('MA5683T não inventa slot: imagem visual com zero posições declaradas', () => {
    const map = modularChassisMap('huawei-ma5683t')!;

    expect(map.slots).toEqual([]);
    expect(map.serviceSlotCount).toBe(0);
    expect(chassisSlotCount(map)).toBe(0);
    expect(chassisRenderMode(map)).toBe('FRONT_APPROX');
  });

  it('só casa com slots que existem no catálogo (POWER fica de fora)', () => {
    const map = modularChassisMap('huawei-ma5800-x2')!;
    const entry = catalogEntry({
      catalogKey: 'huawei-ma5800-x2',
      layoutType: 'MODULAR',
      heightU: 2,
      slots: [
        { index: 0, label: 'power 0', description: '', moduleKeys: [] },
        { index: 1, label: 'service 1', description: '', moduleKeys: [] },
        { index: 2, label: 'service 2', description: '', moduleKeys: [] },
        { index: 3, label: 'control 3', description: '', moduleKeys: [] },
        { index: 4, label: 'control 4', description: '', moduleKeys: [] },
      ],
    });

    // as 3 baías visuais cobrem serviço e controle, nunca a energia
    expect(mappedCatalogSlots(entry, map).map((slot) => slot.ordinal)).toEqual([1, 2, 3]);
    expect(mappedCatalogSlots(entry, map).map((slot) => slot.role)).toEqual([
      'SERVICE_OR_UPLINK',
      'SERVICE_OR_UPLINK',
      'CONTROL',
    ]);
  });

  it('a imagem da placa cabe no slot preservando a proporção natural', () => {
    const slotBox = { left: 40, top: 20, width: 120, height: 640 };
    const aspect = 1438 / 255;
    const { box, offset } = moduleImageBoxInSlot(slotBox, aspect);

    expect(box.width / box.height).toBeCloseTo(aspect, 6);
    // nunca sai do slot (respeitando o respiro interno)
    expect(offset.left + box.width).toBeLessThanOrEqual(
      slotBox.width - MODULE_SLOT_INSET.right + 0.001,
    );
    expect(offset.top + box.height).toBeLessThanOrEqual(
      slotBox.height - MODULE_SLOT_INSET.bottom + 0.001,
    );
    expect(offset.left).toBeGreaterThanOrEqual(MODULE_SLOT_INSET.left);
    expect(offset.top).toBeGreaterThanOrEqual(MODULE_SLOT_INSET.top);
    // a caixa absoluta é a mesma do offset, deslocada pelo slot
    expect(box.left).toBeCloseTo(slotBox.left + offset.left, 6);
    expect(box.top).toBeCloseTo(slotBox.top + offset.top, 6);
  });
});

/**
 * Orientação do slot e rotação da placa: a orientação vem do bbox do mapa e a
 * mesma matemática vale para o desenho e para a âncora do cabo.
 */
describe('orientação do slot e colocação da placa', () => {
  it('deriva horizontal/vertical do bbox declarado no mapa', () => {
    expect(slotOrientation({ x: 0, y: 0, width: 0.3, height: 0.1 })).toBe('HORIZONTAL');
    expect(slotOrientation({ x: 0, y: 0, width: 0.1, height: 0.3 })).toBe('VERTICAL');
    expect(slotOrientation({ x: 0, y: 0, width: 0.2, height: 0.2 })).toBe('HORIZONTAL');
  });

  it('X2/X7 e M4 declaram slots horizontais; X15/X17 e M8 verticais', () => {
    const orientationOf = (key: string) =>
      [...new Set(modularChassisMap(key)!.slots.map((slot) => slotOrientation(slot.bbox)))];

    expect(orientationOf('huawei-ma5800-x2')).toEqual(['HORIZONTAL']);
    expect(orientationOf('huawei-ma5800-x7')).toEqual(['HORIZONTAL']);
    expect(orientationOf('huawei-ne8000-m4')).toEqual(['HORIZONTAL']);
    expect(orientationOf('huawei-ma5800-x15')).toEqual(['VERTICAL']);
    expect(orientationOf('huawei-ma5800-x17')).toEqual(['VERTICAL']);
    expect(orientationOf('huawei-ne8000-m8-dc')).toEqual(['VERTICAL']);
    expect(orientationOf('huawei-ne8000-m8-ac')).toEqual(['VERTICAL']);
  });

  it('nenhum slot de chassi da bancada se sobrepõe', () => {
    for (const key of [
      'huawei-ma5800-x2',
      'huawei-ma5800-x7',
      'huawei-ma5800-x15',
      'huawei-ma5800-x17',
      'huawei-ne8000-m4',
      'huawei-ne8000-m8-dc',
      'huawei-ne8000-m8-ac',
    ]) {
      expect(overlappingChassisSlotPairs(modularChassisMap(key)!)).toEqual([]);
    }
  });

  it('placa horizontal fica no respiro do slot, sem rotação', () => {
    const slotBox = { left: 0, top: 0, width: 400, height: 100 };
    const layout = { width: 100, gridHeight: 20 };
    const placement = modulePanelPlacementInSlot(slotBox, layout, 'HORIZONTAL');

    expect(placement.rotation).toBe(0);
    expect(placement.left).toBe(MODULE_SLOT_INSET.left);
    expect(placement.top).toBe(MODULE_SLOT_INSET.top);
    expect(placement.width).toBeCloseTo(layout.width * placement.scale, 6);
    expect(placement.offset).toEqual({
      left: MODULE_SLOT_INSET.left,
      top: MODULE_SLOT_INSET.top,
    });
  });

  it('placa vertical gira 90° e fica centrada na área interna do slot', () => {
    const slotBox = { left: 0, top: 0, width: 100, height: 400 };
    const layout = { width: 100, gridHeight: 20 };
    const placement = modulePanelPlacementInSlot(slotBox, layout, 'VERTICAL');

    expect(placement.rotation).toBe(90);
    // eixo longo cabe na altura do slot; eixo curto preenche a largura (limitado)
    expect(placement.scale).toBeCloseTo(386 / 100, 10);
    expect(placement.width).toBeCloseTo(layout.gridHeight * (placement.scaleY ?? placement.scale), 6);
    expect(placement.height).toBeCloseTo(layout.width * placement.scale, 6);
    // centrada na área interna (respiro do slot)
    const innerCenterX = MODULE_SLOT_INSET.left + (slotBox.width - MODULE_SLOT_INSET.left - MODULE_SLOT_INSET.right) / 2;
    const innerCenterY = MODULE_SLOT_INSET.top + (slotBox.height - MODULE_SLOT_INSET.top - MODULE_SLOT_INSET.bottom) / 2;
    expect(placement.left + placement.width / 2).toBeCloseTo(innerCenterX, 6);
    expect(placement.top + placement.height / 2).toBeCloseTo(innerCenterY, 6);
    // nunca sai do slot
    expect(placement.left).toBeGreaterThanOrEqual(0);
    expect(placement.top).toBeGreaterThanOrEqual(0);
    expect(placement.left + placement.width).toBeLessThanOrEqual(slotBox.width + 0.001);
    expect(placement.top + placement.height).toBeLessThanOrEqual(slotBox.height + 0.001);
  });

  it('com a placa girada, a âncora continua sendo o centro do conector desenhado', () => {
    const slotBox = { left: 0, top: 0, width: 100, height: 400 };
    const layout = { width: 100, gridHeight: 20 };
    const placement = modulePanelPlacementInSlot(slotBox, layout, 'VERTICAL');
    const originLeft = placement.left + placement.width;
    const originTop = placement.top;
    const placed = { x: 10, y: 4, shape: { width: 4, height: 3 } };

    const anchor = modulePortAnchorPx(placement, placed);
    // mesma transformação do CSS: (u, v) → (origemX - v, origemY + u)
    const u = (placed.x + placed.shape.width / 2) * placement.scale;
    const v = (placed.y + placed.shape.height / 2) * (placement.scaleY ?? placement.scale);
    expect(anchor.x).toBeCloseTo(originLeft - v, 6);
    expect(anchor.y).toBeCloseTo(originTop + u, 6);
    // e o ponto está dentro da caixa visual da placa
    expect(anchor.x).toBeGreaterThanOrEqual(placement.left);
    expect(anchor.x).toBeLessThanOrEqual(placement.left + placement.width);
    expect(anchor.y).toBeGreaterThanOrEqual(placement.top);
    expect(anchor.y).toBeLessThanOrEqual(placement.top + placement.height);
  });

  it('o eixo curto da placa vertical estica só até o limite (portas legíveis)', () => {
    const slotBox = { left: 0, top: 0, width: 100, height: 400 };
    // placa muito alongada (proporção ~30:1): sem limite, a porta ficaria com ~3px
    const layout = { width: 300, gridHeight: 10 };
    const placement = modulePanelPlacementInSlot(slotBox, layout, 'VERTICAL');

    expect(placement.rotation).toBe(90);
    expect(placement.scale).toBeCloseTo(386 / 300, 10);
    // eixo curto limitado a 2.5× a proporção natural — nunca maior que o slot
    const naturalShort = layout.gridHeight * placement.scale;
    expect(placement.width).toBeLessThanOrEqual(naturalShort * VERTICAL_BOARD_MAX_STRETCH + 0.001);
    expect(placement.width).toBeLessThanOrEqual(94 + 0.001);
    expect(placement.scaleY!).toBeGreaterThan(placement.scale);
  });

  it('sem rotação o anchor é o mesmo cálculo de antes (compatibilidade)', () => {
    const moduleBox = modulePanelBoxInSlot(
      { left: 0, top: 0, width: 400, height: 100 },
      { width: 100, gridHeight: 20 },
    );
    const placed = { x: 10, y: 4, shape: { width: 4, height: 3 } };
    const anchor = modulePortAnchorPx(moduleBox, placed);

    expect(anchor.x).toBeCloseTo(moduleBox.left + 12 * moduleBox.scale, 10);
    expect(anchor.y).toBeCloseTo(moduleBox.top + 5.5 * moduleBox.scale, 10);
  });
});
