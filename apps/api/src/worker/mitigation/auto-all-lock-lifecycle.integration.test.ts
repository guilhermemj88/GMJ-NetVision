import { describe, expect, it } from 'vitest';
import { createAutoAllHarness } from '../../testing/auto-all-physical-harness';
import {
  InMemoryPolicyScopeLock,
  UNBOUNDED_POLICY_LEASE,
  type PolicyScopeLock,
} from '../../infrastructure/bgp/mitigation/mitigation-policy-lock';
import { MitigationPolicyReconciler } from '../../infrastructure/bgp/mitigation/mitigation-policy-reconciler';
import { QUARANTINE_RELEASE_MIN_AGE_MS, type JournalCommand } from './auto-lifecycle';
import type { OutboxEntry } from './durable-mitigation-outbox';
import { SINGLE_AUTO_PILOT as P } from './single-pilot-trigger';

/**
 * Ciclo NORMAL -> ACTIVATING -> MITIGATED -> REMOVING -> NORMAL no caminho de producao
 * (motor canonico com asyncExecution + lifecycle + comando canonico + executor Huawei real;
 * so a borda SSH e falsa). O lock da policy e uma exclusividade TEMPORARIA da operacao: o
 * estado MITIGATED e o registro duravel (escopo ACTIVE), nunca um lock mantido.
 *
 * O lock aqui e um try-lock (ocupado = recusa imediata), como o advisory lock de producao.
 */

const HIGH = 9_400_000_000n;
const LOW = 300_000_000n;
type H = Awaited<ReturnType<typeof createAutoAllHarness>>;

const tryLock = () => new InMemoryPolicyScopeLock({ timeoutMs: 0 });
const harness = () => createAutoAllHarness({ asyncExecution: true, scopeLock: tryLock });
const flush = async (until: () => boolean) => {
  for (let i = 0; i < 200 && !until(); i++) await new Promise((r) => setTimeout(r, 0));
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
async function mitigated(h: H) {
  await attack(h);
  await h.engine.settleExecutions();
  expect((await h.scope())?.phase).toBe('ACTIVE');
}
const telegram = (h: H, callbackId: string, action: 'REMOVE' | 'ACTIVATE' = 'REMOVE') =>
  h.commands.execute({ requestId: `telegram-${callbackId}`, action, profileId: P.profileId });
const events = async (h: H) =>
  (await h.store.transaction((tx) => tx.list<OutboxEntry>('outbox'))).map((row) => row.event);
const runtime = async (h: H) => (await h.repository.getRuntime(P.profileId))?.state;
const journals = (h: H) => h.store.transaction((tx) => tx.list<JournalCommand>('command'));
const undoWrites = (h: H) =>
  h.ssh.writes.filter((commands) => commands.some((line) => line.startsWith('undo '))).length;
const reconciler = (h: H) =>
  new MitigationPolicyReconciler({
    beforeApply: (deviceId, policyName, proof) =>
      h.lifecycle.manualMutation(deviceId, policyName, proof),
    repository: h.repository,
    hosts: { getHost: async () => h.host },
    readPolicy: async () => h.ssh.readMitigationRoutePolicy(),
    now: () => new Date(h.now()),
  });
const scopeOf = { deviceId: P.deviceId, policyName: P.policy };
/** Fluxo do operador no painel: preview (leitura fresca) -> apply (so runtime/ownership). */
async function reconcile(h: H) {
  const r = reconciler(h);
  const preview = await r.preview(scopeOf);
  return r.applyLocal(scopeOf, preview.previewId).then(
    (applied) => applied.state as string,
    (error: Error) => `REFUSED:${error.message}`,
  );
}

describe('MITIGATED e estado persistente, sem lock mantido; retirada so por ordem humana', () => {
  it('D: trafego abaixo do limiar NAO retira; Telegram REMOVE -> REMOVED_VERIFIED -> NORMAL', async () => {
    const h = await harness();
    await mitigated(h);
    expect(await runtime(h)).toBe('MITIGATED');
    for (let i = 0; i < 20; i++) await h.cycle({ [P.profileId]: LOW });
    await h.engine.settleExecutions();
    expect(h.ssh.active).toBe(true);
    expect(undoWrites(h)).toBe(0);
    expect((await h.scope())?.phase).toBe('ACTIVE');
    // O lock nao ficou retido durante MITIGATED: a retirada adquire o lock na hora.
    const removed = await telegram(h, 'cb-1');
    expect(removed).toMatchObject({ ok: true, verified: true, status: 'REMOVED_VERIFIED' });
    expect(h.ssh.active).toBe(false);
    expect(await runtime(h)).toBe('NORMAL');
    expect((await h.scope())?.phase).toBe('COOLDOWN');
    expect(await events(h)).toEqual(['MITIGATION_VERIFIED', 'MITIGATION_REMOVED_VERIFIED']);
  });

  it('E: Telegram duplicado (mesmo callback e segundo toque) -> UMA retirada fisica', async () => {
    const h = await harness();
    await mitigated(h);
    const [first, replay] = await Promise.all([telegram(h, 'cb-1'), telegram(h, 'cb-1')]);
    expect([first.status, replay.status]).toEqual(['REMOVED_VERIFIED', 'REMOVED_VERIFIED']);
    expect((await telegram(h, 'cb-1')).idempotent).toBe(true);
    // segundo toque = outro callback_query.id: nada a retirar, nenhuma escrita
    const second = await telegram(h, 'cb-2');
    expect(second.ok).toBe(false);
    expect(second.verified).toBe(false);
    expect(undoWrites(h)).toBe(1);
    expect(h.ssh.writes).toHaveLength(2);
    expect(await runtime(h)).toBe('NORMAL');
    expect((await events(h)).filter((e) => e === 'MITIGATION_REMOVED_VERIFIED')).toHaveLength(1);
  });

  it('F: REMOVE durante ACTIVATING e recusado (POLICY_BUSY), sem escrita; a ativacao conclui', async () => {
    const h = await harness();
    const g = gate();
    h.ssh.afterWrite = () => g.closed;
    await attack(h);
    await flush(() => h.ssh.writes.length === 1);
    expect((await h.scope())?.phase).toBe('ACTIVATING');
    const removal = await telegram(h, 'cb-early');
    expect(removal).toMatchObject({ ok: false, status: 'POLICY_BUSY' });
    // novos ticks durante ACTIVATING nao duplicam a ativacao
    for (let i = 0; i < 3; i++) await h.cycle({ [P.profileId]: HIGH });
    expect(h.ssh.writes).toHaveLength(1);
    delete h.ssh.afterWrite;
    g.open();
    await h.engine.settleExecutions();
    expect((await h.scope())?.phase).toBe('ACTIVE');
    expect(await events(h)).toEqual(['MITIGATION_VERIFIED']);
    // o callback recusado nao ficou "armado": a retirada exige um novo comando
    expect(h.ssh.active).toBe(true);
    expect((await telegram(h, 'cb-later')).status).toBe('REMOVED_VERIFIED');
  });

  it('G: ACTIVATE (manual e AUTO) durante REMOVING e recusado; nenhuma reativacao no cooldown', async () => {
    const h = await harness();
    await mitigated(h);
    const g = gate();
    h.ssh.afterWrite = () => g.closed;
    const removing = telegram(h, 'cb-1');
    await flush(() => h.ssh.writes.length === 2);
    expect(await telegram(h, 'cb-act', 'ACTIVATE')).toMatchObject({
      ok: false,
      status: 'POLICY_BUSY',
    });
    expect((await telegram(h, 'cb-2')).status).toBe('POLICY_BUSY');
    for (let i = 0; i < 4; i++) await h.cycle({ [P.profileId]: HIGH });
    await flush(() => h.engine.inFlightProfiles().length === 0);
    expect(h.ssh.writes).toHaveLength(2);
    delete h.ssh.afterWrite;
    g.open();
    expect((await removing).status).toBe('REMOVED_VERIFIED');
    for (let i = 0; i < 4; i++) await h.cycle({ [P.profileId]: HIGH });
    await h.engine.settleExecutions();
    expect(h.ssh.writes).toHaveLength(2);
    expect(h.ssh.active).toBe(false);
  });

  it('K: falha na retirada (sessao cai depois do commit) NUNCA vira NORMAL', async () => {
    const h = await harness();
    await mitigated(h);
    h.ssh.timeout = true;
    const removed = await telegram(h, 'cb-1');
    expect(removed.ok).toBe(false);
    expect(removed.verified).toBe(false);
    expect(await runtime(h)).toBe('RECONCILIATION_REQUIRED');
    expect((await h.scope())?.phase).toBe('UNCERTAIN');
    expect(await events(h)).not.toContain('MITIGATION_REMOVED_VERIFIED');
    // nenhuma repeticao cega: o mesmo callback e um novo ficam bloqueados
    h.ssh.timeout = false;
    expect((await telegram(h, 'cb-1')).status).toBe('MANUAL_RECONCILIATION_REQUIRED');
    expect((await telegram(h, 'cb-2')).status).toBe('MANUAL_RECONCILIATION_REQUIRED');
    expect(undoWrites(h)).toBe(1);
  });
});

describe('estado incerto: quarentena sem escrita cega e SAIDA por reconciliacao comprovada', () => {
  it('H: processo morre com o comando no Huawei -> restart -> UNCERTAIN; libera so com ausencia provada', async () => {
    const h = await harness();
    h.ssh.afterWrite = () => new Promise<void>(() => undefined); // o processo "morre" aqui
    await attack(h);
    await flush(() => h.ssh.writes.length === 1);
    expect((await journals(h)).map((j) => j.state)).toEqual(['STARTED']);
    delete h.ssh.afterWrite;
    await h.restart();
    expect((await h.scope())?.phase).toBe('UNCERTAIN');
    // nada e repetido nem desfeito sozinho; nenhum VERIFIED foi fabricado
    for (let i = 0; i < 4; i++) await h.cycle({ [P.profileId]: HIGH });
    await h.engine.settleExecutions();
    expect(h.ssh.writes).toHaveLength(1);
    expect(await events(h)).not.toContain('MITIGATION_VERIFIED');
    expect((await telegram(h, 'cb-1')).status).toBe('MANUAL_RECONCILIATION_REQUIRED');
    // par AINDA presente no equipamento: a reconciliacao nao libera
    expect(await reconcile(h)).toBe('REFUSED:MANUAL_RECONCILIATION_REQUIRED');
    // operador retira pelo CLI
    h.ssh.active = false;
    // comando STARTED recente pode ainda estar em execucao: nao libera
    expect(await reconcile(h)).toBe('REFUSED:MANUAL_RECONCILIATION_REQUIRED');
    h.advance(QUARANTINE_RELEASE_MIN_AGE_MS + 1_000);
    expect(await reconcile(h)).toBe('NORMAL');
    expect(await runtime(h)).toBe('NORMAL');
    expect(await h.scope()).toMatchObject({
      phase: 'COOLDOWN',
      reason: 'EXPLICIT_MANUAL_RELEASE_RECONCILED',
    });
    expect((await journals(h)).map((j) => j.state)).toEqual(['RECONCILED']);
    expect(h.ssh.writes).toHaveLength(1); // a reconciliacao nunca escreve no equipamento
  });

  it('piloto manual NAO comprovado (cenario E0): CLI + reconciliacao devolvem o cliente a operacao', async () => {
    const h = await harness();
    await h.cycle({});
    h.ssh.physical.mode = 'not-advertised';
    const first = await telegram(h, 'e0-activate', 'ACTIVATE');
    expect(first).toMatchObject({ ok: false, status: 'ACTIVATED_UNVERIFIED_PHYSICAL' });
    expect(await runtime(h)).toBe('RECONCILIATION_REQUIRED');
    expect(await events(h)).toEqual(['MITIGATION_FAILED']);
    expect((await telegram(h, 'e0-remove')).status).toBe('MANUAL_RECONCILIATION_REQUIRED');
    expect(await reconcile(h)).toBe('REFUSED:MANUAL_RECONCILIATION_REQUIRED');
    h.ssh.active = false; // retirada pelo CLI do operador
    expect(await reconcile(h)).toBe('NORMAL');
    expect(await runtime(h)).toBe('NORMAL');
    expect((await journals(h)).map((j) => j.state)).toEqual(['RECONCILED']);
    const audit = await h.store.transaction((tx) =>
      tx.list<{ action: string }>('reconciliation'),
    );
    expect(audit.map((entry) => entry.action)).toEqual(['RELEASE_WITHOUT_PHYSICAL_WRITE']);
    // o ownership antigo foi descartado: um par no equipamento nao e adotado/removido pela API
    h.ssh.active = true;
    expect((await telegram(h, 'e0-foreign-remove')).ok).toBe(false);
    expect(undoWrites(h)).toBe(0);
    h.ssh.active = false;
    // ciclo completo volta a funcionar
    h.ssh.physical.mode = 'ok';
    expect((await telegram(h, 'e0-activate-2', 'ACTIVATE')).status).toBe('ACTIVATED_VERIFIED');
    expect((await telegram(h, 'e0-remove-2')).status).toBe('REMOVED_VERIFIED');
    expect(await runtime(h)).toBe('NORMAL');
  });

  it('sem prova fisica de ausencia a quarentena permanece (chamada sem prova, MITIGATED, incerto)', async () => {
    const h = await harness();
    await h.cycle({});
    h.ssh.physical.mode = 'not-advertised';
    await telegram(h, 'e0-activate', 'ACTIVATE');
    h.ssh.active = false;
    const mutate = (proof?: { state: string; pairPresent: boolean; readBack: string }) =>
      h.lifecycle.manualMutation(P.deviceId, P.policy, proof).then(
        () => 'RELEASED',
        (error: Error) => error.message,
      );
    expect(await mutate()).toBe('MANUAL_RECONCILIATION_REQUIRED');
    for (const state of ['MITIGATED', 'RECONCILIATION_REQUIRED'])
      expect(await mutate({ state, pairPresent: false, readBack: '' })).toBe(
        'MANUAL_RECONCILIATION_REQUIRED',
      );
    expect(await mutate({ state: 'NORMAL', pairPresent: true, readBack: '' })).toBe(
      'MANUAL_RECONCILIATION_REQUIRED',
    );
    expect((await journals(h)).map((j) => j.state)).toEqual(['UNCERTAIN']);
  });
});

describe('o lock sozinho nao e a garantia: estado duravel e fila do lock', () => {
  /** Lock que SEMPRE concede: simula a exclusividade perdida (lock expirado com a operacao viva). */
  const brokenLock = (): PolicyScopeLock => ({
    run: (_scope, operation) => operation(UNBOUNDED_POLICY_LEASE),
  });

  it('I: exclusividade perdida durante ACTIVATING e REMOVING -> o journal/ownership barram a concorrente', async () => {
    const h = await createAutoAllHarness({ asyncExecution: true, scopeLock: brokenLock });
    const activating = gate();
    h.ssh.afterWrite = () => activating.closed;
    await attack(h);
    await flush(() => h.ssh.writes.length === 1);
    expect((await telegram(h, 'cb-early')).status).toBe('MANUAL_RECONCILIATION_REQUIRED');
    expect((await telegram(h, 'cb-act', 'ACTIVATE')).status).toBe('MANUAL_RECONCILIATION_REQUIRED');
    expect(h.ssh.writes).toHaveLength(1);
    delete h.ssh.afterWrite;
    activating.open();
    await h.engine.settleExecutions();
    expect((await h.scope())?.phase).toBe('ACTIVE');

    const removing = gate();
    h.ssh.afterWrite = () => removing.closed;
    const first = telegram(h, 'cb-1');
    await flush(() => h.ssh.writes.length === 2);
    expect((await telegram(h, 'cb-2')).status).toBe('MANUAL_RECONCILIATION_REQUIRED');
    expect((await telegram(h, 'cb-act-2', 'ACTIVATE')).status).toBe(
      'MANUAL_RECONCILIATION_REQUIRED',
    );
    for (let i = 0; i < 3; i++) await h.cycle({ [P.profileId]: HIGH });
    expect(h.ssh.writes).toHaveLength(2);
    delete h.ssh.afterWrite;
    removing.open();
    expect((await first).status).toBe('REMOVED_VERIFIED');
    expect(undoWrites(h)).toBe(1);
  });

  it('lock em memoria: quem desiste da fila nao libera o escopo para o proximo chamador', async () => {
    const lock = new InMemoryPolicyScopeLock({ timeoutMs: 0 });
    const scope = { deviceId: 'd', policyName: 'p' };
    const holder = gate();
    const running = lock.run(scope, () => holder.closed);
    await expect(lock.run(scope, async () => 'x')).rejects.toMatchObject({ code: 'POLICY_BUSY' });
    await expect(lock.run(scope, async () => 'y')).rejects.toMatchObject({ code: 'POLICY_BUSY' });
    holder.open();
    await running;
    await expect(lock.run(scope, async () => 'z')).resolves.toBe('z');
  });
});
