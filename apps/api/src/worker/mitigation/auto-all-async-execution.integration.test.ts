import { describe, expect, it } from 'vitest';
import { createAutoAllHarness, OTHER } from '../../testing/auto-all-physical-harness';
import { SINGLE_AUTO_PILOT as P } from './single-pilot-trigger';

/**
 * M1-AUTO no MESMO caminho de producao (routes.ts): FAST embutido -> motor canonico com
 * `asyncExecution` -> lifecycle.activate (reserva duravel) -> comando canonico -> executor
 * simulado. O ACTIVATE roda fora do tick; o tick seguinte recebe o resultado final.
 */

const HIGH = 9_400_000_000n; // > 90% de 10 Gbps
const LOW = 300_000_000n;
type H = Awaited<ReturnType<typeof createAutoAllHarness>>;
const decisionOf = (all: Awaited<ReturnType<H['cycle']>>, id: string) =>
  all.filter((d) => d.profileId === id);

async function warm(h: H) {
  await h.cycle({});
  await h.cycle({});
}

describe('M1-AUTO: AUTO-ALL com o ACTIVATE fora do tick (caminho de producao)', () => {
  it('3/3 despacha, o tick NAO espera; o tick seguinte recebe ACTIVATED com 1 escrita canonica', async () => {
    const h = await createAutoAllHarness({ asyncExecution: true });
    await warm(h);
    const steps: string[] = [];
    for (let i = 0; i < 3; i++) {
      const [d] = decisionOf(await h.cycle({ [P.profileId]: HIGH }), P.profileId);
      steps.push(`${d!.samplesOver}:${d!.outcome}:${d!.commandStatus ?? ''}`);
    }
    expect(steps).toEqual([
      '1:TRIGGER_PENDING:',
      '2:TRIGGER_PENDING:',
      '3:TRIGGER_PENDING:IN_FLIGHT',
    ]);
    await h.engine.settleExecutions();
    expect(h.ssh.writes).toHaveLength(1);
    expect(h.ssh.writes[0]).toEqual([
      'system-view',
      `route-policy ${P.policy} deny node 1`,
      ' if-match ip-prefix BOGONS',
      `route-policy ${P.policy} permit node 2`,
      ' if-match ip-prefix AGLINK-BLOCO-TODO-23',
      ' apply local-preference 1100',
      ' apply extcommunity rt 268568:660',
      'commit',
    ]);
    // ACTIVE so depois do veredito do comando (read-back + verificacao)
    expect((await h.scope())?.phase).toBe('ACTIVE');
    const next = decisionOf(await h.cycle({ [P.profileId]: HIGH }), P.profileId);
    const final = next.find((d) => d.outcome === 'ACTIVATED');
    expect(final).toMatchObject({ verified: true, commandStatus: 'ACTIVATED_VERIFIED' });
    // trafego sustentado: nenhuma segunda escrita (ownership duravel)
    for (let i = 0; i < 3; i++) await h.cycle({ [P.profileId]: HIGH });
    await h.engine.settleExecutions();
    expect(h.ssh.writes).toHaveLength(1);
    expect(h.used).toEqual({ bridge: 0, legacy: 0 });
  });

  it('durante o ACTIVATE o escopo fica ACTIVATING (reserva duravel) e nunca ACTIVE antes do veredito', async () => {
    const h = await createAutoAllHarness({ asyncExecution: true, sshLatencyMs: 50 });
    await warm(h);
    for (let i = 0; i < 3; i++) await h.cycle({ [P.profileId]: HIGH });
    expect(h.engine.inFlightProfiles()).toEqual([P.profileId]);
    const during = (await h.scope())?.phase ?? null;
    expect([null, 'ACTIVATING']).toContain(during);
    await h.engine.settleExecutions();
    expect((await h.scope())?.phase).toBe('ACTIVE');
    expect(h.engine.inFlightProfiles()).toEqual([]);
  });

  it('outros perfis seguem com decisao propria em todo tick enquanto o ACTIVATE roda', async () => {
    const h = await createAutoAllHarness({ asyncExecution: true, sshLatencyMs: 50 });
    await warm(h);
    for (let i = 0; i < 3; i++) await h.cycle({ [P.profileId]: HIGH, [OTHER.profileId]: LOW });
    expect(h.engine.inFlightProfiles()).toEqual([P.profileId]);
    const all = await h.cycle({ [P.profileId]: HIGH, [OTHER.profileId]: LOW });
    expect(decisionOf(all, OTHER.profileId)[0]).toMatchObject({
      outcome: 'NO_ACTION',
      reason: 'THRESHOLD_NOT_EXCEEDED',
    });
    await h.engine.settleExecutions();
    expect(h.ssh.writes).toHaveLength(1);
  });

  it('restart com a mitigacao ACTIVE: reconcilia sem reescrever (idempotencia duravel)', async () => {
    const h = await createAutoAllHarness({ asyncExecution: true });
    await warm(h);
    for (let i = 0; i < 3; i++) await h.cycle({ [P.profileId]: HIGH });
    await h.engine.settleExecutions();
    expect(h.ssh.writes).toHaveLength(1);
    await h.restart();
    for (let i = 0; i < 4; i++) await h.cycle({ [P.profileId]: HIGH });
    await h.engine.settleExecutions();
    expect(h.ssh.writes).toHaveLength(1);
    expect((await h.scope())?.phase).toBe('ACTIVE');
    // recuperacao do trafego nunca remove sozinha (AUTO_REMOVE=0)
    for (let i = 0; i < 15; i++) await h.cycle({ [P.profileId]: LOW });
    expect(h.ssh.writes).toHaveLength(1);
    expect(h.ssh.active).toBe(true);
  });

  it('kill switch desligado: so detecta, nada e despachado nem escrito', async () => {
    const h = await createAutoAllHarness({ asyncExecution: true, executionEnabled: false });
    await warm(h);
    for (let i = 0; i < 5; i++) await h.cycle({ [P.profileId]: HIGH });
    await h.engine.settleExecutions();
    expect(h.engine.inFlightProfiles()).toEqual([]);
    expect(h.ssh.writes).toHaveLength(0);
  });
});
