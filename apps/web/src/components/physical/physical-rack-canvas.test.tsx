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

  it('desenha as 56 portas do painel F1A (nunca "+32")', () => {
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
    // QSFP28 desenhado maior que SFP28 (proporção do conector real)
    const qsfpStyle = /data-port-id="f1a-1"[^>]*style="([^"]+)"/.exec(html)?.[1] ?? '';
    const sfpStyle = /data-port-id="f1a-9"[^>]*style="([^"]+)"/.exec(html)?.[1] ?? '';
    const width = (style: string) => Number(/width:\s*(\d+)px/.exec(style)?.[1] ?? 0);
    expect(width(qsfpStyle)).toBeGreaterThan(width(sfpStyle));
    expect(qsfpStyle.length).toBeGreaterThan(0);
    expect(html).toContain('physical-port--qsfp28');
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
});
