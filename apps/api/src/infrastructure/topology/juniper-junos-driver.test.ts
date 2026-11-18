import { describe, expect, it } from 'vitest';
import { JuniperJunosDriver } from './juniper-junos-driver';

/**
 * Fixtures com o formato REAL do Junos 19.2R1.8 (VIANET-OUROPRETO, MX240) e
 * 19.4R3-S10.3 (BORDA-VIANET-NOVA-LIMA). Nenhum dado de host e usado pelo
 * driver: os testes existem para provar que o parsing e generico.
 */
const SHOW_VERSION = `
Hostname: VIANET-OUROPRETO
Model: mx240
Junos: 19.2R1.8
JUNOS OS Kernel 64-bit  [20190517.f0321c3_builder_stable_11]
JUNOS network stack and utilities [20190621.152752_builder_junos_192_r1]
`.trim();

const SHOW_CHASSIS = `
Hardware inventory:
Item             Version  Part number  Serial number     Description
Chassis                                JN122311DAFC      MX240
Midplane         REV 07   760-021404   ACAX0336          MX240 Backplane
Routing Engine 0 REV 08   740-031116   9009151381        RE-S-1800x4
FPC 2            REV 35   750-028467   ABCC0751          MPC 3D 16x 10GE
`.trim();

const SHOW_VERSION_NOVA_LIMA = `
Hostname: BORDA-VIANET-NOVA-LIMA
Model: mx480
Junos: 19.4R3-S10.3
`.trim();

const INTERFACES_TERSE = `
Interface               Admin Link Proto    Local                 Remote
ae0                     up    up
ae0.1101                up    up   inet    10.10.10.1/24
ge-0/0/0                up    down
xe-1/2/3                down  down
lo0.0                   up    up   inet    127.0.0.1
`.trim();

const INTERFACES_DESCRIPTIONS = `
Interface       Admin Link Description
ae0             up    up   WAN
ae0.1101        up    up   TX.5321-Instituto_Mariana-20MB-POP_Serra
ge-0/0/0        up    down CLIENTE-X
`.trim();

const LLDP_DISABLED = `
LLDP                      : Disabled
Advertisement interval    : 30 seconds
Transmit delay            : 0 seconds
Hold timer                : 120 seconds
`.trim();

const LLDP_ENABLED_EMPTY = `
Local Interface    Parent Interface    Chassis Id          Port info      System Name
`.trim();

const LLDP_ENABLED_NEIGHBORS = `
Local Interface    Parent Interface    Chassis Id          Port info      System Name
ge-0/0/0           -                   00:11:22:33:44:55   ge-0/0/1       REMOTE-SW-01
xe-1/2/3           ae0                 00:aa:bb:cc:dd:ee   xe-0/0/2       CORE-REMOTO
`.trim();

describe('JuniperJunosDriver — comandos', () => {
  const driver = new JuniperJunosDriver();

  it('declara vendor Juniper para a selecao por fabricante', () => {
    expect(driver.vendor).toBe('Juniper Junos');
  });

  it('so emite comandos de LEITURA com `| no-more`', () => {
    const commands = [
      ...driver.identityCommands(),
      ...driver.interfaceCommands(),
      ...driver.neighborCommands(),
      ...(driver.neighborFallbackCommands?.() ?? []),
    ];
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command.startsWith('show ')).toBe(true);
      expect(command).toContain('| no-more');
      expect(command).not.toMatch(/\b(configure|set|delete|commit|request|clear|rollback|load)\b/);
    }
  });
});

describe('JuniperJunosDriver — identity', () => {
  const driver = new JuniperJunosDriver();

  it('extrai hostname, modelo, Junos e serial do MX240 de Ouro Preto', () => {
    const identity = driver.parseIdentity(`${SHOW_VERSION}\n${SHOW_CHASSIS}`);

    expect(identity).toMatchObject({
      hostname: 'VIANET-OUROPRETO',
      vendor: 'Juniper',
      model: 'MX240',
      systemDescription: 'Juniper Junos 19.2R1.8',
      chassisId: 'JN122311DAFC',
    });
  });

  it('funciona igual no equipamento de Nova Lima (Junos 19.4)', () => {
    const identity = driver.parseIdentity(`${SHOW_VERSION_NOVA_LIMA}\n${SHOW_CHASSIS}`);

    expect(identity).toMatchObject({
      hostname: 'BORDA-VIANET-NOVA-LIMA',
      vendor: 'Juniper',
      model: 'MX480',
      systemDescription: 'Juniper Junos 19.4R3-S10.3',
    });
  });

  it('nao inventa campos quando a saida nao os traz', () => {
    const identity = driver.parseIdentity('saida inesperada');

    expect(identity.hostname).toBeUndefined();
    expect(identity.model).toBeUndefined();
    expect(identity.chassisId).toBeUndefined();
    expect(identity.vendor).toBe('Juniper');
  });
});

describe('JuniperJunosDriver — interfaces', () => {
  const driver = new JuniperJunosDriver();

  it('reconhece interfaces fisicas e logicas com admin/link', () => {
    const interfaces = driver.parseInterfaces('dev-1', `${INTERFACES_TERSE}\n${INTERFACES_DESCRIPTIONS}`);

    expect(interfaces.map((item) => item.name)).toEqual([
      'ae0',
      'ae0.1101',
      'ge-0/0/0',
      'xe-1/2/3',
      'lo0.0',
    ]);
    expect(interfaces.find((item) => item.name === 'xe-1/2/3')).toMatchObject({
      adminStatus: 'DOWN',
      operStatus: 'DISABLED',
    });
    expect(interfaces.find((item) => item.name === 'ge-0/0/0')).toMatchObject({
      adminStatus: 'UP',
      operStatus: 'DOWN',
    });
    expect(interfaces.find((item) => item.name === 'ae0')).toMatchObject({
      adminStatus: 'UP',
      operStatus: 'UP',
    });
  });

  it('usa o alias de `show interfaces descriptions` e preserva o nome Junos', () => {
    const interfaces = driver.parseInterfaces('dev-1', `${INTERFACES_TERSE}\n${INTERFACES_DESCRIPTIONS}`);
    const byName = new Map(interfaces.map((item) => [item.name, item]));

    expect(byName.get('ae0')?.alias).toBe('WAN');
    expect(byName.get('ae0.1101')?.alias).toBe(
      'TX.5321-Instituto_Mariana-20MB-POP_Serra',
    );
    // Sem descricao no equipamento: alias vazio, nunca inventado.
    expect(byName.get('xe-1/2/3')?.alias).toBe('');
  });

  it('nao inventa ifIndex e identifica a interface pelo nome', () => {
    const interfaces = driver.parseInterfaces('dev-1', INTERFACES_TERSE);

    expect(interfaces.every((item) => item.ifIndex === 0)).toBe(true);
    expect(interfaces.every((item) => item.id === `dev-1-junos-${item.name}`)).toBe(true);
    expect(interfaces.every((item) => item.dataSources?.includes('SSH') === true)).toBe(true);
  });

  it('ignora cabecalho e linhas que nao sao interface', () => {
    const interfaces = driver.parseInterfaces(
      'dev-1',
      ['Interface               Admin Link Proto    Local                 Remote', '   inet   10.0.0.1/24', '---'].join('\n'),
    );

    expect(interfaces).toEqual([]);
  });
});

describe('JuniperJunosDriver — neighbors', () => {
  const driver = new JuniperJunosDriver();

  it('LLDP desabilitado => [] sem erro (estado valido do equipamento)', () => {
    expect(driver.parseNeighbors('dev-1', LLDP_DISABLED)).toEqual([]);
  });

  it('nao tenta o comando de detalhe quando o LLDP esta desabilitado', () => {
    expect(driver.shouldFallbackNeighborCommand(LLDP_DISABLED)).toBe(false);
  });

  it('interpreta a tabela de vizinhos quando o LLDP esta ativo', () => {
    const neighbors = driver.parseNeighbors('dev-1', LLDP_ENABLED_NEIGHBORS);

    expect(neighbors).toHaveLength(2);
    expect(neighbors[0]).toMatchObject({
      localPort: 'ge-0/0/0',
      remoteSystemName: 'REMOTE-SW-01',
      remotePort: 'ge-0/0/1',
      remoteChassisId: '00:11:22:33:44:55',
      source: 'LLDP_SSH',
      matchStatus: 'UNMATCHED',
    });
    expect(neighbors[1]).toMatchObject({
      localPort: 'xe-1/2/3',
      remoteSystemName: 'CORE-REMOTO',
      remotePort: 'xe-0/0/2',
    });
  });

  it('cai no comando de detalhe quando ha tabela mas nada foi interpretado', () => {
    expect(driver.shouldFallbackNeighborCommand(LLDP_ENABLED_EMPTY)).toBe(true);
  });

  it('nao inventa vizinho com dados insuficientes', () => {
    const partial = [
      'Local Interface    Parent Interface    Chassis Id          Port info      System Name',
      'ge-0/0/0           -                   00:11:22:33:44:55   ge-0/0/1',
    ].join('\n');

    expect(driver.parseNeighbors('dev-1', partial)).toEqual([]);
  });
});
