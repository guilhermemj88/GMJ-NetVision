import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HostRecord, MplsVsi } from '@gmj/shared';
import { safeVsiMcpCommand, type VsiMcpOperation } from '../../vsi-mcp/command-policy';
import type { LiveSessionResult, VsiMcpLiveCollector } from '../../vsi-mcp/live-collector';
import { resolveCapability, type HuaweiFamily } from '../../vsi-mcp/platform';

/**
 * REPLAY: coletor que devolve capturas GRAVADAS em vez de abrir SSH. Aplica a mesma politica de
 * comandos e a mesma matriz de capacidades do coletor real. Um comando sem captura gravada volta
 * VAZIO e INCOMPLETO (nunca com texto inventado): o motor o trata como saida nao obtida.
 */
export function replayCollector(
  recordings: Record<string, Record<string, string>>,
  options: { family: HuaweiFamily; completedAt: string; release?: string | null; completedAtOf?: (command: string) => string },
) {
  const sessions: Array<{ hostId: string; commands: string[] }> = [];
  const collector: VsiMcpLiveCollector = {
    async collect(h, operations, opts) {
      const captures: LiveSessionResult['captures'] = [];
      const skipped: LiveSessionResult['skipped'] = [];
      const sent: string[] = [];
      for (const operation of [{ kind: 'VERSION' } as VsiMcpOperation, ...operations]) {
        const decision = resolveCapability(options.family, operation.kind, opts.homologation === true);
        if (!decision.allowed) {
          skipped.push({ operation, reason: decision.reason === 'NOT_SUPPORTED' ? 'NOT_SUPPORTED' : 'CANDIDATE_NOT_HOMOLOGATED', note: decision.note });
          continue;
        }
        const command = safeVsiMcpCommand(operation);
        opts.audit(command);
        sent.push(command);
        if (operation.kind === 'VERSION') continue; // a familia vem do perfil do replay; `display version` nao foi gravado
        const stdout = recordings[h.id]?.[command] ?? '';
        captures.push({
          operation,
          command,
          stdout,
          completedAt: options.completedAtOf?.(command) ?? options.completedAt,
          durationMs: 0,
          sha256: createHash('sha256').update(stdout).digest('hex'),
          complete: stdout.trimEnd().endsWith('>'),
        });
      }
      sessions.push({ hostId: h.id, commands: sent });
      return { platform: { family: options.family, model: null, release: options.release ?? null, matchedLine: null }, prompt: `<${h.name}>`, captures, skipped };
    },
  };
  return { collector, sessions };
}

/* ------------------------------------------------------------------ */
/* Caso CDB TELECOM / VSI 3072 — capturas reais de 2026-11-16          */
/* ------------------------------------------------------------------ */

const dir = join(__dirname, '..', '..', '__fixtures__', 'cdb-etrunk-20261116');
const read = (file: string): string => readFileSync(join(dir, file), 'utf8').trimEnd();

export const CDB_VSI = '3072-QinQ-CDB-MANTIQUEIRA';
export const CDB = { likee: 'h-likee', vta: 'h-vta', mqt: 'h-mqt' } as const;
const NAMES: Record<string, string> = { [CDB.likee]: 'BHE-LIKEE-6730-MPLS-01', [CDB.vta]: 'BHE-VTA-6730-MPLS-01', [CDB.mqt]: 'BHE-MQT-6730-MPLS-01' };

export const cdbHost = (id: string): HostRecord | null =>
  NAMES[id]
    ? ({ id, name: NAMES[id], vendor: 'Huawei', sshEnabled: true, ssh: { host: '192.0.2.1', port: 22, username: 'svc', contextCommand: null, credentialConfigured: true } } as unknown as HostRecord)
    : null;

/** Somente o que foi REALMENTE capturado em 16/11. Nao ha `display vsi` da 3072 em nenhum PE. */
export const CDB_RECORDINGS: Record<string, Record<string, string>> = {
  [CDB.likee]: {
    'display e-trunk brief': read('likee-e-trunk-brief.sanitized.txt'),
    'display eth-trunk 17': read('likee-eth-trunk-17.sanitized.txt'),
    'display current-configuration interface Eth-Trunk17': read('likee-config-eth-trunk17.sanitized.txt'),
  },
  [CDB.vta]: {
    'display e-trunk brief': read('vta-e-trunk-brief.sanitized.txt'),
    'display e-trunk 4': read('vta-e-trunk-4.sanitized.txt'),
    'display eth-trunk 26': read('vta-eth-trunk-26.sanitized.txt'),
    // captura real TRUNCADA (sem o fim do bloco e sem o prompt), mantida como recebida
    'display current-configuration interface Eth-Trunk26': read('vta-config-eth-trunk26.truncated.sanitized.txt'),
  },
};

/**
 * Sessao REAL do fluxo MCP -> SSH no BHE-VTA-6730-MPLS-01 em 2026-11-16T19:37Z (uma sessao, 7 `display`,
 * todos completos). E a primeira captura com `display vsi` da 3072 e com a subinterface de stacking.
 */
const mcpDir = join(__dirname, '..', '..', '__fixtures__', 'vta-3072-mcp-20261116');
const mcp = (file: string): string => readFileSync(join(mcpDir, file), 'utf8').trimEnd();
export const VTA_MCP_AT = '2026-11-16T19:37:10.446Z';
export const VTA_MCP_RECORDINGS: Record<string, Record<string, string>> = {
  [CDB.vta]: {
    [`display vsi name ${CDB_VSI} verbose`]: mcp('vta-vsi-verbose.txt'),
    'display current-configuration interface Eth-Trunk26.3072': mcp('vta-config-eth-trunk26.3072.txt'),
    'display current-configuration interface Eth-Trunk26': mcp('vta-config-eth-trunk26.txt'),
    'display eth-trunk 26': mcp('vta-eth-trunk-26.txt'),
    'display e-trunk brief': mcp('vta-e-trunk-brief.txt'),
    'display e-trunk 4': mcp('vta-e-trunk-4.txt'),
  },
};

/**
 * Sessao REAL do fluxo MCP -> SSH no BHE-LIKEE-6730-MPLS-01 (lado Master) em 2026-11-17T00:15Z: uma sessao,
 * 8 `display`, todos completos, com a tabela MAC da VSI (127 entradas; MACs sanitizados, OUI preservado).
 */
const likeeDir = join(__dirname, '..', '..', '__fixtures__', 'likee-3072-mcp-20261117');
const likee = (file: string): string => readFileSync(join(likeeDir, file), 'utf8').trimEnd();
export const LIKEE_MCP_AT = '2026-11-17T00:15:30.545Z';
export const LIKEE_MCP_RECORDINGS: Record<string, Record<string, string>> = {
  [CDB.likee]: {
    [`display vsi name ${CDB_VSI} verbose`]: likee('likee-vsi-verbose.txt'),
    'display current-configuration interface Eth-Trunk17.3072': likee('likee-config-eth-trunk17.3072.txt'),
    'display current-configuration interface Eth-Trunk17': likee('likee-config-eth-trunk17.txt'),
    'display eth-trunk 17': likee('likee-eth-trunk-17.txt'),
    'display e-trunk brief': likee('likee-e-trunk-brief.txt'),
    'display e-trunk 4': likee('likee-e-trunk-4.txt'),
    [`display mac-address vsi ${CDB_VSI}`]: likee('likee-mac-vsi.txt'),
  },
};

const stamp = (lastSeenAt: string) => ({ lastSeenAt, createdAt: lastSeenAt, updatedAt: lastSeenAt, source: 'SNMP' });

/** Inventario SNMP de 16/11 (valores lidos do banco do NetVision em consulta somente leitura). */
export function cdbInventory(hostId: string): MplsVsi[] {
  const vsi = (lastSeenAt: string, operationalStatus: string, ac: [string, string], pw: [string, string | null, string, string, number, number]) =>
    [
      {
        id: `vsi-${hostId}`, hostId, name: CDB_VSI, rd: hostId === CDB.mqt ? null : '268568:53072', mtu: hostId === CDB.mqt ? null : 2000,
        operationalStatus, status: operationalStatus, ...stamp(lastSeenAt),
        acs: [{ id: `ac-${hostId}`, hostId, ifIndex: 0, interface: { id: 'i', name: ac[0], alias: '', ifIndex: 0 }, status: ac[1], ...stamp(lastSeenAt) }],
        pws: [{ id: `pw-${hostId}`, hostId, remoteIp: pw[0], remoteHostId: pw[1], state: pw[2], inboundLabel: pw[4], outboundLabel: pw[5], ...stamp(pw[3]) }],
      },
    ] as unknown as MplsVsi[];
  if (hostId === CDB.likee) return vsi('2026-11-16T13:50:19.000Z', 'UP', ['Eth-Trunk17.3072', 'UP'], ['10.100.101.2', CDB.mqt, 'UP', '2026-11-16T13:50:19.000Z', 36706, 35842]);
  if (hostId === CDB.vta) return vsi('2026-11-16T13:51:10.000Z', 'DOWN', ['Eth-Trunk26.3072', 'DOWN'], ['10.100.101.2', CDB.mqt, 'UP', '2026-10-27T01:24:40.000Z', 41335, 35840]);
  if (hostId === CDB.mqt) return vsi('2026-11-16T13:52:00.000Z', 'UP', ['XGigabitEthernet0/0/4.3072', 'UP'], ['10.100.101.3', CDB.likee, 'UP', '2026-11-16T13:52:00.000Z', 35842, 36706]);
  return [];
}
