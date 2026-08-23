import type { DiscoveredNeighbor, NetworkInterface, OpticalLaneReading } from '@gmj/shared';
import type { DeviceIdentity, SshDeviceDriver } from '../../domain/ports';
import { normalizeOpticalDbm } from './optical-power';

export interface HuaweiOpticalReading {
  name: string;
  rxPowerDbm: number | null;
  txPowerDbm: number | null;
  opticalLanes: OpticalLaneReading[];
}

function field(block: string, pattern: RegExp): string | undefined {
  const value = block.match(pattern)?.[1]?.trim();
  return value || undefined;
}

function looksLikeInterface(value: string, allowNumeric = false): boolean {
  const candidate = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9./:_-]*$/.test(candidate)) return false;
  if (/^\d+$/.test(candidate)) return allowNumeric;
  if (!/\d/.test(candidate)) return false;
  return (
    candidate.includes('/') ||
    /^(?:Eth-?Trunk|Port-Channel|Bundle-Ether|Vlanif|LoopBack|MEth|Ethernet|GigabitEthernet|XGigabitEthernet|\d*(?:X?GE|FE))/i.test(
      candidate,
    )
  );
}

function parseLaneSection(block: string, label: RegExp): Map<number, number> {
  const lines = block.split(/\r?\n/);
  const result = new Map<number, number>();
  let collecting = false;

  for (const line of lines) {
    if (!collecting) {
      if (!label.test(line)) continue;
      collecting = true;
    } else {
      const metricHeading = line.match(/^\s*(TxPower|RxPower|Current|Temp|Voltage)\b/i)?.[1];
      if (metricHeading && !label.test(line)) break;
    }

    for (const match of line.matchAll(/(-?\d+(?:\.\d+)?)\s*\(lane(\d+)\)/gi)) {
      const value = Number(match[1]);
      const lane = Number(match[2]);
      if (Number.isFinite(value) && Number.isInteger(lane)) result.set(lane, value);
    }
  }
  return result;
}

function parseOpticalLanes(block: string): OpticalLaneReading[] {
  const tx = parseLaneSection(block, /^\s*TxPower\s*\(\s*dBm\s*\)/i);
  const rx = parseLaneSection(block, /^\s*RxPower\s*\(\s*dBm\s*\)/i);
  const bias = parseLaneSection(block, /^\s*Current\s*\(\s*mA\s*\)/i);
  const lanes = [...new Set([...tx.keys(), ...rx.keys(), ...bias.keys()])].sort((a, b) => a - b);

  return lanes.map((lane) => ({
    lane,
    rxPowerDbm: normalizeOpticalDbm(rx.get(lane)),
    txPowerDbm: normalizeOpticalDbm(tx.get(lane)),
    ...(bias.has(lane) ? { biasCurrentMa: bias.get(lane) ?? null } : {}),
  }));
}

export class HuaweiVrpDriver implements SshDeviceDriver {
  readonly vendor = 'Huawei VRP';

  identityCommands(): string[] {
    return ['screen-length 0 temporary', 'display version'];
  }

  interfaceCommands(): string[] {
    return ['screen-length 0 temporary', 'display interface description'];
  }

  opticalCommands(): string[] {
    return ['screen-length 0 temporary', 'display transceiver verbose'];
  }

  neighborCommands(): string[] {
    return ['screen-length 0 temporary', 'display lldp neighbor'];
  }

  neighborFallbackCommands(): string[] {
    return ['screen-length 0 temporary', 'display lldp neighbor brief'];
  }

  shouldFallbackNeighborCommand(output: string): boolean {
    if (this.parseNeighbors('probe', output).length > 0) return false;
    const reportsNoNeighbors =
      /\bno\s+(?:lldp\s+)?neighbou?rs?\b/i.test(output) ||
      /\b(?:has|total(?:\s+entries\s+displayed)?\s*[:=]?)\s*0\s+neighbou?r/i.test(output) ||
      /\b0\s+neighbou?r\(s\)/i.test(output);
    return !reportsNoNeighbors;
  }

  neighborInterfaceCommands(neighborInterface: string): string[] {
    return [
      'screen-length 0 temporary',
      `display lldp neighbor interface ${neighborInterface} verbose`,
    ];
  }

  parseIdentity(output: string): DeviceIdentity {
    const hostname = output.match(/<([^>]+)>/)?.[1];
    const version = output.match(/VRP \(R\) software, Version ([^\r\n]+)/i)?.[1];
    const model = output.match(/HUAWEI\s+([A-Z0-9-]+)\s+Router uptime/i)?.[1];
    return {
      ...(hostname ? { hostname } : {}),
      vendor: 'Huawei',
      ...(model ? { model } : {}),
      ...(version ? { systemDescription: `Huawei VRP ${version}` } : {}),
    };
  }

  parseInterfaces(deviceId: string, output: string): NetworkInterface[] {
    const lines = output.split(/\r?\n/);
    let ifIndex = 1;
    return lines.flatMap((line) => {
      const match = line.match(
        /^\s*([A-Za-z0-9][\w./-]+)\s+(up|down|\*down)\s+(up|down|\*down)(?:\s+(.*?))?\s*$/i,
      );
      if (!match?.[1] || !match[2] || !match[3]) return [];
      const name = match[1];
      const physicalState = match[2].toLowerCase();
      const protocolState = match[3].toLowerCase();
      const adminUp = !physicalState.startsWith('*');
      const operUp = physicalState === 'up' && protocolState === 'up';
      const configuredDescription = match[4]?.trim() ?? '';
      return [
        {
          id: `${deviceId}-ssh-${ifIndex}`,
          deviceId,
          name,
          alias: configuredDescription,
          description: '',
          ifIndex: ifIndex++,
          mac: '',
          mtu: 1500,
          speedBps: 0,
          adminStatus: adminUp ? 'UP' : 'DOWN',
          operStatus: !adminUp ? 'DISABLED' : operUp ? 'UP' : 'DOWN',
          rxBps: 0,
          txBps: 0,
          rxUtilization: 0,
          txUtilization: 0,
          rxErrors: 0,
          txErrors: 0,
          rxDiscards: 0,
          txDiscards: 0,
          dataSources: ['SSH'],
        },
      ];
    });
  }

  parseOpticalPower(output: string): HuaweiOpticalReading[] {
    const starts = [...output.matchAll(/^\s*(?:Port\s+)?(.+?)\s+transceiver(?:\s+diagnostic)?\s+information\s*:/gim)];
    return starts.flatMap((match, index) => {
      const name = match[1]?.trim();
      if (!name || match.index === undefined) return [];
      const end = starts[index + 1]?.index ?? output.length;
      const block = output.slice(match.index, end);
      const opticalLanes = parseOpticalLanes(block);

      const rx =
        block.match(
          /(?:Current\s*)?R\s*X\s*Power\s*(?:\(\s*dBm\s*\))?\s*[:=]\s*(-?\d+(?:\.\d+)?)/i,
        )?.[1] ?? block.match(/RxPower\s*(?:\(\s*dBm\s*\))?\s*[:=]\s*(-?\d+(?:\.\d+)?)/i)?.[1];
      const tx =
        block.match(
          /(?:Current\s*)?T\s*X\s*Power\s*(?:\(\s*dBm\s*\))?\s*[:=]\s*(-?\d+(?:\.\d+)?)/i,
        )?.[1] ?? block.match(/TxPower\s*(?:\(\s*dBm\s*\))?\s*[:=]\s*(-?\d+(?:\.\d+)?)/i)?.[1];

      const lane0 = opticalLanes.find((lane) => lane.lane === 0) ?? opticalLanes[0];
      const rxPowerDbm = normalizeOpticalDbm(rx) ?? lane0?.rxPowerDbm ?? null;
      const txPowerDbm = normalizeOpticalDbm(tx) ?? lane0?.txPowerDbm ?? null;
      if (rxPowerDbm === null && txPowerDbm === null && opticalLanes.length === 0) return [];
      return [
        {
          name,
          rxPowerDbm,
          txPowerDbm,
          opticalLanes,
        },
      ];
    });
  }

  parseNeighbors(deviceId: string, output: string): DiscoveredNeighbor[] {
    const verbose = this.parseNeighborsVerbose(deviceId, output);
    if (verbose.length) return verbose;
    return this.parseNeighborsBrief(deviceId, output);
  }

  private parseNeighborsVerbose(deviceId: string, output: string): DiscoveredNeighbor[] {
    const candidates: Array<{ localPort?: string; lines: string[] }> = [];
    let currentLocalPort: string | undefined;
    let currentLines: string[] = [];

    const flush = (): void => {
      if (currentLines.some((line) => line.trim())) {
        candidates.push({
          ...(currentLocalPort ? { localPort: currentLocalPort } : {}),
          lines: currentLines,
        });
      }
      currentLines = [];
    };

    for (const line of output.split(/\r?\n/)) {
      const heading = line.match(/^\s*(\S+)\s+has\s+\d+\s+neighbou?r(?:\(s\)|s)?\s*:?\s*$/i);
      if (heading?.[1]) {
        flush();
        currentLocalPort = heading[1].trim();
        continue;
      }

      if (/^\s*Neighbor\s+index\s*:/i.test(line)) flush();

      const localField = line.match(/^\s*Local\s+interface\s*:\s*(.+?)\s*$/i)?.[1]?.trim();
      if (localField) {
        if (currentLines.some((item) => /^\s*Local\s+interface\s*:/i.test(item))) flush();
        currentLocalPort = localField;
      }
      currentLines.push(line);
    }
    flush();

    return candidates.flatMap((candidate, index) => {
      const block = candidate.lines.join('\n');
      const localPort =
        field(block, /^\s*Local\s+interface\s*:\s*(.+?)\s*$/im) ?? candidate.localPort;
      const systemName = field(block, /^\s*System\s+name\s*:\s*(.+?)\s*$/im);
      const chassis = field(block, /^\s*Chassis\s+ID\s*:\s*(.+?)\s*$/im);
      const systemDescription = field(block, /^\s*System\s+description\s*:\s*(.+?)\s*$/im);
      const remoteSystemName = systemName ?? chassis ?? systemDescription;
      const remotePort = field(block, /^\s*Port\s+ID\s*:\s*(.+?)\s*$/im);
      if (!localPort || !remoteSystemName || !remotePort) return [];
      const description = field(block, /^\s*Port\s+description\s*:\s*(.+?)\s*$/im);
      const managementAddress = field(
        block,
        /^\s*Management\s+address(?:\s+value)?\s*:\s*(.+?)\s*$/im,
      );
      const capabilitiesValue =
        field(block, /^\s*System\s+capabilities\s+enabled\s*:\s*(.+?)\s*$/im) ??
        field(block, /^\s*System\s+capabilities\s+supported\s*:\s*(.+?)\s*$/im) ??
        field(block, /^\s*System\s+capabilities\s*:\s*(.+?)\s*$/im);
      const capabilities = capabilitiesValue
        ? capabilitiesValue
            .split(/[\s,]+/)
            .map((item) => item.trim().toLowerCase())
            .filter(Boolean)
        : [];
      return [
        {
          id: `ssh-${deviceId}-${index}`,
          localDeviceId: deviceId,
          localPort,
          remoteSystemName,
          ...(chassis ? { remoteChassisId: chassis } : {}),
          ...(managementAddress ? { remoteManagementAddress: managementAddress } : {}),
          remotePort,
          ...(description ? { remotePortDescription: description } : {}),
          ...(systemDescription ? { systemDescription } : {}),
          capabilities,
          source: 'LLDP_SSH' as const,
          matchStatus: 'UNMATCHED' as const,
        },
      ];
    });
  }

  /**
   * Parses `display lldp neighbor brief`, whose columns are
   * Local Intf | Neighbor Dev | Neighbor Intf | Exptime(s).
   */
  parseNeighborsBrief(deviceId: string, output: string): DiscoveredNeighbor[] {
    const lines = output.split(/\r?\n/);
    const headerPattern = /local\s+intf|neighbor\s+dev|exptime/i;
    const separatorPattern = /^-{3,}/;
    return lines.flatMap((line, index) => {
      if (!line.trim() || headerPattern.test(line) || separatorPattern.test(line)) return [];
      const parts = line.trim().split(/\s+/).filter(Boolean);
      if (parts.length < 4) return [];
      const expires = parts.at(-1);
      const remotePort = parts.at(-2);
      const localPort = parts[0];
      const remoteSystemName = parts.slice(1, -2).join(' ');
      if (!expires || !/^\d+s?$/i.test(expires)) return [];
      if (!localPort || !looksLikeInterface(localPort)) return [];
      if (!remotePort || !looksLikeInterface(remotePort, true)) return [];
      if (!remoteSystemName) return [];
      return [
        {
          id: `ssh-${deviceId}-brief-${index}`,
          localDeviceId: deviceId,
          localPort,
          remoteSystemName,
          remotePort,
          capabilities: [],
          source: 'LLDP_SSH' as const,
          matchStatus: 'UNMATCHED' as const,
        },
      ];
    });
  }
}