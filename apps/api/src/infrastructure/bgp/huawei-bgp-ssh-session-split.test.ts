import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { HuaweiBgpSshService, splitHuaweiSessionOutput } from './huawei-bgp-ssh';
import {
  captureBeforeEvidence,
  parseExtcommunityFilters,
  parsePeerVerbose,
  parseRoutingTableEntry,
  verifyMitigationPhysical,
} from './mitigation/mitigation-physical-verification';
import { AGLINK_BGP_PLAN as A } from './mitigation/aglink-bgp-plan';
import { testMitigationContract } from './mitigation/mitigation-test-support';
import { PhysicalBgpSimulator, SIM_CUSTOMER_PEER } from '../../testing/physical-bgp-simulator';
import type { CommandResult, SshClient } from '../../domain/ports';
import type { HostRepository } from '../persistence/host-repository';

/**
 * Defeito encontrado no equipamento real (BHE-VTA-F1A-BGP-01, 10/11/2026, release 783ee63):
 * o SshClientImpl roda um shell interativo e devolve UM CommandResult com o stdout da sessao
 * inteira. `readMitigationDisplays` esperava um resultado por comando e devolvia `null` para
 * TODOS os displays de uma sessao com 2+ comandos: o check `mitigation_export` do preflight
 * nunca passava e a verificacao fisica pos-escrita nunca fechava. A fixture abaixo e a saida
 * BRUTA real (somente leitura) de uma sessao com os 7 displays da verificacao.
 */

const FIXTURE = readFileSync(
  join(__dirname, 'mitigation', '__fixtures__', 'f1a-aglink-multi-display-session-20261110.txt'),
  'utf8',
);
const PROMPT = '<BHE-VTA-F1A-BGP-01>';
const REAL_COMMANDS = [
  'screen-length 0 temporary',
  'display bgp peer 10.200.201.2 verbose',
  'display bgp routing-table peer 10.200.201.2 received-routes',
  'display bgp routing-table 167.250.126.0 23',
  'display bgp routing-table 167.250.126.0 24',
  'display bgp routing-table 167.250.127.0 24',
  'display bgp routing-table peer 198.19.4.145 advertised-routes',
  'display ip extcommunity-filter',
];

const DEVICE = {
  id: 'host-f1a',
  hostname: 'BHE-VTA-F1A-BGP-01',
  vendor: 'Huawei',
  model: 'NE8000',
  displayName: 'BHE-VTA-F1A-BGP-01',
  sshEnabled: true,
  ssh: { host: '10.200.1.1', port: 22, username: 'netvision' },
} as unknown as HostRecord;

const repository = {
  getDecryptedSshCredentials: async () => ({ username: 'netvision', password: 'x' }),
} as unknown as HostRepository;

/** SSH falso no formato REAL: um unico resultado com a sessao inteira. */
function sessionShaped(stdout: (commands: string[]) => string) {
  const sessions: string[][] = [];
  const client: SshClient = {
    execute: async (_host, commands): Promise<CommandResult[]> => {
      sessions.push([...commands]);
      return [{ stdout: stdout(commands), stderr: '', exitCode: 0 }];
    },
  };
  return { sessions, service: new HuaweiBgpSshService(repository, () => client) };
}

/** Compoe uma sessao como o VRP imprime: eco `<PROMPT>cmd`, saida, prompt vazio. */
function composeSession(commands: string[], output: (command: string) => string): string {
  const parts = ['Info: The max number of VTY users is 21.'];
  for (const command of commands) {
    parts.push(`${PROMPT}${command}`, output(command), PROMPT);
  }
  parts.push(`${PROMPT}quit`);
  return parts.join('\r\n');
}

describe('splitHuaweiSessionOutput sobre a sessao REAL do F1A', () => {
  it('separa os 8 trechos, cada um iniciando no proprio eco e sem a saida do vizinho', () => {
    const parts = splitHuaweiSessionOutput(FIXTURE, REAL_COMMANDS);
    expect(parts.every((part) => part !== null)).toBe(true);
    parts.forEach((part, index) => {
      expect(part!.split('\n')[0]).toBe(`${PROMPT}${REAL_COMMANDS[index]}`);
      // nenhum trecho contem o eco de outro comando
      REAL_COMMANDS.filter((_, other) => other !== index).forEach((command) =>
        expect(part!).not.toContain(`${PROMPT}${command}`),
      );
    });
    expect(parsePeerVerbose(parts[1]!)).toEqual({
      state: 'Established',
      receivedTotal: 3,
      upCount: 11,
    });
    expect(parts[2]).toContain('Total Number of Routes: 3');
    const best23 = parseRoutingTableEntry(parts[3]!)!;
    expect(best23.find((path) => path.best)).toMatchObject({
      from: '10.200.201.2',
      localPreference: 1100,
      extCommunities: ['268568:140', '268568:330'],
      select: true,
    });
    expect(parseRoutingTableEntry(parts[4]!)!.map((path) => path.localPreference)).toEqual([
      1100, 800, 50,
    ]);
    expect(parts[6]).toContain('Total Number of Routes: 16');
    expect(parts[6]).not.toContain('167.250.126.0');
    expect(parseExtcommunityFilters(parts[7]!).get('MITIGACAO')).toEqual([
      { action: 'permit', rt: '268568:660' },
    ]);
  });

  it('readMitigationDisplays com o transporte REAL (1 resultado/sessao): 7/7 saidas, 1 sessao', async () => {
    const { service, sessions } = sessionShaped(() => FIXTURE);
    const reads = await service.readMitigationDisplays(DEVICE, REAL_COMMANDS.slice(1));
    expect(sessions).toHaveLength(1);
    expect(reads.map((read) => read.output === null)).toEqual(
      REAL_COMMANDS.slice(1).map(() => false),
    );
    expect(reads.map((read) => read.command)).toEqual(REAL_COMMANDS.slice(1));
  });

  it('eco ausente ou fora de ordem => TODOS null (nunca atribui saida de outro comando)', () => {
    const missing = FIXTURE.replace(
      `${PROMPT}display ip extcommunity-filter`,
      `${PROMPT}display ip x`,
    );
    expect(splitHuaweiSessionOutput(missing, REAL_COMMANDS).every((part) => part === null)).toBe(
      true,
    );
    const reordered = [REAL_COMMANDS[0]!, REAL_COMMANDS[2]!, REAL_COMMANDS[1]!];
    expect(splitHuaweiSessionOutput(FIXTURE, reordered).every((part) => part === null)).toBe(true);
  });

  it('prompt nao reconhecido (sem eco do primeiro comando) => TODOS null', () => {
    expect(
      splitHuaweiSessionOutput('sem prompt nenhum', REAL_COMMANDS).every((p) => p === null),
    ).toBe(true);
    expect(splitHuaweiSessionOutput('', ['screen-length 0 temporary'])).toEqual([null]);
  });

  it('linha de continuacao indentada com <comunidade> NAO corta o trecho', () => {
    const commands = ['screen-length 0 temporary', 'display bgp routing-table 167.250.126.0 24'];
    const session = composeSession(commands, (command) =>
      command.startsWith('display')
        ? [
            ' Community: <3356:5>, <3356:22>,',
            '            <3356:100>, <65000:10001>',
            ' AS-path 3356 269096 273811, origin igp, localpref 800',
          ].join('\r\n')
        : 'Info: ok',
    );
    const parts = splitHuaweiSessionOutput(session, commands);
    expect(parts[1]).toContain('<65000:10001>');
    expect(parts[1]).toContain('localpref 800');
  });

  it('erro de CLI em um comando => so aquele null; os demais preservados', async () => {
    const commands = ['display bgp peer 10.200.201.2 verbose', 'display ip extcommunity-filter'];
    const { service } = sessionShaped((sent) =>
      composeSession(sent, (command) =>
        command === 'display bgp peer 10.200.201.2 verbose'
          ? 'Error: Wrong parameter found at ^ position.'
          : 'Named Extended Community basic filter: MITIGACAO',
      ),
    );
    const reads = await service.readMitigationDisplays(DEVICE, commands);
    expect(reads[0]!.output).toBeNull();
    expect(reads[1]!.output).toContain('MITIGACAO');
  });

  it('quantidade de resultados inesperada (nem 1 nem 1/comando) => todos null', async () => {
    const client: SshClient = {
      execute: async () => [
        { stdout: 'a', stderr: '', exitCode: 0 },
        { stdout: 'b', stderr: '', exitCode: 0 },
      ],
    };
    const service = new HuaweiBgpSshService(repository, () => client);
    const reads = await service.readMitigationDisplays(DEVICE, [
      'display bgp peer 10.200.201.2 verbose',
      'display ip extcommunity-filter',
      'display current-configuration configuration bgp',
    ]);
    expect(reads.every((read) => read.output === null)).toBe(true);
  });
});

describe('verificacao fisica ponta a ponta pelo transporte no formato REAL de sessao', () => {
  const CONTRACT = {
    ...testMitigationContract(A.policy, A.targetPrefixList, 1100),
    prefixListEntries: [A.prefixDefinition],
  };

  function realTransportOver(sim: PhysicalBgpSimulator) {
    // O simulador fornece a saida de cada display; o SSH falso a embala como o VRP real
    // (UMA sessao, ecos com prompt) e o servico real faz a separacao.
    const client: SshClient = {
      execute: async (_host, commands) => {
        const reads = await sim.read(commands.filter((c) => c !== 'screen-length 0 temporary'));
        const by = new Map(reads.map((read) => [read.command, read.output]));
        return [
          {
            stdout: composeSession(commands, (command) =>
              command === 'screen-length 0 temporary'
                ? 'Info: The configuration takes effect on the current user terminal interface only.'
                : (by.get(command) ?? 'Error: Unrecognized command found at ^ position.'),
            ),
            stderr: '',
            exitCode: 0,
          },
        ];
      },
    };
    const service = new HuaweiBgpSshService(repository, () => client);
    return (commands: string[]) => service.readMitigationDisplays(DEVICE, commands);
  }

  async function run(activate: boolean) {
    let mitigated = false;
    const sim = new PhysicalBgpSimulator(() => mitigated);
    const read = realTransportOver(sim);
    const before = await captureBeforeEvidence(read, [SIM_CUSTOMER_PEER]);
    if (activate) mitigated = true;
    let clock = 0;
    const result = await verifyMitigationPhysical({
      read,
      contract: CONTRACT,
      customerPeers: [SIM_CUSTOMER_PEER],
      before,
      timing: { maxAttempts: 3, intervalMs: 1_000, budgetMs: 20_000 },
      sleep: async (ms) => {
        clock += ms;
      },
      clock: () => clock,
    });
    return { before, result };
  }

  it('evidencia PRE completa: peer de mitigacao descoberto e anuncio PRE lido', async () => {
    const { before } = await run(false);
    expect(before.mitigationPeer).toBe('198.19.4.145');
    expect(before.advertisedBefore).not.toBeNull();
    expect(before.peers[0]!.verbose).not.toBeNull();
    expect(before.peers[0]!.received).not.toBeNull();
  });

  it('com a mitigacao aplicada => PASS', async () => {
    const { result } = await run(true);
    expect(result.summary).toMatch(/PASS/);
    expect(result.outcome).toBe('PASS');
  });

  it('sem a mitigacao aplicada => nunca PASS', async () => {
    const { result } = await run(false);
    expect(result.outcome).not.toBe('PASS');
  });
});
