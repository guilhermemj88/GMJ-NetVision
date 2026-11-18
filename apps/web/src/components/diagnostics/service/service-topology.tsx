import type { VsiEndpointView, VsiPwView, VsiServiceDiagnosis } from '@gmj/shared';
import styles from './service-view.module.css';

/**
 * Topologia do servico gerada dos dados, para N PEs. Coluna central: PEs com acesso lido
 * (ou o PE pedido); coluna da direita: demais participantes e peers sem host conhecido.
 * Traco e simbolo mudam com o estado; a cor nunca e o unico sinal.
 */

type LineKind = 'active' | 'standby' | 'unread' | 'crit' | 'stale';
interface Node {
  key: string;
  endpoint: VsiEndpointView | null;
  title: string;
  y: number;
}

const W = 1010;
const STUB = { x: 14, w: 196 };
const LEFT = { x: 300, w: 306 };
const RIGHT = { x: 734, w: 262 };
const ROW = 132;
const BOX = 104;
const day = (iso: string | null): string => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '');

function accessLine(e: VsiEndpointView): { kind: LineKind; lines: string[] } | null {
  const trunk = e.ethTrunks[0];
  if (trunk) {
    const count = `LACP ${trunk.selected ?? '?'}/${trunk.members.length} em uso`;
    const kind: LineKind = trunk.operStatus.freshness === 'STALE' ? 'stale' : trunk.role === 'ACTIVE' ? 'active' : trunk.role === 'STANDBY_EXPECTED' ? 'standby' : trunk.role === 'DOWN_UNEXPECTED' ? 'crit' : 'unread';
    const mark = kind === 'active' ? '▲' : kind === 'standby' ? '⏸' : kind === 'crit' ? '✕' : kind === 'stale' ? '◷' : '?';
    return { kind, lines: [trunk.name, `${mark} ${count}`] };
  }
  const ac = e.acs[0];
  if (!ac) return null;
  const live = ac.state.basis === 'LIVE_SSH' && ac.state.value !== null;
  const kind: LineKind = !live ? 'unread' : ac.state.freshness === 'STALE' ? 'stale' : ac.state.value === 'UP' ? 'active' : e.accessRole === 'STANDBY_EXPECTED' ? 'standby' : 'crit';
  const text = !live ? '? AC não confirmado' : kind === 'stale' ? `◷ AC ${ac.state.value?.toLowerCase()} em ${day(ac.state.observedAt)}` : kind === 'active' ? '▲ AC up' : kind === 'standby' ? '⏸ AC down esperado' : '✕ AC down';
  return { kind, lines: [ac.carrier ?? ac.interfaceName, text] };
}

function nodeLines(e: VsiEndpointView): Array<{ text: string; cls: string }> {
  const out: Array<{ text: string; cls: string }> = [];
  const et = e.eTrunks[0];
  if (et && et.state.value) {
    const mark = et.state.value === 'MASTER' ? '▲' : et.state.value === 'BACKUP' ? '⏸' : '?';
    out.push({ text: `E-Trunk ${et.id} · ${mark} ${et.state.value}${et.causation ? ` · causa ${et.causation}` : ''}`, cls: et.state.value === 'MASTER' ? styles.fGreen! : styles.fSlate! });
  } else if (e.accessRole === 'DOWN_UNEXPECTED') out.push({ text: '✕ acesso em falha inesperada', cls: styles.fRed! });
  else if (e.accessRole === 'ROLE_UNKNOWN') out.push({ text: '? papel do acesso indeterminado', cls: styles.fViolet! });
  else if (e.loopback) out.push({ text: e.loopback, cls: styles.fMuted! });

  const state = e.vsi.value?.state.toLowerCase();
  switch (e.serviceState) {
    case 'PROVEN_OK':
      out.push({ text: '✓ VSI, AC e PW up', cls: styles.fGreen! });
      break;
    case 'ENGINE_APPROVED':
      out.push({ text: `✓ aprovado pelo legado${state ? ` · VSI ${state}` : ''}`, cls: styles.fGreen! });
      break;
    case 'ISSUE':
      out.push({ text: `✕ serviço com falha${state ? ` · VSI ${state}` : ''}`, cls: styles.fRed! });
      break;
    case 'STALE':
      out.push({ text: `◷ VSI ${state} em ${day(e.vsi.observedAt)} · leitura antiga`, cls: styles.fMuted! });
      break;
    case 'EXPECTED_DOWN':
      out.push({ text: '⏸ VSI down esperado (Backup)', cls: styles.fSlate! });
      break;
    default:
      out.push({ text: '? VSI NÃO CONFIRMADA', cls: styles.fViolet! });
  }
  const hint = e.vsi.inventoryHint;
  if (e.serviceState === 'NOT_CONFIRMED')
    out.push({ text: hint ? `inventário: VSI ${hint.value.state.toLowerCase()}` : e.collection === 'NOT_READ' ? 'não lido ao vivo' : 'sem registro de inventário', cls: styles.fMuted! });
  return out;
}

function pwStyle(a: VsiEndpointView, pw: VsiPwView | undefined): { kind: LineKind; label: string; amber?: boolean } {
  if (!pw) return { kind: 'unread', label: '? PW não confirmado' };
  const live = pw.state.basis === 'LIVE_SSH' && pw.state.value !== null;
  if (live && pw.state.freshness === 'STALE') return { kind: 'stale', label: `◷ PW ${pw.state.value?.toLowerCase()} em ${day(pw.state.observedAt)}` };
  if (live && pw.state.value === 'UP') return { kind: 'active', label: '▲ PW up' };
  if (live) return a.accessRole === 'STANDBY_EXPECTED' ? { kind: 'standby', label: '⏸ PW down esperado' } : { kind: 'crit', label: '✕ PW down' };
  if (pw.stale) return { kind: 'unread', label: `◷ PW · registro obsoleto de ${day(pw.state.inventoryHint?.observedAt ?? null)}`, amber: true };
  return { kind: 'unread', label: `? PW não confirmado${pw.state.inventoryHint ? ` · inventário: ${pw.state.inventoryHint.value.toLowerCase()}` : ''}` };
}

const LINE: Record<LineKind, string> = { active: 'lActive', standby: 'lStandby', unread: 'lUnread', crit: 'lCrit', stale: 'lStale' };
const FILL: Record<LineKind, string> = { active: 'fGreen', standby: 'fSlate', unread: 'fViolet', crit: 'fRed', stale: 'fMuted' };

export function ServiceTopology({ diagnosis }: { diagnosis: VsiServiceDiagnosis }) {
  const { endpoints, links } = diagnosis;
  const scoped = endpoints.filter((e) => e.accessRole !== null || e.ethTrunks.length > 0);
  const leftEndpoints = scoped.length > 0 ? scoped : endpoints.slice(0, 1);
  const rightEndpoints = endpoints.filter((e) => !leftEndpoints.includes(e));
  const ghosts = links.filter((l) => !endpoints.some((e) => e.hostId !== null && e.hostId === l.bHostId) && l.bHostId === null);
  const rightCount = rightEndpoints.length + ghosts.length;
  const rows = Math.max(leftEndpoints.length, rightCount, 1);
  const height = rows * ROW + 30;
  const columnY = (count: number, i: number): number => 30 + ((rows - count) * ROW) / 2 + i * ROW;

  const left: Node[] = leftEndpoints.map((e, i) => ({ key: e.hostName, endpoint: e, title: e.hostName, y: columnY(leftEndpoints.length, i) }));
  const right: Node[] = [
    ...rightEndpoints.map((e, i) => ({ key: e.hostName, endpoint: e, title: e.hostName, y: columnY(rightCount, i) })),
    ...ghosts.map((l, i) => ({ key: `peer-${l.bAddress}`, endpoint: null, title: l.bAddress, y: columnY(rightCount, rightEndpoints.length + i) })),
  ];
  const find = (hostId: string | null, address: string): { node: Node; side: 'L' | 'R' } | null => {
    const l = left.find((n) => n.endpoint?.hostId != null && n.endpoint.hostId === hostId);
    if (l) return { node: l, side: 'L' };
    const r = right.find((n) => (n.endpoint?.hostId != null && n.endpoint.hostId === hostId) || n.key === `peer-${address}`);
    return r ? { node: r, side: 'R' } : null;
  };

  const drawn: string[] = [];
  const notDrawn: string[] = [];
  const pwElements = links.map((link, i) => {
    const a = find(link.aHostId, '');
    const b = find(link.bHostId, link.bAddress);
    const aEndpoint = endpoints.find((e) => e.hostId !== null && e.hostId === link.aHostId);
    const pw = aEndpoint?.pws.find((p) => p.peerAddress === link.bAddress || (p.peerHostId !== null && p.peerHostId === link.bHostId));
    const style = aEndpoint ? pwStyle(aEndpoint, pw) : { kind: 'unread' as LineKind, label: '? PW não confirmado' };
    const text = `${a?.node.title ?? link.aHostId} ↔ ${b?.node.title ?? link.bAddress}: ${style.label}`;
    if (!a || !b || a.side === b.side) {
      notDrawn.push(text);
      return null;
    }
    drawn.push(text);
    const l = a.side === 'L' ? a.node : b.node;
    const r = a.side === 'L' ? b.node : a.node;
    const y1 = l.y + BOX / 2 + (i % 2 === 0 ? -8 : 8);
    const y2 = r.y + BOX / 2 + (left.length > 1 ? (l.y < r.y ? -14 : l.y > r.y ? 14 : 0) : 0);
    const x1 = LEFT.x + LEFT.w;
    const mid = (x1 + RIGHT.x) / 2;
    const above = l.y <= r.y;
    return (
      <g key={`${link.aHostId}-${link.bAddress}-${i}`} data-link-kind={style.kind}>
        <path className={styles[LINE[style.kind]]} d={`M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${RIGHT.x} ${y2}`} />
        <text x={x1 - 96} y={above ? l.y - 9 : l.y + BOX + 19} className={'amber' in style && style.amber ? styles.fAmber : styles[FILL[style.kind]]}>
          {style.label}
        </text>
      </g>
    );
  });

  const eTrunkLinks = left.slice(0, -1).flatMap((n, i) => {
    const next = left[i + 1]!;
    const shared = n.endpoint?.eTrunks.find((t) => next.endpoint?.eTrunks.some((o) => o.id === t.id));
    if (!shared) return [];
    const x = LEFT.x + LEFT.w / 2;
    return [
      <g key={`et-${n.key}`}>
        <path className={styles.lCtl} d={`M${x} ${n.y + BOX} V${next.y}`} />
        <text x={x + 10} y={(n.y + BOX + next.y) / 2 + 5} className={styles.fCyan}>
          E-Trunk {shared.id}
        </text>
      </g>,
    ];
  });

  const summary = [
    ...left.map((n) => `${n.title}: ${n.endpoint ? nodeLines(n.endpoint).map((l) => l.text).join('; ') : ''}`),
    ...right.map((n) => `${n.title}: ${n.endpoint ? nodeLines(n.endpoint).map((l) => l.text).join('; ') : 'peer sem equipamento identificado'}`),
    ...drawn,
    ...notDrawn,
  ].join('. ');

  const box = (n: Node, x: number, w: number) => {
    const unread = !n.endpoint || n.endpoint.collection === 'NOT_READ';
    const lines = n.endpoint ? nodeLines(n.endpoint) : [{ text: '? peer sem equipamento identificado', cls: styles.fViolet! }];
    return (
      <g key={n.key} data-node={n.title}>
        <rect className={unread ? styles.boxUnread : styles.box} x={x} y={n.y} width={w} height={BOX} rx={6} />
        <text x={x + 13} y={n.y + 24} className={styles.svgMono}>
          {n.title}
        </text>
        {lines.map((line, i) => (
          <text key={line.text} x={x + 13} y={n.y + 46 + i * 19} className={line.cls}>
            {line.text}
          </text>
        ))}
      </g>
    );
  };

  return (
    <div>
      <div className={styles.topo}>
        <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label={`Topologia do serviço. ${summary}`}>
          {left.map((n) => {
            const access = n.endpoint ? accessLine(n.endpoint) : null;
            if (!access) return null;
            const y = n.y + BOX / 2;
            return (
              <g key={`access-${n.key}`} data-access-kind={access.kind}>
                <rect className={styles.box} x={STUB.x} y={y - 30} width={STUB.w} height={60} rx={6} />
                <text x={STUB.x + 12} y={y - 6}>
                  {access.lines[0]}
                </text>
                <text x={STUB.x + 12} y={y + 14} className={styles[FILL[access.kind]]}>
                  {access.lines[1]}
                </text>
                <path className={styles[LINE[access.kind]]} d={`M${STUB.x + STUB.w} ${y} H${LEFT.x}`} />
              </g>
            );
          })}
          {eTrunkLinks}
          {pwElements}
          {left.map((n) => box(n, LEFT.x, LEFT.w))}
          {right.map((n) => box(n, RIGHT.x, RIGHT.w))}
        </svg>
      </div>
      <p className={styles.topoHint}>Deslize o diagrama para os lados. A comparação por equipamento traz os mesmos dados em lista.</p>
      {notDrawn.length > 0 ? (
        <ul className={styles.topoExtra} aria-label="Pseudowires fora do desenho">
          {notDrawn.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      ) : null}
      <div className={styles.legend} aria-hidden="true">
        <span><i className={styles.lgActive} />▲ ativo</span>
        <span><i className={styles.lgStandby} />⏸ standby esperado</span>
        <span><i className={styles.lgCrit} />✕ falha</span>
        <span><i className={styles.lgStale} />◷ leitura antiga</span>
        <span><i className={styles.lgUnread} />? não confirmado</span>
        <span><i className={styles.lgCtl} />relação E-Trunk</span>
      </div>
    </div>
  );
}
