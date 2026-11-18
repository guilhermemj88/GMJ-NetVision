import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import type { SshClient } from '../../domain/ports';
import { makeHost } from '../../test-fixtures';
import type { HostRepository } from '../persistence/host-repository';
import { bgpCapabilitiesFor } from './bgp-vendor';
import { assertJunosReadOnly } from './juniper-junos-bgp-parser';
import { JuniperJunosBgpSshProvider } from './juniper-junos-bgp-ssh';
import type { JunosSshClientFactory } from './juniper-junos-bgp-ssh';
import { isDeviceAllowed } from './mitigation/mitigation-execution-config';
import type { MitigationExecutionConfig } from './mitigation/mitigation-execution-config';

/**
 * Isolamento do Juniper (integracao na linha de producao).
 *
 * Prova, SEM alterar nenhum codigo de mitigacao/AUTO-ALL, que o suporte Junos:
 *  - declara capacidades de escrita/mitigacao DESLIGADAS;
 *  - nunca emite comando que nao seja `show ...` (somente leitura);
 *  - nao importa nenhum modulo de mitigacao, executor Huawei ou servico
 *    administrativo;
 *  - nunca passa pela allowlist de mitigacao por construcao (por deviceId).
 */

const SRC = resolve(__dirname, '..', '..');

/** Arquivos de producao (nao-teste) que formam o suporte Juniper. */
const JUNIPER_SOURCES = [
  'infrastructure/bgp/juniper-bgp-snmp.ts',
  'infrastructure/bgp/juniper-junos-bgp-parser.ts',
  'infrastructure/bgp/juniper-junos-bgp-ssh.ts',
  'infrastructure/bgp/bgp-vendor.ts',
  'infrastructure/bgp/bgp-platform-providers.ts',
  'infrastructure/ppp/juniper-ppp-subscriber-collector.ts',
  'infrastructure/snmp/profiles/juniper.ts',
  'infrastructure/topology/juniper-junos-driver.ts',
  'infrastructure/ssh/ssh-driver-select.ts',
];

function source(file: string): string {
  return readFileSync(resolve(SRC, file), 'utf8');
}

/** Remove comentarios para que a varredura olhe so codigo. */
function code(file: string): string {
  return source(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('Juniper: capacidades de escrita e mitigacao desligadas', () => {
  it.each([
    ['Juniper', 'MX240'],
    ['Juniper Networks', 'MX80'],
    ['JUNOS', 'MX104'],
    ['juniper', null],
    ['Juniper', 'ACX5448'],
  ])('vendor %s / modelo %s: adminActions=false e mitigation=false', (vendor, model) => {
    const capabilities = bgpCapabilitiesFor(vendor, model);
    expect(capabilities.platform).toBe('JUNIPER_JUNOS');
    expect(capabilities.adminActions).toBe(false);
    expect(capabilities.mitigation).toBe(false);
    expect(capabilities.advertisedRoutes).toBe(true);
  });

  it('vendor desconhecido ou so o modelo NAO habilita nada (falha fechada)', () => {
    for (const [vendor, model] of [
      [null, 'MX240'],
      ['', 'MX240'],
      ['Cisco', 'ASR9K'],
      ['MikroTik', 'CCR2216'],
    ] as const) {
      const capabilities = bgpCapabilitiesFor(vendor, model);
      expect(capabilities.platform).toBe('UNSUPPORTED');
      expect(capabilities.adminActions).toBe(false);
      expect(capabilities.mitigation).toBe(false);
    }
  });

  it('Huawei mantem as capacidades de producao (regressao)', () => {
    const capabilities = bgpCapabilitiesFor('Huawei', 'NE8000');
    expect(capabilities).toMatchObject({
      platform: 'HUAWEI_VRP',
      adminActions: true,
      mitigation: true,
      advertisedRoutes: true,
      snmpCollector: 'BGP4_MIB',
    });
  });
});

describe('Juniper: o codigo nunca importa mitigacao, executor nem administracao', () => {
  it.each(JUNIPER_SOURCES)('%s nao importa modulos de mitigacao/administracao', (file) => {
    const imports = [...code(file).matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]!);
    const forbidden = imports.filter((path) =>
      /(mitigation|executor|bgp-admin-service|huawei-bgp-ssh|command-service)/i.test(path),
    );
    expect(forbidden).toEqual([]);
  });

  it.each(JUNIPER_SOURCES)('%s nao contem comando Junos de escrita', (file) => {
    // Literal de comando que COMECA por verbo de escrita/operacao do Junos.
    const writeVerb =
      /['"`]\s*(configure|edit|commit|rollback|request|clear|delete|load|restart|reboot|halt|start shell|file delete|set)\b/i;
    // `startsWith('set ')` e o PARSER lendo a saida de `| display set`, nao um comando enviado;
    // linhas de comentario (`*`, `/*`, `//`) tambem ficam de fora.
    const lines = code(file)
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line))
      .filter((line) => writeVerb.test(line) && !/\.startsWith\(/.test(line));
    expect(lines).toEqual([]);
  });
});

describe('Juniper: nenhum comando fora de `show` pela sessao SSH', () => {
  const SUMMARY = `Groups: 1 Peers: 1 Down peers: 0
Peer                     AS      InPkt     OutPkt    OutQ   Flaps Last Up/Dwn State|#Active/Received/Accepted/Damped...
10.141.1.81           23106   25109521      97966       0      27 4w3d 21:18:46 Establ
  inet.0: 491930/1103955/1103955/0
`;
  const CONFIG = `set protocols bgp group ATC local-as 265185
set protocols bgp group ATC peer-as 23106
set protocols bgp group ATC neighbor 10.141.1.81
`;
  const NO_ROUTE = `inet.0: 10 destinations, 10 routes (10 active, 0 holddown, 0 hidden)
+ = Active Route, - = Last Active, * = Both
`;

  function juniperHost(): HostRecord {
    return makeHost({
      id: 'mx-isolation',
      hostname: 'MX-ISOLATION',
      vendor: 'Juniper',
      model: 'MX240',
      sshEnabled: true,
      ssh: {
        host: '192.0.2.10',
        port: 22,
        username: 'operator',
        credentialConfigured: true,
        authenticationType: 'PASSWORD',
      },
    });
  }

  it('descoberta e consulta de rotas anunciadas so executam `show ...` aprovados', async () => {
    const executed: string[] = [];
    const factory: JunosSshClientFactory = () =>
      ({
        execute: vi.fn(async (_host: string, commands: string[]) => {
          executed.push(...commands);
          const command = commands[0] ?? '';
          const stdout = command.startsWith('show bgp summary')
            ? SUMMARY
            : command.includes('protocols bgp')
              ? CONFIG
              : NO_ROUTE;
          return [{ command, stdout, stderr: '', exitCode: 0 }];
        }),
      }) as unknown as SshClient;
    const repository = {
      getDecryptedSshCredentials: vi.fn().mockResolvedValue({ username: 'operator', password: 'x' }),
    } as unknown as HostRepository;
    const provider = new JuniperJunosBgpSshProvider(repository, factory);

    await provider.discover(juniperHost());
    await provider.readAdvertisedRoutes(juniperHost(), '10.141.1.81', 265185n);

    expect(executed.length).toBeGreaterThan(0);
    for (const command of executed) {
      expect(command.startsWith('show ')).toBe(true);
      expect(() => assertJunosReadOnly(command)).not.toThrow();
    }
  });

  it.each([
    'configure',
    'edit protocols bgp',
    'set protocols bgp group X shutdown',
    'delete protocols bgp group X',
    'commit',
    'commit confirmed 5',
    'request system reboot',
    'clear bgp neighbor 10.141.1.81',
    'rollback 1',
    'show bgp summary | save /tmp/x',
    'show bgp summary; clear bgp neighbor all',
    'show bgp summary | request',
  ])('assertJunosReadOnly rejeita: %s', (command) => {
    expect(() => assertJunosReadOnly(command)).toThrow();
  });
});

describe('Juniper: nunca passa pela allowlist de mitigacao', () => {
  const config = (allowedDeviceIds: readonly string[]): MitigationExecutionConfig =>
    ({ allowedDeviceIds }) as MitigationExecutionConfig;

  it('um deviceId Juniper nao esta numa allowlist que contem so equipamentos Huawei', () => {
    expect(isDeviceAllowed(config(['dev-huawei-1', 'dev-huawei-2']), 'mx-isolation')).toBe(false);
  });

  it('allowlist vazia ou ausente nega por padrao (falha fechada)', () => {
    expect(isDeviceAllowed(config([]), 'mx-isolation')).toBe(false);
    expect(isDeviceAllowed(config(['dev-huawei-1']), null)).toBe(false);
    expect(isDeviceAllowed(config(['dev-huawei-1']), undefined)).toBe(false);
  });
});
