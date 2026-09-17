import { describe, expect, it } from 'vitest';
import { DemoMapRepository } from './demo-map-repository';

describe('demo link connection sides', () => {
  it('defaults new and legacy links to AUTO', () => {
    const repository = new DemoMapRepository();
    const map = repository.getMap('backbone-main')!;
    expect(map.links[0]).toMatchObject({ sourceHandleSide: 'AUTO', targetHandleSide: 'AUTO' });

    const created = repository.createDiscoveredLink(map.id, { ...map.links[0]! }, 'MANUAL')!;
    expect(created).toMatchObject({ sourceHandleSide: 'AUTO', targetHandleSide: 'AUTO' });

    const manual = repository.createDiscoveredLink(
      map.id,
      { ...map.links[0]!, sourceHandleSide: 'BOTTOM', targetHandleSide: 'LEFT' },
      'MANUAL',
    )!;
    expect(manual).toMatchObject({ sourceHandleSide: 'BOTTOM', targetHandleSide: 'LEFT' });
  });

  it('persists a side change while preserving endpoints, telemetry and geometry', () => {
    const repository = new DemoMapRepository();
    const map = repository.getMap('backbone-main')!;
    const original = map.links[0]!;

    const updated = repository.updateLink(map.id, original.id, {
      capacityBps: original.capacityBps,
      autoCapacityBps: original.autoCapacityBps,
      capacitySource: original.capacitySource,
      label: original.label,
      metricSource: original.metricSource,
      visualStyle: original.visualStyle,
      metricDisplay: original.metricDisplay,
      sourceHandleSide: 'RIGHT',
    })!;

    expect(updated).toMatchObject({
      id: original.id,
      sourceDeviceId: original.sourceDeviceId,
      targetDeviceId: original.targetDeviceId,
      sourceInterfaceId: original.sourceInterfaceId,
      targetInterfaceId: original.targetInterfaceId,
      sourceHandleSide: 'RIGHT',
      targetHandleSide: 'AUTO',
      visualPaths: original.visualPaths,
      directions: original.directions,
      rxBps: original.rxBps,
      txBps: original.txBps,
    });

    const reloaded = repository.getMap(map.id)!.links.find((item) => item.id === original.id)!;
    expect(reloaded).toMatchObject({ sourceHandleSide: 'RIGHT', targetHandleSide: 'AUTO' });
    expect(repository.getMap(map.id)!.links).toHaveLength(map.links.length);
  });
});

describe('demo conceptual node editing', () => {
  it('edits label/type/lock while preserving identity, position, PPP options and links', () => {
    const repository = new DemoMapRepository();
    const map = repository.getMap('backbone-main')!;
    const host = map.devices[0]!;
    const node = repository.addGenericNode(map.id, {
      type: 'CARRIER',
      label: 'Operadora A',
      position: { x: 512.5, y: 348.25 },
    })!;
    repository.updateNodePpp(map.id, node.id, { pppFontSize: 22, pppColor: '#123456' });
    const link = repository.createDiscoveredLink(
      map.id,
      {
        ...map.links[0]!,
        sourceDeviceId: host.id,
        sourceInterfaceId: host.interfaces[0]!.id,
        targetDeviceId: null,
        targetInterfaceId: null,
        targetNodeId: node.id,
        trafficMode: 'SINGLE_ENDED',
      },
      'MANUAL',
    )!;

    const updated = repository.updateConceptualNode(map.id, node.id, {
      label: 'Operadora B',
      genericType: 'DATACENTER',
      locked: true,
    });

    expect(updated).toMatchObject({
      id: node.id,
      mapId: map.id,
      deviceId: null,
      nodeKind: 'GENERIC',
      label: 'Operadora B',
      genericType: 'DATACENTER',
      locked: true,
      position: { x: 512.5, y: 348.25 },
      positionSource: 'MANUAL',
      pppFontSize: 22,
      pppColor: '#123456',
    });

    const reloaded = repository.getMap(map.id)!;
    expect(reloaded.nodes.find((item) => item.id === node.id)).toMatchObject({
      label: 'Operadora B',
      genericType: 'DATACENTER',
      locked: true,
      position: { x: 512.5, y: 348.25 },
    });
    expect(reloaded.links.find((item) => item.id === link.id)).toMatchObject({
      id: link.id,
      targetNodeId: node.id,
      trafficMode: 'SINGLE_ENDED',
    });
  });

  it('never touches DEVICE nodes or unknown nodes', () => {
    const repository = new DemoMapRepository();
    const map = repository.getMap('backbone-main')!;
    const deviceNode = map.nodes[0]!;
    const before = structuredClone(deviceNode);

    expect(
      repository.updateConceptualNode(map.id, deviceNode.id, { label: 'Nope', locked: true }),
    ).toBeNull();
    expect(repository.updateConceptualNode(map.id, 'missing', { label: 'Nope' })).toBeNull();
    expect(repository.updateConceptualNode('missing-map', deviceNode.id, { label: 'Nope' })).toBeNull();

    expect(repository.getMap(map.id)!.nodes.find((item) => item.id === deviceNode.id)).toEqual(
      before,
    );
  });
});

describe.each(['SOURCE', 'TARGET'] as const)('demo SINGLE_ENDED %s', (side) => {
  it('materializes live interface states and counters without creating a host for the carrier', () => {
    const repository = new DemoMapRepository();
    const map = repository.getMap('backbone-main')!;
    const host = map.devices[0]!;
    const real = host.interfaces[0]!;
    const node = repository.addGenericNode(map.id, {
      type: 'carrier',
      label: 'FTI',
      position: { x: 100, y: 100 },
    })!;
    const input = {
      ...map.links[0]!,
      sourceDeviceId: side === 'SOURCE' ? host.id : null,
      targetDeviceId: side === 'TARGET' ? host.id : null,
      sourceNodeId: side === 'TARGET' ? node.id : null,
      targetNodeId: side === 'SOURCE' ? node.id : null,
      sourceInterfaceId: side === 'SOURCE' ? real.id : null,
      targetInterfaceId: side === 'TARGET' ? real.id : null,
      trafficMode: 'SINGLE_ENDED' as const,
    };
    const created = repository.createDiscoveredLink(map.id, input, 'MANUAL')!;
    for (const operStatus of ['UP', 'DOWN', 'DISABLED', 'UNKNOWN'] as const) {
      repository.updateInterfaceStatuses(host.id, [{ ifIndex: real.ifIndex, operStatus }]);
      const reloaded = repository.getMap(map.id)!.links.find((link) => link.id === created.id)!;
      expect(reloaded.status).toBe(operStatus === 'DISABLED' ? 'DOWN' : operStatus);
      expect(reloaded.rxBps).toBe(real.rxBps);
      expect(reloaded.txBps).toBe(real.txBps);
    }
    expect(repository.listHosts()).toHaveLength(map.devices.length);
    expect(node).toMatchObject({ nodeKind: 'GENERIC', deviceId: null });
  });
});
