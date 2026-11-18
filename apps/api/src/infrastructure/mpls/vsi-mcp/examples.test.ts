import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VsiMcpTools } from './tools';
import { fakeCollector } from './__fixtures__/harness';
import * as S from './__fixtures__/synthetic';
import type { HostRecord } from '@gmj/shared';

/**
 * Exemplos de request/response MCP versionados em docs/vsi-mcp-examples/.
 * Teste "golden": o JSON publicado na documentacao e exatamente o que o codigo
 * produz. Regenerar com `UPDATE_VSI_MCP_EXAMPLES=1 npx vitest run examples`.
 * Dados: fixtures SINTETICAS (ver __fixtures__/synthetic.ts).
 */

const DOCS = join(__dirname, '..', '..', '..', '..', '..', '..', 'docs', 'vsi-mcp-examples');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ADMIN = { id: 'u1', username: 'admin', role: 'ADMIN' } as const;

const hostOf = (id: string): HostRecord =>
  ({ id, name: id === 'h-a' ? 'PE-A' : 'PE-B', vendor: 'Huawei', sshEnabled: true, ssh: { host: '10.0.0.1', port: 2222, username: 'svc', contextCommand: null, credentialConfigured: true } }) as unknown as HostRecord;

function tools(outputs: Record<string, Record<string, string>>) {
  return new VsiMcpTools({
    hosts: { getHost: async (id) => (id === 'h-a' || id === 'h-b' ? hostOf(id) : null) },
    mpls: { listVsis: async () => [] },
    live: fakeCollector(outputs).collector,
    consumeApproval: () => {},
    audit: () => {},
    now: () => new Date('2026-11-09T12:00:00.000Z'),
  });
}

const scenarioA = {
  'h-a': {
    'display version': S.NE_VERSION,
    'display vsi name L2-PPPOE-3901 verbose': S.SCEN_A_VSI,
    'display mac-address vsi L2-PPPOE-3901': S.MAC_WITH_AC_AND_PW,
    'display current-configuration interface GigabitEthernet1/0/1': S.SCEN_A_PARENT_CFG,
    'display current-configuration interface GigabitEthernet1/0/1.3901': S.SCEN_A_SUB_CFG,
  },
};
const scenarioB = {
  'h-a': { 'display version': S.NE_VERSION, 'display vsi name SVC-50-502 verbose': S.SCEN_B_VSI_A, 'display current-configuration interface GigabitEthernet2/0/1.50': S.SCEN_B_CFG_A, 'display mac-address vsi SVC-50-502': S.MAC_SCEN_B_A },
  'h-b': { 'display version': S.NE_VERSION, 'display vsi name SVC-50-502 verbose': S.SCEN_B_VSI_B, 'display current-configuration interface GigabitEthernet3/0/2.502': S.SCEN_B_CFG_B, 'display mac-address vsi SVC-50-502': S.MAC_EMPTY },
};

const cases = [
  {
    file: 'diagnose_vsi.cenario-a-pppoe-3901.json',
    tool: 'diagnose_vsi' as const,
    outputs: scenarioA,
    request: { hostId: 'h-a', vsiName: 'L2-PPPOE-3901', approvalId: A, includeMac: true, homologation: true },
  },
  {
    file: 'compare_vsi_endpoints.cenario-b-vlan-50-502.json',
    tool: 'compare_vsi_endpoints' as const,
    outputs: scenarioB,
    request: {
      a: { hostId: 'h-a', vsiName: 'SVC-50-502', approvalId: A, peerAddress: '10.0.0.9' },
      b: { hostId: 'h-b', vsiName: 'SVC-50-502', approvalId: B, peerAddress: '10.0.0.1' },
      includeMac: true,
      homologation: true,
    },
  },
  {
    file: 'get_vsi_mac_table.not-supported-sem-homologacao.json',
    tool: 'get_vsi_mac_table' as const,
    outputs: scenarioA,
    request: { hostId: 'h-a', vsiName: 'L2-PPPOE-3901', approvalId: A },
  },
];

describe('exemplos MCP (golden)', () => {
  for (const c of cases) {
    it(c.file, async () => {
      const response = await tools(c.outputs).call(c.tool, c.request, ADMIN);
      const text = JSON.stringify({ request: { tool: c.tool, arguments: c.request }, response }, null, 2) + '\n';
      const path = join(DOCS, c.file);
      if (process.env.UPDATE_VSI_MCP_EXAMPLES === '1') {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
      }
      expect(readFileSync(path, 'utf8')).toBe(text);
    });
  }
});
