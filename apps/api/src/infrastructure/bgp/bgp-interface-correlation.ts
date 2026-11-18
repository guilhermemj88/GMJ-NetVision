import type { BgpAddressFamily, NetworkInterface } from '@gmj/shared';
import { interfaceNameKeys, normalizeInterfaceName } from '../topology/interface-correlation';
import { parseHuaweiRouteLookup } from './huawei-bgp-ssh-parser';

export type BgpInterfaceCorrelationStatus =
  'MATCHED' | 'NO_ROUTE' | 'NO_SAFE_INTERFACE' | 'AMBIGUOUS' | 'COMMAND_FAILED';

export type BgpRouteCommandResult =
  { status: 'SUCCESS'; output: string } | { status: 'COMMAND_FAILED'; error: string };

/**
 * Resultado de rota JÁ interpretado pelo parser do fabricante. É o contrato
 * vendor-neutral que o correlator consome: o parser Huawei e o parser Junos
 * produzem este mesmo formato.
 */
export interface BgpRouteLookupData {
  routeFound: boolean;
  unresolvedRoute: boolean;
  interfaceNames: string[];
}

export type BgpRouteLookup =
  | { status: 'SUCCESS'; lookup: BgpRouteLookupData }
  | { status: 'COMMAND_FAILED'; error: string };

export interface BgpCorrelationOptions {
  /**
   * Junos entrega a saída como unidade lógica (`ae0.2800`, `xe-0/0/0.100`).
   * Quando o inventário só tem a interface pai, aceitar o fallback é correto —
   * mas é um comportamento por vendor: Huawei mantém exatamente o de antes.
   */
  allowLogicalUnitFallback?: boolean;
}

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
  return correlateFromLookup(
    deviceId,
    peerAddress,
    { status: 'SUCCESS', lookup: parseHuaweiRouteLookup(routeCommand.output, addressFamily) },
    interfaces,
  );
}

/**
 * Junos: a unidade lógica (`ae0.2800`) só é reduzida ao pai (`ae0`) quando o
 * inventário NÃO tem a unidade. O sufixo removido é apenas o `.NNNN` terminal;
 * `:0`/`:1` (breakout) nunca é tocado.
 */
export function parentInterfaceCandidates(name: string): string[] {
  const trimmed = name.trim();
  const withoutUnit = trimmed.replace(/\.\d+$/, '');
  return withoutUnit !== trimmed && withoutUnit ? [withoutUnit] : [];
}

export function correlateFromLookup(
  deviceId: string,
  peerAddress: string,
  lookupResult: BgpRouteLookup,
  interfaces: NetworkInterface[],
  options: BgpCorrelationOptions = {},
): BgpInterfaceCorrelation {
  if (lookupResult.status === 'COMMAND_FAILED') {
    return unavailable(peerAddress, 'COMMAND_FAILED', lookupResult.error);
  }
  const route = lookupResult.lookup;
  if (!route.routeFound) return unavailable(peerAddress, 'NO_ROUTE');
  if (route.unresolvedRoute) return unavailable(peerAddress, 'NO_SAFE_INTERFACE');

  const candidates = [
    ...new Map(route.interfaceNames.map((name) => [normalizeInterfaceName(name), name])).values(),
  ];
  if (candidates.length !== 1) return unavailable(peerAddress, 'AMBIGUOUS');
  const candidate = candidates[0]!;
  if (unsafeEgressInterface(candidate)) return unavailable(peerAddress, 'NO_SAFE_INTERFACE');

  const match = findUniqueInterface(deviceId, candidate, interfaces);
  if (match.status === 'MATCHED') return match.correlation;
  if (!options.allowLogicalUnitFallback || match.status !== 'NOT_FOUND') {
    return unavailable(peerAddress, match.status === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'NO_SAFE_INTERFACE');
  }

  // Fallback por unidade lógica: aceitar SOMENTE com correspondência única.
  for (const parent of parentInterfaceCandidates(candidate)) {
    const parentMatch = findUniqueInterface(deviceId, parent, interfaces);
    if (parentMatch.status === 'MATCHED') return parentMatch.correlation;
    if (parentMatch.status === 'AMBIGUOUS') break;
  }
  return unavailable(peerAddress, 'NO_SAFE_INTERFACE');
}

type InterfaceMatch =
  | { status: 'MATCHED'; correlation: BgpInterfaceCorrelation }
  | { status: 'NOT_FOUND' | 'AMBIGUOUS' };

function findUniqueInterface(
  deviceId: string,
  candidate: string,
  interfaces: NetworkInterface[],
): InterfaceMatch {
  const candidateKeys = new Set(interfaceNameKeys(candidate));
  const matches = interfaces.filter(
    (networkInterface) =>
      networkInterface.deviceId === deviceId &&
      interfaceNameKeys(networkInterface.name).some((key) => candidateKeys.has(key)),
  );
  if (matches.length > 1) return { status: 'AMBIGUOUS' };
  const networkInterface = matches[0];
  if (!networkInterface) return { status: 'NOT_FOUND' };
  return {
    status: 'MATCHED',
    correlation: {
      interfaceId: networkInterface.id,
      interfaceName: networkInterface.name,
      interfaceAlias: networkInterface.alias?.trim() || null,
      interfaceDescription: networkInterface.description?.trim() || null,
      displayName: bgpPeerDisplayName(candidate, networkInterface),
      correlationStatus: 'MATCHED',
      correlationError: null,
    },
  };
}
