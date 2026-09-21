import type { BgpAddressFamily, NetworkInterface } from '@gmj/shared';
import { interfaceNameKeys, normalizeInterfaceName } from '../topology/interface-correlation';
import { parseHuaweiRouteLookup } from './huawei-bgp-ssh-parser';

export type BgpInterfaceCorrelationStatus =
  'MATCHED' | 'NO_ROUTE' | 'NO_SAFE_INTERFACE' | 'AMBIGUOUS' | 'COMMAND_FAILED';

export type BgpRouteCommandResult =
  { status: 'SUCCESS'; output: string } | { status: 'COMMAND_FAILED'; error: string };

export interface BgpInterfaceCorrelation {
  interfaceId: string | null;
  interfaceName: string | null;
  interfaceAlias: string | null;
  interfaceDescription: string | null;
  displayName: string;
  correlationStatus: BgpInterfaceCorrelationStatus;
  correlationError: string | null;
}

function unavailable(
  peerAddress: string,
  correlationStatus: Exclude<BgpInterfaceCorrelationStatus, 'MATCHED'>,
  correlationError: string | null = null,
): BgpInterfaceCorrelation {
  return {
    interfaceId: null,
    interfaceName: null,
    interfaceAlias: null,
    interfaceDescription: null,
    displayName: peerAddress,
    correlationStatus,
    correlationError,
  };
}

function unsafeEgressInterface(name: string): boolean {
  const normalized = normalizeInterfaceName(name);
  return /^(?:null|loopback|inloopback)\d*/.test(normalized);
}

export function bgpPeerDisplayName(
  peerAddress: string,
  networkInterface: Pick<NetworkInterface, 'alias' | 'description' | 'name'> | null,
): string {
  return (
    networkInterface?.alias?.trim() ||
    networkInterface?.description?.trim() ||
    networkInterface?.name?.trim() ||
    peerAddress
  );
}

export function correlateBgpPeerInterface(
  deviceId: string,
  peerAddress: string,
  addressFamily: BgpAddressFamily,
  routeCommand: BgpRouteCommandResult,
  interfaces: NetworkInterface[],
): BgpInterfaceCorrelation {
  if (routeCommand.status === 'COMMAND_FAILED') {
    return unavailable(peerAddress, 'COMMAND_FAILED', routeCommand.error);
  }
  const route = parseHuaweiRouteLookup(routeCommand.output, addressFamily);
  if (!route.routeFound) return unavailable(peerAddress, 'NO_ROUTE');
  if (route.unresolvedRoute) return unavailable(peerAddress, 'NO_SAFE_INTERFACE');

  const candidates = [
    ...new Map(route.interfaceNames.map((name) => [normalizeInterfaceName(name), name])).values(),
  ];
  if (candidates.length !== 1) return unavailable(peerAddress, 'AMBIGUOUS');
  const candidate = candidates[0]!;
  if (unsafeEgressInterface(candidate)) return unavailable(peerAddress, 'NO_SAFE_INTERFACE');

  const candidateKeys = new Set(interfaceNameKeys(candidate));
  const matches = interfaces.filter(
    (networkInterface) =>
      networkInterface.deviceId === deviceId &&
      interfaceNameKeys(networkInterface.name).some((key) => candidateKeys.has(key)),
  );
  if (!matches.length) return unavailable(peerAddress, 'NO_SAFE_INTERFACE');
  if (matches.length !== 1) return unavailable(peerAddress, 'AMBIGUOUS');

  const networkInterface = matches[0]!;
  return {
    interfaceId: networkInterface.id,
    interfaceName: networkInterface.name,
    interfaceAlias: networkInterface.alias?.trim() || null,
    interfaceDescription: networkInterface.description?.trim() || null,
    displayName: bgpPeerDisplayName(peerAddress, networkInterface),
    correlationStatus: 'MATCHED',
    correlationError: null,
  };
}
