import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostRecord } from '@gmj/shared';
import { PrismaClient } from '../src/generated/prisma/index.js';
import { PrismaAutomationStore } from '../src/worker/mitigation/automation-store';
import { AutomationMitigationBaselineStore } from '../src/worker/mitigation/baseline-store';
import { HuaweiMitigationExecutor } from '../src/infrastructure/bgp/mitigation/huawei-mitigation-executor';

/** Constantes e fabricas compartilhadas do laboratorio. */

export const POLICY = 'PL-HOMOLOG_IPv4-IN';
export const RT = '268568:660';
export const DEVICE_ID = 'host-lab-homolog';
export const STATE_PATH = join(tmpdir(), 'nv-lab-homolog', 'device.json');

export const LAB_URL =
  process.env.LAB_DATABASE_URL ??
  'postgresql://nv_baseline_lab:nv_lab_only_2026@127.0.0.1:55077/mitigation_baseline_test?schema=public';

export function device(): HostRecord {
  return {
    id: DEVICE_ID,
    hostname: 'LAB-SIMULADO',
    displayName: 'LAB-SIMULADO',
    name: 'LAB-SIMULADO',
    sshEnabled: true,
    ssh: { host: '127.0.0.1', port: 22, username: 'lab-sim' },
  } as unknown as HostRecord;
}

/** Guarda de isolamento: recusa qualquer destino que nao seja o laboratorio. */
export function assertLabUrl(url: string): void {
  const parsed = new URL(url);
  const ok =
    parsed.hostname === '127.0.0.1' &&
    (parsed.port === '55077' || parsed.port === '55999') &&
    parsed.pathname === '/mitigation_baseline_test';
  if (!ok) {
    throw new Error(`LAB_GUARD: URL fora do laboratorio: ${parsed.hostname}:${parsed.port}`);
  }
}

export function prismaClient(url: string = LAB_URL): PrismaClient {
  assertLabUrl(url);
  return new PrismaClient({ datasources: { db: { url } } });
}

export function baselineStore(client: PrismaClient): AutomationMitigationBaselineStore {
  const store = {
    transaction: (work: Parameters<PrismaAutomationStore['transaction']>[0]) =>
      new PrismaAutomationStore(client).transaction(work),
  };
  return new AutomationMitigationBaselineStore(store as unknown as PrismaAutomationStore);
}

export function executor(
  ssh: ConstructorParameters<typeof HuaweiMitigationExecutor>[0]['ssh'],
  store: AutomationMitigationBaselineStore,
): HuaweiMitigationExecutor {
  return new HuaweiMitigationExecutor({
    ssh,
    config: { executor: 'HUAWEI', liveWriteEnabled: true, allowedDeviceIds: [DEVICE_ID] },
    rt: RT,
    labels: { bogonPrefixList: 'BOGONS', targetPrefixList: 'PREFIX8to24' },
    baseline: store,
  });
}

export const ACTIVATE_INPUT = {
  mode: 'ACTIVATE' as const,
  policyName: POLICY,
  bogonNode: 1,
  mitigationNode: 2,
  rt: RT,
  bogonPrefixList: 'BOGONS',
  targetPrefixList: 'PREFIX8to24',
  expectedExistingNodes: [10, 1000] as number[] | null,
};

export const REMOVE_INPUT = { ...ACTIVATE_INPUT, mode: 'REMOVE' as const };

/** Imprime o resultado de forma legivel e estavel (evidencia). */
export function report(label: string, payload: unknown): void {
  process.stdout.write(`\n### ${label}\n${JSON.stringify(payload, null, 2)}\n`);
}

export function check(
  id: string,
  result: { checks: { id: string; ok: boolean; detail: string }[] },
): { id: string; ok: boolean; detail: string } | undefined {
  return result.checks.find((entry) => entry.id === id);
}
