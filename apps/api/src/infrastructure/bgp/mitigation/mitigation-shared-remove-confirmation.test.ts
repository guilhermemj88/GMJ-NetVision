import { describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { InMemoryMitigationRepository } from './in-memory-mitigation-repository';
import { MitigationCommandService } from './mitigation-command-service';
import { MockMitigationExecutor } from './mitigation-executor';
import { DEFAULT_BOGON_PREFIX_LIST, DEFAULT_TARGET_PREFIX_LIST } from './mitigation-planner';
import { ScopeConfirmationStore } from './mitigation-scope-confirmation';
import type { MitigationExecutor } from './mitigation-executor';

// FLUXO TELEGRAM/n8n -> API -> Huawei SIMULADO.
//
// Dois clientes compartilham a MESMA route-policy fisica (caso real BHNET:
// Eth-Trunk1.3043 / Eth-Trunk1.3044, PL-BHNET_IPv4-IN, nodes 1/2, RT 268568:660).
// A retirada manual atinge o escopo inteiro e exige confirmacao vinculada.

const POLICY = 'PL-BHNET_IPv4-IN';
const RT = '268568:660';
const DEVICE = 'host-bhnet';

async function build() {
  const repository = new InMemoryMitigationRepository();
  const executor = new MockMitigationExecutor();
  // Nodes que NAO pertencem a mitigacao precisam sobreviver ao REMOVE.
  executor.seedNode(POLICY, 11, { action: 'permit', ifMatchIpPrefix: ['OUTRA-LISTA'] });
  executor.seedNode(POLICY, 1, { action: 'deny', ifMatchIpPrefix: [DEFAULT_BOGON_PREFIX_LIST] });
  executor.seedNode(POLICY, 2, {
    action: 'permit',
    ifMatchIpPrefix: [DEFAULT_TARGET_PREFIX_LIST],
    routeTargets: [RT],
  });

  const p1 = await repository.upsertProfile({
    deviceId: DEVICE,
    policyName: POLICY,
    interfaceId: 'if-3043',
    addressFamily: 'IPV4',
    detectedBandwidthBps: 300_000_000_000n,
    bandwidthSource: 'DESCRIPTION',
    prefixLimit: 100,
    mode: 'AUTO',
    mitigationRt: RT,
  });
  await repository.replaceProfilePeers(p1.id, [{ peerAddress: '10.200.200.222', primary: true }]);
  await repository.upsertRuntime(p1.id, {
    state: 'MITIGATED',
    plannedBogonNode: 1,
    plannedMitigationNode: 2,
    plannedNode: 2,
    triggerCounter: 3,
    recoveryCounter: 2119,
  });

  const p2 = await repository.upsertProfile({
    deviceId: DEVICE,
    policyName: POLICY,
    interfaceId: 'if-3044',
    addressFamily: 'IPV4',
    detectedBandwidthBps: 300_000_000_000n,
    bandwidthSource: 'DESCRIPTION',
    prefixLimit: 100,
    mode: 'AUTO',
    mitigationRt: RT,
  });
  await repository.replaceProfilePeers(p2.id, [{ peerAddress: '10.200.200.226', primary: true }]);
  await repository.upsertRuntime(p2.id, {
    state: 'MITIGATED',
    plannedBogonNode: 1,
    plannedMitigationNode: 2,
    plannedNode: 2,
    triggerCounter: 0,
    recoveryCounter: 106,
  });

  let clock = Date.parse('2026-10-19T12:40:00.000Z');
  const onScopeRemoved = vi.fn();
  const store = new ScopeConfirmationStore({
    now: () => new Date(clock),
    ttlMs: 10 * 60_000,
  });
  const commands = new MitigationCommandService({
    repository,
    hosts: {
      getHost: async () => HOST,
    },
    executor,
    onScopeRemoved,
    scopeConfirmations: store,
    now: () => new Date(clock),
    scopeConfirmationTtlMs: 10 * 60_000,
  });

  return {
    repository,
    executor,
    commands,
    store,
    p1: p1.id,
    p2: p2.id,
    onScopeRemoved,
    advance: (ms: number) => (clock += ms),
  };
}

/** Host com as interfaces do escopo: a mensagem do Telegram usa o NOME. */
const HOST = {
  id: DEVICE,
  hostname: 'BHE-VTA-F1A-BGP-01',
  displayName: 'BHE-VTA-F1A-BGP-01',
  interfaces: [
    { id: 'if-3043', name: 'Eth-Trunk1.3043', description: 'BHNET-CEASA' },
    { id: 'if-3044', name: 'Eth-Trunk1.3044', description: 'BHNET-RBN' },
  ],
} as unknown as HostRecord;

function undoCount(executor: MockMitigationExecutor): number {
  return executor.calls.filter((call) => call.startsWith('undo route-policy')).length;
}

describe('retirada manual em policy compartilhada', () => {
  it('solicitacao sem confirmacao devolve a lista completa e um token', async () => {
    const h = await build();
    const blocked = await h.commands.execute({
      requestId: 'telegram-1',
      action: 'REMOVE',
      profileId: h.p1,
    });

    expect(blocked.ok).toBe(false);
    expect(blocked.status).toBe('SCOPE_CONFIRMATION_REQUIRED');
    expect(blocked.removalScope?.policy).toBe(POLICY);
    expect(blocked.removalScope?.affected).toHaveLength(1);
    expect(blocked.removalScope?.affected[0]).toMatchObject({
      profileId: h.p2,
      interfaceName: 'Eth-Trunk1.3044',
      peerAddress: '10.200.200.226',
      runtimeState: 'MITIGATED',
    });
    expect(blocked.scopeConfirmation?.required).toBe(true);
    expect(blocked.scopeConfirmation?.token).toBeTruthy();
    expect(blocked.scopeConfirmation?.expiresAt).toBeTruthy();
    // Nada foi escrito: o gate e anterior ao preflight.
    expect(h.executor.calls).toEqual([]);
  });

  it('a solicitacao pode partir de QUALQUER um dos perfis', async () => {
    const h = await build();
    const fromP2 = await h.commands.execute({
      requestId: 'telegram-2',
      action: 'REMOVE',
      profileId: h.p2,
    });
    expect(fromP2.status).toBe('SCOPE_CONFIRMATION_REQUIRED');
    expect(fromP2.removalScope?.affected.map((item) => item.profileId)).toEqual([h.p1]);
    expect(fromP2.scopeConfirmation?.token).toBeTruthy();
  });

  it('cancelar nao executa nada', async () => {
    const h = await build();
    await h.commands.execute({ requestId: 'telegram-3', action: 'REMOVE', profileId: h.p1 });

    // Operador clica CANCELAR: nenhuma nova chamada e feita com o token.
    expect(h.executor.calls).toEqual([]);
    expect((await h.repository.getRuntime(h.p1))?.state).toBe('MITIGATED');
    expect((await h.repository.getRuntime(h.p2))?.state).toBe('MITIGATED');
  });

  it('confirmacao valida executa UMA retirada fisica e reconcilia os dois runtimes', async () => {
    const h = await build();
    const blocked = await h.commands.execute({
      requestId: 'telegram-4',
      action: 'REMOVE',
      profileId: h.p1,
    });
    const token = blocked.scopeConfirmation!.token!;
    expect(token).toBeTruthy();

    const removal = await h.commands.execute({
      requestId: 'telegram-4-confirm',
      action: 'REMOVE',
      profileId: h.p1,
      scopeConfirmationToken: token,
      confirmedBy: 'telegram:1434618946480210113',
    });

    expect(removal.ok).toBe(true);
    expect(removal.status).toBe('REMOVED_VERIFIED');
    expect(removal.verified).toBe(true);
    expect(removal.scopeConfirmation).toMatchObject({
      required: true,
      confirmedBy: 'telegram:1434618946480210113',
    });

    // Uma unica alteracao fisica: exatamente dois `undo` (o par BOGONS+mitigacao).
    expect(undoCount(h.executor)).toBe(2);
    expect(h.executor.calls.filter((call) => call === 'commit')).toHaveLength(1);

    // Nodes alheios a mitigacao preservados.
    const readBack = await h.executor.readRoutePolicy(POLICY);
    expect(readBack).toContain('node 11');
    expect(readBack).not.toContain('node 1\n');
    expect(readBack).not.toContain('route-policy ' + POLICY + ' deny node 1');

    // Runtime do escopo inteiro reconciliado.
    expect((await h.repository.getRuntime(h.p1))?.state).toBe('NORMAL');
    expect((await h.repository.getRuntime(h.p2))?.state).toBe('NORMAL');

    // Sequencia de gatilho zerada nos DOIS vinculos + motor avisado.
    for (const profileId of [h.p1, h.p2]) {
      const runtime = await h.repository.getRuntime(profileId);
      expect(runtime?.triggerCounter).toBe(0);
      expect(runtime?.recoveryCounter).toBe(0);
    }
    expect(h.onScopeRemoved).toHaveBeenCalledTimes(1);
    const scope = h.onScopeRemoved.mock.calls[0]?.[0] as { profileIds: string[] };
    expect([...scope.profileIds].sort()).toEqual([h.p1, h.p2].sort());
  });

  it('token reutilizado nao executa a retirada duas vezes', async () => {
    const h = await build();
    const blocked = await h.commands.execute({
      requestId: 't5',
      action: 'REMOVE',
      profileId: h.p1,
    });
    const token = blocked.scopeConfirmation!.token!;

    const first = await h.commands.execute({
      requestId: 't5-a',
      action: 'REMOVE',
      profileId: h.p1,
      scopeConfirmationToken: token,
    });
    expect(first.status).toBe('REMOVED_VERIFIED');
    const callsAfterFirst = h.executor.calls.length;

    const replay = await h.commands.execute({
      requestId: 't5-b',
      action: 'REMOVE',
      profileId: h.p1,
      scopeConfirmationToken: token,
    });
    expect(replay.ok).toBe(false);
    expect(replay.status).toBe('SCOPE_CONFIRMATION_USED');
    expect(h.executor.calls.length).toBe(callsAfterFirst);
  });

  it('confirmacao expirada exige nova solicitacao', async () => {
    const h = await build();
    const blocked = await h.commands.execute({
      requestId: 't6',
      action: 'REMOVE',
      profileId: h.p1,
    });
    h.advance(11 * 60_000);

    const expired = await h.commands.execute({
      requestId: 't6-a',
      action: 'REMOVE',
      profileId: h.p1,
      scopeConfirmationToken: blocked.scopeConfirmation!.token!,
    });
    expect(expired.status).toBe('SCOPE_CONFIRMATION_TOKEN_UNKNOWN');
    expect(h.executor.calls).toEqual([]);
  });

  it('confirmacao de um perfil nao autoriza a retirada do outro', async () => {
    const h = await build();
    const blocked = await h.commands.execute({
      requestId: 't7',
      action: 'REMOVE',
      profileId: h.p1,
    });

    const wrongProfile = await h.commands.execute({
      requestId: 't7-a',
      action: 'REMOVE',
      profileId: h.p2,
      scopeConfirmationToken: blocked.scopeConfirmation!.token!,
    });
    expect(wrongProfile.ok).toBe(false);
    expect(wrongProfile.status).toBe('SCOPE_CONFIRMATION_SCOPE_MISMATCH');
    expect(h.executor.calls).toEqual([]);
  });

  it('mudanca de membros do escopo invalida a confirmacao anterior', async () => {
    const h = await build();
    const blocked = await h.commands.execute({
      requestId: 't8',
      action: 'REMOVE',
      profileId: h.p1,
    });

    // Terceiro cliente entra na MESMA policy fisica depois da aprovacao.
    const p3 = await h.repository.upsertProfile({
      deviceId: DEVICE,
      policyName: POLICY,
      interfaceId: 'if-3065',
      addressFamily: 'IPV4',
      detectedBandwidthBps: 10_000_000_000n,
      bandwidthSource: 'DESCRIPTION',
      prefixLimit: 100,
      mitigationRt: RT,
    });
    await h.repository.replaceProfilePeers(p3.id, [{ peerAddress: '10.200.200.230', primary: true }]);
    await h.repository.upsertRuntime(p3.id, { state: 'MITIGATED' });

    const changed = await h.commands.execute({
      requestId: 't8-a',
      action: 'REMOVE',
      profileId: h.p1,
      scopeConfirmationToken: blocked.scopeConfirmation!.token!,
    });
    expect(changed.ok).toBe(false);
    expect(changed.status).toBe('SCOPE_CHANGED');
    // A resposta ja traz a lista atualizada (2 afetados) e um token novo.
    expect(changed.removalScope?.affected).toHaveLength(2);
    expect(changed.scopeConfirmation?.token).toBeTruthy();
    expect(changed.scopeConfirmation?.token).not.toBe(blocked.scopeConfirmation!.token!);
    expect(h.executor.calls).toEqual([]);
  });

  it('read-back sem efeito nao declara sucesso e vai para RECONCILIATION_REQUIRED', async () => {
    const h = await build();
    const blocked = await h.commands.execute({
      requestId: 't9',
      action: 'REMOVE',
      profileId: h.p1,
    });

    // Equipamento "nao aplicou" o comando: o read-back continua com o par.
    const ineffective: MitigationExecutor = {
      readRoutePolicy: (policyName) => h.executor.readRoutePolicy(policyName),
      activate: (input) => h.executor.activate(input),
      remove: async () => ({ output: 'timeout' }),
    };
    const commands = new MitigationCommandService({
      repository: h.repository,
      hosts: {
        getHost: async (id) =>
          ({ id, hostname: 'BHE-VTA-F1A-BGP-01', displayName: 'BHE-VTA-F1A-BGP-01' }) as unknown as HostRecord,
      },
      executor: ineffective,
      onScopeRemoved: h.onScopeRemoved,
      scopeConfirmations: h.store,
      now: () => new Date('2026-10-19T12:45:00.000Z'),
    });

    const result = await commands.execute({
      requestId: 't9-a',
      action: 'REMOVE',
      profileId: h.p1,
      scopeConfirmationToken: blocked.scopeConfirmation!.token!,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('REVALIDATION_FAILED');
    expect(result.verified).toBe(false);
    expect((await h.repository.getRuntime(h.p1))?.state).toBe('RECONCILIATION_REQUIRED');
    expect((await h.repository.getRuntime(h.p2))?.state).toBe('RECONCILIATION_REQUIRED');
  });

  it('bloqueio ANTES da escrita (preflight) nao consome a confirmacao', async () => {
    const h = await build();
    const blocked = await h.commands.execute({
      requestId: 't10',
      action: 'REMOVE',
      profileId: h.p1,
    });
    const token = blocked.scopeConfirmation!.token!;

    const live = {
      enabledFor: () => true,
      preflight: async () => ({
        ok: false,
        mode: 'REMOVE' as const,
        blockedReasons: ['ssh_readback_unavailable'],
        checks: [],
      }),
      activate: async () => ({ output: '' }),
      remove: async () => ({ output: '' }),
      readRoutePolicy: async () => '',
      resolveActivePair: async () => null,
    };
    const commands = new MitigationCommandService({
      repository: h.repository,
      hosts: {
        getHost: async (id) =>
          ({ id, hostname: 'BHE-VTA-F1A-BGP-01', displayName: 'BHE-VTA-F1A-BGP-01' }) as unknown as HostRecord,
      },
      executor: h.executor,
      live: live as never,
      onScopeRemoved: h.onScopeRemoved,
      scopeConfirmations: h.store,
      now: () => new Date('2026-10-19T12:46:00.000Z'),
    });

    const blockedByPreflight = await commands.execute({
      requestId: 't10-a',
      action: 'REMOVE',
      profileId: h.p1,
      scopeConfirmationToken: token,
    });
    expect(blockedByPreflight.ok).toBe(false);
    expect(blockedByPreflight.status).toBe('REVALIDATION_FAILED');
    // Nenhuma escrita chegou ao equipamento: o runtime nao muda e o token
    // continua valido para o operador tentar de novo dentro do prazo.
    expect((await h.repository.getRuntime(h.p1))?.state).toBe('MITIGATED');
    expect(h.store.peek(token)?.usedAtMs).toBeNull();

    const retry = await h.commands.execute({
      requestId: 't10-b',
      action: 'REMOVE',
      profileId: h.p1,
      scopeConfirmationToken: token,
    });
    expect(retry.status).toBe('REMOVED_VERIFIED');
    expect(h.store.peek(token)?.usedAtMs).not.toBeNull();
  });

  it('REMOVE sem escopo compartilhado continua simples (sem token)', async () => {
    const h = await build();
    await h.repository.upsertRuntime(h.p2, { state: 'NORMAL' });

    const result = await h.commands.execute({
      requestId: 't11',
      action: 'REMOVE',
      profileId: h.p1,
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe('REMOVED_VERIFIED');
    expect(result.scopeConfirmation).toBeUndefined();
    expect(result.removalScope).toBeUndefined();
  });

  it('falha de commit Huawei consome o token e deixa o escopo em reconciliacao', async () => {
    const h = await build();
    const blocked = await h.commands.execute({
      requestId: 't12',
      action: 'REMOVE',
      profileId: h.p1,
    });
    const token = blocked.scopeConfirmation!.token!;

    const failing: MitigationExecutor = {
      readRoutePolicy: (policyName) => h.executor.readRoutePolicy(policyName),
      activate: (input) => h.executor.activate(input),
      remove: async () => {
        throw new Error('SSH timeout durante o commit');
      },
    };
    const commands = new MitigationCommandService({
      repository: h.repository,
      hosts: {
        getHost: async (id) =>
          ({ id, hostname: 'BHE-VTA-F1A-BGP-01', displayName: 'BHE-VTA-F1A-BGP-01' }) as unknown as HostRecord,
      },
      executor: failing,
      onScopeRemoved: h.onScopeRemoved,
      scopeConfirmations: h.store,
      now: () => new Date('2026-10-19T12:47:00.000Z'),
    });

    const result = await commands.execute({
      requestId: 't12-a',
      action: 'REMOVE',
      profileId: h.p1,
      scopeConfirmationToken: token,
    });

    // Nunca sucesso falso: resultado desconhecido vira reconciliacao.
    expect(result.ok).toBe(false);
    expect(result.status).toBe('REVALIDATION_FAILED');
    expect(result.verified).toBe(false);
    expect((await h.repository.getRuntime(h.p1))?.state).toBe('RECONCILIATION_REQUIRED');
    expect((await h.repository.getRuntime(h.p2))?.state).toBe('RECONCILIATION_REQUIRED');

    // Escrita iniciada => token consumido (replay recebe USED, nao repete).
    expect(h.store.peek(token)?.usedAtMs).not.toBeNull();
    const replay = await commands.execute({
      requestId: 't12-b',
      action: 'REMOVE',
      profileId: h.p1,
      scopeConfirmationToken: token,
    });
    expect(replay.status).toBe('SCOPE_CONFIRMATION_USED');

    // A sequencia antiga do motor tambem e descartada.
    expect(h.onScopeRemoved).toHaveBeenCalled();
  });

  it('reinicio da API invalida confirmacoes pendentes (store em memoria)', async () => {    const h = await build();
    const blocked = await h.commands.execute({
      requestId: 't13',
      action: 'REMOVE',
      profileId: h.p1,
    });
    const token = blocked.scopeConfirmation!.token!;

    // Restart: nova instancia do servico com store vazio (nenhum estado em disco).
    const restarted = new MitigationCommandService({
      repository: h.repository,
      hosts: {
        getHost: async (id) =>
          ({ id, hostname: 'BHE-VTA-F1A-BGP-01', displayName: 'BHE-VTA-F1A-BGP-01' }) as unknown as HostRecord,
      },
      executor: h.executor,
      onScopeRemoved: h.onScopeRemoved,
      now: () => new Date('2026-10-19T12:48:00.000Z'),
    });
    expect(restarted.scopeConfirmationProfile(token)).toBeNull();

    const result = await restarted.execute({
      requestId: 't13-a',
      action: 'REMOVE',
      profileId: h.p1,
      scopeConfirmationToken: token,
    });

    // Fail-closed: sem confirmacao conhecida, nada chega ao equipamento.
    expect(result.ok).toBe(false);
    expect(result.status).toBe('SCOPE_CONFIRMATION_TOKEN_UNKNOWN');
    expect(result.scopeConfirmation?.token).toBeTruthy();
    expect(result.scopeConfirmation?.token).not.toBe(token);
    expect(h.executor.calls).toEqual([]);
    expect((await h.repository.getRuntime(h.p1))?.state).toBe('MITIGATED');
    expect((await h.repository.getRuntime(h.p2))?.state).toBe('MITIGATED');
  });

  it('cancelamento revoga o token e impede a confirmacao posterior', async () => {
    const h = await build();
    const blocked = await h.commands.execute({
      requestId: 't14',
      action: 'REMOVE',
      profileId: h.p1,
    });
    const token = blocked.scopeConfirmation!.token!;

    const revoke = h.commands.revokeScopeConfirmation(token, {
      confirmedBy: 'telegram:42',
      chatId: '-100200',
    });
    expect(revoke.ok).toBe(true);
    expect(revoke.status).toBe('SCOPE_CONFIRMATION_REVOKED');
    expect(h.store.peek(token)).toBeNull();

    const after = await h.commands.execute({
      requestId: 't14-b',
      action: 'REMOVE',
      profileId: h.p1,
      scopeConfirmationToken: token,
    });
    expect(after.ok).toBe(false);
    expect(after.status).toBe('SCOPE_CONFIRMATION_TOKEN_UNKNOWN');
    expect(h.executor.calls).toEqual([]);
    expect((await h.repository.getRuntime(h.p1))?.state).toBe('MITIGATED');
    expect((await h.repository.getRuntime(h.p2))?.state).toBe('MITIGATED');
  });
});
