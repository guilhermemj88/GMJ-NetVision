import type { DiscoveredNeighbor, NetworkInterface } from '@gmj/shared';
import type { DeviceIdentity, SshDeviceDriver } from '../../domain/ports';

export class HuaweiVrpDriver implements SshDeviceDriver {
  readonly vendor = 'Huawei VRP';

  identityCommands(): string[] {
    return ['screen-length 0 temporary', 'display version'];
  }

  interfaceCommands(): string[] {
    return ['screen-length 0 temporary', 'display interface description'];
  }

  neighborCommands(): string[] {
    return ['screen-length 0 temporary', 'display lldp neighbor brief', 'display lldp neighbor'];
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

  parseNeighbors(deviceId: string, output: string): DiscoveredNeighbor[] {
    const blocks = output.split(/-{8,}/);
    return blocks.flatMap((block, index) => {
      const localPort = block.match(/Local interface\s*:\s*(.+)/i)?.[1]?.trim();
      const remoteSystemName = block.match(/System name\s*:\s*(.+)/i)?.[1]?.trim();
      const remotePort = block.match(/Port ID\s*:\s*(.+)/i)?.[1]?.trim();
      if (!localPort || !remoteSystemName || !remotePort) return [];
      const chassis = block.match(/Chassis ID\s*:\s*(.+)/i)?.[1]?.trim();
      const description = block.match(/Port description\s*:\s*(.+)/i)?.[1]?.trim();
      return [
        {
          id: `ssh-${deviceId}-${index}`,
          localDeviceId: deviceId,
          localPort,
          remoteSystemName,
          ...(chassis ? { remoteChassisId: chassis } : {}),
          remotePort,
          ...(description ? { remotePortDescription: description } : {}),
          capabilities: [],
          source: 'LLDP_SSH' as const,
          matchStatus: 'UNMATCHED' as const,
        },
      ];
    });
  }
}
