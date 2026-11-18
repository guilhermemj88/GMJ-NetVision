import { describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { HuaweiBgpSshService } from '../huawei-bgp-ssh';
import { HuaweiMitigationExecutor, type MitigationSshPort } from './huawei-mitigation-executor';
import type { MitigationExecutionConfig } from './mitigation-execution-config';
import {
  assertMitigationPlatform,
  createPlatformGuardedMitigationSsh,
} from './mitigation-platform-guard';
import { testDurableBaselineStore } from './mitigation-test-support';

const POLICY = 'PL-HORIZONTES_IPv4-IN';
const RT = '268568:660';

function device(patch: Record<string, unknown> = {}): HostRecord {
  return {
    id: 'host-f1a',
    hostname: 'BHE-VTA-F1A-BGP-01',
    sshEnabled: true,
    ssh: { host: '10.200.1.1', port: 22, username: 'netvision' },
    vendor: 'Huawei',
    model: 'NE8000',
    ...patch,
  } as unknown as HostRecord;
}

const JUNIPER = { vendor: 'Juniper', model: 'MX204' };
const OLT = { vendor: 'Huawei', model: 'MA5800-X7' };
const DESCONHECIDO = { vendor: '', model: '' };
const CONTRADITORIO = { vendor: 'Huawei', model: 'MX204' };

function config(patch: Partial<MitigationExecutionConfig> = {}): MitigationExecutionConfig {
  return { executor: 'HUAWEI', liveWriteEnabled: true, allowedDeviceIds: ['host-f1a'], ...patch };
}

function port() {
  return {
    readMitigationConfiguration: vi.fn().mockResolvedValue({
      routePolicyConfiguration: null,
      prefixListConfiguration: null,
      warnings: [],
    }),
    readMitigationRoutePolicy: vi.fn().mockResolvedValue(''),
    applyMitigationCommands: vi.fn().mockResolvedValue({ ok: true, output: '' }),
    readMitigationDisplays: vi.fn().mockResolvedValue([]),
  };
}

function executor(ssh: MitigationSshPort): HuaweiMitigationExecutor {
  return new HuaweiMitigationExecutor({
    ssh,
    config: config(),
    rt: RT,
    baseline: testDurableBaselineStore(),
  });
}

describe('M1 — plataforma da mitigacao', () => {
  it('aceita apenas Huawei VRP e recusa o resto com motivo explicito', () => {
    expect(() => assertMitigationPlatform(device(), 'teste')).not.toThrow();
    for (const patch of [JUNIPER, OLT, DESCONHECIDO, CONTRADITORIO]) {
      expect(() => assertMitigationPlatform(device(patch), 'teste')).toThrow(
        /MITIGATION_PLATFORM_NOT_SUPPORTED/,
      );
    }
  });

  it('a porta guardada recusa leitura E escrita sem tocar no transporte', async () => {
    const inner = port();
    const guarded = createPlatformGuardedMitigationSsh(inner);
    const juniper = device(JUNIPER);

    await expect(guarded.readMitigationConfiguration(juniper)).rejects.toThrow(
      /MITIGATION_PLATFORM_NOT_SUPPORTED/,
    );
    await expect(guarded.readMitigationRoutePolicy(juniper, POLICY)).rejects.toThrow(
      /MITIGATION_PLATFORM_NOT_SUPPORTED/,
    );
    await expect(guarded.applyMitigationCommands(juniper, ['system-view'])).rejects.toThrow(
      /MITIGATION_PLATFORM_NOT_SUPPORTED/,
    );
    await expect(guarded.readMitigationDisplays(juniper, ['display bgp peer'])).rejects.toThrow(
      /MITIGATION_PLATFORM_NOT_SUPPORTED/,
    );

    expect(inner.readMitigationConfiguration).not.toHaveBeenCalled();
    expect(inner.readMitigationRoutePolicy).not.toHaveBeenCalled();
    expect(inner.applyMitigationCommands).not.toHaveBeenCalled();
    expect(inner.readMitigationDisplays).not.toHaveBeenCalled();
  });

  it('a porta guardada delega normalmente para Huawei', async () => {
    const inner = port();
    const guarded = createPlatformGuardedMitigationSsh(inner);
    const huawei = device();

    await guarded.readMitigationConfiguration(huawei);
    await guarded.applyMitigationCommands(huawei, ['system-view']);

    expect(inner.readMitigationConfiguration).toHaveBeenCalledWith(huawei);
    expect(inner.applyMitigationCommands).toHaveBeenCalledWith(huawei, ['system-view']);
  });

  it('enabledFor nunca habilita leitura para plataforma nao-Huawei', () => {
    const live = executor(port() as unknown as MitigationSshPort);
    expect(live.enabledFor(device())).toBe(true);
    expect(live.enabledFor(device(JUNIPER))).toBe(false);
    expect(live.enabledFor(device(DESCONHECIDO))).toBe(false);
  });

  it('preflight de Juniper falha fechado: nenhuma leitura chega ao equipamento', async () => {
    const inner = port();
    const live = executor(inner as unknown as MitigationSshPort);

    const result = await live.preflight(device(JUNIPER), {
      mode: 'REMOVE',
      policyName: POLICY,
      bogonNode: 1,
      mitigationNode: 2,
      rt: RT,
      bogonPrefixList: 'BOGONS',
      targetPrefixList: 'PREFIX',
      expectedExistingNodes: [11, 50],
    });

    expect(result.ok).toBe(false);
    expect(result.blockedReasons.join(' ')).toMatch(/MITIGATION_PLATFORM_NOT_SUPPORTED/);
    expect(inner.readMitigationConfiguration).not.toHaveBeenCalled();
    expect(inner.applyMitigationCommands).not.toHaveBeenCalled();
  });

  it('o transporte Huawei recusa a escrita de mitigacao sem abrir sessao SSH', async () => {
    const factory = vi.fn();
    const service = new HuaweiBgpSshService(
      { getDecryptedSshCredentials: vi.fn() } as never,
      factory as never,
    );

    for (const patch of [JUNIPER, OLT, DESCONHECIDO, CONTRADITORIO]) {
      const result = await service.applyMitigationCommands(device(patch), ['system-view']);
      expect(result.ok).toBe(false);
      expect(result.output).toMatch(/MITIGATION_PLATFORM_NOT_SUPPORTED/);
    }

    expect(factory).not.toHaveBeenCalled();
  });
});
