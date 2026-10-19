import { describe, expect, it } from 'vitest';
import {
  ScopeConfirmationStore,
  scopeConfirmationHash,
  type ScopeConfirmationScope,
} from './mitigation-scope-confirmation';

const SCOPE: ScopeConfirmationScope = {
  deviceId: 'device-1',
  policyName: 'PL-BHNET_IPv4-IN',
  originProfileId: 'p-3043',
  affected: [
    { profileId: 'p-3044', runtimeState: 'MITIGATED' },
    { profileId: 'p-3043b', runtimeState: 'RECOVERY_PENDING' },
  ],
};

function build(options: { ttlMs?: number } = {}) {
  let clock = Date.parse('2026-10-19T12:40:00.000Z');
  let counter = 0;
  const store = new ScopeConfirmationStore({
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    now: () => new Date(clock),
    createToken: () => `token-${++counter}-abcdefghij`,
  });
  return { store, advance: (ms: number) => (clock += ms), nowMs: () => clock };
}

describe('confirmacao de escopo fisico', () => {
  it('hash e estavel e independente da ordem dos membros', () => {
    const a = scopeConfirmationHash(SCOPE);
    const b = scopeConfirmationHash({ ...SCOPE, affected: [...SCOPE.affected].reverse() });
    expect(a).toBe(b);
    expect(a).not.toBe(scopeConfirmationHash({ ...SCOPE, originProfileId: 'p-3044' }));
    expect(a).not.toBe(
      scopeConfirmationHash({
        ...SCOPE,
        affected: [{ profileId: 'p-3044', runtimeState: 'NORMAL' }],
      }),
    );
  });

  it('emite token de uso unico com prazo e escopo no hash', () => {
    const { store, nowMs } = build();
    const issue = store.issue(SCOPE);
    expect(issue.token).toMatch(/^token-/);
    expect(issue.scopeHash).toBe(scopeConfirmationHash(SCOPE));
    expect(Date.parse(issue.expiresAt)).toBe(nowMs() + issue.ttlMs);
    expect(store.size).toBe(1);
  });

  it('reaproveita a confirmacao pendente do MESMO escopo', () => {
    const { store } = build();
    const first = store.issue(SCOPE);
    const second = store.issue({ ...SCOPE, affected: [...SCOPE.affected].reverse() });
    expect(second.token).toBe(first.token);
    expect(store.size).toBe(1);
  });

  it('consome uma vez; replay recebe USED', () => {
    const { store } = build();
    const issue = store.issue(SCOPE);

    const first = store.consume(issue.token, SCOPE, { confirmedBy: 'telegram:42' });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.record.confirmedBy).toBe('telegram:42');
      expect(first.record.members.map((m) => m.profileId)).toEqual(['p-3043b', 'p-3044']);
    }

    const replay = store.consume(issue.token, SCOPE);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.code).toBe('SCOPE_CONFIRMATION_USED');
  });

  it('expira e nao aceita confirmacao vencida', () => {
    const { store, advance } = build({ ttlMs: 60_000 });
    const issue = store.issue(SCOPE);
    advance(61_000);

    const consumed = store.consume(issue.token, SCOPE);
    expect(consumed.ok).toBe(false);
    if (!consumed.ok) expect(consumed.code).toBe('SCOPE_CONFIRMATION_TOKEN_UNKNOWN');
  });

  it('rejeita token de outro escopo/perfil', () => {
    const { store } = build();
    const issue = store.issue(SCOPE);

    const other = store.consume(issue.token, { ...SCOPE, originProfileId: 'p-3044' });
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.code).toBe('SCOPE_CONFIRMATION_SCOPE_MISMATCH');

    const otherPolicy = store.consume(issue.token, { ...SCOPE, policyName: 'PL-OUTRA-IN' });
    expect(otherPolicy.ok).toBe(false);
    if (!otherPolicy.ok) expect(otherPolicy.code).toBe('SCOPE_CONFIRMATION_SCOPE_MISMATCH');
  });

  it('recusa quando a composicao do escopo mudou desde a aprovacao', () => {
    const { store } = build();
    const issue = store.issue(SCOPE);

    const changed = store.consume(issue.token, {
      ...SCOPE,
      affected: [...SCOPE.affected, { profileId: 'p-3065', runtimeState: 'MITIGATED' }],
    });
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.code).toBe('SCOPE_CHANGED');

    const stateChanged = store.consume(issue.token, {
      ...SCOPE,
      affected: [
        { profileId: 'p-3044', runtimeState: 'NORMAL' },
        { profileId: 'p-3043b', runtimeState: 'RECOVERY_PENDING' },
      ],
    });
    expect(stateChanged.ok).toBe(false);
    if (!stateChanged.ok) expect(stateChanged.code).toBe('SCOPE_CHANGED');
  });

  it('release devolve a confirmacao quando nada foi escrito', () => {
    const { store } = build();
    const issue = store.issue(SCOPE);

    const first = store.consume(issue.token, SCOPE);
    expect(first.ok).toBe(true);
    store.release(issue.token);

    const retry = store.consume(issue.token, SCOPE);
    expect(retry.ok).toBe(true);
  });

  it('token desconhecido e recusado', () => {
    const { store } = build();
    const consumed = store.consume('nao-existe', SCOPE);
    expect(consumed.ok).toBe(false);
    if (!consumed.ok) expect(consumed.code).toBe('SCOPE_CONFIRMATION_TOKEN_UNKNOWN');
  });
});
