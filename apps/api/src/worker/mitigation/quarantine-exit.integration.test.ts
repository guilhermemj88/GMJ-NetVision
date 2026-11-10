import { describe, expect, it } from 'vitest';
import { createAutoAllHarness } from '../../testing/auto-all-physical-harness';
import { InMemoryPolicyScopeLock } from '../../infrastructure/bgp/mitigation/mitigation-policy-lock';
import { MitigationPolicyReconciler } from '../../infrastructure/bgp/mitigation/mitigation-policy-reconciler';
import {
  QUARANTINE_RELEASE_MIN_AGE_MS,
  type JournalCommand,
  type ScopeOwnership,
} from './auto-lifecycle';
import type { OutboxEntry } from './durable-mitigation-outbox';
import { SINGLE_AUTO_PILOT as P } from './single-pilot-trigger';

/**
 * SAIDA DA QUARENTENA (executor manual, caminho de producao; so a borda SSH e falsa).
 *
 * Um comando com resultado fisico nao comprovado deixa o escopo em quarentena: nada e repetido
 * nem desfeito sozinho. A unica saida e a reconciliacao explicita do operador (preview + apply)
 * com DUAS provas frescas: policy lida NORMAL sem o par de nodes E efeito BGP desfeito (RT de
 * mitigacao fora das rotas do cliente, anuncio ao peer de mitigacao retirado).
 */

const HIGH = 9_400_000_000n;
const LOW = 300_000_000n;
type H = Awaited<ReturnType<typeof createAutoAllHarness>>;

const harness = async (options: Parameters<typeof createAutoAllHarness>[0] = {}) => {
  const h = await createAutoAllHarness({
    scopeLock: () => new InMemoryPolicyScopeLock({ timeoutMs: 0 }),
    ...options,
  });
  await h.cycle({});
  return h;
};
const flush = async (until: () => boolean) => {
  for (let i = 0; i < 200 && !until(); i++) await new Promise((r) => setTimeout(r, 0));
  expect(until()).toBe(true);
};
const command = (h: H, requestId: string, action: 'ACTIVATE' | 'REMOVE') =>
  h.commands.execute({ requestId, action, profileId: P.profileId });
const events = async (h: H) =>
  (await h.store.transaction((tx) => tx.list<OutboxEntry>('outbox'))).map((row) => row.event);
const runtime = async (h: H) => (await h.repository.getRuntime(P.profileId))?.state;
const journals = async (h: H) =>
  (await h.store.transaction((tx) => tx.list<JournalCommand>('command'))).map((j) => j.state);
const audits = (h: H) =>
  h.store.transaction((tx) =>
    tx.list<{ action: string; routingProof: string; reconciledCommands: string[] }>(
      'reconciliation',
    ),
  );
const capacityUsed = async (h: H) =>
  (
    await h.store.transaction((tx) =>
      tx.list<ScopeOwnership>('scope', ['ACTIVATING', 'ACTIVE', 'REMOVING', 'UNCERTAIN', 'MANUAL']),
    )
  ).length;
const undoWrites = (h: H) =>
  h.ssh.writes.filter((commands) => commands.some((line) => line.startsWith('undo '))).length;
const scopeOf = { deviceId: P.deviceId, policyName: P.policy };
const reconciler = (h: H, lock?: InMemoryPolicyScopeLock) =>
  new MitigationPolicyReconciler({
    beforeApply: (deviceId, policyName, proof) =>
      h.lifecycle.manualMutation(deviceId, policyName, proof),
    repository: h.repository,
    hosts: { getHost: async () => h.host },
    readPolicy: async () => h.ssh.readMitigationRoutePolicy(),
    restorationVerifier: (device, scope, customerPeers) =>
      h.live.verifyRestorationPhysical(device, { policyName: scope.policyName, customerPeers }),
    ...(lock ? { lock } : {}),
    now: () => new Date(h.now()),
  });
/** Fluxo do operador no painel: preview (leitura fresca) -> apply. */
async function reconcile(h: H, r = reconciler(h)) {
  try {
    const preview = await r.preview(scopeOf);
    return (await r.applyLocal(scopeOf, preview.previewId)).state as string;
  } catch (error) {
    return `REFUSED:${(error as Error).message}`;
  }
}
/** Retirada pelo CLI do operador: os nodes saem e o BGP volta ao normal. */
const cliRemove = (h: H) => {
  h.ssh.active = false;
};
/** ACTIVATE manual cujo resultado fisico NAO foi comprovado (commit feito). */
async function uncertainActivate(h: H, kind: 'session-lost' | 'unverified') {
  if (kind === 'session-lost') h.ssh.timeout = true;
  else h.ssh.physical.mode = 'not-advertised';
  const result = await command(h, 'e0-activate', 'ACTIVATE');
  h.ssh.timeout = false;
  h.ssh.physical.mode = 'ok';
  return result;
}

describe('quarentena depois de ACTIVATE nao comprovado', () => {
  it.each(['session-lost', 'unverified'] as const)(
    '1-6 (%s): commit feito, resultado incerto -> quarentena -> CLI -> ausencia + BGP provados -> liberado sem VERIFIED',
    async (kind) => {
      const h = await harness();
      const first = await uncertainActivate(h, kind);
      // 1. a escrita aconteceu e o resultado NAO e sucesso
      expect(h.ssh.writes).toHaveLength(1);
      expect(first).toMatchObject({ ok: false, verified: false });
      expect(await runtime(h)).toBe('RECONCILIATION_REQUIRED');
      expect(await journals(h)).toEqual(['UNCERTAIN']);
      // 2. quarentena: nenhuma nova escrita, nenhuma retirada automatica
      expect((await command(h, 'e0-remove', 'REMOVE')).status).toBe(
        'MANUAL_RECONCILIATION_REQUIRED',
      );
      expect((await command(h, 'e0-activate-b', 'ACTIVATE')).status).toBe(
        'MANUAL_RECONCILIATION_REQUIRED',
      );
      expect(await reconcile(h)).toContain('REFUSED:'); // par ainda no equipamento
      expect(h.ssh.writes).toHaveLength(1);
      expect(h.ssh.active).toBe(true);
      // 3. retirada fisica manual pelo CLI
      cliRemove(h);
      // 4-6. leitura nova: nodes ausentes + BGP restaurado -> liberado
      expect(await reconcile(h)).toBe('NORMAL');
      expect(await runtime(h)).toBe('NORMAL');
      expect(await journals(h)).toEqual(['RECONCILED']);
      expect(await events(h)).not.toContain('MITIGATION_VERIFIED');
      expect(await events(h)).not.toContain('MITIGATION_REMOVED_VERIFIED');
      const [audit] = await audits(h);
      expect(audit).toMatchObject({ action: 'RELEASE_WITHOUT_PHYSICAL_WRITE' });
      expect(audit!.routingProof).toContain('restauracao BGP PASS');
      expect(audit!.reconciledCommands).toHaveLength(1);
      expect(h.ssh.writes).toHaveLength(1); // a reconciliacao nunca escreve no equipamento
      // o executor manual volta a operar o ciclo completo
      expect((await command(h, 'e0-activate-2', 'ACTIVATE')).status).toBe('ACTIVATED_VERIFIED');
      expect((await command(h, 'e0-remove-2', 'REMOVE')).status).toBe('REMOVED_VERIFIED');
      expect(await runtime(h)).toBe('NORMAL');
    },
  );

  it('5: nodes ausentes no TEXTO, mas o BGP ainda mostra a mitigacao -> quarentena mantida', async () => {
    const h = await harness();
    await uncertainActivate(h, 'unverified');
    // a policy ja e lida sem os nodes 1 e 2, mas as rotas ainda carregam a RT 660
    const normalText = () =>
      [
        `route-policy ${P.policy} permit node 10`,
        ' if-match ip-prefix AGLINK-BLOCO-TODO-23',
        ' apply local-preference 1100',
        ' apply extcommunity rt 268568:140 additive',
        `route-policy ${P.policy} deny node 1000`,
      ].join('\n');
    const realConfig = h.ssh.config.bind(h.ssh);
    h.ssh.config = normalText;
    const refused = await reconcile(h);
    expect(refused).toContain('RECONCILIATION_ROUTING_NOT_RESTORED');
    expect(refused).toContain('268568:660');
    expect(await runtime(h)).toBe('RECONCILIATION_REQUIRED');
    expect(await journals(h)).toEqual(['UNCERTAIN']);
    expect(await audits(h)).toHaveLength(0);
    // o BGP converge: agora libera
    h.ssh.config = realConfig;
    cliRemove(h);
    expect(await reconcile(h)).toBe('NORMAL');
  });

  it('8: falha de leitura (policy ou evidencia BGP) mantem a quarentena', async () => {
    const h = await harness();
    await uncertainActivate(h, 'unverified');
    cliRemove(h);
    h.ssh.readFails = true;
    expect(await reconcile(h)).toContain('REFUSED:');
    h.ssh.readFails = false;
    h.ssh.physical.mode = 'unreadable';
    expect(await reconcile(h)).toContain('RECONCILIATION_ROUTING_NOT_RESTORED');
    h.ssh.physical.mode = 'garbled-routing';
    expect(await reconcile(h)).toContain('RECONCILIATION_ROUTING_NOT_RESTORED');
    expect(await journals(h)).toEqual(['UNCERTAIN']);
    expect(await runtime(h)).toBe('RECONCILIATION_REQUIRED');
    h.ssh.physical.mode = 'ok';
    expect(await reconcile(h)).toBe('NORMAL');
  });

  it('sem verificador de restauracao, sem prova ou com estado diferente de NORMAL: nunca libera', async () => {
    const h = await harness();
    await uncertainActivate(h, 'unverified');
    cliRemove(h);
    const pass = async () => ({ outcome: 'PASS', summary: 'x' });
    const mutate = (proof?: Parameters<H['lifecycle']['manualMutation']>[2]) =>
      h.lifecycle.manualMutation(P.deviceId, P.policy, proof).then(
        () => 'RELEASED',
        (error: Error) => error.message,
      );
    expect(await mutate()).toBe('MANUAL_RECONCILIATION_REQUIRED');
    expect(await mutate({ state: 'NORMAL', pairPresent: false, readBack: '' })).toBe(
      'MANUAL_RECONCILIATION_REQUIRED',
    );
    for (const state of ['MITIGATED', 'RECONCILIATION_REQUIRED'])
      expect(await mutate({ state, pairPresent: false, readBack: '', restoration: pass })).toBe(
        'MANUAL_RECONCILIATION_REQUIRED',
      );
    expect(
      await mutate({ state: 'NORMAL', pairPresent: true, readBack: '', restoration: pass }),
    ).toBe('MANUAL_RECONCILIATION_REQUIRED');
    for (const outcome of ['FAIL', 'INCONCLUSIVE'])
      expect(
        await mutate({
          state: 'NORMAL',
          pairPresent: false,
          readBack: '',
          restoration: async () => ({ outcome, summary: 's' }),
        }),
      ).toContain('RECONCILIATION_ROUTING_NOT_RESTORED');
    expect(
      await mutate({
        state: 'NORMAL',
        pairPresent: false,
        readBack: '',
        restoration: async () => {
          throw Error('ssh');
        },
      }),
    ).toContain('RECONCILIATION_ROUTING_NOT_RESTORED');
    expect(await journals(h)).toEqual(['UNCERTAIN']);
  });
});

describe('comando possivelmente em execucao e concorrencia', () => {
  it('9: processo morre com o comando no Huawei; comando iniciado ha menos de 5 min mantem a quarentena', async () => {
    const h = await harness();
    h.ssh.afterWrite = () => new Promise<void>(() => undefined); // o processo "morre" aqui
    void command(h, 'e0-activate', 'ACTIVATE');
    await flush(() => h.ssh.writes.length === 1);
    expect(await journals(h)).toEqual(['STARTED']);
    delete h.ssh.afterWrite;
    await h.restart();
    expect((await command(h, 'e0-remove', 'REMOVE')).status).toBe('MANUAL_RECONCILIATION_REQUIRED');
    cliRemove(h);
    // ausencia e BGP ja provados, mas o comando STARTED e recente: pode estar em execucao
    expect(await reconcile(h)).toContain('MANUAL_RECONCILIATION_REQUIRED');
    h.advance(QUARANTINE_RELEASE_MIN_AGE_MS - 5_000);
    expect(await reconcile(h)).toContain('MANUAL_RECONCILIATION_REQUIRED');
    expect(await journals(h)).toEqual(['STARTED']);
    h.advance(10_000);
    expect(await reconcile(h)).toBe('NORMAL');
    expect(await journals(h)).toEqual(['RECONCILED']);
    expect(h.ssh.writes).toHaveLength(1);
  });

  it('9b: comando AINDA rodando sob o lock: a reconciliacao nem entra (policy ocupada)', async () => {
    const h = await harness();
    const lock = new InMemoryPolicyScopeLock({ timeoutMs: 0 });
    const running = lock.run(scopeOf, () => new Promise<void>(() => undefined));
    void running;
    await uncertainActivate(h, 'unverified');
    cliRemove(h);
    expect(await reconcile(h, reconciler(h, lock))).toContain('REFUSED:');
    expect(await journals(h)).toEqual(['UNCERTAIN']);
  });

  it('10: reconciliacoes concorrentes liberam UMA vez; comandos repetidos nao duplicam escrita', async () => {
    const h = await harness();
    const [a, b] = await Promise.all([
      command(h, 'e0-activate', 'ACTIVATE'),
      command(h, 'e0-activate', 'ACTIVATE'),
    ]);
    expect(h.ssh.writes).toHaveLength(1);
    expect([a.status, b.status]).toEqual(['ACTIVATED_VERIFIED', 'ACTIVATED_VERIFIED']);
    h.ssh.timeout = true;
    await command(h, 'e0-remove', 'REMOVE'); // retirada com resultado incerto
    h.ssh.timeout = false;
    expect((await command(h, 'e0-remove', 'REMOVE')).status).toBe('MANUAL_RECONCILIATION_REQUIRED');
    expect((await command(h, 'e0-remove-b', 'REMOVE')).status).toBe(
      'MANUAL_RECONCILIATION_REQUIRED',
    );
    expect(undoWrites(h)).toBe(1);
    // sem lock compartilhado (pior caso): as duas chegam ao lifecycle
    const results = await Promise.all([reconcile(h), reconcile(h), reconcile(h)]);
    expect(results).toEqual(['NORMAL', 'NORMAL', 'NORMAL']);
    expect(await audits(h)).toHaveLength(1);
    expect(await runtime(h)).toBe('NORMAL');
    // com o lock de producao (try-lock): uma entra, as outras sao recusadas
    const lock = new InMemoryPolicyScopeLock({ timeoutMs: 0 });
    const again = await Promise.all([
      reconcile(h, reconciler(h, lock)),
      reconcile(h, reconciler(h, lock)),
    ]);
    expect(again.filter((state) => state === 'NORMAL').length).toBeGreaterThanOrEqual(1);
    expect(await audits(h)).toHaveLength(1);
  });
});

describe('7: MAX_ACTIVE volta a permitir operacoes', () => {
  it('escopo incerto consome a capacidade AUTO; depois da reconciliacao ela e devolvida', async () => {
    const h = await harness();
    await h.cycle({});
    h.ssh.physical.mode = 'not-advertised';
    for (let i = 0; i < 3; i++) await h.cycle({ [P.profileId]: HIGH });
    h.ssh.physical.mode = 'ok';
    expect(h.ssh.writes).toHaveLength(1);
    expect((await h.scope())?.phase).toBe('UNCERTAIN');
    expect(await capacityUsed(h)).toBe(1); // MAX_ACTIVE=1: AUTO bloqueado para todos
    for (let i = 0; i < 4; i++) await h.cycle({ [P.profileId]: HIGH });
    expect(h.ssh.writes).toHaveLength(1); // nada e repetido nem desfeito sozinho
    cliRemove(h);
    expect(await reconcile(h)).toBe('NORMAL');
    expect(await capacityUsed(h)).toBe(0);
    expect(await h.scope()).toMatchObject({
      phase: 'COOLDOWN',
      reason: 'EXPLICIT_MANUAL_RELEASE_RECONCILED',
    });
    // dentro do cooldown e sem episodio novo o AUTO nao reativa
    for (let i = 0; i < 4; i++) await h.cycle({ [P.profileId]: HIGH });
    expect(h.ssh.writes).toHaveLength(1);
    // episodio novo depois do cooldown: a operacao volta a ser possivel
    for (let i = 0; i < 4; i++) await h.cycle({ [P.profileId]: LOW });
    h.advance(h.lcConfig.cooldownMs + 60_000);
    for (let i = 0; i < 3; i++) await h.cycle({});
    for (let i = 0; i < 4; i++) await h.cycle({ [P.profileId]: HIGH });
    expect(h.ssh.writes).toHaveLength(2);
    expect((await h.scope())?.phase).toBe('ACTIVE');
    expect(await events(h)).toContain('MITIGATION_VERIFIED');
  });
});

describe('lock em memoria (demo/testes)', () => {
  it('quem desiste da fila nao libera o escopo para o proximo chamador', async () => {
    const lock = new InMemoryPolicyScopeLock({ timeoutMs: 0 });
    let open!: () => void;
    const holder = new Promise<void>((resolve) => {
      open = resolve;
    });
    const running = lock.run(scopeOf, () => holder);
    await expect(lock.run(scopeOf, async () => 'x')).rejects.toMatchObject({ code: 'POLICY_BUSY' });
    await expect(lock.run(scopeOf, async () => 'y')).rejects.toMatchObject({ code: 'POLICY_BUSY' });
    open();
    await running;
    await expect(lock.run(scopeOf, async () => 'z')).resolves.toBe('z');
  });
});
