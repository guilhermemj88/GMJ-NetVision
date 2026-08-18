import {
  calculateUtilization,
  cloneDemoMaps,
  createLocalId,
  type AddDeviceResult,
  type AssistedDiscoveryPreview,
  type AssistedDiscoveredNeighbor,
  type ConnectionTestResult,
  type CreateHostInput,
  type CreateLinkInput,
  type CreateMapInput,
  type DeviceType,
  type DiscoveryApplyResult,
  type DiscoveryApplySelection,
  type DiscoveryReview,
  type HostRecord,
  type MapNode,
  type MapPlaylist,
  type MapSettings,
  type MapSummary,
  type NetworkInterface,
  type NetworkLink,
  type NetworkMap,
  type Position,
  type SnmpHostInput,
  type SourceHealth,
  type SshHostInput,
  type UpdateHostInput,
  type UpdateMapInput,
  type ZabbixHostCandidate,
  type ZabbixImportPreview,
  type ZabbixImportResult,
} from '@gmj/shared';
import type { CredentialVault } from '../../application/credential-vault';

export interface NodePositionUpdate {
  nodeId: string;
  position: Position;
  locked?: boolean;
}

export interface CreateDeviceInput {
  name: string;
  hostname: string;
  ip: string;
  vendor: string;
  model: string;
  site: string;
  deviceType: DeviceType;
  position: Position;
}

interface StoredCredentialPair {
  ssh?: Buffer;
  snmp?: Buffer;
}

type StoredMap = Omit<NetworkMap, 'devices'>;

const blankSettings: MapSettings = {
  nodeDisplayMode: 'ICON_2D',
  linkDisplayStyle: 'HYBRID',
  linkMetricDisplay: 'BOTH',
  filters: {
    showTraffic: true,
    showUtilization: true,
    showLabels: true,
    showOffline: true,
    showInterfaces: false,
  },
  viewport: { x: 0, y: 0, zoom: 1 },
  nodeScale: 100,
  linkScale: 100,
  labelScale: 100,
};

function disabledHealth(): SourceHealth {
  return { state: 'DISABLED', lastSuccess: null, lastFailure: null, lastErrorSafe: null };
}

function configuredHealth(enabled: boolean): SourceHealth {
  return enabled
    ? { state: 'CONFIGURED', lastSuccess: null, lastFailure: null, lastErrorSafe: null }
    : disabledHealth();
}

function normalize(value: string | undefined | null): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function defaultInterfaces(deviceId: string, source: 'DEMO' | 'ZABBIX' | 'SNMP' = 'DEMO') {
  return Array.from({ length: 2 }, (_, index): NetworkInterface => ({
    id: createLocalId('interface'),
    deviceId,
    name: `GE0/0/${index + 1}`,
    alias: '',
    description: 'Interface cadastrada pelo inventário',
    ifIndex: index + 1,
    mac: '',
    mtu: 1500,
    speedBps: 1_000_000_000,
    adminStatus: 'UP',
    operStatus: 'UNKNOWN',
    rxBps: 0,
    txBps: 0,
    rxUtilization: 0,
    txUtilization: 0,
    rxErrors: 0,
    txErrors: 0,
    rxDiscards: 0,
    txDiscards: 0,
    rxItemId: null,
    txItemId: null,
    statusItemId: null,
    inErrorsItemId: null,
    outErrorsItemId: null,
    inDiscardsItemId: null,
    outDiscardsItemId: null,
    dataSources: [source],
  }));
}

export class CredentialEncryptionUnavailableError extends Error {
  constructor() {
    super('Credential encryption is not configured');
  }
}

export class DemoMapRepository {
  private devices: HostRecord[];
  private maps: StoredMap[];
  private playlists: MapPlaylist[];
  private readonly credentials = new Map<string, StoredCredentialPair>();
  private readonly zabbixPreviews = new Map<string, ZabbixImportPreview>();
  private readonly discoveryPreviews = new Map<string, AssistedDiscoveryPreview>();

  constructor(private readonly vault: CredentialVault | null = null) {
    const maps = cloneDemoMaps();
    this.devices = structuredClone(maps[0]?.devices ?? []);
    this.maps = maps.map(({ devices: _devices, ...map }) => map);
    const timestamp = new Date().toISOString();
    this.playlists = [
      {
        id: 'noc-main',
        name: 'NOC Principal',
        rotationIntervalSeconds: 60,
        isDefault: true,
        items: this.maps.map((map, order) => ({ mapId: map.id, order })),
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ];
    this.refreshMembership();
  }

  listHosts(): HostRecord[] {
    this.refreshMembership();
    return structuredClone(this.devices);
  }

  getHost(hostId: string): HostRecord | null {
    this.refreshMembership();
    const host = this.devices.find((item) => item.id === hostId);
    return host ? structuredClone(host) : null;
  }

  createHost(input: CreateHostInput, interfaces?: NetworkInterface[]): HostRecord {
    this.assertCredentialEncryption(input.ssh, input.snmp);
    const duplicate = this.devices.find(
      (host) =>
        normalize(host.hostname) === normalize(input.hostname) ||
        (input.managementIp && host.managementIp === input.managementIp),
    );
    if (duplicate) return structuredClone(duplicate);

    const id = createLocalId('host');
    const timestamp = new Date().toISOString();
    const host: HostRecord = {
      id,
      name: input.displayName,
      displayName: input.displayName,
      hostname: input.hostname,
      ip: input.managementIp,
      managementIp: input.managementIp,
      vendor: input.vendor,
      model: input.model,
      status: 'UNKNOWN',
      deviceType: input.deviceType,
      site: input.site,
      description: input.description,
      notes: input.notes,
      origin: input.origin,
      source: input.zabbix.enabled ? 'ZABBIX' : 'MANUAL',
      discoveryMethod: input.snmp.enabled ? 'SNMP' : input.ssh.enabled ? 'SSH' : 'MANUAL',
      useZabbix: input.zabbix.enabled,
      zabbix: input.zabbix.enabled
        ? {
            hostId: input.zabbix.hostId,
            hostName: input.zabbix.hostName,
            primaryInterfaceId: input.zabbix.primaryInterfaceId,
            ip: input.zabbix.ip,
          }
        : null,
      sshEnabled: false,
      ssh: null,
      snmpEnabled: false,
      snmp: null,
      sourceHealth: {
        ZABBIX: configuredHealth(input.zabbix.enabled),
        SSH: disabledHealth(),
        SNMP: disabledHealth(),
      },
      lastPollingAt: null,
      lastDiscoveryAt: null,
      uptimeSeconds: 0,
      updatedAt: timestamp,
      createdAt: timestamp,
      interfaces: (interfaces?.length ? interfaces : defaultInterfaces(id)).map((item) => ({
        ...item,
        deviceId: id,
      })),
      mapIds: [],
      mapCount: 0,
    };
    this.devices.push(host);
    this.applySsh(host, input.ssh);
    this.applySnmp(host, input.snmp);
    return structuredClone(host);
  }

  updateHost(hostId: string, input: UpdateHostInput): HostRecord | null {
    const host = this.findHost(hostId);
    if (!host) return null;
    this.assertCredentialEncryption(input.ssh, input.snmp);
    if (input.hostname !== undefined) host.hostname = input.hostname;
    if (input.displayName !== undefined) {
      host.displayName = input.displayName;
      host.name = input.displayName;
    }
    if (input.managementIp !== undefined) {
      host.managementIp = input.managementIp;
      host.ip = input.managementIp;
    }
    if (input.vendor !== undefined) host.vendor = input.vendor;
    if (input.model !== undefined) host.model = input.model;
    if (input.deviceType !== undefined) host.deviceType = input.deviceType;
    if (input.site !== undefined) host.site = input.site;
    if (input.description !== undefined) host.description = input.description;
    if (input.notes !== undefined) host.notes = input.notes;
    if (input.origin !== undefined) host.origin = input.origin;
    if (input.zabbix) {
      host.useZabbix = input.zabbix.enabled;
      host.zabbix = input.zabbix.enabled
        ? {
            hostId: input.zabbix.hostId,
            hostName: input.zabbix.hostName,
            primaryInterfaceId: input.zabbix.primaryInterfaceId,
            ip: input.zabbix.ip,
          }
        : null;
      host.sourceHealth.ZABBIX = configuredHealth(input.zabbix.enabled);
    }
    if (input.ssh) this.applySsh(host, input.ssh);
    if (input.snmp) this.applySnmp(host, input.snmp);
    host.discoveryMethod = host.snmpEnabled ? 'SNMP' : host.sshEnabled ? 'SSH' : 'MANUAL';
    host.updatedAt = new Date().toISOString();
    return this.getHost(hostId);
  }

  deleteHost(hostId: string): boolean {
    if (!this.findHost(hostId)) return false;
    this.devices = this.devices.filter((host) => host.id !== hostId);
    this.credentials.delete(hostId);
    this.maps.forEach((map) => {
      const hadNode = map.nodes.some((node) => node.deviceId === hostId);
      const hadLink = map.links.some(
        (link) => link.sourceDeviceId === hostId || link.targetDeviceId === hostId,
      );
      map.nodes = map.nodes.filter((node) => node.deviceId !== hostId);
      map.links = map.links.filter(
        (link) => link.sourceDeviceId !== hostId && link.targetDeviceId !== hostId,
      );
      if (hadNode || hadLink) this.touch(map);
    });
    this.zabbixPreviews.forEach((preview, previewId) => {
      this.zabbixPreviews.set(previewId, {
        ...preview,
        hosts: preview.hosts.map((candidate) =>
          candidate.matchedHostId === hostId
            ? { ...candidate, alreadyRegistered: false, matchedHostId: null }
            : candidate,
        ),
      });
    });
    this.discoveryPreviews.forEach((preview, previewId) => {
      if (preview.hostId === hostId) {
        this.discoveryPreviews.delete(previewId);
        return;
      }
      this.discoveryPreviews.set(previewId, {
        ...preview,
        neighbors: preview.neighbors.map((neighbor) => {
          if (neighbor.matchedDeviceId !== hostId) return neighbor;
          const withoutMatch = { ...neighbor };
          delete withoutMatch.matchedDeviceId;
          return {
            ...withoutMatch,
            matchStatus: 'UNMATCHED',
            inventoryState: 'NOT_REGISTERED',
            mapPresent: false,
            linkExists: false,
            candidateDeviceIds: neighbor.candidateDeviceIds.filter((id) => id !== hostId),
          };
        }),
      });
    });
    this.refreshMembership();
    return true;
  }

  addHostToMap(hostId: string, mapId: string, position: Position): AddDeviceResult | null {
    const host = this.findHost(hostId);
    const map = this.findMap(mapId);
    if (!host || !map) return null;
    const existing = map.nodes.find((node) => node.deviceId === hostId);
    const node: MapNode = existing ?? {
      id: createLocalId('node'),
      mapId,
      deviceId: hostId,
      position,
      locked: false,
      positionSource: 'MANUAL',
    };
    if (!existing) map.nodes.push(node);
    this.touch(map);
    this.refreshMembership();
    return { device: structuredClone(host), node: structuredClone(node) };
  }

  addHostsToMap(mapId: string, deviceIds: string[], seedPosition: Position = { x: 520, y: 340 }): AddDeviceResult[] {
    const map = this.findMap(mapId);
    if (!map) return [];
    const created: AddDeviceResult[] = [];

    deviceIds.forEach((deviceId, index) => {
      if (map.nodes.some((node) => node.deviceId === deviceId)) return;
      const host = this.findHost(deviceId);
      if (!host) return;
      const position = {
        x: seedPosition.x + (index % 4) * 120 - 180,
        y: seedPosition.y + Math.floor(index / 4) * 90,
      };
      const result = this.addHostToMap(deviceId, mapId, position);
      if (result) created.push(result);
    });

    return created;
  }

  storeZabbixPreview(
    candidates: ZabbixHostCandidate[],
    version: string,
    demoMode: boolean,
  ): ZabbixImportPreview {
    const hosts = candidates.map((candidate) => {
      const matched = this.matchHost(candidate.hostname, candidate.managementIp, candidate.hostId);
      return {
        ...candidate,
        alreadyRegistered: Boolean(matched),
        matchedHostId: matched?.id ?? null,
      };
    });
    const preview: ZabbixImportPreview = {
      id: createLocalId('zabbix-preview'),
      version,
      demoMode,
      hosts,
      createdAt: new Date().toISOString(),
    };
    this.zabbixPreviews.set(preview.id, structuredClone(preview));
    return preview;
  }

  importZabbixHosts(
    previewId: string,
    hostIds: string[],
    interfacesByHostId: Map<string, NetworkInterface[]> = new Map(),
  ): ZabbixImportResult | null {
    const preview = this.zabbixPreviews.get(previewId);
    if (!preview) return null;
    const imported: HostRecord[] = [];
    const skippedHostIds: string[] = [];
    for (const hostId of hostIds) {
      const candidate = preview.hosts.find((item) => item.hostId === hostId);
      if (
        !candidate ||
        candidate.alreadyRegistered ||
        this.matchHost(candidate.hostname, candidate.managementIp, hostId)
      ) {
        skippedHostIds.push(hostId);
        continue;
      }
      const host = this.createHost(
        {
          hostname: candidate.hostname,
          displayName: candidate.displayName,
          managementIp: candidate.managementIp,
          vendor: candidate.vendor,
          model: candidate.model,
          deviceType: 'generic',
          site: '',
          description: `Importado do Zabbix ${preview.version}`,
          notes: '',
          origin: 'ZABBIX',
          zabbix: {
            enabled: true,
            hostId: candidate.hostId,
            hostName: candidate.hostname,
            primaryInterfaceId: candidate.primaryInterfaceId,
            ip: candidate.managementIp,
          },
          ssh: { enabled: false, host: candidate.managementIp, port: 22, username: '' },
          snmp: {
            enabled: false,
            version: 'SNMP_V2C',
            host: candidate.managementIp,
            port: 161,
            username: '',
            securityLevel: 'NO_AUTH_NO_PRIV',
            authProtocol: null,
            privacyProtocol: null,
          },
        },
        interfacesByHostId.get(hostId),
      );
      const stored = this.findHost(host.id)!;
      stored.status = candidate.status;
      stored.lastPollingAt = preview.createdAt;
      stored.sourceHealth.ZABBIX = {
        state: 'CONNECTED',
        lastSuccess: preview.createdAt,
        lastFailure: null,
        lastErrorSafe: null,
      };
      imported.push(this.getHost(host.id)!);
    }
    return { imported, skippedHostIds };
  }

  createDiscoveryPreview(
    hostId: string,
    mapId: string,
    review: DiscoveryReview,
    zabbixCandidates: ZabbixHostCandidate[],
  ): AssistedDiscoveryPreview | null {
    const map = this.findMap(mapId);
    const sourceHost = this.findHost(hostId);
    if (!map || !sourceHost || !map.nodes.some((node) => node.deviceId === hostId)) return null;
    const neighbors: AssistedDiscoveredNeighbor[] = review.neighbors.map((neighbor) => {
      const identities = [
        normalize(neighbor.remoteSystemName),
        normalize(neighbor.remoteManagementAddress),
        normalize(neighbor.remoteChassisId),
      ].filter(Boolean);
      const inventoryMatches = this.devices.filter((host) =>
        [host.hostname, host.displayName, host.managementIp]
          .map(normalize)
          .some((identity) => identities.includes(identity)),
      );
      const zabbixMatches = zabbixCandidates.filter((candidate) =>
        [candidate.hostname, candidate.displayName, candidate.managementIp]
          .map(normalize)
          .some((identity) => identities.includes(identity)),
      );
      const matchedHost = inventoryMatches.length === 1 ? inventoryMatches[0] : undefined;
      const mapPresent = Boolean(
        matchedHost && map.nodes.some((node) => node.deviceId === matchedHost.id),
      );
      const linkExists = Boolean(
        matchedHost &&
        map.links.some(
          (link) =>
            (link.sourceDeviceId === hostId && link.targetDeviceId === matchedHost.id) ||
            (link.sourceDeviceId === matchedHost.id && link.targetDeviceId === hostId),
        ),
      );
      return {
        ...neighbor,
        matchStatus:
          inventoryMatches.length === 1
            ? 'MATCHED'
            : inventoryMatches.length > 1
              ? 'AMBIGUOUS'
              : 'UNMATCHED',
        ...(matchedHost ? { matchedDeviceId: matchedHost.id } : {}),
        inventoryState:
          inventoryMatches.length > 1
            ? 'AMBIGUOUS'
            : matchedHost
              ? mapPresent
                ? 'PRESENT_IN_MAP'
                : 'REGISTERED'
              : 'NOT_REGISTERED',
        zabbixState:
          zabbixMatches.length === 1
            ? 'FOUND'
            : zabbixMatches.length > 1
              ? 'AMBIGUOUS'
              : 'NOT_FOUND',
        mapPresent,
        linkExists,
        candidateDeviceIds: inventoryMatches.map((host) => host.id),
        zabbixCandidate: zabbixMatches.length === 1 ? zabbixMatches[0]! : null,
      };
    });
    const preview: AssistedDiscoveryPreview = {
      id: createLocalId('discovery-preview'),
      hostId,
      mapId,
      method: review.method,
      neighbors,
      warnings: review.warnings,
      createdAt: new Date().toISOString(),
    };
    this.discoveryPreviews.set(preview.id, structuredClone(preview));
    return preview;
  }

  applyDiscovery(
    previewId: string,
    selections: DiscoveryApplySelection[],
  ): DiscoveryApplyResult | null {
    const preview = this.discoveryPreviews.get(previewId);
    const map = preview ? this.findMap(preview.mapId) : undefined;
    const sourceHost = preview ? this.findHost(preview.hostId) : undefined;
    if (!preview || !map || !sourceHost) return null;
    const createdHosts: string[] = [];
    const addedNodes: string[] = [];
    const createdLinks: string[] = [];
    const skipped: string[] = [];
    const sourceNode = map.nodes.find((node) => node.deviceId === sourceHost.id);

    selections.forEach((selection, index) => {
      const neighbor = preview.neighbors.find((item) => item.id === selection.neighborId);
      if (!neighbor || selection.action === 'IGNORE') {
        if (neighbor) skipped.push(neighbor.id);
        return;
      }
      let target = selection.selectedDeviceId
        ? this.findHost(selection.selectedDeviceId)
        : neighbor.matchedDeviceId
          ? this.findHost(neighbor.matchedDeviceId)
          : null;
      if (!target && neighbor.zabbixCandidate && selection.action === 'ADD') {
        const result = this.storeZabbixPreview([neighbor.zabbixCandidate], 'discovery', false);
        target =
          this.importZabbixHosts(result.id, [neighbor.zabbixCandidate.hostId])?.imported[0] ?? null;
        if (target) createdHosts.push(target.id);
      }
      if (!target && selection.action === 'ADD_UNMONITORED') {
        target = this.createHost({
          hostname: neighbor.remoteSystemName,
          displayName: neighbor.remoteSystemName,
          managementIp: neighbor.remoteManagementAddress ?? '',
          vendor: '',
          model: '',
          deviceType: neighbor.capabilities.includes('router') ? 'router' : 'switch',
          site: sourceHost.site,
          description: neighbor.systemDescription ?? 'Host descoberto via LLDP',
          notes: '',
          origin: 'DISCOVERY',
          zabbix: { enabled: false, hostId: '', hostName: '', primaryInterfaceId: '', ip: '' },
          ssh: {
            enabled: false,
            host: neighbor.remoteManagementAddress ?? '',
            port: 22,
            username: '',
          },
          snmp: {
            enabled: false,
            version: 'SNMP_V2C',
            host: neighbor.remoteManagementAddress ?? '',
            port: 161,
            username: '',
            securityLevel: 'NO_AUTH_NO_PRIV',
            authProtocol: null,
            privacyProtocol: null,
          },
        });
        createdHosts.push(target.id);
      }
      if (!target) {
        skipped.push(neighbor.id);
        return;
      }

      let targetNode = map.nodes.find((node) => node.deviceId === target!.id);
      if (!targetNode && selection.action !== 'LINK_ONLY') {
        targetNode = {
          id: createLocalId('node'),
          mapId: map.id,
          deviceId: target.id,
          position: {
            x: (sourceNode?.position.x ?? 500) + 260,
            y: (sourceNode?.position.y ?? 350) + (index - selections.length / 2) * 130,
          },
          locked: false,
          positionSource: 'AUTO',
        };
        map.nodes.push(targetNode);
        addedNodes.push(targetNode.id);
      }
      if (!targetNode) {
        skipped.push(neighbor.id);
        return;
      }
      const duplicate = map.links.some(
        (link) =>
          (link.sourceDeviceId === sourceHost.id && link.targetDeviceId === target!.id) ||
          (link.sourceDeviceId === target!.id && link.targetDeviceId === sourceHost.id),
      );
      if (duplicate) {
        skipped.push(neighbor.id);
        return;
      }
      const sourceInterface = this.ensureInterface(sourceHost, neighbor.localPort);
      const targetInterface = this.ensureInterface(target, neighbor.remotePort);
      const capacity = Math.max(1, Math.min(sourceInterface.speedBps, targetInterface.speedBps));
      const link = this.createLink(map.id, {
        sourceDeviceId: sourceHost.id,
        sourceInterfaceId: sourceInterface.id,
        targetDeviceId: target.id,
        targetInterfaceId: targetInterface.id,
        capacityBps: capacity,
        autoCapacityBps: capacity,
        capacitySource: 'AUTO',
        label: 'LLDP DISCOVERED',
        metricSource: target.useZabbix || sourceHost.useZabbix ? 'ZABBIX' : 'DEMO',
        visualStyle: null,
        metricDisplay: null,
      });
      if (link) {
        const stored = map.links.find((item) => item.id === link.id);
        if (stored) stored.discoverySource = neighbor.source;
        createdLinks.push(link.id);
      }
    });
    this.discoveryPreviews.delete(previewId);
    sourceHost.lastDiscoveryAt = new Date().toISOString();
    this.touch(map);
    this.refreshMembership();
    return {
      map: this.materialize(map),
      createdHosts,
      addedNodes,
      createdLinks,
      skipped,
    };
  }

  updateSourceHealth(hostId: string, result: ConnectionTestResult): HostRecord | null {
    const host = this.findHost(hostId);
    if (!host) return null;
    const now = result.checkedAt;
    host.sourceHealth[result.source] = {
      state: result.state,
      lastSuccess:
        result.state === 'CONNECTED' ? now : host.sourceHealth[result.source].lastSuccess,
      lastFailure: result.state === 'CONNECTED' || result.state === 'DISABLED' ? null : now,
      lastErrorSafe:
        result.state === 'CONNECTED' || result.state === 'DISABLED' ? null : result.message,
    };
    host.updatedAt = now;
    return this.getHost(hostId);
  }

  listMaps(): MapSummary[] {
    return this.maps.map((map) => this.summary(map));
  }

  getMap(mapId: string): NetworkMap | null {
    const map = this.findMap(mapId);
    return map ? this.materialize(map) : null;
  }

  getDefaultMap(): NetworkMap | null {
    const map = this.maps.find((item) => item.isDefault) ?? this.maps[0];
    return map ? this.materialize(map) : null;
  }

  createMap(input: CreateMapInput): NetworkMap {
    const timestamp = new Date().toISOString();
    const id = createLocalId('map');
    const source = input.sourceMapId ? this.findMap(input.sourceMapId) : undefined;
    const map: StoredMap = source
      ? {
          ...structuredClone(source),
          id,
          name: input.name,
          description: input.description,
          mode: input.mode,
          isDefault: false,
          nodes: source.nodes.map((node) => ({ ...node, id: createLocalId('node'), mapId: id })),
          links: source.links.map((link) => ({
            ...link,
            id: createLocalId('link'),
            mapId: id,
            createdAt: timestamp,
            updatedAt: timestamp,
          })),
          createdAt: timestamp,
          updatedAt: timestamp,
        }
      : {
          id,
          name: input.name,
          description: input.description,
          mode: input.mode,
          isDefault: this.maps.length === 0,
          settings: structuredClone(blankSettings),
          nodes: [],
          links: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        };
    this.maps.push(map);
    this.refreshMembership();
    return this.materialize(map);
  }

  updateMap(mapId: string, input: UpdateMapInput): NetworkMap | null {
    const map = this.findMap(mapId);
    if (!map) return null;
    if (input.name !== undefined) map.name = input.name;
    if (input.description !== undefined) map.description = input.description;
    if (input.mode !== undefined) map.mode = input.mode;
    if (input.settings) {
      map.settings = {
        ...map.settings,
        ...input.settings,
        filters: { ...map.settings.filters, ...input.settings.filters },
        viewport: { ...map.settings.viewport, ...input.settings.viewport },
      };
    }
    if (input.isDefault) {
      this.maps.forEach((item) => {
        item.isDefault = item.id === mapId;
      });
    }
    this.touch(map);
    return this.materialize(map);
  }

  deleteMap(mapId: string): boolean {
    if (this.maps.length <= 1) return false;
    const map = this.findMap(mapId);
    if (!map) return false;
    this.maps = this.maps.filter((item) => item.id !== mapId);
    this.playlists = this.playlists.map((playlist) => ({
      ...playlist,
      items: playlist.items
        .filter((item) => item.mapId !== mapId)
        .map((item, order) => ({ ...item, order })),
      updatedAt: new Date().toISOString(),
    }));
    if (map.isDefault && this.maps[0]) this.maps[0].isDefault = true;
    this.refreshMembership();
    return true;
  }

  listPlaylists(): MapPlaylist[] {
    return structuredClone(this.playlists);
  }

  savePlaylist(input: {
    id?: string;
    name: string;
    rotationIntervalSeconds: number;
    mapIds: string[];
    isDefault: boolean;
  }): MapPlaylist {
    const timestamp = new Date().toISOString();
    const existing = input.id ? this.playlists.find((item) => item.id === input.id) : undefined;
    if (input.isDefault) {
      this.playlists = this.playlists.map((item) => ({ ...item, isDefault: false }));
    }
    const playlist: MapPlaylist = {
      id: existing?.id ?? createLocalId('playlist'),
      name: input.name,
      rotationIntervalSeconds: input.rotationIntervalSeconds,
      isDefault: input.isDefault,
      items: input.mapIds.map((mapId, order) => ({ mapId, order })),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.playlists = existing
      ? this.playlists.map((item) => (item.id === existing.id ? playlist : item))
      : [...this.playlists, playlist];
    return structuredClone(playlist);
  }

  updatePositions(mapId: string, updates: NodePositionUpdate[]): NetworkMap | null {
    const map = this.findMap(mapId);
    if (!map) return null;
    const byId = new Map(updates.map((item) => [item.nodeId, item]));
    map.nodes = map.nodes.map((node) => {
      const update = byId.get(node.id);
      if (!update) return node;
      return {
        ...node,
        position: update.position,
        positionSource: 'MANUAL',
        ...(update.locked === undefined ? {} : { locked: update.locked }),
      };
    });
    this.touch(map);
    return this.materialize(map);
  }

  setNodeLocked(mapId: string, nodeId: string, locked: boolean): NetworkMap | null {
    const map = this.findMap(mapId);
    if (!map) return null;
    map.nodes = map.nodes.map((node) => (node.id === nodeId ? { ...node, locked } : node));
    this.touch(map);
    return this.materialize(map);
  }

  createLink(mapId: string, input: CreateLinkInput): NetworkLink | null {
    return this.createDiscoveredLink(mapId, input, 'MANUAL');
  }

  createDiscoveredLink(
    mapId: string,
    input: CreateLinkInput,
    discoverySource: NetworkLink['discoverySource'],
  ): NetworkLink | null {
    const map = this.findMap(mapId);
    if (!map) return null;
    const timestamp = new Date().toISOString();
    const link: NetworkLink = {
      id: createLocalId('link'),
      mapId,
      ...input,
      status: 'UP',
      discoverySource,
      directions: {
        A_TO_B: { bps: 0, utilization: 0 },
        B_TO_A: { bps: 0, utilization: 0 },
      },
      rxBps: 0,
      txBps: 0,
      rxUtilization: 0,
      txUtilization: 0,
      rxErrors: 0,
      txErrors: 0,
      rxDiscards: 0,
      txDiscards: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    map.links.push(link);
    this.touch(map);
    return structuredClone(link);
  }

  updateLink(
    mapId: string,
    linkId: string,
    input: Pick<
      CreateLinkInput,
      | 'capacityBps'
      | 'autoCapacityBps'
      | 'capacitySource'
      | 'label'
      | 'metricSource'
      | 'visualStyle'
      | 'metricDisplay'
    >,
  ): NetworkLink | null {
    const map = this.findMap(mapId);
    if (!map) return null;
    const link = map.links.find((item) => item.id === linkId);
    if (!link) return null;
    Object.assign(link, input, { updatedAt: new Date().toISOString() });
    link.directions = {
      A_TO_B: {
        ...link.directions.A_TO_B,
        utilization: calculateUtilization(link.directions.A_TO_B.bps, link.capacityBps),
      },
      B_TO_A: {
        ...link.directions.B_TO_A,
        utilization: calculateUtilization(link.directions.B_TO_A.bps, link.capacityBps),
      },
    };
    link.txUtilization = link.directions.A_TO_B.utilization;
    link.rxUtilization = link.directions.B_TO_A.utilization;
    this.touch(map);
    return structuredClone(link);
  }

  deleteLink(mapId: string, linkId: string): boolean {
    const map = this.findMap(mapId);
    if (!map) return false;
    const count = map.links.length;
    map.links = map.links.filter((item) => item.id !== linkId);
    if (count === map.links.length) return false;
    this.touch(map);
    return true;
  }

  addDevice(mapId: string, input: CreateDeviceInput): AddDeviceResult | null {
    const map = this.findMap(mapId);
    if (!map) return null;
    const host = this.createHost({
      hostname: input.hostname,
      displayName: input.name,
      managementIp: input.ip,
      vendor: input.vendor,
      model: input.model,
      deviceType: input.deviceType,
      site: input.site,
      description: '',
      notes: '',
      origin: 'MANUAL',
      zabbix: { enabled: false, hostId: '', hostName: '', primaryInterfaceId: '', ip: '' },
      ssh: { enabled: false, host: input.ip, port: 22, username: '' },
      snmp: {
        enabled: false,
        version: 'SNMP_V2C',
        host: input.ip,
        port: 161,
        username: '',
        securityLevel: 'NO_AUTH_NO_PRIV',
        authProtocol: null,
        privacyProtocol: null,
      },
    });
    return this.addHostToMap(host.id, mapId, input.position);
  }

  deleteDevice(mapId: string, deviceId: string): boolean {
    const map = this.findMap(mapId);
    if (!map || !map.nodes.some((item) => item.deviceId === deviceId)) return false;
    map.nodes = map.nodes.filter((item) => item.deviceId !== deviceId);
    map.links = map.links.filter(
      (item) => item.sourceDeviceId !== deviceId && item.targetDeviceId !== deviceId,
    );
    this.touch(map);
    this.refreshMembership();
    return true;
  }

  private applySsh(host: HostRecord, input: SshHostInput): void {
    host.sshEnabled = input.enabled;
    if (!input.enabled) {
      host.ssh = null;
      host.sourceHealth.SSH = disabledHealth();
      return;
    }
    const stored = this.credentials.get(host.id) ?? {};
    if (input.clearCredential) delete stored.ssh;
    if (input.password) {
      if (!this.vault) throw new CredentialEncryptionUnavailableError();
      stored.ssh = this.vault.encrypt({ type: 'PASSWORD', password: input.password });
    }
    this.credentials.set(host.id, stored);
    host.ssh = {
      host: input.host || host.managementIp,
      port: input.port,
      username: input.username,
      credentialConfigured: Boolean(stored.ssh),
      authenticationType: 'PASSWORD',
    };
    host.sourceHealth.SSH = configuredHealth(true);
  }

  private assertCredentialEncryption(
    ssh: SshHostInput | undefined,
    snmp: SnmpHostInput | undefined,
  ): void {
    if (
      !this.vault &&
      (Boolean(ssh?.password) ||
        Boolean(snmp?.community) ||
        Boolean(snmp?.authPassword) ||
        Boolean(snmp?.privacyPassword))
    ) {
      throw new CredentialEncryptionUnavailableError();
    }
  }

  private applySnmp(host: HostRecord, input: SnmpHostInput): void {
    host.snmpEnabled = input.enabled;
    if (!input.enabled) {
      host.snmp = null;
      host.sourceHealth.SNMP = disabledHealth();
      return;
    }
    const stored = this.credentials.get(host.id) ?? {};
    if (input.clearCredential) delete stored.snmp;
    const hasNewSecret = Boolean(input.community || input.authPassword || input.privacyPassword);
    if (hasNewSecret) {
      if (!this.vault) throw new CredentialEncryptionUnavailableError();
      stored.snmp = this.vault.encrypt({
        version: input.version,
        ...(input.community ? { community: input.community } : {}),
        ...(input.authPassword ? { authPassword: input.authPassword } : {}),
        ...(input.privacyPassword ? { privacyPassword: input.privacyPassword } : {}),
      });
    }
    this.credentials.set(host.id, stored);
    host.snmp = {
      version: input.version,
      host: input.host || host.managementIp,
      port: input.port,
      username: input.username,
      securityLevel: input.securityLevel,
      authProtocol: input.authProtocol,
      privacyProtocol: input.privacyProtocol,
      credentialConfigured: Boolean(stored.snmp),
    };
    host.sourceHealth.SNMP = configuredHealth(true);
  }

  /**
   * Get decrypted SNMP credentials for a host.
   * Returns community and auth details in plaintext (only in memory).
   * Never logs or exposes this data.
   */
  async getDecryptedSnmpCredentials(
    hostId: string,
  ): Promise<{ community?: string; authPassword?: string; privacyPassword?: string } | null> {
    const stored = this.credentials.get(hostId);
    if (!stored?.snmp || !this.vault) {
      return null;
    }
    try {
      const decrypted = this.vault.decrypt(stored.snmp) as Record<string, unknown>;
      return {
        ...(typeof decrypted.community === 'string' ? { community: decrypted.community } : {}),
        ...(typeof decrypted.authPassword === 'string' ? { authPassword: decrypted.authPassword } : {}),
        ...(typeof decrypted.privacyPassword === 'string' ? { privacyPassword: decrypted.privacyPassword } : {}),
      };
    } catch {
      return null;
    }
  }

  /** Decrypts an SSH password only for the backend transport. */
  async getDecryptedSshCredentials(hostId: string): Promise<{ password?: string } | null> {
    const stored = this.credentials.get(hostId);
    if (!stored?.ssh || !this.vault) return null;
    try {
      const decrypted = this.vault.decrypt(stored.ssh);
      return typeof decrypted.password === 'string' ? { password: decrypted.password } : null;
    } catch {
      return null;
    }
  }

  private ensureInterface(host: HostRecord, name: string): NetworkInterface {
    const existing = host.interfaces.find(
      (item) =>
        normalize(item.name) === normalize(name) || normalize(item.alias) === normalize(name),
    );
    if (existing) return existing;
    const networkInterface: NetworkInterface = {
      ...defaultInterfaces(host.id, 'SNMP')[0]!,
      id: createLocalId('interface'),
      name,
      alias: '',
      description: 'Interface descoberta por LLDP',
      ifIndex: Math.max(0, ...host.interfaces.map((item) => item.ifIndex)) + 1,
      dataSources: ['SNMP'],
    };
    host.interfaces.push(networkInterface);
    return networkInterface;
  }

  private findMap(mapId: string): StoredMap | undefined {
    return this.maps.find((item) => item.id === mapId);
  }

  private findHost(hostId: string): HostRecord | undefined {
    return this.devices.find((item) => item.id === hostId);
  }

  private matchHost(hostname: string, ip: string, zabbixHostId?: string): HostRecord | undefined {
    return this.devices.find(
      (host) =>
        normalize(host.hostname) === normalize(hostname) ||
        Boolean(ip && host.managementIp === ip) ||
        Boolean(zabbixHostId && host.zabbix?.hostId === zabbixHostId),
    );
  }

  private refreshMembership(): void {
    this.devices.forEach((host) => {
      host.mapIds = this.maps
        .filter((map) => map.nodes.some((node) => node.deviceId === host.id))
        .map((map) => map.id);
      host.mapCount = host.mapIds.length;
    });
  }

  private materialize(map: StoredMap): NetworkMap {
    this.refreshMembership();
    return structuredClone({ ...map, devices: this.devices });
  }

  private summary(map: StoredMap): MapSummary {
    return {
      id: map.id,
      name: map.name,
      description: map.description,
      mode: map.mode,
      isDefault: map.isDefault,
      nodeCount: map.nodes.length,
      linkCount: map.links.length,
      createdAt: map.createdAt,
      updatedAt: map.updatedAt,
    };
  }

  private touch(map: StoredMap): void {
    map.updatedAt = new Date().toISOString();
  }
}
