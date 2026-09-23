import { renderToStaticMarkup } from 'react-dom/server';
import type {
  PhysicalCatalogEntry,
  PhysicalCatalogPort,
  PhysicalConnectorKind,
  PhysicalPath,
} from '@gmj/shared';
import { describe, expect, it } from 'vitest';
import { PhysicalRackCanvas } from './physical-rack-canvas';
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

/** Painel F1A-8H20Q declarado no catálogo: 8 QSFP28 + 20 SFP28 + 28 SFP+. */
function f1aCatalogPorts(): PhysicalCatalogPort[] {
  const groups: Array<[string, number, PhysicalConnectorKind, string, string]> = [
    ['100ge-cages', 8, 'QSFP28', '100GE-', 'QSFP'],
    ['25ge-cages', 20, 'SFP28', '25GE-', 'SFP'],
    ['10ge-cages', 28, 'SFP_PLUS', '10GE-', 'SFP'],
  ];
  const ports: PhysicalCatalogPort[] = [];
  let order = 0;
  for (const [groupKey, count, connector, prefix, type] of groups) {
    for (let index = 1; index <= count; index += 1) {
      order += 1;
      ports.push({
        name: `${prefix}${index}`,
        label: `${prefix}${index}`,
        order,
        side: 'DEVICE',
        type: type as PhysicalCatalogPort['type'],
        connector,
        portFunction: 'SERVICE',
        groupKey,
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
    expect(html).toContain('aria-label="Porta GE1 (SFP)"');
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
    expect(widthPct('f1a-1')).toBeGreaterThan(widthPct('f1a-9'));
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
