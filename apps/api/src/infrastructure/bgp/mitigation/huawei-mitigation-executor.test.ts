import { describe, expect, it } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { HuaweiMitigationExecutor, type MitigationSshPort } from './huawei-mitigation-executor';
import type { MitigationExecutionConfig } from './mitigation-execution-config';
import { SimulationCommandExecutor } from './simulation-command-executor';
import { verifyActivation } from './mitigation-executor';
import { DEFAULT_BOGON_PREFIX_LIST, DEFAULT_TARGET_PREFIX_LIST } from './mitigation-planner';

const DEVICE_ID = 'host-f1a';
const POLICY = 'PL-HORIZONTES_IPv4-IN';
const RT = '268568:660';

/** Config real do F1A (nodes 11 e 50 existem; 1 e 2 livres). */
const ROUTE_POLICY = [
  'route-policy PL-HORIZONTES_IPv4-IN permit node 11',
  ' if-match ip-prefix PREFIX-HORIZONTES-IPV4',
  ' apply extcommunity rt 268568:110 additive',
  'route-policy PL-HORIZONTES_IPv4-IN permit node 50',
].join('\n');

const IP_PREFIX = [
  'ip ip-prefix BOGONS index 10 permit 10.0.0.0 8',
  'ip ip-prefix PREFIX8to24 index 10 permit 10.200.200.0 24',
].join('\n');

function device(id = DEVICE_ID): HostRecord {
  return {
    id,
    hostname: 'BHE-VTA-F1A-BGP-01',
    displayName: 'BHE-VTA-F1A-BGP-01',
    name: 'BHE-VTA-F1A-BGP-01',
    sshEnabled: true,
    ssh: { host: '10.200.1.1', port: 22, username: 'netvision' },
  } as unknown as HostRecord;
}

function config(overrides: Partial<MitigationExecutionConfig> = {}): MitigationExecutionConfig {
  return {
    executor: 'HUAWEI',
    liveWriteEnabled: true,
    allowedDeviceIds: [DEVICE_ID],
    ...overrides,
  };
}

class FakeSsh implements MitigationSshPort {
  readonly applied: { deviceId: string; commands: string[] }[] = [];
  routePolicyConfiguration: string | null = ROUTE_POLICY;
  prefixListConfiguration: string | null = IP_PREFIX;
  readBack = ROUTE_POLICY;
  applyOk = true;
  applyOutput: string | null = 'ok';
  readThrows = false;
  readBackThrows = false;

  async readMitigationConfiguration(): Promise<{
    routePolicyConfiguration: string | null;
    prefixListConfiguration: string | null;
    warnings: string[];
  }> {
    if (this.readThrows) throw new Error('SSH connection timeout');
    return {
      routePolicyConfiguration: this.routePolicyConfiguration,
      prefixListConfiguration: this.prefixListConfiguration,
      warnings: [],
    };
  }

  async readMitigationRoutePolicy(): Promise<string> {
    if (this.readBackThrows) throw new Error('SSH command failed');
    return this.readBack;
  }

  async applyMitigationCommands(
    target: HostRecord,
    commands: readonly string[],
  ): Promise<{ ok: boolean; output: string | null }> {
    this.applied.push({ deviceId: target.id, commands: [...commands] });
    return this.applyOk
      ? { ok: true, output: this.applyOutput }
      : { ok: false, output: this.applyOutput };
  }
}

const INPUT = {
  mode: 'ACTIVATE' as const,
  policyName: POLICY,
  bogonNode: 1,
  mitigationNode: 2,
  rt: RT,
  bogonPrefixList: DEFAULT_BOGON_PREFIX_LIST,
  targetPrefixList: DEFAULT_TARGET_PREFIX_LIST,
  expectedExistingNodes: [11, 50] as number[] | null,
};

function executor(ssh: FakeSsh, cfg = config()): HuaweiMitigationExecutor {
  return new HuaweiMitigationExecutor({ ssh, config: cfg, rt: RT });
}

const ACTIVATION = {
  policyName: POLICY,
  bogonNode: 1,
  mitigationNode: 2,
  rt: RT,
  bogonPrefixList: DEFAULT_BOGON_PREFIX_LIST,
  targetPrefixList: DEFAULT_TARGET_PREFIX_LIST,
};

describe('HuaweiMitigationExecutor - gate fail-closed (zero escrita)', () => {
  it('executor MOCK nunca libera leitura/escrita real', async () => {
    const ssh = new FakeSsh();
    const exec = executor(ssh, config({ executor: 'MOCK' }));
    expect(exec.enabledFor(device())).toBe(false);
    await expect(exec.activate(device(), ACTIVATION)).rejects.toThrow(/MITIGATION_WRITE_DISABLED/);
    expect(ssh.applied).toHaveLength(0);
  });

  it('device fora da allowlist nunca escreve', async () => {
    const ssh = new FakeSsh();
    const exec = executor(ssh, config({ allowedDeviceIds: ['outro-device'] }));
    expect(exec.enabledFor(device())).toBe(false);
    await expect(exec.activate(device(), ACTIVATION)).rejects.toThrow(/MITIGATION_WRITE_DISABLED/);
    expect(ssh.applied).toHaveLength(0);
  });

  it('live_write=false: leitura liberada, escrita totalmente bloqueada', async () => {
    const ssh = new FakeSsh();
    const exec = executor(ssh, config({ liveWriteEnabled: false }));
    expect(exec.enabledFor(device())).toBe(true);
    // O preflight read-only funciona...
    expect((await exec.preflight(device(), INPUT)).ok).toBe(true);
    // ...mas a escrita nao sai.
    await expect(exec.activate(device(), ACTIVATION)).rejects.toThrow(/MITIGATION_WRITE_DISABLED/);
    await expect(exec.remove(device(), ACTIVATION)).rejects.toThrow(/MITIGATION_WRITE_DISABLED/);
    expect(ssh.applied).toHaveLength(0);
  });

  it('remove tambem exige o gate completo', async () => {
    const ssh = new FakeSsh();
    const exec = executor(ssh, config({ allowedDeviceIds: ['outro'] }));
    await expect(exec.remove(device(), ACTIVATION)).rejects.toThrow(/MITIGATION_WRITE_DISABLED/);
    expect(ssh.applied).toHaveLength(0);
  });
});

describe('HuaweiMitigationExecutor - preflight READ-ONLY', () => {
  it('valida device, policy, nodes, prefix-lists e RT', async () => {
    const result = await executor(new FakeSsh()).preflight(device(), INPUT);
    expect(result.ok).toBe(true);
    expect(result.existingNodes).toEqual([11, 50]);
    expect(result.bogonNode).toBe(1);
    expect(result.mitigationNode).toBe(2);
    expect(result.bogonPrefixListExists).toBe(true);
    expect(result.targetPrefixListExists).toBe(true);
    expect(result.rt).toBe(RT);
    expect(result.sshReadBackOk).toBe(true);
    expect(result.blockedReasons).toEqual([]);
  });

  it('aborta quando o node do par ja esta ocupado', async () => {
    const ssh = new FakeSsh();
    ssh.routePolicyConfiguration = [
      'route-policy PL-HORIZONTES_IPv4-IN permit node 1',
      ' if-match ip-prefix PREFIX8to24',
      ` apply extcommunity rt ${RT} additive`,
      'route-policy PL-HORIZONTES_IPv4-IN permit node 11',
    ].join('\n');
    const result = await executor(ssh).preflight(device(), INPUT);
    expect(result.ok).toBe(false);
    expect(result.blockedReasons.join(' ')).toMatch(/bogon_node_free|mitigation_node_free/);
  });

  it('aborta quando a ip-prefix BOGONS nao existe', async () => {
    const ssh = new FakeSsh();
    ssh.prefixListConfiguration = 'ip ip-prefix PREFIX8to24 index 10 permit 10.200.200.0 24';
    const result = await executor(ssh).preflight(device(), INPUT);
    expect(result.ok).toBe(false);
    expect(result.bogonPrefixListExists).toBe(false);
    expect(result.blockedReasons.join(' ')).toMatch(/bogon_prefix_list/);
  });

  it('aborta quando a ip-prefix PREFIX8to24 nao existe', async () => {
    const ssh = new FakeSsh();
    ssh.prefixListConfiguration = 'ip ip-prefix BOGONS index 10 permit 10.0.0.0 8';
    const result = await executor(ssh).preflight(device(), INPUT);
    expect(result.ok).toBe(false);
    expect(result.targetPrefixListExists).toBe(false);
    expect(result.blockedReasons.join(' ')).toMatch(/target_prefix_list/);
  });

  it('aborta sem snapshot de discovery (fail-closed)', async () => {
    const result = await executor(new FakeSsh()).preflight(device(), {
      ...INPUT,
      expectedExistingNodes: null,
    });
    expect(result.ok).toBe(false);
    expect(result.blockedReasons.join(' ')).toMatch(/existing_nodes/);
  });

  it('aborta quando existingNodes diverge do snapshot', async () => {
    const result = await executor(new FakeSsh()).preflight(device(), {
      ...INPUT,
      expectedExistingNodes: [11, 12],
    });
    expect(result.ok).toBe(false);
    expect(result.blockedReasons.join(' ')).toMatch(/existing_nodes/);
  });

  it('aborta quando a policy nao existe', async () => {
    const ssh = new FakeSsh();
    ssh.routePolicyConfiguration = ['route-policy PL-OUTRA-IN permit node 11'].join('\n');
    const result = await executor(ssh).preflight(device(), INPUT);
    expect(result.ok).toBe(false);
    expect(result.blockedReasons.join(' ')).toMatch(/policy/);
  });

  it('aborta quando o SSH falha (nunca assume estado limpo)', async () => {
    const ssh = new FakeSsh();
    ssh.readThrows = true;
    const result = await executor(ssh).preflight(device(), INPUT);
    expect(result.ok).toBe(false);
    expect(result.sshReadBackOk).toBe(false);
  });

  it('aborta quando a RT esperada nao bate', async () => {
    const result = await executor(new FakeSsh()).preflight(device(), {
      ...INPUT,
      rt: '9999:1',
    });
    expect(result.ok).toBe(false);
    expect(result.blockedReasons.join(' ')).toMatch(/route_target/);
  });
});

const ROUTE_POLICY_MITIGATED = [
  'route-policy PL-HORIZONTES_IPv4-IN deny node 1',
  ' if-match ip-prefix BOGONS',
  'route-policy PL-HORIZONTES_IPv4-IN permit node 2',
  ' if-match ip-prefix PREFIX8to24',
  ' apply extcommunity rt 268568:660 additive',
  'route-policy PL-HORIZONTES_IPv4-IN permit node 11',
  'route-policy PL-HORIZONTES_IPv4-IN permit node 50',
].join('\n');

/** Monta o input do preflight de REMOVE (sem snapshot, sem exigir nodes livres). */
const REMOVE_INPUT = { ...INPUT, mode: 'REMOVE' as const, expectedExistingNodes: null };

describe('HuaweiMitigationExecutor - preflight de REMOVE (par presente)', () => {
  it('3) REMOVE com o par correto presente -> OK (nao exige nodes livres)', async () => {
    const ssh = new FakeSsh();
    ssh.routePolicyConfiguration = ROUTE_POLICY_MITIGATED;
    const result = await executor(ssh).preflight(device(), REMOVE_INPUT);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('REMOVE');
    expect(result.existingNodes).toEqual([1, 2, 11, 50]);
    expect(result.bogonNodeExists).toBe(true);
    expect(result.bogonNodeMatches).toBe(true);
    expect(result.mitigationNodeExists).toBe(true);
    expect(result.mitigationNodeMatches).toBe(true);
    expect(result.partial).toBe(false);
    expect(result.blockedReasons).toEqual([]);
  });

  it('ACTIVATE no mesmo estado (par presente) e que fica bloqueado', async () => {
    const ssh = new FakeSsh();
    ssh.routePolicyConfiguration = ROUTE_POLICY_MITIGATED;
    const result = await executor(ssh).preflight(device(), {
      ...INPUT,
      expectedExistingNodes: [1, 2, 11, 50],
    });
    expect(result.ok).toBe(false);
    expect(result.blockedReasons.join(' ')).toMatch(/bogon_node_free|mitigation_node_free/);
  });

  it('4) REMOVE com so o node BOGONS presente -> bloqueia e marca partial', async () => {
    const ssh = new FakeSsh();
    ssh.routePolicyConfiguration = [
      'route-policy PL-HORIZONTES_IPv4-IN deny node 1',
      ' if-match ip-prefix BOGONS',
      'route-policy PL-HORIZONTES_IPv4-IN permit node 11',
    ].join('\n');
    const result = await executor(ssh).preflight(device(), REMOVE_INPUT);
    expect(result.ok).toBe(false);
    expect(result.partial).toBe(true);
    expect(result.bogonNodeMatches).toBe(true);
    expect(result.mitigationNodeMatches).toBe(false);
    expect(result.blockedReasons.join(' ')).toMatch(/mitigation_node_present/);
  });

  it('5) REMOVE com so o node de mitigacao presente -> bloqueia e marca partial', async () => {
    const ssh = new FakeSsh();
    ssh.routePolicyConfiguration = [
      'route-policy PL-HORIZONTES_IPv4-IN permit node 2',
      ' if-match ip-prefix PREFIX8to24',
      ' apply extcommunity rt 268568:660 additive',
      'route-policy PL-HORIZONTES_IPv4-IN permit node 11',
    ].join('\n');
    const result = await executor(ssh).preflight(device(), REMOVE_INPUT);
    expect(result.ok).toBe(false);
    expect(result.partial).toBe(true);
    expect(result.bogonNodeMatches).toBe(false);
    expect(result.mitigationNodeMatches).toBe(true);
    expect(result.blockedReasons.join(' ')).toMatch(/bogon_node_present/);
  });

  it('6) REMOVE com node 1 presente mas conteudo errado (permit em vez de deny) -> bloqueia', async () => {
    const ssh = new FakeSsh();
    ssh.routePolicyConfiguration = [
      'route-policy PL-HORIZONTES_IPv4-IN permit node 1',
      ' if-match ip-prefix BOGONS',
      'route-policy PL-HORIZONTES_IPv4-IN permit node 2',
      ' if-match ip-prefix PREFIX8to24',
      ' apply extcommunity rt 268568:660 additive',
      'route-policy PL-HORIZONTES_IPv4-IN permit node 11',
    ].join('\n');
    const result = await executor(ssh).preflight(device(), REMOVE_INPUT);
    expect(result.ok).toBe(false);
    expect(result.bogonNodeExists).toBe(true);
    expect(result.bogonNodeMatches).toBe(false);
    expect(result.blockedReasons.join(' ')).toMatch(/bogon_node_present/);
  });

  it('6b) REMOVE com node 1 deny mas sem if-match BOGONS -> bloqueia', async () => {
    const ssh = new FakeSsh();
    ssh.routePolicyConfiguration = [
      'route-policy PL-HORIZONTES_IPv4-IN deny node 1',
      ' if-match ip-prefix OUTRA-LISTA',
      'route-policy PL-HORIZONTES_IPv4-IN permit node 2',
      ' if-match ip-prefix PREFIX8to24',
      ' apply extcommunity rt 268568:660 additive',
      'route-policy PL-HORIZONTES_IPv4-IN permit node 11',
    ].join('\n');
    const result = await executor(ssh).preflight(device(), REMOVE_INPUT);
    expect(result.ok).toBe(false);
    expect(result.bogonNodeMatches).toBe(false);
  });

  it('7) REMOVE com node 2 presente mas RT errada -> bloqueia', async () => {
    const ssh = new FakeSsh();
    ssh.routePolicyConfiguration = [
      'route-policy PL-HORIZONTES_IPv4-IN deny node 1',
      ' if-match ip-prefix BOGONS',
      'route-policy PL-HORIZONTES_IPv4-IN permit node 2',
      ' if-match ip-prefix PREFIX8to24',
      ' apply extcommunity rt 9999:1 additive',
      'route-policy PL-HORIZONTES_IPv4-IN permit node 11',
    ].join('\n');
    const result = await executor(ssh).preflight(device(), REMOVE_INPUT);
    expect(result.ok).toBe(false);
    expect(result.mitigationNodeExists).toBe(true);
    expect(result.mitigationNodeMatches).toBe(false);
    expect(result.blockedReasons.join(' ')).toMatch(/mitigation_node_present/);
  });

  it('7b) REMOVE com node 2 presente mas SEM PREFIX8to24 -> bloqueia', async () => {
    const ssh = new FakeSsh();
    ssh.routePolicyConfiguration = [
      'route-policy PL-HORIZONTES_IPv4-IN deny node 1',
      ' if-match ip-prefix BOGONS',
      'route-policy PL-HORIZONTES_IPv4-IN permit node 2',
      ' apply extcommunity rt 268568:660 additive',
      'route-policy PL-HORIZONTES_IPv4-IN permit node 11',
    ].join('\n');
    const result = await executor(ssh).preflight(device(), REMOVE_INPUT);
    expect(result.ok).toBe(false);
    expect(result.mitigationNodeMatches).toBe(false);
  });

  it('REMOVE nao falha por SSH sem as ip-prefix (so a route-policy importa)', async () => {
    const ssh = new FakeSsh();
    ssh.routePolicyConfiguration = ROUTE_POLICY_MITIGATED;
    ssh.prefixListConfiguration = null;
    const result = await executor(ssh).preflight(device(), REMOVE_INPUT);
    expect(result.sshReadBackOk).toBe(true);
    expect(result.ok).toBe(true);
  });

  it('REMOVE continua bloqueado quando o SSH falha', async () => {
    const ssh = new FakeSsh();
    ssh.readThrows = true;
    const result = await executor(ssh).preflight(device(), REMOVE_INPUT);
    expect(result.ok).toBe(false);
    expect(result.sshReadBackOk).toBe(false);
  });
});

describe('reconciliacao REMOVE: par ATIVO lido do equipamento', () => {
  it('acha exatamente o par 1/2 ativo (deny+BOGONS / permit+PREFIX8to24+RT)', async () => {
    const ssh = new FakeSsh();
    ssh.routePolicyConfiguration = ROUTE_POLICY_MITIGATED;
    const pair = await executor(ssh).resolveActivePair(device(), POLICY, RT);
    expect(pair).toEqual({ bogonNode: 1, mitigationNode: 2 });
  });

  it('sem mitigacao ativa devolve null (nunca inventa par)', async () => {
    const ssh = new FakeSsh();
    ssh.routePolicyConfiguration = ROUTE_POLICY;
    expect(await executor(ssh).resolveActivePair(device(), POLICY, RT)).toBeNull();
  });

  it('ambiguidade (dois nodes BOGONS) devolve null: fail-closed', async () => {
    const ssh = new FakeSsh();
    ssh.routePolicyConfiguration = [
      'route-policy PL-HORIZONTES_IPv4-IN deny node 1',
      ' if-match ip-prefix BOGONS',
      'route-policy PL-HORIZONTES_IPv4-IN deny node 3',
      ' if-match ip-prefix BOGONS',
      'route-policy PL-HORIZONTES_IPv4-IN permit node 2',
      ' if-match ip-prefix PREFIX8to24',
      ` apply extcommunity rt ${RT} additive`,
    ].join('\n');
    expect(await executor(ssh).resolveActivePair(device(), POLICY, RT)).toBeNull();
  });

  it('RT errada nao forma par ativo', async () => {
    const ssh = new FakeSsh();
    ssh.routePolicyConfiguration = [
      'route-policy PL-HORIZONTES_IPv4-IN deny node 1',
      ' if-match ip-prefix BOGONS',
      'route-policy PL-HORIZONTES_IPv4-IN permit node 2',
      ' if-match ip-prefix PREFIX8to24',
      ' apply extcommunity rt 9999:1 additive',
    ].join('\n');
    expect(await executor(ssh).resolveActivePair(device(), POLICY, RT)).toBeNull();
  });
});

describe('HuaweiMitigationExecutor - comandos exatos', () => {
  it('ACTIVATE envia exatamente os 7 comandos do preview', async () => {
    const ssh = new FakeSsh();
    await executor(ssh).activate(device(), ACTIVATION);

    expect(ssh.applied).toHaveLength(1);
    expect(ssh.applied[0]!.commands).toEqual([
      'system-view',
      'route-policy PL-HORIZONTES_IPv4-IN deny node 1',
      ' if-match ip-prefix BOGONS',
      'route-policy PL-HORIZONTES_IPv4-IN permit node 2',
      ' if-match ip-prefix PREFIX8to24',
      ' apply extcommunity rt 268568:660 additive',
      'commit',
    ]);
    // Prova de equivalencia: o preview e a escrita montam a MESMA lista.
    expect(ssh.applied[0]!.commands).toEqual(
      new SimulationCommandExecutor().buildMitigation(
        POLICY,
        { bogonNode: 1, mitigationNode: 2 },
        RT,
        { bogonPrefixList: DEFAULT_BOGON_PREFIX_LIST, targetPrefixList: DEFAULT_TARGET_PREFIX_LIST },
      ).commands,
    );
  });

  it('REMOVE envia exatamente os 4 comandos de retirada', async () => {
    const ssh = new FakeSsh();
    await executor(ssh).remove(device(), ACTIVATION);
    expect(ssh.applied[0]!.commands).toEqual([
      'system-view',
      'undo route-policy PL-HORIZONTES_IPv4-IN node 1',
      'undo route-policy PL-HORIZONTES_IPv4-IN node 2',
      'commit',
    ]);
    // `return` e finalizacao de TRANSPORTE, nunca parte dos 4 comandos canonicos.
    expect(ssh.applied[0]!.commands).toHaveLength(4);
    expect(ssh.applied[0]!.commands.join(' ')).not.toContain('return');
    expect(ssh.applied[0]!.commands).toEqual(
      new SimulationCommandExecutor().buildRecovery(POLICY, {
        bogonNode: 1,
        mitigationNode: 2,
      }).commands,
    );
  });

  it('nome de policy malicioso e rejeitado ANTES do SSH', async () => {
    const ssh = new FakeSsh();
    const exec = executor(ssh);
    await expect(
      exec.activate(device(), { ...ACTIVATION, policyName: 'PL-X\nreboot' }),
    ).rejects.toThrow(/MITIGATION_WRITE_REJECTED/);
    await expect(
      exec.activate(device(), { ...ACTIVATION, policyName: 'PL-X;save' }),
    ).rejects.toThrow(/MITIGATION_WRITE_REJECTED/);
    expect(ssh.applied).toHaveLength(0);
  });

  it('prefix-lists vem SEMPRE da config do motor (nunca do chamador)', async () => {
    const ssh = new FakeSsh();
    await executor(ssh).activate(device(), {
      ...ACTIVATION,
      bogonPrefixList: 'BOGONS-QUALQUER',
      targetPrefixList: 'PREFIX8to24-QUALQUER',
    });
    // O valor do chamador e ignorado: o comando usa BOGONS/PREFIX8to24 do motor.
    expect(ssh.applied[0]!.commands).toContain(' if-match ip-prefix BOGONS');
    expect(ssh.applied[0]!.commands).toContain(' if-match ip-prefix PREFIX8to24');
  });

  it('falha do SSH na escrita nao vira sucesso', async () => {
    const ssh = new FakeSsh();
    ssh.applyOk = false;
    await expect(executor(ssh).activate(device(), ACTIVATION)).rejects.toThrow(
      /MITIGATION_WRITE_FAILED/,
    );
  });

  it('o motivo da falha de escrita carrega o trecho real do equipamento', async () => {
    const ssh = new FakeSsh();
    ssh.applyOk = false;
    ssh.applyOutput = 'Error: The route-policy does not exist.';
    await expect(executor(ssh).remove(device(), ACTIVATION)).rejects.toThrow(
      /Error: The route-policy does not exist\./,
    );
  });
});

// ---- read-back REAL: formato de display do `display route-policy` ----

/** Read-back real do F1A (policy ainda NAO mitigada). */
const DISPLAY_NORMAL = [
  'Route-policy: PL-HORIZONTES_IPv4-IN',
  '  permit : 11 (matched counts: 2)',
  '    Match clauses: ',
  '      if-match ip-prefix PREFIX-HORIZONTES-IPV4',
  '    Apply clauses: ',
  '      apply extcommunity rt 268568:140',
  '  deny : 50 (matched counts: 0)',
].join('\n');

/** Read-back esperado DEPOIS do commit (par presente, formato display). */
const DISPLAY_MITIGATED = [
  'Route-policy: PL-HORIZONTES_IPv4-IN',
  '  permit : 11 (matched counts: 0)',
  '    Match clauses: ',
  '      if-match ip-prefix PREFIX-HORIZONTES-IPV4',
  '  deny : 1 (matched counts: 0)',
  '    Match clauses: ',
  '      if-match ip-prefix BOGONS',
  '  permit : 2 (matched counts: 0)',
  '    Match clauses: ',
  '      if-match ip-prefix PREFIX8to24',
  '    Apply clauses: ',
  '      apply extcommunity rt 268568:660',
  '  deny : 50 (matched counts: 0)',
].join('\n');

describe('read-back real (display route-policy)', () => {
  it('o preflight reconhece o formato REAL e le os nodes 11 e 50', async () => {
    const ssh = new FakeSsh();
    ssh.readBack = DISPLAY_NORMAL;
    const result = await executor(ssh).preflight(device(), INPUT);
    expect(result.readBackNodes).toEqual([11, 50]);
    expect(result.readBackExcerpt).toContain('Route-policy: PL-HORIZONTES_IPv4-IN');
    expect(result.checks.find((check) => check.id === 'route_policy_readback')?.ok).toBe(true);
    expect(result.ok).toBe(true);
  });

  it('o MESMO verify pos-commit aprova o read-back display com o par presente', () => {
    const check = verifyActivation(
      POLICY,
      DISPLAY_MITIGATED,
      { bogonNode: 1, mitigationNode: 2 },
      RT,
      {
        bogonPrefixList: DEFAULT_BOGON_PREFIX_LIST,
        targetPrefixList: DEFAULT_TARGET_PREFIX_LIST,
      },
    );
    expect(check.bogonOk).toBe(true);
    expect(check.mitigationOk).toBe(true);
    expect(check.verified).toBe(true);
    expect(check.partial).toBe(false);
  });

  it('o preflight de REMOVE aprova o read-back display do par presente', async () => {
    const ssh = new FakeSsh();
    ssh.routePolicyConfiguration = ROUTE_POLICY_MITIGATED;
    ssh.readBack = DISPLAY_MITIGATED;
    const result = await executor(ssh).preflight(device(), REMOVE_INPUT);
    expect(result.ok).toBe(true);
    expect(result.readBackNodes).toEqual([1, 2, 11, 50]);
    expect(result.bogonNodeMatches).toBe(true);
    expect(result.mitigationNodeMatches).toBe(true);
  });

  it('read-back NAO interpretavel bloqueia o preflight (fail-closed)', async () => {
    const ssh = new FakeSsh();
    ssh.readBack = 'Error: The route-policy does not exist.';
    const result = await executor(ssh).preflight(device(), INPUT);
    expect(result.ok).toBe(false);
    expect(result.readBackNodes).toEqual([]);
    expect(result.blockedReasons.join(' ')).toMatch(/route_policy_readback/);
  });

  it('falha de SSH no read-back bloqueia o preflight', async () => {
    const ssh = new FakeSsh();
    ssh.readBackThrows = true;
    const result = await executor(ssh).preflight(device(), INPUT);
    expect(result.ok).toBe(false);
    expect(result.blockedReasons.join(' ')).toMatch(/route_policy_readback/);
  });
});
