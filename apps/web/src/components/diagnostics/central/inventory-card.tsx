'use client';

import type { MplsAc, MplsPw, MplsVsi } from '@gmj/shared';
import { Badge } from '../service/badges';
import { formatInstant, type Tone } from '../service/view-model';
import styles from './central.module.css';

const STATUS_TONE: Record<string, Tone> = { UP: 'ok', DOWN: 'crit', DEGRADED: 'warn', ADMIN_DOWN: 'stale', PLUG_OUT: 'warn', BACKUP: 'standby', UNKNOWN: 'unk' };
const STATUS_LABEL: Record<string, string> = {
  UP: 'UP',
  DOWN: 'DOWN',
  DEGRADED: 'DEGRADADA',
  ADMIN_DOWN: 'DESATIVADA (ADMIN)',
  PLUG_OUT: 'PLUG-OUT',
  BACKUP: 'BACKUP',
  UNKNOWN: 'DESCONHECIDO',
};
const stateBadge = (status: string) => <Badge tone={STATUS_TONE[status] ?? 'unk'} label={STATUS_LABEL[status] ?? status} />;
const labelOf = (value: number | null) => (value === null ? '—' : String(value));

function acName(ac: MplsAc): string {
  return ac.interface?.name || `ifIndex ${ac.ifIndex}`;
}
function pwPeer(pw: MplsPw): string {
  return pw.remoteHost?.name ? `${pw.remoteHost.name} (${pw.remoteIp})` : pw.remoteIp;
}

/** PEs relacionados = pares remotos dos PWs (nome quando o NetVision conhece o equipamento; senao so o IP). */
export function relatedPes(vsi: Pick<MplsVsi, 'pws'>): Array<{ key: string; label: string; known: boolean }> {
  const seen = new Map<string, { key: string; label: string; known: boolean }>();
  for (const pw of vsi.pws) seen.set(pw.remoteIp, { key: pw.remoteIp, label: pwPeer(pw), known: Boolean(pw.remoteHost?.name) });
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label, 'pt-BR', { numeric: true }));
}

/**
 * Inventario PERSISTIDO (SNMP) da VSI selecionada, lido do banco. NAO e um diagnostico e nao inventa o que o
 * inventario nao tem: E-Trunk, QinQ e aprendizado MAC so existem em resultados guardados de coleta por SSH.
 */
export function VsiInventoryCard({ vsi, hostName, lastSuccessAt, canViewStored = true }: { vsi: MplsVsi; hostName: string; lastSuccessAt: string | null; canViewStored?: boolean }) {
  const pes = relatedPes(vsi);
  return (
    <section className={styles.card} aria-label="Inventário da VSI" data-inventory-card>
      <header className={styles.cardHead}>
        <h3>Inventário persistido · {vsi.name}</h3>
        <span className={styles.originTag} data-origin="INVENTORY">
          INVENTÁRIO SNMP · NÃO É DIAGNÓSTICO
        </span>
      </header>
      <dl className={styles.facts}>
        <div>
          <dt>Estado operacional</dt>
          <dd data-field="operational">{stateBadge(vsi.operationalStatus)}</dd>
        </div>
        <div>
          <dt>Administrativo</dt>
          <dd>{stateBadge(vsi.adminStatus)}</dd>
        </div>
        <div>
          <dt>Equipamento</dt>
          <dd>{hostName}</dd>
        </div>
        <div>
          <dt>Visto pela última vez</dt>
          <dd>{formatInstant(vsi.lastSeenAt)}</dd>
        </div>
        <div>
          <dt>Inventário do equipamento</dt>
          <dd>{lastSuccessAt ? `coleta ${formatInstant(lastSuccessAt)}` : 'sem coleta registrada'}</dd>
        </div>
        <div>
          <dt>Encapsulamento / sinalização</dt>
          <dd>
            {[vsi.vcType, vsi.signalingType, vsi.vlanId !== null ? `VLAN ${vsi.vlanId}` : null, vsi.mtu !== null ? `MTU ${vsi.mtu}` : null]
              .filter(Boolean)
              .join(' · ') || '—'}
          </dd>
        </div>
      </dl>

      <div className={styles.cols}>
        <div>
          <h4>PEs relacionados</h4>
          {pes.length === 0 ? (
            <p className={styles.note}>Nenhum PW registrado: não há PE remoto conhecido para esta VSI.</p>
          ) : (
            <ul className={styles.plain} data-related-pes>
              {pes.map((pe) => (
                <li key={pe.key}>
                  {pe.label}
                  {pe.known ? null : <span className={styles.note}> · fora do cadastro</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h4>
            ACs <span className={styles.count}>{vsi.acs.length}</span>
          </h4>
          {vsi.acs.length === 0 ? (
            <p className={styles.note}>Nenhum AC no inventário.</p>
          ) : (
            <ul className={styles.plain} data-acs>
              {vsi.acs.map((ac) => (
                <li key={ac.id}>
                  <span className={styles.mono}>{acName(ac)}</span> {stateBadge(ac.status)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <h4>
        PWs e labels <span className={styles.count}>{vsi.pws.length}</span>
      </h4>
      {vsi.pws.length === 0 ? (
        <p className={styles.note}>Nenhum PW no inventário.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table} data-pws>
            <thead>
              <tr>
                <th scope="col">Peer</th>
                <th scope="col">PW ID</th>
                <th scope="col">Label entrada</th>
                <th scope="col">Label saída</th>
                <th scope="col">Estado</th>
                <th scope="col">Papel</th>
              </tr>
            </thead>
            <tbody>
              {vsi.pws.map((pw) => (
                <tr key={pw.id}>
                  <td>{pwPeer(pw)}</td>
                  <td className={styles.mono}>{pw.pwId}</td>
                  <td className={styles.mono}>{labelOf(pw.inboundLabel)}</td>
                  <td className={styles.mono}>{labelOf(pw.outboundLabel)}</td>
                  <td>{stateBadge(pw.status)}</td>
                  <td>{pw.workingState === 'UNKNOWN' ? '—' : pw.workingState}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className={styles.note}>
        E-Trunk MASTER/BACKUP, encapsulamento QinQ e aprendizado MAC por interface não fazem parte do inventário SNMP.{' '}
        {canViewStored
          ? 'Aparecem nos resultados guardados de coleta (seção “Resultados guardados”).'
          : 'Aparecem nos resultados guardados de coleta, restritos a OPERATOR e ADMIN.'}
      </p>
    </section>
  );
}
