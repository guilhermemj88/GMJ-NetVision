import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HostRecord, MplsVsi } from '@gmj/shared';
import type { HuaweiFamily } from '../vsi-mcp/platform';
import type { ToolEnvelope } from '../vsi-mcp/contracts';
import { aggregateVsiService, type AggregateParticipant, type DiagnoseVsiData } from './aggregator';
import { CDB, CDB_RECORDINGS, CDB_VSI, cdbHost, cdbInventory, replayCollector } from './__fixtures__/replay';
import { VsiMcpTools } from '../vsi-mcp/tools';

/**
 * FERRAMENTA DE HOMOLOGACAO (nao abre SSH, nao chama API): transforma os resultados de
 * `diagnose_vsi` JA COLETADOS em cada PE num `VsiServiceDiagnosis`, para abrir na pre-visualizacao.
 *
 *   VSI_HOMOLOG_DIR=<pasta> npx vitest run src/infrastructure/mpls/vsi-service/homolog-aggregate
 *
 * A pasta contem `manifest.json` e os arquivos de resultado que ele cita (saida de call.sh com
 * VSI_CALL_OUT). Grava `<pasta>/service-diagnosis.json`. Sem a variavel, so o teste de formato roda.
 *
 * REPROCESSAMENTO OFFLINE (tambem sem SSH): com VSI_HOMOLOG_REPLAY=1, cada participante que tenha `replay`
 * no manifesto e REDIAGNOSTICADO pelo motor atual a partir das capturas preservadas daquela sessao
 * (`<capturesDir>/*.txt`, com cabecalho `# command:` / `# completedAt:`). O resultado sai em
 * `<pasta>/service-diagnosis.replay.json`, com origem REPLAY; os arquivos originais nao sao tocados.
 */

interface Manifest {
  vsiName: string;
  engineVersion: string;
  operator: { username: string; role: string } | null;
  participants: Array<{
    hostId: string | null;
    hostName: string;
    loopback: string | null;
    discoveredBy: AggregateParticipant['discoveredBy'];
    /** Arquivo com a resposta de diagnose_vsi deste PE; null = PE nao lido. */
    resultFile: string | null;
    inventory: MplsVsi | null;
    /** Capturas preservadas da sessao real + os mesmos argumentos da chamada original. */
    replay?: { capturesDir: string; family: HuaweiFamily; includeMac: boolean; carrierInterfaces: string[]; eTrunkIds: number[] };
  }>;
}

/** Le as capturas gravadas pelo coletor (`# command:` / `# completedAt:` + saida). A preparacao da sessao nao e um `display`. */
export function readCaptures(dir: string): { recordings: Record<string, string>; completedAt: Record<string, string> } {
  const recordings: Record<string, string> = {};
  const completedAt: Record<string, string> = {};
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.txt')).sort()) {
    const text = readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n');
    const command = /^# command: (.+)$/m.exec(text)?.[1]?.trim();
    const at = /^# completedAt: (.+)$/m.exec(text)?.[1]?.trim();
    if (!command || !at || !command.startsWith('display ')) continue;
    recordings[command] = text.replace(/^# command: .*\n# completedAt: .*\n\n?/, '').trimEnd();
    completedAt[command] = at;
  }
  return { recordings, completedAt };
}

/** Rediagnostica UM PE a partir das capturas preservadas: motor real (politica, parsers, correlator), nenhum SSH. */
export async function replayParticipant(dir: string, vsiName: string, p: Manifest['participants'][number]): Promise<ToolEnvelope<DiagnoseVsiData>> {
  const r = p.replay!;
  const { recordings, completedAt } = readCaptures(join(dir, r.capturesDir));
  const last = Object.values(completedAt).sort().at(-1)!;
  const hostId = p.hostId!;
  const { collector } = replayCollector({ [hostId]: recordings }, { family: r.family, completedAt: last, completedAtOf: (command) => completedAt[command] ?? last });
  const host = { id: hostId, name: p.hostName, vendor: 'Huawei', sshEnabled: true, ssh: { host: '192.0.2.1', port: 22, username: 'replay', contextCommand: null, credentialConfigured: true } } as unknown as HostRecord;
  const tools = new VsiMcpTools({
    hosts: { getHost: async (id) => (id === hostId ? host : null) },
    mpls: { listVsis: async (id) => (id === hostId && p.inventory ? [p.inventory] : []) },
    live: collector,
    consumeApproval: () => {},
    audit: () => {},
    now: () => new Date(last),
  });
  const env = await tools.call(
    'diagnose_vsi',
    { hostId, vsiName, approvalId: '00000000-0000-4000-8000-000000000000', includeMac: r.includeMac, carrierInterfaces: r.carrierInterfaces, eTrunkIds: r.eTrunkIds, homologation: true },
    { id: 'replay', username: 'replay', role: 'ADMIN' },
  );
  return JSON.parse(JSON.stringify(env)) as ToolEnvelope<DiagnoseVsiData>;
}

/** Aceita o envelope puro ou embrulhado pelo MCP (JSON-RPC -> result.content[].text / structuredContent). */
export function unwrapEnvelope(value: unknown): ToolEnvelope<DiagnoseVsiData> {
  const seen = new Set<unknown>();
  const visit = (v: unknown): ToolEnvelope<DiagnoseVsiData> | null => {
    if (typeof v === 'string') {
      const t = v.trim();
      if (!t.startsWith('{')) return null;
      try {
        return visit(JSON.parse(t));
      } catch {
        return null;
      }
    }
    if (v === null || typeof v !== 'object' || seen.has(v)) return null;
    seen.add(v);
    const o = v as Record<string, unknown>;
    if (o.tool === 'diagnose_vsi' && typeof o.status === 'string' && Array.isArray(o.evidence)) return o as unknown as ToolEnvelope<DiagnoseVsiData>;
    for (const child of Array.isArray(v) ? v : Object.values(o)) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  const env = visit(value);
  if (!env) throw new Error('Resposta de diagnose_vsi nao encontrada no arquivo (formato inesperado ou resposta cortada).');
  if (!Array.isArray(env.collectionIssues) || (env.data && !('facts' in env.data)))
    throw new Error('Resposta gerada por bundle antigo: faltam `collectionIssues`/`facts`. Atualize o bundle do harness antes de coletar.');
  return env;
}

export function aggregateFromManifest(dir: string, manifest: Manifest, runId: string, replayed: Map<string, ToolEnvelope<DiagnoseVsiData>> | null = null) {
  const participants: AggregateParticipant[] = manifest.participants.map((p) => ({
    hostId: p.hostId,
    hostName: p.hostName,
    loopback: p.loopback,
    discoveredBy: p.discoveredBy,
    inventory: p.inventory,
    envelope: replayed?.get(p.hostName) ?? (p.resultFile ? unwrapEnvelope(JSON.parse(readFileSync(join(dir, p.resultFile), 'utf8'))) : null),
    ...(p.resultFile ? {} : { notRead: 'NOT_REQUESTED' as const }),
  }));
  const times = participants.flatMap((p) => (p.envelope ? [p.envelope.generatedAt] : [])).sort();
  if (times.length === 0) throw new Error('Nenhum resultado de PE no manifesto.');
  return aggregateVsiService({
    runId,
    engineVersion: manifest.engineVersion,
    origin: replayed ? 'REPLAY' : 'ENGINE_RUN',
    vsiName: manifest.vsiName,
    operator: manifest.operator,
    startedAt: times[0]!,
    // "agora" da composicao = a leitura mais recente: as leituras sao julgadas entre si, nao contra o relogio de quem agrega
    completedAt: times.at(-1)!,
    demonstration: replayed
      ? {
          label: 'Replay das capturas reais',
          provenance: `REPLAY, sem SSH: o motor atual rediagnosticou as capturas preservadas das sessões reais de ${[...replayed.keys()].join(' e ')} (leituras originais em ${times.join(' e ')}, uma sessão por PE, não simultâneas). Mostra como o motor de hoje interpreta aquelas saídas; não é uma nova leitura dos equipamentos.`,
        }
      : {
          label: 'Homologação DEV',
          provenance: `Leituras reais de diagnose_vsi feitas em ${times.length} PE(s), uma sessão por PE, agregadas fora da API. Cada PE foi lido em momento próprio (${times.join(' e ')}): não é uma leitura simultânea.`,
        },
    participants,
  });
}

describe('agregacao offline de resultados de homologacao', () => {
  it('le o envelope embrulhado pelo MCP e recusa resposta de bundle antigo ou cortada', async () => {
    const { collector } = replayCollector(CDB_RECORDINGS, { family: 'S6730_V200', completedAt: '2026-11-16T14:00:00.000Z' });
    const tools = new VsiMcpTools({ hosts: { getHost: async (id) => cdbHost(id) }, mpls: { listVsis: async (id) => cdbInventory(id) }, live: collector, consumeApproval: () => {}, audit: () => {} });
    const env = JSON.parse(JSON.stringify(await tools.call('diagnose_vsi', { hostId: CDB.likee, vsiName: CDB_VSI, approvalId: '11111111-1111-4111-8111-111111111111', includeMac: false, carrierInterfaces: ['Eth-Trunk17'], eTrunkIds: [4], homologation: true }, { id: 'u', username: 'admin', role: 'ADMIN' })));
    const wrapped = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(env) }] } };
    expect(unwrapEnvelope(wrapped)).toEqual(env);
    expect(unwrapEnvelope(env)).toEqual(env);
    const { collectionIssues: _dropped, ...old } = env;
    expect(() => unwrapEnvelope(old)).toThrow(/bundle antigo/);
    expect(() => unwrapEnvelope({ result: { content: [{ type: 'text', text: JSON.stringify(env).slice(0, 500) }] } })).toThrow(/nao encontrada/);
  });

  it.skipIf(!process.env.VSI_HOMOLOG_DIR || process.env.VSI_HOMOLOG_REPLAY !== '1')('REPLAY: rediagnostica as capturas preservadas e grava service-diagnosis.replay.json', async () => {
    const dir = process.env.VSI_HOMOLOG_DIR!;
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
    const replayed = new Map<string, ToolEnvelope<DiagnoseVsiData>>();
    for (const p of manifest.participants) if (p.replay) replayed.set(p.hostName, await replayParticipant(dir, manifest.vsiName, p));
    expect(replayed.size).toBeGreaterThan(0);
    for (const [name, env] of replayed) {
      writeFileSync(join(dir, `replay-envelope-${name}.json`), `${JSON.stringify(env, null, 1)}\n`);
      expect(env.collectionIssues, name).toEqual([]);
    }
    const d = aggregateFromManifest(dir, { ...manifest, engineVersion: process.env.VSI_HOMOLOG_ENGINE ?? manifest.engineVersion }, `replay-${manifest.vsiName}`, replayed);
    writeFileSync(join(dir, 'service-diagnosis.replay.json'), `${JSON.stringify(d, null, 2)}\n`);
    expect(d.origin).toBe('REPLAY');
    expect(JSON.stringify(d)).not.toMatch(/password|passwd/i);
    console.log(`REPLAY veredito ${d.verdict.status} · eixos ${Object.entries(d.axes).map(([k, a]) => `${k}=${a.state}`).join(' ')} · ${d.endpoints.map((e) => `${e.hostName}:${e.collection}/${e.accessRole ?? 'sem papel'}/${e.serviceState}/falta[${e.missingEvidence.join('; ')}]`).join(' ')}`);
  });

  it.skipIf(!process.env.VSI_HOMOLOG_DIR || process.env.VSI_HOMOLOG_REPLAY === '1')('gera service-diagnosis.json a partir do manifesto', () => {
    const dir = process.env.VSI_HOMOLOG_DIR!;
    expect(existsSync(join(dir, 'manifest.json'))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
    const d = aggregateFromManifest(dir, manifest, `homolog-${manifest.vsiName}`);
    writeFileSync(join(dir, 'service-diagnosis.json'), `${JSON.stringify(d, null, 2)}\n`);
    expect(d.endpoints).toHaveLength(manifest.participants.length);
    expect(JSON.stringify(d)).not.toMatch(/password|passwd/i);
    console.log(`veredito ${d.verdict.status} · eixos ${Object.entries(d.axes).map(([k, a]) => `${k}=${a.state}`).join(' ')} · papeis ${d.endpoints.map((e) => `${e.hostName}:${e.accessRole ?? 'sem papel'}/${e.serviceState}`).join(' ')}`);
  });
});
