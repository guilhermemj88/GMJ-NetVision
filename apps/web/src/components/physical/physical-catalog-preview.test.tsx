import { renderToStaticMarkup } from 'react-dom/server';
import type { PhysicalCatalogEntry, PhysicalCatalogPort } from '@gmj/shared';
import { describe, expect, it } from 'vitest';
import { PhysicalPanelPreviewCard } from './physical-catalog-preview';
import { PhysicalModuleMapCard } from './physical-module-map-card';
import { MODULE_FRONT_PANEL_MAPS } from './module-front-panel-map';
import { catalogEntry } from './physical-fixtures';

function catalogPorts(
  count: number,
  prefix = 'SFP-',
  connector: PhysicalCatalogPort['connector'] = 'SFP',
  /** Primeiro número físico do grupo (o painel do F1A começa em `0`). */
  start = 1,
): PhysicalCatalogPort[] {
  return Array.from({ length: count }, (_value, index) => ({
    name: `${prefix}${start + index}`,
    label: `${prefix}${start + index}`,
    order: index + 1,
    side: 'DEVICE' as const,
    type: 'SFP' as const,
    connector,
    panelNumber: start + index,
  }));
}

/** S6730 com a mesma identidade de portas do catálogo real. */
function s6730(catalogKey: string, count10ge: number, model: string): PhysicalCatalogEntry {
  return catalogEntry({
    catalogKey,
    name: `Huawei ${model}`,
    manufacturer: 'Huawei',
    family: 'S6730',
    model,
    heightU: 1,
    layoutType: 'FIXED',
    panelLayout: { type: 'LOGICAL', width: 100, height: 10 },
    ports: [
      ...catalogPorts(count10ge, '10GE-', 'SFP_PLUS').map((port, index) => ({
        ...port,
        order: index + 1,
        type: 'SFP_PLUS' as const,
        visual: { row: 1, columns: 24, x: 3, y: 0.6 },
      })),
      ...catalogPorts(6, 'QSFP28-', 'QSFP28').map((port, index) => ({
        ...port,
        order: count10ge + index + 1,
        type: 'QSFP' as const,
        visual: { row: 3, columns: 6, x: 38, y: 6.4 },
      })),
    ],
  });
}

const f1a: PhysicalCatalogEntry = catalogEntry({
  catalogKey: 'huawei-ne8000-f1a-8h20q',
  name: 'Huawei F1A-8H20Q',
  manufacturer: 'Huawei',
  family: 'NetEngine 8000',
  model: 'F1A-8H20Q',
  heightU: 1,
  layoutType: 'FIXED',
  panelLayout: { type: 'FRONT', width: 118, height: 7 },
  ports: [
    // painel físico 0-55: 28 SFP+ (0-27), 8+12 SFP28 (28-47), 8 QSFP28 (48-55)
    ...catalogPorts(28, '10GE-', 'SFP_PLUS', 0).map((port, index) => ({
      ...port,
      order: index + 1,
      visual: { row: 1, x: 2, y: 0.6, gapX: 0.6, pairing: 'EVEN_ODD' as const },
    })),
    ...catalogPorts(8, '25GE-', 'SFP28', 28).map((port, index) => ({
      ...port,
      order: 29 + index,
      visual: { row: 1, x: 55.4, y: 0.6, gapX: 0.6, pairing: 'EVEN_ODD' as const },
    })),
    ...catalogPorts(12, '25GE-', 'SFP28', 36).map((port, index) => ({
      ...port,
      order: 37 + index,
      visual: { row: 1, x: 70.8, y: 0.6, gapX: 0.6, pairing: 'EVEN_ODD' as const },
    })),
    ...catalogPorts(8, '100GE-', 'QSFP28', 48).map((port, index) => ({
      ...port,
      order: 49 + index,
      visual: { row: 1, x: 93.8, y: 0.6, gapX: 0.6, pairing: 'EVEN_ODD' as const },
    })),
  ],
});

describe('PhysicalPanelPreviewCard (fallback geométrico)', () => {
  it('marca LAYOUT NÃO CONFIRMADO quando o template não declara geometria', () => {
    const plain = catalogEntry({
      catalogKey: 'generico-sem-layout',
      manufacturer: 'Generic',
      model: 'Sem layout',
      layoutType: 'FIXED',
      ports: catalogPorts(6),
    });
    const html = renderToStaticMarkup(<PhysicalPanelPreviewCard entry={plain} />);
    expect(html).toContain('data-layout-mode="LOGICAL"');
    expect(html).toContain('LAYOUT NÃO CONFIRMADO');
    expect(html).toContain('6/6');
  });

  it('desenha os slots de um chassi modular sem mapa de chassi', () => {
    const modular = catalogEntry({
      catalogKey: 'modular-sem-mapa-de-chassi',
      manufacturer: 'Huawei',
      model: 'M4',
      heightU: 2,
      layoutType: 'MODULAR',
      slots: [
        { index: 1, label: 'line-card 1', description: '', moduleKeys: [], visual: { x: 8, y: 1 } },
        {
          index: 2,
          label: 'line-card 2',
          description: '',
          moduleKeys: [],
          visual: { x: 30, y: 1 },
        },
      ],
    });
    const html = renderToStaticMarkup(<PhysicalPanelPreviewCard entry={modular} />);
    expect(html).toContain('data-layout-mode="SLOT_VENDOR"');
    expect(html.match(/class="physical-slot/g)).toHaveLength(2);
    // chassi sem portas declaradas: nada inventado
    expect(html).not.toContain('data-port-id=');
    // sem mapa de chassi, nenhum painel modular é desenhado
    expect(html).not.toContain('class="physical-modular-panel');
  });
});

describe('PhysicalPanelPreviewCard (F1A migrado para painel por imagem)', () => {
  it('renderiza os 56 hotspots pela imagem, sem cair no renderer geométrico', () => {
    const html = renderToStaticMarkup(<PhysicalPanelPreviewCard entry={f1a} />);

    expect(html).toContain('data-catalog-key="huawei-ne8000-f1a-8h20q"');
    expect(html).toContain('data-layout-mode="IMAGE"');
    expect(html).toContain('IMAGE PANEL');
    expect(html).toContain('56/56');
    expect(html).toContain('>1U<');
    expect(html.match(/class="physical-image-panel__hitbox/g)).toHaveLength(56);
    expect(html.match(/data-port-id="/g)).toHaveLength(56);
    expect(html).toContain('ne8000-f1a-8h20q-front.png');
    // a imagem é um esquema gerado: a tela precisa dizer isso
    expect(html).toContain('imagem gerada pelo NetVision');
    expect(html).not.toContain('LAYOUT APROXIMADO');
  });
});

describe('PhysicalPanelPreviewCard (OLT MA5800 com imagem)', () => {
  /** MA5800-X2 como está no catálogo: 1 energia, 2 serviço e 2 controle. */
  function x2(debugHitboxes = false) {
    const entry = catalogEntry({
      catalogKey: 'huawei-ma5800-x2',
      name: 'Huawei MA5800-X2',
      manufacturer: 'Huawei',
      family: 'MA5800',
      model: 'MA5800-X2',
      heightU: 2,
      layoutType: 'MODULAR',
      slots: [0, 1, 2, 3, 4].map((index) => ({
        index,
        label: `slot ${index}`,
        description: '',
        moduleKeys: [],
      })),
    });
    return renderToStaticMarkup(
      <PhysicalPanelPreviewCard entry={entry} debugHitboxes={debugHitboxes} />,
    );
  }

  it('mostra a imagem do chassi, 3 baías mapeadas e a diferença para o catálogo', () => {
    const html = x2();

    expect(html).toContain('data-layout-mode="MODULAR_IMAGE"');
    expect(html).toContain('huawei-ma5800-x2-front.png');
    expect(html).toContain('Service slots');
    expect(html).toContain('3/3');
    expect(html).toContain('5 slots · 3 com região visual');
    expect(html).toContain('imagem gerada (não é a oficial)');
    expect(html.match(/data-slot-key=/g)).toHaveLength(3);
    // chassi não declara conector: nenhuma porta é inventada
    expect(html).not.toContain('physical-image-panel__hitbox');
  });

  it('o toggle de inspeção desenha os ordinais das baías mapeadas', () => {
    const html = x2(true);
    expect(html.match(/class="physical-modular-panel__ordinal"/g)).toHaveLength(3);
  });

  it('MA5683T aparece por imagem sem inventar slot nenhum', () => {
    const entry = catalogEntry({
      catalogKey: 'huawei-ma5683t',
      name: 'Huawei MA5683T',
      manufacturer: 'Huawei',
      family: 'SmartAX',
      model: 'MA5683T',
      heightU: 1,
      layoutType: 'MODULAR',
      slots: [],
    });
    const html = renderToStaticMarkup(<PhysicalPanelPreviewCard entry={entry} />);

    expect(html).toContain('data-layout-mode="MODULAR_IMAGE"');
    expect(html).toContain('huawei-ma5683t-front.png');
    expect(html).toContain('0/0');
    expect(html).not.toContain('data-slot-key=');
  });
});

describe('PhysicalModuleMapCard (placas com painel por imagem)', () => {
  it('desenha os hotspots declarados da placa e não promete compatibilidade', () => {
    const map = MODULE_FRONT_PANEL_MAPS.find((item) => item.moduleKey === 'huawei-gpfd-16')!;
    const html = renderToStaticMarkup(<PhysicalModuleMapCard map={map} debugHitboxes={false} />);

    expect(html).toContain('data-module-card="huawei-gpfd-16"');
    expect(html.match(/data-port-name=/g)).toHaveLength(16);
    expect(html).toContain('data-port-name="GPON-1"');
    // sem template de módulo no catálogo, todo hotspot fica não resolvido
    expect(html.match(/is-unresolved/g)).toHaveLength(16);
    expect(html).toContain('sem template de módulo no catálogo');
    expect(html).toContain('16/16');
    expect(html).toContain('Encaixe no slot (demonstração)');
    expect(html).not.toContain('data-demo-slot="1"');
  });

  it('a fonte aparece sem porta de dados e com a imagem declarada', () => {
    const map = MODULE_FRONT_PANEL_MAPS.find((item) => item.moduleKey === 'huawei-pac600s12-cb')!;
    const html = renderToStaticMarkup(<PhysicalModuleMapCard map={map} debugHitboxes={false} />);

    expect(html).toContain('huawei-pac600s12-cb-front.png');
    expect(html).toContain('0/0');
    expect(html).not.toContain('data-port-name=');
  });
});

describe('PhysicalPanelPreviewCard (chassi modular com imagem)', () => {
  /** M4 como está no catálogo: 4 slots de serviço, nenhuma placa cadastrada. */
  function m4(debugHitboxes = false) {
    const entry = catalogEntry({
      catalogKey: 'huawei-ne8000-m4',
      name: 'Huawei NetEngine 8000 M4',
      manufacturer: 'Huawei',
      family: 'NetEngine 8000',
      model: 'M4',
      heightU: 2,
      layoutType: 'MODULAR',
      ports: [],
      slots: [1, 2, 3, 4].map((index) => ({
        index,
        label: `Slot ${index}`,
        description: '',
        moduleKeys: [],
      })),
    });
    return renderToStaticMarkup(
      <PhysicalPanelPreviewCard entry={entry} debugHitboxes={debugHitboxes} />,
    );
  }

  it('M4: MODULAR IMAGE PANEL com 2U, 4 service slots e 4/4 slots', () => {
    const html = m4();

    expect(html).toContain('data-layout-mode="MODULAR_IMAGE"');
    expect(html).toContain('data-chassis-panel="huawei-ne8000-m4"');
    expect(html).toContain('>IMAGE PANEL<');
    expect(html).toContain('2U');
    expect(html).toContain('Service slots');
    expect(html).toContain('4/4');
    expect(html).toContain('/physical-panels/huawei/ne8000-m4-front.png');
    expect(html.match(/physical-modular-panel__slot/g)).toHaveLength(4);
    expect(html).toContain('4 slots');
    // chassi não inventa porta de serviço
    expect(html).not.toContain('data-port-id=');
    // sem inspeção, a imagem fica limpa (sem bbox/ordinal)
    expect(html).not.toContain('physical-modular-panel__ordinal');
    expect(html).not.toContain('is-slots-visible');
  });

  it('M4 com "mostrar slots" desenha bbox e ordinal dos 4 slots', () => {
    const html = m4(true);

    expect(html).toContain('is-slots-visible');
    expect(html.match(/physical-modular-panel__ordinal/g)).toHaveLength(4);
    expect(html).toContain('data-slot-ordinal="1"');
    expect(html).toContain('data-slot-ordinal="4"');
    expect(html).toContain('data-slot-state="EMPTY"');
  });

  it('chassi do pacote sem imagem continua no renderer geométrico', () => {
    const m8 = catalogEntry({
      catalogKey: 'huawei-ne8000-m8-ac',
      manufacturer: 'Huawei',
      family: 'NetEngine 8000',
      model: 'M8 AC',
      heightU: 3,
      layoutType: 'MODULAR',
      ports: [],
      slots: [1, 2, 3, 4, 5, 6].map((index) => ({
        index,
        label: `Slot ${index}`,
        description: '',
        moduleKeys: [],
      })),
    });
    const html = renderToStaticMarkup(<PhysicalPanelPreviewCard entry={m8} />);

    // mapa existe, mas sem imagem frontal: continua no renderer geométrico
    expect(html).not.toContain('class="physical-modular-panel');
    expect(html).toContain('data-layout-mode="SLOT_APPROX"');
    expect(html.match(/class="physical-slot/g)).toHaveLength(6);
  });
});

describe('PhysicalPanelPreviewCard (painel por imagem)', () => {
  it('S6730-H48X6C: IMAGE PANEL com 54 hotspots, 54/54 resolvidos e overlap 0', () => {
    const html = renderToStaticMarkup(
      <PhysicalPanelPreviewCard entry={s6730('huawei-s6730-h48x6c', 48, 'S6730-H48X6C')} />,
    );
    expect(html).toContain('data-layout-mode="IMAGE"');
    expect(html).toContain('data-image-panel="huawei-s6730-h48x6c"');
    expect(html).toContain('>IMAGE PANEL<');
    expect(html.match(/physical-image-panel__hitbox/g)).toHaveLength(54);
    expect(html).toContain('54/54');
    expect(html).toContain('54 hotspots');
    expect(html).toContain('/physical-panels/huawei/s6730-h48x6c-front.png');
    // nenhum aviso de layout: a imagem é o painel real
    expect(html).not.toContain('LAYOUT APROXIMADO');
    expect(html).not.toContain('LAYOUT NÃO CONFIRMADO');
    // o mapa cobre 10GE-1..48 e QSFP28-1..6
    expect(html).toContain('data-port-name="10GE-48"');
    expect(html).toContain('data-port-name="QSFP28-6"');
    // sem debug, os anchors não são renderizados
    expect(html).not.toContain('physical-image-panel__anchor');
  });

  it('S6730-H24X6C: IMAGE PANEL com 30 hotspots', () => {
    const html = renderToStaticMarkup(
      <PhysicalPanelPreviewCard entry={s6730('huawei-s6730-h24x6c', 24, 'S6730-H24X6C')} />,
    );
    expect(html).toContain('data-layout-mode="IMAGE"');
    expect(html.match(/physical-image-panel__hitbox/g)).toHaveLength(30);
    expect(html).toContain('30/30');
    expect(html).toContain('30 hotspots');
    expect(html).toContain('/physical-panels/huawei/s6730-h24x6c-front.png');
    expect(html).not.toContain('data-port-name="10GE-25"');
  });

  it('debug desenha hitboxes e âncoras por cima da imagem', () => {
    const html = renderToStaticMarkup(
      <PhysicalPanelPreviewCard
        entry={s6730('huawei-s6730-h48x6c', 48, 'S6730-H48X6C')}
        debugHitboxes
      />,
    );
    expect(html).toContain('is-debug');
    expect(html.match(/physical-image-panel__anchor/g)).toHaveLength(54);
    // rótulos só nas portas largas (as 48 SFP+ são densas demais para caber texto)
    expect(html.match(/physical-image-panel__tag/g)).toHaveLength(6);
  });

  it('os V2 permanecem AWAITING_APPROVED_IMAGE e usam o renderer geométrico', () => {
    const v2 = s6730('huawei-s6730-h48x6c-v2', 48, 'S6730-H48X6C-V2');
    const html = renderToStaticMarkup(<PhysicalPanelPreviewCard entry={v2} />);
    expect(html).toContain('data-layout-mode="FRONT_APPROX"');
    expect(html).toContain('AWAITING APPROVED IMAGE');
    expect(html).not.toContain('physical-image-panel__hitbox');
    expect(html.match(/data-port-id="/g)).toHaveLength(54);
  });
});
