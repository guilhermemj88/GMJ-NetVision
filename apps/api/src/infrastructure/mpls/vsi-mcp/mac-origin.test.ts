import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EndpointDiagnosis } from './correlator';
import { parseMacTable } from './parsers';
import { VsiMcpTools } from './tools';
import { CDB, CDB_VSI, LIKEE_MCP_AT, LIKEE_MCP_RECORDINGS, cdbHost, cdbInventory, replayCollector } from '../vsi-service/__fixtures__/replay';

/**
 * REGRESSAO — origem do aprendizado MAC.
 * Captura REAL: BHE-LIKEE-6730-MPLS-01 (Master), S6730 V200R021C00SPC100, fluxo MCP -> SSH em 2026-11-17T00:15Z.
 * A VSI tem UM AC (Eth-Trunk17.3072) e um PW up; a tabela traz 125 MACs em Eth-Trunk1 e 2 em Eth-Trunk17.
 * Antes: os 127 eram resumidos como "via AC" (todo Learned-From com nome de interface contava como AC).
 * Agora: AC so com evidencia (o AC ou sua interface pai/filha); o resto fica NAO CLASSIFICADO — nem AC, nem PW.
 */
const RAW = readFileSync(join(__dirname, '..', '__fixtures__', 'likee-3072-mcp-20261117', 'likee-mac-vsi.txt'), 'utf8');

const run = async (recordings = LIKEE_MCP_RECORDINGS) => {
  const { collector } = replayCollector(recordings, { family: 'S6730_V200', completedAt: LIKEE_MCP_AT, release: 'V200R021C00SPC100' });
  const tools = new VsiMcpTools({ hosts: { getHost: async (id) => cdbHost(id) }, mpls: { listVsis: async (id) => cdbInventory(id) }, live: collector, consumeApproval: () => {}, audit: () => {}, now: () => new Date(LIKEE_MCP_AT) });
  const env = await tools.call('diagnose_vsi', { hostId: CDB.likee, vsiName: CDB_VSI, approvalId: '11111111-1111-4111-8111-111111111111', includeMac: true, carrierInterfaces: ['Eth-Trunk17'], eTrunkIds: [4], homologation: true }, { id: 'u', username: 'admin', role: 'ADMIN' });
  return { env, diagnosis: (env.data as { diagnosis: EndpointDiagnosis }).diagnosis };
};

describe('tabela MAC real do LIKEE: a interface de aprendizado e preservada', () => {
  it('parser: 127 entradas completas, 125 em Eth-Trunk1 e 2 em Eth-Trunk17, nenhuma com peer/PW no Learned-From', () => {
    const t = parseMacTable(RAW, CDB_VSI);
    expect(t).toMatchObject({ complete: true, declaredTotal: 127 });
    expect(t.entries).toHaveLength(127);
    expect(t.entries.filter((e) => e.learnedFrom === 'Eth-Trunk1')).toHaveLength(125);
    expect(t.entries.filter((e) => e.learnedFrom === 'Eth-Trunk17')).toHaveLength(2);
    expect(t.entries.some((e) => e.side === 'PW')).toBe(false);
    expect(new Set(t.entries.map((e) => e.mac)).size).toBe(127);
  });

  it('resumo: 2 pelo AC (pai do AC Eth-Trunk17.3072), 0 pelo PW, 125 NAO CLASSIFICADOS em Eth-Trunk1 — total mantido', async () => {
    const { diagnosis } = await run();
    const m = diagnosis.macSummary!;
    expect(m).toMatchObject({ total: 127, declaredTotal: 127, viaAc: 2, viaPw: 0, viaUnresolved: 125, unresolvedOrigin: ['Eth-Trunk1'] });
    expect(m.byLearnedFrom).toEqual({ 'Eth-Trunk1': 125, 'Eth-Trunk17': 2 });
    expect(m.viaAc + m.viaPw + m.viaUnresolved).toBe(m.total);
  });

  it('Eth-Trunk1 nao e presumido PW nem AC: nenhuma ausencia e afirmada e o achado diz "nao classificada"', async () => {
    const { diagnosis } = await run();
    const codes = diagnosis.findings.map((f) => f.code);
    expect(codes).not.toContain('NO_MAC_FROM_PW');
    expect(codes).not.toContain('NO_MAC_FROM_AC');
    const f = diagnosis.findings.find((x) => x.code === 'MAC_LEARNED_ON_NON_AC_INTERFACE')!;
    expect(f).toMatchObject({ severity: 'INFO', certainty: 'CONFIRMED' });
    expect(f.title).toContain('Eth-Trunk1');
    expect(f.title).not.toContain('Eth-Trunk17');
    expect(f.explanation).toContain('Eth-Trunk1 (125)');
    expect(f.explanation).toMatch(/NAO CLASSIFICADA/);
    expect(JSON.stringify(diagnosis.findings)).not.toMatch(/via PW: 125|125 via PW/);
    expect(diagnosis.notVerified.join(' ')).toMatch(/Origem real .* Eth-Trunk1/);
  });

  it('o restante do diagnostico do Master nao muda: ACTIVE, sem critico/alerta, servico e encapsulamento OK', async () => {
    const { env, diagnosis } = await run();
    expect(env.collectionIssues).toEqual([]);
    expect(diagnosis.operationalRole).toBe('ACTIVE');
    expect(diagnosis.findings.some((f) => f.severity === 'CRITICAL' || f.severity === 'WARNING')).toBe(false);
    expect(diagnosis.dimensions).toEqual({ VSI_STATE: 'OK', AC_STATE: 'OK', PW_STATE: 'OK', AC_BINDING: 'OK', MAC_LEARNING: 'OK', ENCAPSULATION: 'OK' });
    expect(diagnosis.vlanPaths[0]).toMatchObject({ mode: 'QINQ_STACKING', tagCount: 2 });
  });

  it('com o peer do PW no Learned-From a entrada E classificada como PW (evidencia do proprio campo)', async () => {
    const withPw = RAW.replace(/Eth-Trunk1 {10}dynamic/, '10.100.101.2        dynamic');
    const { diagnosis } = await run({ [CDB.likee]: { ...LIKEE_MCP_RECORDINGS[CDB.likee]!, [`display mac-address vsi ${CDB_VSI}`]: withPw.trimEnd() } });
    expect(diagnosis.macSummary).toMatchObject({ total: 127, viaAc: 2, viaPw: 1, viaUnresolved: 124 });
  });
});
