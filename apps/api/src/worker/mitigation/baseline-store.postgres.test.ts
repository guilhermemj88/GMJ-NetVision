import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/index.js';
import { PrismaAutomationStore, type AutomationStore } from './automation-store';
import { AutomationMitigationBaselineStore } from './baseline-store';
import { captureMitigationBaseline } from '../../infrastructure/bgp/mitigation/mitigation-baseline-record';

// Opt-in explicito: nunca aceitar URL de banco operacional.
const url = process.env.MITIGATION_BASELINE_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '55077' ||
    parsed.pathname !== '/mitigation_baseline_test'
  )
    throw Error('DISPOSABLE_BASELINE_DATABASE_REQUIRED');
}

const POLICY = 'PL-CLIENTE_IPv4-IN';
const READBACK = [
  `route-policy ${POLICY} deny node 1`,
  ' if-match ip-prefix BOGONS',
  `route-policy ${POLICY} permit node 2`,
  ' if-match ip-prefix PREFIX8to24',
  ' apply extcommunity rt 268568:660 additive',
  `route-policy ${POLICY} permit node 10`,
  ' if-match ip-prefix PREFIX8to24',
  ' apply local-preference 1100',
  ' apply extcommunity rt 268568:140 additive',
  `route-policy ${POLICY} deny node 1000`,
].join('\n');

describe.skipIf(!url)('baseline duravel com PostgreSQL real (B6)', () => {
  let db = new PrismaClient({ datasources: { db: { url: url ?? 'postgresql://invalid/unused' } } });
  const store = (): AutomationStore => ({
    transaction: (work) => new PrismaAutomationStore(db).transaction(work),
  });
  beforeEach(async () => {
    await db.mitigationAutomationRecord.deleteMany();
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  const record = captureMitigationBaseline({
    deviceId: 'host-f1a',
    policyName: POLICY,
    readBack: READBACK,
    bogonNode: 1,
    mitigationNode: 2,
  })!;

  it('persiste o registro e recupera por uma instancia nova do adaptador', async () => {
    const writer = new AutomationMitigationBaselineStore(store());
    expect(writer.durable).toBe(true);
    await writer.save(record);

    // Reconnect: prova que o payload esta no PostgreSQL, nao em memoria.
    await db.$disconnect();
    db = new PrismaClient({ datasources: { db: { url: url! } } });

    const reader = new AutomationMitigationBaselineStore(store());
    expect(await reader.load({ deviceId: 'host-f1a', policyName: POLICY })).toEqual(record);
  });

  it('devolve null para escopo sem registro', async () => {
    const reader = new AutomationMitigationBaselineStore(store());
    expect(await reader.load({ deviceId: 'host-outro', policyName: POLICY })).toBeNull();
  });
});
