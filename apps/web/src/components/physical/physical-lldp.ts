import type { PhysicalInventory, PhysicalLldpSuggestion, PhysicalPort } from '@gmj/shared';

/**
 * Camada de apresentação das sugestões LLDP.
 *
 * Nada aqui altera dados: o backend continua com uma sugestão por adjacência
 * observada. O que fazemos é agrupar as adjacências espelhadas (A→B e B→A) em
 * um único "ghost" visual por par físico, escolhendo de forma determinística
 * qual `adjacencyId` representa o grupo na hora de confirmar.
 */

export interface PhysicalLldpGhostSide {
  siteId: string;
  siteName: string;
  rackId: string;
  rackName: string;
  assetId: string;
  assetName: string;
  portId: string;
  portName: string;
}

/** `NONE`: pode confirmar. Os demais bloqueiam a confirmação e o desenho. */
export type PhysicalLldpConflict = 'NONE' | 'ALREADY_CONNECTED' | 'BUSY';

export interface PhysicalLldpGhost {
  /** Chave canônica do par físico (`portA|portB` ordenado). */
  key: string;
  /** Sugestão escolhida do grupo — é o id enviado para confirmar. */
  adjacencyId: string;
  /** Todas as adjacências do grupo (identidade original preservada). */
  adjacencyIds: string[];
  state: PhysicalLldpSuggestion['state'];
  confidence: string;
  observedAt: string;
  reason: string;
  localPortName: string;
  remoteHostname: string;
  remotePortName: string;
  /** Ponta local resolvida no inventário físico (ancorável). */
  from: PhysicalLldpGhostSide | null;
  /** Ponta remota resolvida — `null` em PARTIAL (nunca inventamos endpoint). */
  to: PhysicalLldpGhostSide | null;
  /** A ponta remota está em outro POP. */
  external: boolean;
  conflict: PhysicalLldpConflict;
  conflictDetail: string;
  /** READY + duas pontas + nenhum conflito. */
  confirmable: boolean;
}

const CONFIDENCE_RANK: Record<string, number> = {
  CONFIRMED: 3,
  PROBABLE: 2,
  AMBIGUOUS: 1,
  UNRESOLVED: 0,
};

const STATE_RANK: Record<PhysicalLldpSuggestion['state'], number> = {
  READY: 2,
  PARTIAL: 1,
  UNRESOLVED: 0,
};

/** Chave visual do par físico: ordena os dois portIds. */
export function lldpPairKey(portA: string | null | undefined, portB: string | null | undefined): string {
  if (portA && portB) return [portA, portB].sort().join('|');
  return `single:${portA ?? portB ?? ''}`;
}

/**
 * Melhor candidato do grupo: READY antes de PARTIAL/UNRESOLVED, maior
 * confiança, observação mais recente e, por fim, `adjacencyId` estável.
 */
export function pickPrimaryLldpSuggestion(
  suggestions: readonly PhysicalLldpSuggestion[],
): PhysicalLldpSuggestion {
  return [...suggestions].sort((left, right) => {
    const byState = STATE_RANK[right.state] - STATE_RANK[left.state];
    if (byState !== 0) return byState;
    const byConfidence =
      (CONFIDENCE_RANK[right.confidence] ?? 0) - (CONFIDENCE_RANK[left.confidence] ?? 0);
    if (byConfidence !== 0) return byConfidence;
    const byObservedAt = String(right.observedAt).localeCompare(String(left.observedAt));
    if (byObservedAt !== 0) return byObservedAt;
    return String(left.adjacencyId).localeCompare(String(right.adjacencyId));
  })[0]!;
}

interface LocatedPort {
  siteId: string;
  siteName: string;
  rackId: string;
  rackName: string;
  assetId: string;
  assetName: string;
  port: PhysicalPort;
}

export function locatePhysicalPort(
  inventory: PhysicalInventory,
  portId: string,
): LocatedPort | null {
  for (const site of inventory.sites) {
    for (const rack of site.racks) {
      for (const asset of rack.assets) {
        const port = asset.ports.find((candidate) => candidate.id === portId);
        if (!port) continue;
        return {
          siteId: site.id,
          siteName: site.name,
          rackId: rack.id,
          rackName: rack.name,
          assetId: asset.id,
          assetName: asset.name,
          port,
        };
      }
    }
  }
  return null;
}

function side(
  inventory: PhysicalInventory,
  endpoint: PhysicalLldpSuggestion['local'],
): PhysicalLldpGhostSide | null {
  if (!endpoint) return null;
  /**
   * O backend só marca a adjacência como resolvida quando o mapeamento físico
   * existe: `assetId`/`portId` do endpoint são a verdade. O inventário entra
   * para enriquecer com o id do rack/POP (usado só para navegar) e com o nome
   * atual da porta, caso ela tenha sido renomeada depois da coleta.
   */
  const located = locatePhysicalPort(inventory, endpoint.portId);
  return {
    siteId: located?.siteId ?? '',
    siteName: located?.siteName ?? endpoint.siteName,
    rackId: located?.rackId ?? '',
    rackName: located?.rackName ?? endpoint.rackName,
    assetId: endpoint.assetId,
    assetName: located?.assetName ?? endpoint.assetName,
    portId: endpoint.portId,
    portName: located?.port.name ?? endpoint.portName,
  };
}

function conflictOf(
  inventory: PhysicalInventory,
  from: PhysicalLldpGhostSide | null,
  to: PhysicalLldpGhostSide | null,
): { conflict: PhysicalLldpConflict; detail: string } {
  if (!from) return { conflict: 'NONE', detail: '' };
  const fromPort = locatePhysicalPort(inventory, from.portId)?.port;
  const toPort = to ? locatePhysicalPort(inventory, to.portId)?.port : null;
  const fromConnectionId = fromPort?.connectionId ?? null;
  const toConnectionId = toPort?.connectionId ?? null;

  // Já existe um cabo exatamente entre as duas portas do par.
  if (fromConnectionId && fromConnectionId === toConnectionId) {
    return {
      conflict: 'ALREADY_CONNECTED',
      detail: 'Já existe uma conexão física entre estas duas portas.',
    };
  }
  if (toConnectionId) {
    return {
      conflict: 'BUSY',
      detail: 'A porta remota já está conectada a outro endpoint.',
    };
  }
  if (fromConnectionId) {
    return { conflict: 'BUSY', detail: 'Esta porta já possui uma conexão física.' };
  }
  return { conflict: 'NONE', detail: '' };
}

/**
 * Ghosts do inventário inteiro, um por par físico. O canvas filtra pelo rack
 * que está desenhando; o inspector usa o mesmo objeto para o detalhe.
 */
export function buildPhysicalLldpGhosts(inventory: PhysicalInventory): PhysicalLldpGhost[] {
  const groups = new Map<string, PhysicalLldpSuggestion[]>();
  for (const suggestion of inventory.lldpSuggestions) {
    const key = lldpPairKey(suggestion.local?.portId, suggestion.remote?.portId);
    const bucket = groups.get(key);
    if (bucket) bucket.push(suggestion);
    else groups.set(key, [suggestion]);
  }

  return [...groups.entries()].map(([key, bucket]) => {
    const primary = pickPrimaryLldpSuggestion(bucket);
    const from = side(inventory, primary.local);
    const to = side(inventory, primary.remote);
    const { conflict, detail } = conflictOf(inventory, from, to);
    return {
      key,
      adjacencyId: primary.adjacencyId,
      adjacencyIds: bucket
        .map((item) => item.adjacencyId)
        .sort((left, right) => left.localeCompare(right)),
      state: primary.state,
      confidence: primary.confidence,
      observedAt: primary.observedAt,
      reason: primary.reason,
      localPortName: primary.localPortName,
      remoteHostname: primary.remoteHostname,
      remotePortName: primary.remotePortName,
      from,
      to,
      external: Boolean(from && to && from.siteId !== to.siteId),
      conflict,
      conflictDetail: detail,
      confirmable: primary.state === 'READY' && Boolean(from && to) && conflict === 'NONE',
    };
  });
}

/** Ghosts que o canvas do rack informado pode desenhar (com ponta local). */
export function ghostsForRack(
  ghosts: readonly PhysicalLldpGhost[],
  rackId: string,
): PhysicalLldpGhost[] {
  return ghosts.filter((ghost) => {
    if (ghost.state === 'READY' && ghost.conflict !== 'NONE') return false;
    if (!ghost.from) return false;
    return ghost.from.rackId === rackId || ghost.to?.rackId === rackId;
  });
}
