import { createHash } from 'node:crypto';
import { interfaceMitigationScope } from '../../infrastructure/bgp/mitigation/mitigation-scope';

export interface ClientBinding {
  profileId: string;
  deviceId: string;
  interfaceId: string;
  interfaceName: string;
  ifIndex: number;
  description: string;
  customer: string;
  direction: 'rx' | 'tx';
  detectedBandwidthBps: string;
  effectiveBandwidthBps: string;
  key: string;
}
interface ClientInterface {
  id: string;
  name: string;
  ifIndex: number;
  alias?: string | null | undefined;
  description?: string | null | undefined;
  adminStatus: string;
  operStatus: string;
}
export function resolveAutoClientBinding(
  input: {
    profileId: string;
    deviceId: string;
    interfaceId: string | null;
    customer: string | null;
    direction?: 'rx' | 'tx' | null | undefined;
    detectedBandwidthBps: bigint | null;
    bandwidthOverrideBps: bigint | null;
  },
  host: { id: string; interfaces: readonly ClientInterface[] },
): ClientBinding | null {
  if (host.id !== input.deviceId || !input.interfaceId || !input.direction) return null;
  const matches = host.interfaces.filter((i) => i.id === input.interfaceId);
  if (matches.length !== 1) return null;
  const i = matches[0]!;
  if (
    !/^Eth-Trunk\d+(?:\.\d+)?$/i.test(i.name) ||
    !Number.isInteger(i.ifIndex) ||
    i.ifIndex <= 0 ||
    i.adminStatus !== 'UP' ||
    i.operStatus !== 'UP'
  )
    return null;
  if (host.interfaces.filter((other) => other.name === i.name).length !== 1) return null;
  const scope = interfaceMitigationScope({
    description: i.description ?? '',
    alias: i.alias ?? '',
  });
  if (
    !scope.inScope ||
    !scope.descriptionRaw ||
    !scope.customerDisplayName ||
    /MITIG|SCRUB|DDOS|UPLINK|BACKBONE|TRANSIT|LACP/i.test(scope.descriptionRaw)
  )
    return null;
  if (
    scope.customerDisplayName !== input.customer ||
    scope.detectedBandwidthBps !== input.detectedBandwidthBps
  )
    return null;
  const effective = input.bandwidthOverrideBps ?? input.detectedBandwidthBps;
  if (!effective || effective <= 0n) return null;
  const value = {
    profileId: input.profileId,
    deviceId: input.deviceId,
    interfaceId: i.id,
    interfaceName: i.name,
    ifIndex: i.ifIndex,
    description: scope.descriptionRaw,
    customer: scope.customerDisplayName,
    direction: input.direction,
    detectedBandwidthBps: scope.detectedBandwidthBps!.toString(),
    effectiveBandwidthBps: effective.toString(),
  };
  return { ...value, key: createHash('sha256').update(JSON.stringify(value)).digest('hex') };
}
