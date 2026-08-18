import { describe, expect, it } from 'vitest';
import type {
  CreateLinkInput,
  LldpAdjacencyProposal,
  LldpApplySelection,
  LldpTopologyPreview,
  NetworkLink,
} from '@gmj/shared';
import { makeHost, makeInterface, makeLink, makeMap } from '../test-fixtures';
import { TopologyApplyService } from './topology-apply-service';

function adjacency(partial: Partial<LldpAdjacencyProposal>): LldpAdjacencyProposal {
  return {
    id: 'adj-1',
    sourceHostId: 'host-a',
    sourceHostname: 'bhe-a',
    sourcePort: '100GE1/0/1',
    sourceIfIndex: 1001,
    sourceInterfaceId: 'a-if',
    sourceSpeedBps: 100_000_000_000,
    targetHostId: 'host-b',
    targetHostname: 'bhe-b',
    targetManagementAddress: '10.0.0.2',
    targetChassisId: null,
    targetPort: '100GE1/0/2',
    targetPortDescription: null,
    targetInterfaceId: 'b-if',
    targetSpeedBps: 100_000_000_000,
    confidence: 'CONFIRMED',
    signals: [],
    reasons: [],
    duplicate: false,
    existingLinkId: null,
    source: 'LLDP_SNMP',
    ...partial,
  };
}

function preview(adjacencies: LldpAdjacencyProposal[]): LldpTopologyPreview {
  return {
    id: 'preview-1',
    mapId: 'map-1',
    createdAt: '',
    stats: {
      hostsQueried: 0,
      hostsFailed: 0,
      adjacencies: adjacencies.length,
      confirmed: 0,
      probable: 0,
      ambiguous: 0,
      unknownNeighbor: 0,
    },
    adjacencies,
    warnings: [],
  };
}

function selection(adjacencyId: string, action: LldpApplySelection['action'] = 'CREATE_LINK'): LldpApplySelection {
  return { adjacencyId, action };
}

const hostA = makeHost({
  id: 'host-a',
  hostname: 'bhe-a',
  managementIp: '10.0.0.1',
  interfaces: [makeInterface({ id: 'a-if', deviceId: 'host-a', name: '100GE1/0/1', ifIndex: 1001 })],
});
const hostB = makeHost({
  id: 'host-b',
  hostname: 'bhe-b',
  managementIp: '10.0.0.2',
  interfaces: [
    makeInterface({ id: 'b-if', deviceId: 'host-b', name: '100GE1/0/2', ifIndex: 2002 }),
    makeInterface({ id: 'b-if-2', deviceId: 'host-b', name: '100GE1/0/3', ifIndex: 2003 }),
  ],
});
const hosts = [hostA, hostB];

class FakeLinkRepository {
  links: NetworkLink[];

  constructor(initial: NetworkLink[] = []) {
    this.links = [...initial];
  }

  async getMap() {
    return makeMap({ id: 'map-1', links: structuredClone(this.links), devices: hosts });
  }

  async createDiscoveredLink(_mapId: string, input: CreateLinkInput, source: NetworkLink['discoverySource']) {
    const link = makeLink({
      id: `new-${this.links.length + 1}`,
      mapId: 'map-1',
      sourceDeviceId: input.sourceDeviceId,
      sourceInterfaceId: input.sourceInterfaceId,
      targetDeviceId: input.targetDeviceId,
      targetInterfaceId: input.targetInterfaceId,
      capacityBps: input.capacityBps,
      autoCapacityBps: input.autoCapacityBps,
      capacitySource: input.capacitySource,
      label: input.label,
      metricSource: input.metricSource,
      visualStyle: input.visualStyle,
      metricDisplay: input.metricDisplay,
      discoverySource: source,
    });
    this.links.push(link);
    return structuredClone(link);
  }
}

function applyService(links: NetworkLink[] = []) {
  return new TopologyApplyService(new FakeLinkRepository(links), { listHosts: async () => hosts });
}

describe('TopologyApplyService', () => {
  it('creates only approved links and skips ambiguous neighbors', async () => {
    const proposals = preview([
      adjacency({ id: 'adj-confirmed' }),
      adjacency({ id: 'adj-probable', confidence: 'PROBABLE', targetPort: '100GE1/0/3', targetInterfaceId: 'b-if-2' }),
      adjacency({ id: 'adj-ambiguous', confidence: 'AMBIGUOUS' }),
    ]);
    const result = await applyService().apply('map-1', proposals, [
      selection('adj-confirmed'),
      selection('adj-probable'),
      selection('adj-ambiguous'),
    ]);
    expect(result.createdLinks).toHaveLength(2);
    expect(result.skipped).toContain('adj-ambiguous');
  });

  it('never creates links for ambiguous or unknown neighbors even when selected', async () => {
    const proposals = preview([
      adjacency({ id: 'adj-ambiguous', confidence: 'AMBIGUOUS' }),
      adjacency({ id: 'adj-unknown', confidence: 'UNKNOWN_NEIGHBOR', targetHostId: null, targetInterfaceId: null }),
    ]);
    const result = await applyService().apply('map-1', proposals, [
      selection('adj-ambiguous'),
      selection('adj-unknown'),
    ]);
    expect(result.createdLinks).toHaveLength(0);
    expect(result.skipped).toEqual(expect.arrayContaining(['adj-ambiguous', 'adj-unknown']));
  });

  it('does not duplicate an existing link', async () => {
    const existing = makeLink({
      id: 'existing',
      mapId: 'map-1',
      sourceDeviceId: 'host-a',
      sourceInterfaceId: 'a-if',
      targetDeviceId: 'host-b',
      targetInterfaceId: 'b-if',
    });
    const proposals = preview([adjacency({ id: 'adj-confirmed', duplicate: true, existingLinkId: 'existing' })]);
    const repo = new FakeLinkRepository([existing]);
    const service = new TopologyApplyService(repo, { listHosts: async () => hosts });
    const result = await service.apply('map-1', proposals, [selection('adj-confirmed')]);
    expect(result.createdLinks).toHaveLength(0);
    expect(repo.links).toHaveLength(1);
  });

  it('treats A↔B and B↔A as equivalent when checking duplicates', async () => {
    const existing = makeLink({
      id: 'existing',
      mapId: 'map-1',
      sourceDeviceId: 'host-b',
      sourceInterfaceId: 'b-if',
      targetDeviceId: 'host-a',
      targetInterfaceId: 'a-if',
    });
    const proposals = preview([adjacency({
      id: 'adj-reversed',
      sourceHostId: 'host-a',
      sourceInterfaceId: 'a-if',
      targetHostId: 'host-b',
      targetInterfaceId: 'b-if',
      duplicate: false,
    })]);
    const repo = new FakeLinkRepository([existing]);
    const service = new TopologyApplyService(repo, { listHosts: async () => hosts });
    const result = await service.apply('map-1', proposals, [selection('adj-reversed')]);
    expect(result.createdLinks).toHaveLength(0);
    expect(repo.links).toHaveLength(1);
  });

  it('preserves existing links while adding new ones', async () => {
    const existing = makeLink({
      id: 'existing',
      mapId: 'map-1',
      sourceDeviceId: 'host-a',
      sourceInterfaceId: 'a-if',
      targetDeviceId: 'host-b',
      targetInterfaceId: 'other-if',
    });
    const proposals = preview([adjacency({ id: 'adj-new' })]);
    const repo = new FakeLinkRepository([existing]);
    const service = new TopologyApplyService(repo, { listHosts: async () => hosts });
    const result = await service.apply('map-1', proposals, [selection('adj-new')]);
    expect(result.createdLinks).toHaveLength(1);
    expect(repo.links.map((link) => link.id).sort()).toEqual(['existing', 'new-2']);
  });

  it('allows one interface to participate in more than one link (LAG)', async () => {
    const existing = makeLink({
      id: 'existing',
      mapId: 'map-1',
      sourceDeviceId: 'host-a',
      sourceInterfaceId: 'a-if',
      targetDeviceId: 'host-b',
      targetInterfaceId: 'b-if',
    });
    const proposals = preview([adjacency({
      id: 'adj-lag',
      targetPort: '100GE1/0/3',
      targetInterfaceId: 'b-if-2',
    })]);
    const repo = new FakeLinkRepository([existing]);
    const service = new TopologyApplyService(repo, { listHosts: async () => hosts });
    const result = await service.apply('map-1', proposals, [selection('adj-lag')]);
    expect(result.createdLinks).toHaveLength(1);
    expect(repo.links).toHaveLength(2);
  });
});
