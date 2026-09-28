/**
 * Geometria do traçado LLDP **same-rack**.
 *
 * O traçado antigo levava a linha até o corredor lateral (`laneX - 24`) e voltava
 * atravessando toda a fileira de portas do equipamento par — o olho não
 * conseguia seguir a relação. Aqui o corredor principal é o **vão entre os
 * chassis**: a linha sai da porta com um stub perpendicular curto, anda no vão
 * (espaço livre, sem portas), alinha com a porta remota e entra com outro stub.
 *
 * Quando existe um terceiro chassis entre os dois, o vão direto não serve: a
 * linha sai para o corredor lateral (fora da faixa do rack), sobe/desce por
 * fora dos equipamentos e entra pelo vão mais próximo da porta remota.
 */

export interface LldpRouteBox {
  /** topo do chassis no canvas (px) */
  top: number;
  /** altura do chassis no canvas (px) */
  height: number;
}

export interface LldpRoutePoint {
  x: number;
  y: number;
}

export interface LldpRouteInput {
  local: LldpRoutePoint;
  remote: LldpRoutePoint;
  localBox: LldpRouteBox;
  remoteBox: LldpRouteBox;
  /** âncoras das portas do equipamento local (usadas para achar o canal livre). */
  localPorts: readonly LldpRoutePoint[];
  /** âncoras das portas do equipamento remoto. */
  remotePorts: readonly LldpRoutePoint[];
  /** caixas dos **demais** chassis do rack (para detectar chassis no meio). */
  otherChassisBoxes: readonly LldpRouteBox[];
  /** corredor lateral, **fora** da faixa do rack. */
  riserX: number;
  /** limites horizontais do painel do rack, para manter o badge dentro dele. */
  rackLeft: number;
  rackRight: number;
}

export interface LldpRoute {
  /** porta local → vão (stub + corredor). */
  trunk: string;
  /** vão → porta remota (stub de entrada). */
  entry: string;
  corridorY: number;
  badgeX: number;
  badgeY: number;
}

/**
 * Meia-largura de segurança de uma caixa de porta ao escolher o canal. As
 * colunas do painel ficam ~24–30px uma da outra, então o canal livre é o
 * **meio-vão** entre duas colunas: 12px (e não 16px, que nunca caberia).
 */
const PORT_CLEARANCE = 12;
/** Largura aproximada do badge `LLDP` (texto 7px + letter-spacing). */
export const LLDP_BADGE_WIDTH = 26;
/** Altura usada para empilhar badges que caem no mesmo vão. */
export const LLDP_BADGE_HEIGHT = 12;

/** Y do corredor no vão entre dois chassis empilhados. */
export function gapYBetween(a: LldpRouteBox, b: LldpRouteBox): number {
  const aBottom = a.top + a.height;
  const bBottom = b.top + b.height;
  if (b.top >= aBottom) return (aBottom + b.top) / 2;
  if (a.top >= bBottom) return (bBottom + a.top) / 2;
  return (a.top + a.height + b.top) / 2;
}

/** Existe outro chassis entre os dois? (o vão direto não serve) */
function hasChassisBetween(a: LldpRouteBox, b: LldpRouteBox, others: readonly LldpRouteBox[]): boolean {
  const top = Math.min(a.top + a.height, b.top + b.height);
  const bottom = Math.max(a.top, b.top);
  return others.some((box) => box.top < bottom - 1 && box.top + box.height > top + 1);
}

/**
 * Canal vertical livre para sair/entrar no chassis.
 *
 * Parte do próprio x da porta (o caso normal: o traço desce na coluna da porta)
 * e só desloca se outra porta do mesmo equipamento estiver na vertical. A porta
 * do par e as portas da mesma fileira não contam: elas não são atravessadas.
 */
export function freeChannelX(
  x: number,
  fromY: number,
  toY: number,
  ports: readonly LldpRoutePoint[],
  bounds?: { left: number; right: number },
): number {
  const top = Math.min(fromY, toY);
  const bottom = Math.max(fromY, toY);
  /** Portas que o traço realmente atravessaria (a própria fileira não conta). */
  const band = ports.filter((port) => port.y > top + 1 && port.y < bottom - 1);
  if (band.length === 0) return x;
  const blocked = (candidate: number) =>
    band.some((port) => Math.abs(port.x - candidate) < PORT_CLEARANCE);
  if (!blocked(x)) return x;
  /**
   * Candidatos: meio-vão entre colunas vizinhas e as duas laterais do bloco.
   * O mais próximo vence — o desvio fica sempre curto (≤ meia coluna).
   */
  const columns = [...new Set(band.map((port) => Math.round(port.x * 100) / 100))].sort(
    (left, right) => left - right,
  );
  const half = (left: number, right: number) => (left + right) / 2;
  const candidates: number[] = [];
  if (columns.length >= 2) {
    for (let index = 0; index < columns.length - 1; index += 1) {
      candidates.push(half(columns[index]!, columns[index + 1]!));
    }
    candidates.push(columns[0]! - (columns[1]! - columns[0]!) / 2);
    candidates.push(
      columns[columns.length - 1]! + (columns[columns.length - 1]! - columns[columns.length - 2]!) / 2,
    );
  } else {
    candidates.push(columns[0]! - PORT_CLEARANCE * 2, columns[0]! + PORT_CLEARANCE * 2);
  }
  const free = candidates.filter((candidate) => !blocked(candidate));
  const inside = bounds
    ? free.filter((candidate) => candidate >= bounds.left && candidate <= bounds.right)
    : free;
  if (inside.length === 0) return x;
  return inside.reduce(
    (best, candidate) => (Math.abs(candidate - x) < Math.abs(best - x) ? candidate : best),
    inside[0]!,
  );
}

/** Y do vão mais próximo da caixa, na direção pedida. */
function nearestGapY(box: LldpRouteBox, direction: -1 | 1, others: readonly LldpRouteBox[]): number {
  const edge = direction === 1 ? box.top + box.height : box.top;
  const neighbour = others
    .map((other) => ({ top: other.top, bottom: other.top + other.height }))
    .filter((other) => (direction === 1 ? other.top >= edge - 1 : other.bottom <= edge + 1))
    .sort((left, right) =>
      direction === 1 ? left.top - right.top : right.bottom - left.bottom,
    )[0];
  if (!neighbour) return edge + direction * 12;
  return direction === 1 ? (edge + neighbour.top) / 2 : (neighbour.bottom + edge) / 2;
}

/**
 * Traçado same-rack: stub curto na porta local, corredor no vão, alinhamento com
 * a porta remota e stub de entrada. Nenhum segmento horizontal corre sobre
 * fileira de portas.
 */
export function routeSameRackLldp(input: LldpRouteInput): LldpRoute {
  const { local, remote, localBox, remoteBox } = input;
  const others = input.otherChassisBoxes;
  const direct = !hasChassisBetween(localBox, remoteBox, others);
  const direction: -1 | 1 = remoteBox.top >= localBox.top ? 1 : -1;

  const corridorY = direct
    ? gapYBetween(localBox, remoteBox)
    : nearestGapY(localBox, direction, others);

  const channelBounds = { left: input.rackLeft + 4, right: input.rackRight - 4 };
  const localChannel = freeChannelX(local.x, local.y, corridorY, input.localPorts, channelBounds);

  let entryCorridorY = corridorY;
  if (!direct) {
    entryCorridorY = nearestGapY(remoteBox, (direction * -1) as -1 | 1, others);
  }
  const remoteChannel = freeChannelX(
    remote.x,
    remote.y,
    entryCorridorY,
    input.remotePorts,
    channelBounds,
  );

  // O stub sai da porta: o desenho começa nela e vai até o canal escolhido.
  const trunkParts = [`M ${local.x} ${local.y}`];
  if (localChannel !== local.x) trunkParts.push(`H ${localChannel}`);
  trunkParts.push(`V ${corridorY}`);
  if (direct) {
    trunkParts.push(`H ${remoteChannel}`);
  } else {
    // Chassi no meio: contorna por fora da faixa do rack antes de entrar no vão
    // do equipamento remoto.
    trunkParts.push(`H ${input.riserX}`, `V ${entryCorridorY}`, `H ${remoteChannel}`);
  }
  const trunk = trunkParts.join(' ');
  const entry = `M ${remoteChannel} ${entryCorridorY} V ${remote.y}`;

  const midX = (local.x + remote.x) / 2;
  const badgeX = Math.round(
    Math.min(Math.max(midX - LLDP_BADGE_WIDTH / 2, input.rackLeft + 6), input.rackRight - LLDP_BADGE_WIDTH - 6),
  );
  return {
    trunk,
    entry,
    corridorY,
    badgeX,
    badgeY: Math.round(corridorY) - 6,
  };
}
