import { describe, expect, it } from 'vitest';
import { createAutoAllHarness } from '../../testing/auto-all-physical-harness';
import { InMemoryPolicyScopeLock } from '../../infrastructure/bgp/mitigation/mitigation-policy-lock';
import { MitigationPolicyReconciler } from '../../infrastructure/bgp/mitigation/mitigation-policy-reconciler';
import type { OutboxEntry } from './durable-mitigation-outbox';
import { SINGLE_AUTO_PILOT as P } from './single-pilot-trigger';

/**
 * Pos-SHADOW: concorrencia entre ACTIVATE (AUTO e manual), REMOVE manual, FAST (ticks continuos), reconciliador e
 * encerramento do processo, no caminho de producao (motor canonico + lifecycle + comando canonico + executor Huawei
 * real; so a borda SSH e simulada: NENHUMA escrita em equipamento). O lock e um try-lock, como o advisory lock.
 * Invariante central: nunca dois ACTIVATE fisicos concorrentes para a mesma policy.
 */
const HIGH = 9_400_000_000n;
type H = Awaited<ReturnType<typeof createAutoAllHarness>>;
const harness = () =>
  createAutoAllHarness({
    asyncExecution: true,
    scopeLock: () => new InMemoryPolicyScopeLock({ timeoutMs: 0 }),
  });
const flush = async (until: () => boolean) => {
  for (let i = 0; i < 400 && !until(); i++) await new Promise((r) => setTimeout(r, 0));
  expect(until()).toBe(true);
};
function gate() {
  let open!: () => void;
  const closed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { closed, open };
}
async function attack(h: H) {
  await h.cycle({});
  await h.cycle({});
  for (let i = 0; i < 3; i++) await h.cycle({ [P.profileId]: HIGH });
}
const manual = (h: H, id: string, action: 'ACTIVATE' | 'REMOVE') =>
  h.commands.execute({ requestId: `manual-${id}`, action, profileId: P.profileId });
const activations = (h: H) =>
  h.ssh.writes.filter((c) => c.some((l) => l.includes('apply local-preference'))).length;
const removals = (h: H) => h.ssh.writes.filter((c) => c.some((l) => l.startsWith('undo '))).length;
const events = async (h: H) =>
  (await h.store.transaction((tx) => tx.list<OutboxEntry>('outbox'))).map((row) => row.event);

describe('pos-SHADOW: nenhum caminho permite dois ACTIVATE fisicos concorrentes na mesma policy', () => {
  it('AUTO em andamento + 8 ACTIVATE manuais simultaneos: continua UMA escrita; os manuais sao recusados', async () => {
    const h = await harness();
    const g = gate();
    h.ssh.afterWrite = () => g.closed;
    await attack(h);
    await flush(() => h.ssh.writes.length === 1);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => manual(h, `during-auto-${i}`, 'ACTIVATE')),
    );
    expect(results.every((r) => r.ok === false)).toBe(true);
    expect(results.every((r) => r.status === 'POLICY_BUSY')).toBe(true);
    expect(activations(h)).toBe(1);
    delete h.ssh.afterWrite;
    g.open();
    await h.engine.settleExecutions();
    expect(activations(h)).toBe(1);
    expect((await h.scope())?.phase).toBe('ACTIVE');
  });

  it('8 ACTIVATE manuais simultaneos a partir de NORMAL (sem AUTO): exatamente UMA escrita fisica', async () => {
    const h = await harness();
    await h.cycle({});
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => manual(h, `burst-${i}`, 'ACTIVATE')),
    );
    expect(activations(h)).toBe(1);
    expect(results.filter((r) => r.status === 'ACTIVATED_VERIFIED')).toHaveLength(1);
    expect(h.ssh.active).toBe(true);
  });

  it('manual ACTIVATE em andamento + AUTO com trafego alto: o AUTO NAO escreve por cima (reserva duravel + lock)', async () => {
    const h = await harness();
    const g = gate();
    h.ssh.afterWrite = () => g.closed;
    await h.cycle({});
    const op = manual(h, 'first', 'ACTIVATE');
    await flush(() => h.ssh.writes.length === 1);
    for (let i = 0; i < 6; i++) await h.cycle({ [P.profileId]: HIGH });
    await h.engine.settleExecutions();
    expect(activations(h)).toBe(1);
    delete h.ssh.afterWrite;
    g.open();
    await expect(op).resolves.toMatchObject({ status: 'ACTIVATED_VERIFIED' });
    for (let i = 0; i < 4; i++) await h.cycle({ [P.profileId]: HIGH });
    await h.engine.settleExecutions();
    expect(activations(h)).toBe(1);
  });

  it('REMOVE manual em andamento + FAST continuo (trafego alto): nenhuma reativacao; so as escritas do ACTIVATE e do REMOVE', async () => {
    const h = await harness();
    await attack(h);
    await h.engine.settleExecutions();
    expect((await h.scope())?.phase).toBe('ACTIVE');
    const g = gate();
    h.ssh.afterWrite = () => g.closed;
    const removal = manual(h, 'remove', 'REMOVE');
    await flush(() => h.ssh.writes.length === 2);
    for (let i = 0; i < 6; i++) await h.cycle({ [P.profileId]: HIGH }); // FAST segue amostrando
    await h.engine.settleExecutions();
    expect(activations(h)).toBe(1);
    expect(removals(h)).toBe(1);
    delete h.ssh.afterWrite;
    g.open();
    await expect(removal).resolves.toMatchObject({ status: 'REMOVED_VERIFIED' });
    for (let i = 0; i < 6; i++) await h.cycle({ [P.profileId]: HIGH }); // cooldown: nada de reativar
    await h.engine.settleExecutions();
    expect(activations(h)).toBe(1);
  });

  it('REMOVE e ACTIVATE manuais simultaneos: um so executa por vez (nunca as duas escritas sobrepostas)', async () => {
    const h = await harness();
    await attack(h);
    await h.engine.settleExecutions();
    const g = gate();
    h.ssh.afterWrite = () => g.closed;
    const removal = manual(h, 'r', 'REMOVE');
    await flush(() => h.ssh.writes.length === 2);
    const activate = await manual(h, 'a', 'ACTIVATE');
    expect(activate).toMatchObject({ ok: false, status: 'POLICY_BUSY' });
    expect(h.ssh.writes).toHaveLength(2);
    delete h.ssh.afterWrite;
    g.open();
    await removal;
    expect(activations(h)).toBe(1);
  });
});

describe('pos-SHADOW: encerramento do processo e reconciliador com ACTIVATE em andamento', () => {
  it('beginShutdown com ACTIVATE fisico em andamento: ele TERMINA e e verificado; nada novo parte; settle nao trava', async () => {
    const h = await harness();
    const g = gate();
    h.ssh.afterWrite = () => g.closed;
    await attack(h);
    await flush(() => h.ssh.writes.length === 1);
    h.engine.beginShutdown();
    for (let i = 0; i < 4; i++) await h.cycle({ [P.profileId]: HIGH });
    expect(h.ssh.writes).toHaveLength(1);
    let settled = false;
    const wait = h.engine.settleExecutions().then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 15));
    expect(settled).toBe(false); // aguardando a operacao fisica, sem abandona-la
    delete h.ssh.afterWrite;
    g.open();
    await wait;
    expect(settled).toBe(true);
    expect((await h.scope())?.phase).toBe('ACTIVE');
    expect(await events(h)).toEqual(['MITIGATION_VERIFIED']);
    expect(activations(h)).toBe(1);
  });

  it('reconciliador com ACTIVATE em andamento: preview/apply NAO liberam nem escrevem; o ACTIVATE conclui intacto', async () => {
    const h = await harness();
    const g = gate();
    h.ssh.afterWrite = () => g.closed;
    await attack(h);
    await flush(() => h.ssh.writes.length === 1);
    const reconciler = new MitigationPolicyReconciler({
      beforeApply: (deviceId, policyName, proof) =>
        h.lifecycle.manualMutation(deviceId, policyName, proof),
      repository: h.repository,
      hosts: { getHost: async () => h.host },
      readPolicy: async () => h.ssh.readMitigationRoutePolicy(),
      restorationVerifier: (device, scope, customerPeers) =>
        h.live.verifyRestorationPhysical(device, { policyName: scope.policyName, customerPeers }),
      now: () => new Date(h.now()),
    });
    const scopeOf = { deviceId: P.deviceId, policyName: P.policy };
    const outcome = await reconciler
      .preview(scopeOf)
      .then((p) => reconciler.applyLocal(scopeOf, p.previewId))
      .then(
        () => 'APPLIED',
        (e: Error) => `REFUSED:${e.message}`,
      );
    expect(outcome).not.toBe('APPLIED');
    expect(h.ssh.writes).toHaveLength(1);
    delete h.ssh.afterWrite;
    g.open();
    await h.engine.settleExecutions();
    expect((await h.scope())?.phase).toBe('ACTIVE');
    expect(activations(h)).toBe(1);
  });

  it('MITIGATED nao segura lock: apos o veredito um REMOVE manual obtem o lock imediatamente (sem POLICY_BUSY)', async () => {
    const h = await harness();
    await attack(h);
    await h.engine.settleExecutions();
    expect((await h.scope())?.phase).toBe('ACTIVE');
    const removal = await manual(h, 'after-mitigated', 'REMOVE');
    expect(removal.status).toBe('REMOVED_VERIFIED');
  });
});
