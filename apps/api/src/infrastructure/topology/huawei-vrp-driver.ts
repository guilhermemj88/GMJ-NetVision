import type {
  DiscoveredNeighbor,
  NetworkInterface,
  OpticalLaneReading,
  OpticalThresholdSide,
  OpticalThresholdSource,
} from '@gmj/shared';
import type { DeviceIdentity, SshDeviceDriver } from '../../domain/ports';
import { normalizeHuaweiBiasCurrentMa } from './huawei-optical';
import { normalizeOpticalDbm } from './optical-power';
import {
  assignOpticalThresholdSide,
  emptyHuaweiOpticalThresholds,
  emptyOpticalThresholdSide,
  hasUsefulOpticalThresholds,
  type HuaweiOpticalThresholds,
} from './optical-thresholds';

export interface HuaweiOpticalReading {
  name: string;
  rxPowerDbm: number | null;
  txPowerDbm: number | null;
  opticalLanes: OpticalLaneReading[];
  thresholds: HuaweiOpticalThresholds;
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

export function huaweiMultiLaneInterfaceName(value: string): string | null {
  const compact = value.trim().replace(/\s+/g, '');
  return /^(?:40|100|200|400|800)GE\d+(?:\/\d+){2,}$/i.test(compact) ? compact : null;
}

export function huaweiVerboseInterfaceName(value: string): string | null {
  const compact = huaweiMultiLaneInterfaceName(value);
  if (!compact) return null;
  return compact.replace(/^((?:40|100|200|400|800)GE)(?=\d)/i, '$1 ');
}

export function huaweiDiagnosisCommand(value: string): string | null {
  const name = huaweiMultiLaneInterfaceName(value);
  return name ? `display transceiver diagnosis interface ${name}` : null;
}

export function huaweiInterfaceTransceiverVerboseCommand(value: string): string | null {
  const name = huaweiVerboseInterfaceName(value);
  return name ? `display interface ${name} transceiver verbose` : null;
}

type LaneMetric = 'rx' | 'tx' | 'bias';

function laneMetricHeading(line: string): LaneMetric | null {
  if (/^\s*(?:Current\s+)?RX\s+Power\s*\(\s*dBm\s*\)/i.test(line)
    || /^\s*RxPower\s*\(\s*dBm\s*\)/i.test(line)) return 'rx';
  if (/^\s*(?:Current\s+)?TX\s+Power\s*\(\s*dBm\s*\)/i.test(line)
    || /^\s*TxPower\s*\(\s*dBm\s*\)/i.test(line)) return 'tx';
  if (/^\s*Bias\s+Current\s*\(\s*mA\s*\)/i.test(line)
    || /^\s*Current\s*\(\s*mA\s*\)/i.test(line)) return 'bias';
  return null;
}

function laneMetricValue(metric: LaneMetric, value: string): number | null {
  if (!value.trim()) return null;
  if (metric === 'rx' || metric === 'tx') return normalizeOpticalDbm(value);
  return normalizeHuaweiBiasCurrentMa(value);
}

function parseOpticalLanes(block: string): OpticalLaneReading[] {
  const values: Record<LaneMetric, Map<number, number>> = {
    rx: new Map(),
    tx: new Map(),
    bias: new Map(),
  };
  let metric: LaneMetric | null = null;

  for (const line of block.split(/\r?\n/)) {
    const heading = laneMetricHeading(line);
    if (heading) {
      metric = heading;
    } else if (/^\s*(?:Temperature|Temp|Voltage)\s*\(/i.test(line)) {
      metric = null;
    }
    if (!metric) continue;

    // Older VRP format: one value followed by one `(laneN)` annotation.
    for (const match of line.matchAll(/(-?\d+(?:\.\d+)?)\s*\(\s*lane\s*(\d+)\s*\)/gi)) {
      const value = laneMetricValue(metric, match[1] ?? '');
      const lane = Number(match[2]);
      if (value !== null && Number.isInteger(lane)) values[metric].set(lane, value);
    }

    // Newer VRP format: pipe-delimited values and an explicit pipe-delimited lane list.
    const annotation = [...line.matchAll(/\(([^)]*\blane\s*\d+(?:\s*\|\s*lane\s*\d+)+[^)]*)\)/gi)].at(-1);
    if (!annotation || annotation.index === undefined) continue;
    const lanes = [...(annotation[1] ?? '').matchAll(/lane\s*(\d+)/gi)]
      .map((match) => Number(match[1]));
    const prefix = line.slice(0, annotation.index);
    const valueText = prefix.includes(':') ? prefix.slice(prefix.lastIndexOf(':') + 1) : prefix;
    const laneValues = valueText.split('|').map((value) => value.trim());
    lanes.forEach((lane, index) => {
      if (!metric) return;
      const value = laneMetricValue(metric, laneValues[index] ?? '');
      if (Number.isInteger(lane) && value !== null) values[metric].set(lane, value);
    });
  }

  const lanes = [...new Set([
    ...values.rx.keys(),
    ...values.tx.keys(),
    ...values.bias.keys(),
  ])].sort((a, b) => a - b);

  return lanes.map((lane) => ({
    lane,
    rxPowerDbm: values.rx.get(lane) ?? null,
    txPowerDbm: values.tx.get(lane) ?? null,
    ...(values.bias.has(lane) ? { biasCurrentMa: values.bias.get(lane) ?? null } : {}),
  }));
}

type ThresholdMetric = 'rx' | 'tx';

interface ThresholdHit {
  metric: ThresholdMetric;
  side: 'low' | 'high';
  lane: number | null;
  value: number;
  source: OpticalThresholdSource;
}

/** Marcadores de bloco (`User Set/Default/Device Thresholds:`) que valem para as linhas seguintes. */
function thresholdSourceContext(line: string): OpticalThresholdSource | null {
  if (/^\s*user\s*(?:set)?\s+thresholds?\s*:?\s*$/i.test(line)) return 'USER';
  if (/^\s*default\s+thresholds?\s*:?\s*$/i.test(line)) return 'DEFAULT';
  if (/^\s*device\s+thresholds?\s*:?\s*$/i.test(line)) return 'DEVICE';
  return null;
}

function explicitThresholdSource(line: string): OpticalThresholdSource | null {
  if (/user\s*set/i.test(line) || /\buser\b/i.test(line)) return 'USER';
  if (/\bdefault\b/i.test(line)) return 'DEFAULT';
  if (/\bdevice\b/i.test(line)) return 'DEVICE';
  return null;
}

/** Linha escalar `RX Power (High Alarm Threshold) : -1.00 dBm` (verbose). */
function parseThresholdLine(line: string, context: OpticalThresholdSource | null): ThresholdHit | null {
  const valueMatch = /(?:=|:)\s*(-?\d+(?:\.\d+)?)/.exec(line);
  if (!valueMatch || valueMatch.index === undefined) return null;
  const label = line.slice(0, valueMatch.index);
  if (!/threshold/i.test(label) || !/alarm/i.test(label)) return null;
  const metric: ThresholdMetric | null = /(?:^|[^a-z])r\s*x\s*power/i.test(label)
    ? 'rx'
    : /(?:^|[^a-z])t\s*x\s*power/i.test(label)
      ? 'tx'
      : null;
  if (!metric) return null;
  const hasLow = /\blow\b/i.test(label);
  const hasHigh = /\bhigh\b/i.test(label);
  if (hasLow === hasHigh) return null;
  const value = normalizeOpticalDbm(valueMatch[1]);
  if (value === null) return null;
  const lane = /\(\s*lane\s*(\d+)\s*\)/i.exec(line)?.[1];
  return {
    metric,
    side: hasLow ? 'low' : 'high',
    lane: lane === undefined ? null : Number(lane),
    value,
    source: explicitThresholdSource(line) ?? context ?? 'DEVICE',
  };
}

function numericTokens(line: string): number[] {
  return [...line.replace(/\([^)]*\)/g, ' ').matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
}

/** Conta valores que sao, eles mesmos, valores de lane (`1.50 (lane0)`). */
function laneAnnotatedTokenCount(line: string): number {
  return [...line.matchAll(/-?\d+(?:\.\d+)?\s*\(\s*lane\s*\d+\s*\)/gi)].length;
}

/**
 * Tabela do `display transceiver diagnosis interface`: Current + Low Alarm +
 * High Alarm na mesma linha do metrica (a primeira linha daquele metrica).
 * Linhas de continuacao trazem um valor por lane e nao montam threshold.
 */
function parseTableThresholds(block: string): Map<ThresholdMetric, { low: number; high: number }> {
  const found = new Map<ThresholdMetric, { low: number; high: number }>();
  let pending: ThresholdMetric | null = null;

  const record = (metric: ThresholdMetric, tokens: number[]): boolean => {
    const low = normalizeOpticalDbm(tokens[1]);
    const high = normalizeOpticalDbm(tokens[2]);
    if (low === null || high === null || low >= high) return false;
    found.set(metric, { low, high });
    return true;
  };

  for (const line of block.split(/\r?\n/)) {
    const heading = laneMetricHeading(line);
    if (heading) {
      const metric = heading === 'bias' ? null : heading;
      // O VRP imprime a linha do metrica JA com Current/Low/High; a lista de
      // lanes vem nas linhas seguintes (um valor por linha).
      if (!line.includes('|') && laneAnnotatedTokenCount(line) <= 1) {
        const tokens = numericTokens(line);
        if (tokens.length === 3) {
          if (metric) record(metric, tokens);
          pending = null;
          continue;
        }
      }
      pending = metric;
      continue;
    }
    if (/^\s*(?:Temperature|Temp|Voltage)\s*\(/i.test(line)) {
      pending = null;
      continue;
    }
    if (!pending || !/\d/.test(line)) continue;
    const metric = pending;
    pending = null;
    if (line.includes('|') || laneAnnotatedTokenCount(line) > 1) continue;
    const tokens = numericTokens(line);
    if (tokens.length === 3) record(metric, tokens);
  }

  return found;
}

function parseOpticalThresholds(block: string): HuaweiOpticalThresholds {
  const thresholds = emptyHuaweiOpticalThresholds();

  for (const [metric, pair] of parseTableThresholds(block)) {
    assignOpticalThresholdSide(thresholds.scalar[metric], 'low', pair.low, 'DEVICE');
    assignOpticalThresholdSide(thresholds.scalar[metric], 'high', pair.high, 'DEVICE');
  }

  const laneSides = new Map<number, { rx: OpticalThresholdSide; tx: OpticalThresholdSide }>();
  let context: OpticalThresholdSource | null = null;
  for (const line of block.split(/\r?\n/)) {
    const declared = thresholdSourceContext(line);
    if (declared) {
      context = declared;
      continue;
    }
    const hit = parseThresholdLine(line, context);
    if (!hit) continue;
    let target: OpticalThresholdSide;
    if (hit.lane === null) {
      target = thresholds.scalar[hit.metric];
    } else {
      const lane = laneSides.get(hit.lane) ?? {
        rx: emptyOpticalThresholdSide(),
        tx: emptyOpticalThresholdSide(),
      };
      laneSides.set(hit.lane, lane);
      target = lane[hit.metric];
    }
    assignOpticalThresholdSide(target, hit.side, hit.value, hit.source);
  }

  thresholds.lanes = [...laneSides.entries()]
    .filter(([, sides]) =>
      sides.rx.lowAlarmDbm !== null || sides.rx.highAlarmDbm !== null
      || sides.tx.lowAlarmDbm !== null || sides.tx.highAlarmDbm !== null)
    .map(([lane, sides]) => ({ lane, rx: sides.rx, tx: sides.tx }))
    .sort((left, right) => left.lane - right.lane);

  return thresholds;
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

  opticalEnrichmentCommands(interfaceNames: string[], includeVerbose: boolean): string[] {
    const candidates = [...new Set(interfaceNames.flatMap((name) => {
      const command = huaweiDiagnosisCommand(name);
      return command ? [command] : [];
    }))];
    return [
      'screen-length 0 temporary',
      ...(includeVerbose ? ['display transceiver verbose'] : []),
      ...candidates,
    ];
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
      const thresholds = parseOpticalThresholds(block);

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
      if (
        rxPowerDbm === null
        && txPowerDbm === null
        && opticalLanes.length === 0
        && !hasUsefulOpticalThresholds(thresholds)
      ) {
        return [];
      }
      return [
        {
          name,
          rxPowerDbm,
          txPowerDbm,
          opticalLanes,
          thresholds,
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
