import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acVlanTransform, type EndpointDiagnosis } from './correlator';
import { parseInterfaceConfig } from './parsers';
import { VsiMcpTools } from './tools';
import { CDB, CDB_VSI, VTA_MCP_AT, VTA_MCP_RECORDINGS, cdbHost, cdbInventory, replayCollector } from '../vsi-service/__fixtures__/replay';

/**
 * `qinq stacking vid <ce> [to <ce-fim>] pe-vid <pe>` (subinterface de stacking da serie S).
 * Captura REAL: BHE-VTA-6730-MPLS-01, S6730 V200R022C00SPC500, fluxo MCP -> SSH em 2026-11-16T19:37Z.
 * Antes desta correcao a linha era ignorada e o motor dizia "sem diretivas de encapsulamento (comum em VLANIF)".
 */
const REAL = readFileSync(join(__dirname, '..', '__fixtures__', 'vta-3072-mcp-20261116', 'vta-config-eth-trunk26.3072.txt'), 'utf8');
const block = (...lines: string[]) => `#\ninterface Eth-Trunk9.100\n${lines.map((l) => ` ${l}`).join('\n')}\n#\nreturn\n<PE>`;

describe('parser: qinq stacking vid ... pe-vid ...', () => {
  it('captura real: as duas linhas (faixa e VLAN unica) viram diretivas de stacking; binding e interface preservados', () => {
    const cfg = parseInterfaceConfig(REAL, 'Eth-Trunk26.3072');
    expect(cfg).toMatchObject({ complete: true, interfaceName: 'Eth-Trunk26.3072', l2BindingVsi: CDB_VSI, parentInterface: 'Eth-Trunk26' });
    expect(cfg.directives).toEqual([
      { kind: 'QINQ_STACKING', vlan: '3072 to 3073', stackVlan: '3072', raw: 'qinq stacking vid 3072 to 3073 pe-vid 3072' },
      { kind: 'QINQ_STACKING', vlan: '3951', stackVlan: '3072', raw: 'qinq stacking vid 3951 pe-vid 3072' },
    ]);
  });

  it('caminho de VLAN: todas as VLANs de cliente entram, a tag externa e a pe-vid, duas tags seguem para a VSI', () => {
    expect(acVlanTransform(parseInterfaceConfig(REAL, 'Eth-Trunk26.3072'))).toEqual({
      interfaceName: 'Eth-Trunk26.3072',
      mode: 'QINQ_STACKING',
      ingress: ['3072 to 3073', '3951'],
      transported: ['3072', '3072 to 3073', '3951'],
      tagCount: 2,
      directives: ['qinq stacking vid 3072 to 3073 pe-vid 3072', 'qinq stacking vid 3951 pe-vid 3072'],
    });
  });

  it('VLAN unica e faixa isoladas; a sintaxe antiga (vlan ... stack-vlan ...) continua com o mesmo resultado', () => {
    expect(parseInterfaceConfig(block('qinq stacking vid 10 pe-vid 200'), 'Eth-Trunk9.100').directives).toEqual([
      { kind: 'QINQ_STACKING', vlan: '10', stackVlan: '200', raw: 'qinq stacking vid 10 pe-vid 200' },
    ]);
    expect(parseInterfaceConfig(block('qinq stacking vid 10 to 20 pe-vid 200'), 'Eth-Trunk9.100').directives[0]).toMatchObject({ vlan: '10 to 20', stackVlan: '200' });
    const old = acVlanTransform(parseInterfaceConfig(block('qinq stacking vlan 10 stack-vlan 200'), 'Eth-Trunk9.100'));
    expect(old).toMatchObject({ mode: 'QINQ_STACKING', ingress: ['10'], transported: ['200', '10'], tagCount: 2 });
  });

  it('linha malformada nao e aceita por aproximacao', () => {
    for (const bad of ['qinq stacking vid 10 pe-vid', 'qinq stacking vid pe-vid 200', 'qinq stacking vid 10 to pe-vid 200', 'qinq stacking vid 10 pe-vid 200 extra', 'qinq stacking vid abc pe-vid 200'])
      expect(parseInterfaceConfig(block(bad), 'Eth-Trunk9.100').directives, bad).toEqual([]);
  });
});

describe('motor sobre a sessao real do VTA-01 (replay, sem SSH)', () => {
  const run = async () => {
    const { collector, sessions } = replayCollector(VTA_MCP_RECORDINGS, { family: 'S6730_V200', completedAt: VTA_MCP_AT, release: 'V200R022C00SPC500' });
    const tools = new VsiMcpTools({ hosts: { getHost: async (id) => cdbHost(id) }, mpls: { listVsis: async (id) => cdbInventory(id) }, live: collector, consumeApproval: () => {}, audit: () => {}, now: () => new Date(VTA_MCP_AT) });
    const env = await tools.call('diagnose_vsi', { hostId: CDB.vta, vsiName: CDB_VSI, approvalId: '11111111-1111-4111-8111-111111111111', includeMac: false, carrierInterfaces: ['Eth-Trunk26'], eTrunkIds: [4], homologation: true }, { id: 'u', username: 'admin', role: 'ADMIN' });
    return { env, sessions, diagnosis: (env.data as { diagnosis: EndpointDiagnosis }).diagnosis };
  };

  it('encapsulamento passa a ser avaliado (local) e a classificacao da ponta NAO muda', async () => {
    const { env, diagnosis } = await run();
    expect(env.collectionIssues).toEqual([]);
    expect(diagnosis.vlanPaths).toEqual([expect.objectContaining({ interfaceName: 'Eth-Trunk26.3072', mode: 'QINQ_STACKING', tagCount: 2 })]);
    expect(diagnosis.dimensions.ENCAPSULATION).toBe('OK');
    expect(diagnosis.findings.map((f) => f.code)).not.toContain('ENCAPSULATION_NOT_EVALUATED');
    // o que ja valia na leitura real de 19:37Z continua igual
    expect(diagnosis.operationalRole).toBe('STANDBY_EXPECTED');
    expect(diagnosis.findings.map((f) => f.code).sort()).toEqual(['PERSISTED_PW_STALE', 'STANDBY_PATH_IDLE', 'VSI_DOWN_STANDBY_EXPECTED']);
    expect(diagnosis.findings.some((f) => f.severity === 'CRITICAL' || f.severity === 'WARNING')).toBe(false);
    expect(diagnosis.dimensions).toMatchObject({ VSI_STATE: 'NOT_EVALUATED', AC_STATE: 'NOT_EVALUATED', AC_BINDING: 'OK' });
  });

  it('a outra ponta continua nao verificada: encapsulamento OK e sempre LOCAL', async () => {
    const { diagnosis } = await run();
    expect(diagnosis.notVerified.join(' ')).toContain('outra ponta');
  });
});
