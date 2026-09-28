import { renderToStaticMarkup } from 'react-dom/server';
import type {
  PhysicalCatalogEntry,
  PhysicalCatalogPort,
  PhysicalConnectorKind,
  PhysicalPath,
} from '@gmj/shared';
import { describe, expect, it } from 'vitest';
import { PhysicalRackCanvas } from './physical-rack-canvas';
import type { PhysicalLldpGhost } from './physical-lldp';
import type { PhysicalSelection } from './physical-types';
import {
  catalogEntry,
  physicalAsset,
  physicalConnection,
  physicalModule,
  physicalPort,
  physicalRack,
  physicalSlot,
} from './physical-fixtures';

const rack = physicalRack({
  assets: [
    physicalAsset({
      id: 'asset-a',
      name: 'SW-01',
      startU: 10,
      heightU: 1,
      ports: [
        physicalPort({
          id: 'port-a',
          assetId: 'asset-a',
          name: 'GE1',
          connectionId: 'connection-1',
          state: 'CONNECTED',
        }),
      ],
    }),
    physicalAsset({
      id: 'asset-b',
      name: 'EDD-01',
      kind: 'GENERIC',
      startU: 2,
      heightU: 2,
      ports: [
        physicalPort({
          id: 'port-b',
          assetId: 'asset-b',
          name: 'LAN1',
          type: 'RJ45',
          connectionId: 'connection-1',
          state: 'CONNECTED',
        }),
      ],
    }),
  ],
});

const connection = physicalConnection({});

const noop = () => undefined;

/**
 * Painel F1A-8H20Q declarado no catálogo: 28 SFP+ (0-27), 8+12 SFP28 (28-47) e
 * 8 QSFP28 (48-55) em uma faixa contínua de 28 colunas × 2 fileiras.
 */
function f1aCatalogPorts(): PhysicalCatalogPort[] {
  const groups: Array<[string, number, number, PhysicalConnectorKind, string, string]> = [
    // groupKey, primeiro número físico, quantidade, conector, prefixo, tipo
    ['sfpplus-10g', 0, 28, 'SFP_PLUS', '10GE-', 'SFP_PLUS'],
    ['sfp28-25g-a', 28, 8, 'SFP28', '25GE-', 'SFP'],
    ['sfp28-25g-b', 36, 12, 'SFP28', '25GE-', 'SFP'],
    ['qsfp28-100g', 48, 8, 'QSFP28', '100GE-', 'QSFP'],
  ];
  const ports: PhysicalCatalogPort[] = [];
  let order = 0;
  for (const [groupKey, start, count, connector, prefix, type] of groups) {
    for (let index = 0; index < count; index += 1) {
      order += 1;
      ports.push({
        name: `${prefix}${start + index}`,
        label: `${prefix}${start + index}`,
        order,
        side: 'DEVICE',
        type: type as PhysicalCatalogPort['type'],
        connector,
        portFunction: groupKey === 'qsfp28-100g' ? 'UPLINK' : 'SERVICE',
        groupKey,
        panelNumber: start + index,
      });
    }
  }
  return ports;
}

function templateRef(catalogKey: string, model: string) {
  return {
    id: `template-${catalogKey}`,
    catalogKey,
    name: model,
    category: 'SWITCH' as const,
    manufacturer: 'Huawei',
    family: '',
    model,
    kind: 'NETWORK' as const,
    heightU: 1,
    description: '',
    vendorVerified: true,
    structureConfirmed: true,
    referenceUrl: null,
    origin: 'SYSTEM' as const,
    ports: [],
    slots: [],
    modules: [],
    createdAt: '2026-09-21T12:00:00.000Z',
    updatedAt: '2026-09-21T12:00:00.000Z',
  };
}

describe('PhysicalRackCanvas', () => {
  it('renders rack units and equipment with the physical identity', () => {
    const html = renderToStaticMarkup(
      <PhysicalRackCanvas
        rack={rack}
        connections={[connection]}
        mode="hidden"
        selection={null}
        path={null}
        onSelectAsset={noop}
        onSelectPort={noop}
        onSelectConnection={noop}
        onClear={noop}
      />,
    );
    expect(html.match(/physical-u-row/g)).toHaveLength(12);
    expect(html).toContain('SW-01');
    expect(html).toContain('EDD-01');
    // identidade: U física ocupada nunca vira "altura visual"
    expect(html).toContain('U10 · 1U');
    expect(html).toContain('U2–U3 · 2U');
    expect(html).toContain('state-connected');
    expect(html).not.toContain('physical-cable physical-cable--fiber');
  });

  it('renders only the selected physical path in selected mode', () => {
    const path: PhysicalPath = {
      originPortId: 'port-a',
      endpointPortId: 'port-b',
      loopDetected: false,
      steps: [
        {
          kind: 'PORT',
          portId: 'port-a',
          portName: 'GE1',
          side: 'DEVICE',
          assetId: 'asset-a',
          assetName: 'SW-01',
          rackName: 'Rack 01',
          siteName: 'POP Centro',
        },
        { kind: 'CABLE', connectionId: 'connection-1', medium: 'FIBER', label: 'CIR-01' },
        {
          kind: 'PORT',
          portId: 'port-b',
          portName: 'LAN1',
          side: 'DEVICE',
          assetId: 'asset-b',
          assetName: 'EDD-01',
          rackName: 'Rack 01',
          siteName: 'POP Centro',
        },
      ],
    };
    const html = renderToStaticMarkup(
      <PhysicalRackCanvas
        rack={rack}
        connections={[connection]}
        mode="selected"
        selection={{ kind: 'port', id: 'port-a' }}
        path={path}
        onSelectAsset={noop}
        onSelectPort={noop}
        onSelectConnection={noop}
        onClear={noop}
      />,
    );
    expect(html).toContain('physical-cable physical-cable--fiber is-selected');
    expect(html).toContain('data-port-id="port-a"');
    expect(html).toContain('class="physical-port physical-port--sfp state-connected is-selected"');
    // identidade apresentada é a porta/interface; o conector é característica
    expect(html).toContain('aria-label="Porta GE1 (conector SFP)"');
  });

  it('desenha os 56 hotspots do painel F1A por imagem (nunca "+32")', () => {
    const entry: PhysicalCatalogEntry = catalogEntry({
      catalogKey: 'huawei-ne8000-f1a-8h20q',
      panelLayout: { type: 'LOGICAL', width: 100, height: 14 },
      ports: f1aCatalogPorts(),
    });
    const asset = physicalAsset({
      id: 'asset-f1a',
      name: 'BHE-VTA-F1A-BGP',
      startU: 42,
      heightU: 1,
      templateId: 'template-huawei-ne8000-f1a-8h20q',
      template: templateRef('huawei-ne8000-f1a-8h20q', 'F1A-8H20Q'),
      ports: f1aCatalogPorts().map((port, index) =>
        physicalPort({
          id: `f1a-${index + 1}`,
          assetId: 'asset-f1a',
          name: port.name,
          label: port.label,
          order: port.order,
          type: port.type,
        }),
      ),
    });
    const html = renderToStaticMarkup(
      <PhysicalRackCanvas
        rack={physicalRack({ units: 42, assets: [asset] })}
        connections={[]}
        mode="hidden"
        selection={null}
        path={null}
        catalog={[entry]}
        onSelectAsset={noop}
        onSelectPort={noop}
        onSelectConnection={noop}
        onClear={noop}
      />,
    );
    expect(html.match(/data-port-id="/g)).toHaveLength(56);
    expect(html).not.toContain('+32');
    // migrado para painel por imagem: a imagem manda no desenho e nos hotspots
    expect(html).toContain('ne8000-f1a-8h20q-front.png');
    expect(html).toContain('data-image-panel="huawei-ne8000-f1a-8h20q"');
    expect(html.match(/class="physical-image-panel__hitbox/g)).toHaveLength(56);
    // proporção vem do bbox do mapa (QSFP28 ocupa mais área que SFP+)
    const buttonOf = (id: string) =>
      new RegExp(`<button[^>]*data-port-id="${id}"[^>]*>`).exec(html)?.[0] ?? '';
    const widthPct = (id: string) => Number(/width:\s*([\d.]+)%/.exec(buttonOf(id))?.[1] ?? 0);
    // `f1a-49` é o 100GE-48 (QSFP28); `f1a-2` é o 10GE-1 (SFP+)
    expect(widthPct('f1a-49')).toBeGreaterThan(widthPct('f1a-2'));
    expect(html).toContain('data-connector="QSFP28"');
  });

  it('ancora o cabo no centro do conector desenhado', () => {
    const entry = catalogEntry({
      catalogKey: 'mikrotik-crs328-24p-4splus-rm',
      ports: [
        {
          name: 'ether1',
          label: 'ether1',
          order: 1,
          side: 'DEVICE',
          type: 'RJ45',
          connector: 'RJ45',
          portFunction: 'SERVICE',
          groupKey: 'ether',
        },
      ],
    });
    const assetA = physicalAsset({
      id: 'asset-a',
      name: 'SW-01',
      startU: 10,
      heightU: 1,
      templateId: 'template-mikrotik-crs328-24p-4splus-rm',
      template: templateRef('mikrotik-crs328-24p-4splus-rm', 'CRS328-24P-4S+RM'),
      ports: [
        physicalPort({
          id: 'port-a',
          assetId: 'asset-a',
          name: 'ether1',
          label: 'ether1',
          type: 'RJ45',
          connectionId: 'connection-1',
          state: 'CONNECTED',
        }),
      ],
    });
    const assetB = physicalAsset({
      id: 'asset-b',
      name: 'EDD-01',
      kind: 'GENERIC',
      startU: 2,
      heightU: 1,
      ports: [
        physicalPort({
          id: 'port-b',
          assetId: 'asset-b',
          name: 'LAN1',
          type: 'RJ45',
          connectionId: 'connection-1',
          state: 'CONNECTED',
        }),
      ],
    });
    const html = renderToStaticMarkup(
      <PhysicalRackCanvas
        rack={physicalRack({ units: 12, assets: [assetA, assetB] })}
        connections={[connection]}
        mode="all"
        selection={null}
        path={null}
        catalog={[entry]}
        onSelectAsset={noop}
        onSelectPort={noop}
        onSelectConnection={noop}
        onClear={noop}
      />,
    );
    const button = /<button[^>]*data-port-id="port-a"[^>]*>/.exec(html)?.[0] ?? '';
    const style = /style="([^"]+)"/.exec(button)?.[1] ?? '';
    // React omite a unidade quando o valor é 0 (`top:0`)
    const value = (name: string) =>
      Number(new RegExp(`${name}:\\s*(-?[\\d.]+)(?:px)?`).exec(style)?.[1] ?? Number.NaN);
    const left = value('left');
    const top = value('top');
    expect(button).not.toBe('');
    expect(style).not.toBe('');
    expect(Number.isFinite(left)).toBe(true);
    expect(Number.isFinite(top)).toBe(true);
    // offset do painel dentro do canvas (cabeçalho da faceplate + respiro)
    const articleStyle =
      /<article[^>]*data-asset-id="asset-a"[^>]*style="([^"]+)"/.exec(html)?.[1] ?? '';
    const panelStyle =
      /<div class="physical-faceplate__panel"[^>]*style="([^"]+)"/.exec(html)?.[1] ?? '';
    const offset = (source: string, name: string) =>
      Number(new RegExp(`${name}:\\s*(-?[\\d.]+)(?:px)?`).exec(source)?.[1] ?? Number.NaN);
    const offsetX = offset(articleStyle, 'left') + offset(panelStyle, 'left');
    const offsetY = offset(articleStyle, 'top') + offset(panelStyle, 'top');
    const cable = /<path[^>]*d="M ([\d.]+) ([\d.]+)[^>]*class="physical-cable /.exec(html);
    expect(cable).not.toBeNull();
    const width = value('width');
    const height = value('height');
    // tolerância de 1px: a largura/altura do botão é arredondada para o desenho
    expect(Math.abs(Number(cable![1]) - (offsetX + left + width / 2))).toBeLessThanOrEqual(1);
    expect(Math.abs(Number(cable![2]) - (offsetY + top + height / 2))).toBeLessThanOrEqual(1);
  });

  it('mantém todas as portas da placa dentro do slot (sem limite de 6)', () => {
    const modular = physicalRack({
      assets: [
        physicalAsset({
          id: 'asset-olt',
          name: 'OLT-01',
          kind: 'OLT',
          startU: 5,
          heightU: 6,
          ports: [
            physicalPort({ id: 'port-plain', assetId: 'asset-olt', name: 'MGMT', state: 'MAPPED' }),
          ],
          slots: [
            physicalSlot({
              id: 'slot-1',
              assetId: 'asset-olt',
              index: 1,
              module: physicalModule({
                id: 'module-1',
                assetId: 'asset-olt',
                slotId: 'slot-1',
                name: 'Placa GPON 8 portas',
                model: 'H802GPBD',
                ports: Array.from({ length: 8 }, (_value, index) =>
                  physicalPort({
                    id: `port-gpon-${index + 1}`,
                    assetId: 'asset-olt',
                    slotId: 'slot-1',
                    moduleId: 'module-1',
                    name: `GPON0/1/${index + 1}`,
                    state: index === 0 ? 'LLDP_DETECTED' : 'FREE',
                    ...(index === 0
                      ? {
                          lldp: {
                            adjacencyId: 'l1',
                            remoteHostname: 'SW-CORE',
                            remotePortName: 'GE1/0/1',
                            confidence: 'CONFIRMED',
                            resolved: true,
                            ambiguous: false,
                            source: 'LLDP',
                            observedAt: '2026-09-21T11:00:00.000Z',
                          },
                        }
                      : {}),
                  }),
                ),
              }),
            }),
            physicalSlot({ id: 'slot-2', assetId: 'asset-olt', index: 2 }),
          ],
        }),
      ],
    });

    const html = renderToStaticMarkup(
      <PhysicalRackCanvas
        rack={modular}
        connections={[]}
        mode="hidden"
        selection={null}
        path={null}
        onSelectAsset={noop}
        onSelectPort={noop}
        onSelectConnection={noop}
        onClear={noop}
      />,
    );
    expect(html.match(/data-port-id="port-gpon-/g)).toHaveLength(8);
    expect(html).toContain('H802GPBD');
    expect(html).toContain('physical-slot__panel');
    expect(html).toContain('state-mapped');
    expect(html).toContain('state-lldp_detected');
    expect(html).toContain('physical-port__lldp');
  });

  it('OLT MA5800-X2: chassi por imagem e placa com painel próprio dentro do slot', () => {
    const entry: PhysicalCatalogEntry = catalogEntry({
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
    const modulePorts = Array.from({ length: 3 }, (_value, index) =>
      physicalPort({
        id: `port-gpon-${index + 1}`,
        assetId: 'asset-x2',
        slotId: 'slot-1',
        moduleId: 'module-1',
        name: `GPON-${index + 1}`,
      }),
    );
    const gpdf = physicalModule({
      id: 'module-1',
      assetId: 'asset-x2',
      slotId: 'slot-1',
      slotIndex: 1,
      name: 'GPFD 16 portas GPON',
      model: 'H802GPFD',
      ports: modulePorts,
    });
    const asset = physicalAsset({
      id: 'asset-x2',
      name: 'OLT-VTA-01',
      kind: 'OLT',
      startU: 8,
      heightU: 2,
      templateId: 'template-huawei-ma5800-x2',
      template: templateRef('huawei-ma5800-x2', 'MA5800-X2'),
      ports: modulePorts,
      modules: [gpdf],
      slots: [
        physicalSlot({
          id: 'slot-1',
          assetId: 'asset-x2',
          index: 1,
          module: gpdf,
        }),
      ],
    });

    const html = renderToStaticMarkup(
      <PhysicalRackCanvas
        rack={physicalRack({ units: 42, assets: [asset] })}
        connections={[]}
        mode="hidden"
        selection={null}
        path={null}
        catalog={[entry]}
        onSelectAsset={noop}
        onSelectPort={noop}
        onSelectConnection={noop}
        onClear={noop}
      />,
    );

    // chassi por imagem com o slot do mapa
    expect(html).toContain('huawei-ma5800-x2-front.png');
    expect(html).toContain('data-chassis-panel="huawei-ma5800-x2"');
    expect(html.match(/data-slot-key=/g)).toHaveLength(3);
    // a placa usa o painel por imagem dela, desenhado dentro do slot
    expect(html).toContain('physical-modular-panel__module-panel');
    expect(html).toContain('data-image-panel="module:huawei-gpfd-16"');
    expect(html).toContain('huawei-gpfd-16-gpon-front.png');
    expect(html.match(/data-port-name=/g)).toHaveLength(16);
    // as portas materializadas do módulo resolvem nos hotspots
    expect(html).toContain('data-port-id="port-gpon-1"');
    expect(html).toContain('data-port-id="port-gpon-2"');
    // nenhuma porta do chassi é inventada: conector só existe em placa instalada
    expect(html).not.toContain('data-image-panel="huawei-ma5800-x2"');
  });

  it('desenha endpoint remoto clicável na cable-lane (outro rack, mesmo POP)', () => {
    const localRack = physicalRack({
      id: 'rack-1',
      siteId: 'site-1',
      units: 6,
      assets: [
        physicalAsset({
          id: 'asset-local',
          name: 'SW-LOCAL',
          startU: 3,
          heightU: 1,
          ports: [
            physicalPort({
              id: 'port-local',
              assetId: 'asset-local',
              name: '10GE-1',
              connectionId: 'conn-remote',
              state: 'CONNECTED',
            }),
          ],
        }),
      ],
    });
    const cross = physicalConnection({
      id: 'conn-remote',
      portAId: 'port-local',
      portBId: 'port-remote',
      a: {
        portId: 'port-local',
        portName: '10GE-1',
        side: 'DEVICE',
        assetId: 'asset-local',
        assetName: 'SW-LOCAL',
        rackId: 'rack-1',
        rackName: 'Rack 01',
        siteId: 'site-1',
        siteName: 'POP A',
      },
      b: {
        portId: 'port-remote',
        portName: '100GE-2',
        side: 'DEVICE',
        assetId: 'asset-remote',
        assetName: 'SW-CBF-MPLS-01',
        rackId: 'rack-9',
        rackName: 'Rack 02',
        siteId: 'site-1',
        siteName: 'POP A',
      },
    });
    const html = renderToStaticMarkup(
      <PhysicalRackCanvas
        rack={localRack}
        connections={[cross]}
        mode="all"
        selection={null}
        path={null}
        onSelectAsset={noop}
        onSelectPort={noop}
        onSelectConnection={noop}
        onClear={noop}
      />,
    );
    expect(html).toContain('physical-cable-endpoint');
    expect(html).not.toContain('is-external');
    expect(html).toContain('Rack 02');
    expect(html).toContain('SW-CBF-MPLS-01');
    expect(html).toContain('100GE-2');
    // a linha termina na lateral (mesmo Y da porta local), nunca dentro do rack
    expect(html).not.toContain('M 0 0');
  });

  it('identifica a ponta de outro POP como fibra externa', () => {
    const localRack = physicalRack({
      id: 'rack-1',
      siteId: 'site-1',
      units: 6,
      assets: [
        physicalAsset({
          id: 'asset-local',
          name: 'SW-LOCAL',
          startU: 3,
          heightU: 1,
          ports: [
            physicalPort({
              id: 'port-local',
              assetId: 'asset-local',
              name: '100GE-1',
              connectionId: 'conn-external',
              state: 'CONNECTED',
            }),
          ],
        }),
      ],
    });
    const external = physicalConnection({
      id: 'conn-external',
      portAId: 'port-local',
      portBId: 'port-remote',
      a: {
        portId: 'port-local',
        portName: '100GE-1',
        side: 'DEVICE',
        assetId: 'asset-local',
        assetName: 'SW-LOCAL',
        rackId: 'rack-1',
        rackName: 'Rack 01',
        siteId: 'site-1',
        siteName: 'POP Vista Alegre',
      },
      b: {
        portId: 'port-remote',
        portName: '100GE-2',
        side: 'DEVICE',
        assetId: 'asset-remote',
        assetName: 'SW-CBF-MPLS-01',
        rackId: 'rack-9',
        rackName: 'Rack 01',
        siteId: 'site-2',
        siteName: 'POP Cabo Frio',
      },
    });
    const html = renderToStaticMarkup(
      <PhysicalRackCanvas
        rack={localRack}
        connections={[external]}
        mode="all"
        selection={null}
        path={null}
        onSelectAsset={noop}
        onSelectPort={noop}
        onSelectConnection={noop}
        onClear={noop}
      />,
    );
    expect(html).toContain('physical-cable-endpoint is-external');
    expect(html).toContain('FIBRA EXTERNA');
    expect(html).toContain('SW-CBF-MPLS-01');
  });

  it('destaca a porta par quando uma porta conectada está selecionada', () => {
    const html = renderToStaticMarkup(
      <PhysicalRackCanvas
        rack={rack}
        connections={[connection]}
        mode="selected"
        selection={{ kind: 'port', id: 'port-a' }}
        path={null}
        onSelectAsset={noop}
        onSelectPort={noop}
        onSelectConnection={noop}
        onClear={noop}
      />,
    );
    // o cabo do par fica visível e com destaque máximo no modo "Selecionado"
    expect(html).toContain('physical-cable physical-cable--fiber is-selected');
    // a porta local segue selecionada (sem o anel de "par")
    expect(html).toContain('class="physical-port physical-port--sfp state-connected is-selected"');
    // a ponta remota ganha o destaque de par (is-related)
    expect(html).toContain('is-related');
    expect(html).toContain('data-port-id="port-b"');
  });
});

function lldpGhost(partial: Partial<PhysicalLldpGhost> = {}): PhysicalLldpGhost {
  return {
    key: 'port-a|port-b',
    adjacencyId: 'lldp-1',
    adjacencyIds: ['lldp-1'],
    state: 'READY',
    confidence: 'CONFIRMED',
    observedAt: '2026-09-21T11:00:00.000Z',
    reason: 'Ambos os lados estão no inventário físico.',
    localPortName: 'GE1',
    remoteHostname: 'EDD-01',
    remotePortName: 'LAN1',
    from: {
      siteId: 'site-1',
      siteName: 'POP Centro',
      rackId: 'rack-1',
      rackName: 'Rack 01',
      assetId: 'asset-a',
      assetName: 'SW-01',
      portId: 'port-a',
      portName: 'GE1',
    },
    to: {
      siteId: 'site-1',
      siteName: 'POP Centro',
      rackId: 'rack-1',
      rackName: 'Rack 01',
      assetId: 'asset-b',
      assetName: 'EDD-01',
      portId: 'port-b',
      portName: 'LAN1',
    },
    external: false,
    conflict: 'NONE',
    conflictDetail: '',
    confirmable: true,
    ...partial,
  };
}

describe('PhysicalRackCanvas · sugestões LLDP', () => {
  function render(ghosts: PhysicalLldpGhost[], options: {
    lldpMode?: 'hidden' | 'related' | 'all';
    selection?: PhysicalSelection;
    connections?: typeof connection[];
    rack?: typeof rack;
  } = {}) {
    return renderToStaticMarkup(
      <PhysicalRackCanvas
        rack={options.rack ?? rack}
        connections={options.connections ?? []}
        lldpGhosts={ghosts}
        lldpMode={options.lldpMode ?? 'all'}
        mode="all"
        selection={options.selection ?? null}
        path={null}
        onSelectAsset={noop}
        onSelectPort={noop}
        onSelectConnection={noop}
        onSelectLldp={noop}
        onNavigateToPort={noop}
        onClear={noop}
      />,
    );
  }

  /** Classe do `<article>` de um equipamento do rack desenhado. */
  function faceplateClass(html: string, assetId: string): string {
    return html.match(new RegExp(`data-asset-id="${assetId}"[^>]*class="([^"]+)"`))?.[1] ?? '';
  }

  /**
   * Rack com um terceiro equipamento: só ele deve escurecer quando a relação
   * em foco é o par entre `asset-a` e `asset-b`.
   */
  const rackWithThirdAsset = physicalRack({
    assets: [
      physicalAsset({
        id: 'asset-a',
        name: 'SW-01',
        startU: 10,
        heightU: 1,
        ports: [physicalPort({ id: 'port-a', assetId: 'asset-a', name: 'GE1', state: 'LLDP_DETECTED' })],
      }),
      physicalAsset({
        id: 'asset-b',
        name: 'EDD-01',
        kind: 'GENERIC',
        startU: 20,
        heightU: 1,
        ports: [physicalPort({ id: 'port-b', assetId: 'asset-b', name: 'LAN1', type: 'RJ45', state: 'LLDP_DETECTED' })],
      }),
      physicalAsset({
        id: 'asset-c',
        name: 'SW-02',
        startU: 30,
        heightU: 1,
        ports: [physicalPort({ id: 'port-c', assetId: 'asset-c', name: 'GE2' })],
      }),
    ],
  });

  /** Dois chassis vizinhos (vão de uma U entre eles), como na RACK 01 real. */
  const adjacentRack = physicalRack({
    units: 8,
    assets: [
      physicalAsset({
        id: 'asset-a',
        name: 'SW-01',
        startU: 6,
        heightU: 1,
        ports: [physicalPort({ id: 'port-a', assetId: 'asset-a', name: 'GE1', state: 'LLDP_DETECTED' })],
      }),
      physicalAsset({
        id: 'asset-b',
        name: 'EDD-01',
        kind: 'GENERIC',
        startU: 4,
        heightU: 1,
        ports: [physicalPort({ id: 'port-b', assetId: 'asset-b', name: 'LAN1', type: 'RJ45', state: 'LLDP_DETECTED' })],
      }),
    ],
  });

  /** Segmentos (M/H/V) de um path, em coordenadas do canvas. */
  function pathSegments(d: string): Array<{ x1: number; y1: number; x2: number; y2: number }> {
    const segments: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    let x = 0;
    let y = 0;
    for (const token of d.match(/[MHV][^MHV]*/g) ?? []) {
      const numbers = (token.slice(1).match(/-?[0-9.]+/g) ?? []).map(Number);
      if (token[0] === 'M') {
        x = numbers[0]!;
        y = numbers[1]!;
      } else if (token[0] === 'H') {
        segments.push({ x1: x, y1: y, x2: numbers[0]!, y2: y });
        x = numbers[0]!;
      } else if (token[0] === 'V') {
        segments.push({ x1: x, y1: y, x2: x, y2: numbers[0]! });
        y = numbers[0]!;
      }
    }
    return segments;
  }

  /** Caixas dos chassis desenhados (`<article>` com estilo inline). */
  function chassisBoxes(html: string) {
    return [...html.matchAll(/<article[^>]*data-asset-id="([^"]+)"[^>]*style="([^"]+)"/g)].map((match) => {
      const top = Number(match[2]!.match(/top:(-?[0-9.]+)px/)?.[1]);
      const height = Number(match[2]!.match(/height:(-?[0-9.]+)px/)?.[1]);
      return { id: match[1]!, top, height, bottom: top + height };
    });
  }

  /** Origem (canvas) do chassis que contém o índice informado. */
  function chassisOriginAt(html: string, index: number) {
    const before = html.slice(0, index);
    const style = [...before.matchAll(/<article[^>]*style="([^"]+)"/g)].pop()?.[1] ?? '';
    const value = (key: string) => Number(style.match(new RegExp(`${key}:(-?[0-9.]+)(?:px)?`))?.[1]);
    return { left: value('left'), top: value('top') };
  }

  /**
   * Porta desenhada em coordenadas do canvas: o `<button>` é posicionado dentro
   * do chassis, então a origem do `<article>` entra na conta. O anchor do cabo é
   * exatamente o centro da caixa da porta.
   */
  function portBox(html: string, displayName: string) {
    const index = html.search(new RegExp(`data-port-display-name="${displayName}"`));
    const start = html.lastIndexOf('<button', index);
    const tag = html.slice(start, html.indexOf('>', start) + 1);
    const origin = chassisOriginAt(html, index);
    const value = (key: string) => Number(tag.match(new RegExp(`${key}:(-?[0-9.]+)(?:px)?`))?.[1]);
    const box = {
      left: value('left') + origin.left,
      top: value('top') + origin.top,
      width: value('width'),
      height: value('height'),
    };
    return { ...box, centerX: box.left + box.width / 2, centerY: box.top + box.height / 2 };
  }

  /** Uma linha de `LLDP` no vão (badge). */
  function badges(html: string) {
    return [...html.matchAll(/class="physical-lldp-badge[^"]*" x="([0-9.]+)" y="([0-9.]+)"/g)].map(
      (match) => ({ x: Number(match[1]), y: Number(match[2]) }),
    );
  }

  it('desenha o ghost READY como sugestão: tracejado, abaixo dos cabos e nunca como cabo', () => {
    const html = render([lldpGhost()]);

    expect(html).toContain('physical-lldp-layer');
    expect(html).toContain('physical-lldp-ghost');
    expect(html).toContain('physical-lldp-hit');
    expect(html).toContain('>LLDP</text>');
    // A sugestão não vira cabo confirmado: nenhuma linha de cabo é desenhada.
    expect(html).not.toContain('physical-cable physical-cable--');
  });

  it('PARTIAL usa marcador compacto ancorado na porta local e não inventa endpoint', () => {
    const html = render([lldpGhost({ state: 'PARTIAL', to: null, confirmable: false })]);

    // Sem traçado e sem caixa de texto sobre o equipamento: só o marcador.
    expect(html).not.toContain('physical-lldp-ghost');
    expect(html).toContain('physical-lldp-partial');
    // Marcador mínimo colado na porta local (ponto âmbar, sem caixa de texto).
    expect(html).toContain('physical-lldp-partial__dot');
    // O título/aria do marcador diz qual porta local originou o anúncio.
    expect(html).toContain('GE1 · PARTIAL');
    expect(html).toContain('aria-label="GE1 · PARTIAL');
    expect(html).not.toContain('A interface remota ainda não está vinculada');
    expect(html).not.toContain('Ir para a ponta');
  });

  it('marcadores PARTIAL ficam na própria porta, sem empilhamento diagonal', () => {
    const partial = (side: 'a' | 'b'): PhysicalLldpGhost => {
      const portId = side === 'a' ? 'port-a' : 'port-b';
      const assetId = side === 'a' ? 'asset-a' : 'asset-b';
      const portName = side === 'a' ? 'GE1' : 'LAN1';
      return lldpGhost({
        key: `${portId}|null`,
        adjacencyId: `lldp-${side}`,
        adjacencyIds: [`lldp-${side}`],
        state: 'PARTIAL',
        to: null,
        confirmable: false,
        localPortName: portName,
        from: {
          siteId: 'site-1',
          siteName: 'POP Centro',
          rackId: 'rack-1',
          rackName: 'Rack 01',
          assetId,
          assetName: assetId,
          portId,
          portName,
        },
      });
    };
    const html = render([partial('a'), partial('b')], { rack: adjacentRack });

    const marker = (name: string) => {
      const tag = html.match(new RegExp(`<button[^>]*aria-label="${name} · PARTIAL[^>]*>`))?.[0] ?? '';
      return {
        left: Number(tag.match(/left:(-?[0-9.]+)px/)?.[1]),
        top: Number(tag.match(/top:(-?[0-9.]+)px/)?.[1]),
      };
    };
    const first = marker('GE1');
    const second = marker('LAN1');
    const firstPort = portBox(html, 'GE1');
    const secondPort = portBox(html, 'LAN1');

    // Cada marcador guarda a MESMA relação com a sua própria porta (o anchor do
    // cabo é o centro dela, deslocado só pelo inset do painel): nada de
    // deslocamento acumulado por índice/fileira.
    expect(Math.abs(first.left - firstPort.centerX - (second.left - secondPort.centerX))).toBeLessThanOrEqual(1);
    expect(Math.abs(first.top - firstPort.centerY - (second.top - secondPort.centerY))).toBeLessThanOrEqual(1);
    // E acompanham a própria porta, não a fileira: a distância entre os dois
    // marcadores é a distância entre as duas portas.
    expect(Math.abs(second.left - first.left - (secondPort.centerX - firstPort.centerX))).toBeLessThanOrEqual(1);
    expect(Math.abs(second.top - first.top - (secondPort.centerY - firstPort.centerY))).toBeLessThanOrEqual(1);
  });

  it('estado limpo (sem seleção) não desenha par READY, badge nem MAPA', () => {
    const html = render([lldpGhost()], { lldpMode: 'related' });

    expect(html).not.toContain('physical-lldp-ghost');
    expect(html).not.toContain('physical-lldp-badge');
    expect(html).not.toContain('physical-maplink-ghost');
  });

  it('com a porta do par selecionada aparece só aquele LLDP, com as duas pontas', () => {
    const html = render([lldpGhost()], {
      lldpMode: 'related',
      selection: { kind: 'port', id: 'port-a' },
    });

    expect(html.match(/physical-lldp-ghost/g)).toHaveLength(1);
    expect(html.match(/physical-lldp-badge/g)).toHaveLength(1);
    expect(html).toContain('data-port-id="port-b"');
    expect(html).toContain('is-related');
  });

  it('relação LLDP em foco mantém as DUAS pontas visíveis e escurece só o resto', () => {
    const html = render([lldpGhost()], {
      lldpMode: 'related',
      selection: { kind: 'port', id: 'port-a' },
      rack: rackWithThirdAsset,
    });

    // Ponta local e ponta remota: nenhuma das duas escurece.
    expect(faceplateClass(html, 'asset-a')).not.toContain('is-dimmed');
    expect(faceplateClass(html, 'asset-b')).not.toContain('is-dimmed');
    // Os dois equipamentos do par parecem ativos.
    expect(faceplateClass(html, 'asset-a')).toContain('is-selected');
    expect(faceplateClass(html, 'asset-b')).toContain('is-selected');
    // O equipamento de fora da relação é o único escurecido.
    expect(faceplateClass(html, 'asset-c')).toContain('is-dimmed');
    expect(faceplateClass(html, 'asset-c')).not.toContain('is-selected');
    // As duas portas continuam com o destaque forte do par.
    expect(html).toContain('is-selected');
    expect(html).toContain('is-related');
  });

  it('sugestão PARTIAL selecionada mantém só o equipamento da porta local', () => {
    const html = render([lldpGhost({ state: 'PARTIAL', to: null, confirmable: false })], {
      lldpMode: 'related',
      selection: { kind: 'lldp', id: 'lldp-1' },
      rack: rackWithThirdAsset,
    });

    expect(faceplateClass(html, 'asset-a')).not.toContain('is-dimmed');
    expect(faceplateClass(html, 'asset-b')).toContain('is-dimmed');
    expect(faceplateClass(html, 'asset-c')).toContain('is-dimmed');
    // Continua sem segunda ponta inventada.
    expect(html).not.toContain('physical-lldp-ghost');
  });

  it('traçado LLDP same-rack fica antes da CABLE LANE (tronco + drop curtos)', () => {
    const html = render([lldpGhost()]);
    const laneLeft = 938;

    // Tronco (saída + corredor) e drop (entrada na porta par), nunca na lane.
    expect(html).toContain('physical-lldp-drop');
    const paths = [...html.matchAll(/class="physical-lldp-(?:ghost|drop)[^"]*" d="([^"]+)"/g)].map(
      (match) => match[1]!,
    );
    expect(paths).toHaveLength(2);

    const xs: number[] = [];
    for (const d of paths) {
      for (const token of d.match(/[MHVL][^MHVL]*/g) ?? []) {
        const numbers = (token.slice(1).match(/-?[0-9.]+/g) ?? []).map(Number);
        if (token[0] === 'M' || token[0] === 'L' || token[0] === 'H') xs.push(numbers[0]!);
      }
    }
    expect(Math.max(...xs)).toBeLessThan(laneLeft);
  });

  it('same-rack B+: nenhum segmento horizontal corre sobre as fileiras de portas', () => {
    const html = render([lldpGhost()], {
      lldpMode: 'related',
      selection: { kind: 'port', id: 'port-a' },
      rack: adjacentRack,
    });
    const paths = [...html.matchAll(/class="physical-lldp-(?:ghost|drop)[^"]*" d="([^"]+)"/g)].map(
      (match) => match[1]!,
    );
    expect(paths).toHaveLength(2);

    const boxes = chassisBoxes(html);
    const local = boxes.find((box) => box.id === 'asset-a')!;
    const remote = boxes.find((box) => box.id === 'asset-b')!;
    const segments = paths.flatMap((d) => pathSegments(d));
    const horizontal = segments.filter(
      (segment) => Math.abs(segment.y2 - segment.y1) < 0.001 && Math.abs(segment.x2 - segment.x1) > 0.001,
    );
    const vertical = segments.filter(
      (segment) => Math.abs(segment.x2 - segment.x1) < 0.001 && Math.abs(segment.y2 - segment.y1) > 0.001,
    );

    // Nada de horizontal dentro de um chassis (isso é o que escondia as portas).
    expect(horizontal.length).toBeGreaterThan(0);
    for (const segment of horizontal) {
      const inside = [...boxes].find(
        (box) => segment.y1 > box.top + 0.5 && segment.y1 < box.bottom - 0.5,
      );
      expect(inside).toBeUndefined();
    }

    // O corredor principal é o vão entre os dois chassis.
    const corridor = horizontal.reduce((longest, segment) =>
      Math.abs(segment.x2 - segment.x1) > Math.abs(longest.x2 - longest.x1) ? segment : longest,
    );
    const upper = local.top < remote.top ? local : remote;
    const lower = local.top < remote.top ? remote : local;
    const gapTop = upper.bottom;
    const gapBottom = lower.top;
    expect(corridor.y1).toBeGreaterThanOrEqual(gapTop - 0.001);
    expect(corridor.y1).toBeLessThanOrEqual(gapBottom + 0.001);

    // Stubs verticais curtos: saem da porta local e entram na porta remota.
    const stubs = vertical.sort((left, right) => left.y1 - right.y1);
    const localPort = portBox(html, 'GE1');
    const remotePort = portBox(html, 'LAN1');
    // Cada stub sai da coluna da sua porta (o anchor do cabo é o centro dela,
    // deslocado apenas pelo inset do painel dentro do chassis).
    expect(Math.abs(stubs[0]!.x1 - localPort.centerX)).toBeLessThanOrEqual(40);
    expect(Math.abs(stubs[stubs.length - 1]!.x1 - remotePort.centerX)).toBeLessThanOrEqual(40);
    for (const stub of stubs) {
      expect(Math.abs(stub.y2 - stub.y1)).toBeLessThanOrEqual(local.height + 40);
    }
  });

  it('badge LLDP do par same-rack fica no vão entre os chassis', () => {
    const html = render([lldpGhost()], {
      lldpMode: 'related',
      selection: { kind: 'port', id: 'port-a' },
      rack: adjacentRack,
    });
    const boxes = chassisBoxes(html);
    const local = boxes.find((box) => box.id === 'asset-a')!;
    const remote = boxes.find((box) => box.id === 'asset-b')!;
    const [badge] = badges(html);
    expect(badges(html)).toHaveLength(1);

    // Verticalmente no vão (nunca sobre um equipamento)...
    expect(badge!.y).toBeGreaterThan(local.bottom - 14);
    expect(badge!.y).toBeLessThan(remote.top + 1);
    // ...e perto da relação, não no extremo direito do rack.
    expect(badge!.x).toBeGreaterThan(62);
    expect(badge!.x).toBeLessThan(922 - 30);
  });

  it('badge LLDP fica à esquerda do corredor, fora da CABLE LANE', () => {
    const html = render([lldpGhost()]);
    const badges = [...html.matchAll(/class="physical-lldp-badge[^"]*" x="([0-9.]+)"/g)].map(
      (match) => Number(match[1]),
    );

    // Um badge por relação e sempre antes da lane.
    expect(badges).toHaveLength(1);
    expect(badges[0]!).toBeLessThan(938);
    expect(badges[0]!).toBeLessThan(924);
  });

  it('UNRESOLVED não cria caminho entre assets (só marca a porta observada)', () => {
    const html = render([lldpGhost({ state: 'UNRESOLVED', to: null, confirmable: false })]);

    expect(html).not.toContain('physical-lldp-ghost');
    expect(html).toContain('physical-lldp-dot');
  });

  it('READY com porta ocupada (conflito) não é desenhado', () => {
    const html = render([
      lldpGhost({ conflict: 'BUSY', conflictDetail: 'Esta porta já possui uma conexão física.', confirmable: false }),
    ]);

    expect(html).not.toContain('physical-lldp-ghost');
  });

  it('cross-site vira marcador externo com navegação para a ponta', () => {
    const html = render([
      lldpGhost({
        external: true,
        to: {
          siteId: 'site-2',
          siteName: 'BHE-VTA',
          rackId: 'rack-9',
          rackName: 'RACK-MPLS',
          assetId: 'asset-z',
          assetName: 'S6750-MPLS-01',
          portId: 'port-z',
          portName: '100GE1/0/2',
        },
      }),
    ]);

    expect(html).toContain('physical-lldp-endpoint is-confirmable is-external');
    expect(html).toContain('BHE-VTA');
    expect(html).toContain('100GE1/0/2');
    expect(html).toContain('Ir para a ponta');
  });

  it('respeita o modo de exibição das sugestões', () => {
    expect(render([lldpGhost()], { lldpMode: 'hidden' })).not.toContain('physical-lldp-ghost');
    // `related` sem seleção não mostra nada; com a sugestão selecionada, mostra.
    expect(render([lldpGhost()], { lldpMode: 'related' })).not.toContain('physical-lldp-ghost');
    const selected = render([lldpGhost()], {
      lldpMode: 'related',
      selection: { kind: 'lldp', id: 'lldp-1' },
    });
    expect(selected).toContain('physical-lldp-ghost is-selected');
  });
});
