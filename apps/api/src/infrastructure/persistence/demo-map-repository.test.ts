import { describe, expect, it } from 'vitest';
import { DemoMapRepository } from './demo-map-repository';

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
