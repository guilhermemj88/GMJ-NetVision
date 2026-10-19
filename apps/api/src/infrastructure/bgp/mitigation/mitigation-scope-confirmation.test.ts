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

  it('vincula a confirmacao ao chat/grupo de origem', () => {
    const { store } = build();
    const issue = store.issue(SCOPE, { requestedBy: 'telegram:42', chatId: '-100200' });

    const outroGrupo = store.consume(issue.token, SCOPE, { confirmedBy: 'telegram:42', chatId: '-999' });
    expect(outroGrupo.ok).toBe(false);
    if (!outroGrupo.ok) expect(outroGrupo.code).toBe('SCOPE_CONFIRMATION_CHAT_MISMATCH');

    const mesmoGrupo = store.consume(issue.token, SCOPE, { confirmedBy: 'telegram:42', chatId: '-100200' });
    expect(mesmoGrupo.ok).toBe(true);
    if (mesmoGrupo.ok) expect(mesmoGrupo.record.requestedBy).toBe('telegram:42');
  });

  it('nao reaproveita a pendencia emitida em outro chat', () => {
    const { store } = build();
    const primeiro = store.issue(SCOPE, { chatId: '-100200' });
    const outroChat = store.issue(SCOPE, { chatId: '-999' });
    expect(outroChat.token).not.toBe(primeiro.token);
    expect(store.size).toBe(2);
  });

  it('sem chat conhecido no pedido, o token nao fica preso a um grupo', () => {
    const { store } = build();
    const issue = store.issue(SCOPE);
    const consumed = store.consume(issue.token, SCOPE, { chatId: '-100200' });
    expect(consumed.ok).toBe(true);
  });

  it('revoga a confirmacao pendente e o token deixa de existir', () => {
    const { store } = build();
    const issue = store.issue(SCOPE, { chatId: '-100200' });

    const revoked = store.revoke(issue.token, { confirmedBy: 'telegram:42', chatId: '-100200' });
    expect(revoked.ok).toBe(true);
    expect(store.size).toBe(0);
    expect(store.peek(issue.token)).toBeNull();

    // Um `rmx:` antigo deixa de funcionar.
    const after = store.consume(issue.token, SCOPE);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.code).toBe('SCOPE_CONFIRMATION_TOKEN_UNKNOWN');
  });

  it('revogar de novo devolve TOKEN_UNKNOWN (idempotente)', () => {
    const { store } = build();
    const issue = store.issue(SCOPE);
    expect(store.revoke(issue.token).ok).toBe(true);
    const again = store.revoke(issue.token);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe('SCOPE_CONFIRMATION_TOKEN_UNKNOWN');
  });

  it('nao revoga confirmacao ja usada', () => {
    const { store } = build();
    const issue = store.issue(SCOPE);
    expect(store.consume(issue.token, SCOPE).ok).toBe(true);
    const revoked = store.revoke(issue.token);
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.code).toBe('SCOPE_CONFIRMATION_USED');
  });

  it('nao revoga confirmacao expirada', () => {
    const { store, advance } = build({ ttlMs: 60_000 });
    const issue = store.issue(SCOPE);
    advance(61_000);
    // Expirada ja e podada pelo store: o resultado e o mesmo de desconhecida.
    const revoked = store.revoke(issue.token);
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.code).toBe('SCOPE_CONFIRMATION_TOKEN_UNKNOWN');
    expect(store.consume(issue.token, SCOPE).ok).toBe(false);
  });

  it('nao revoga a partir de outro chat', () => {
    const { store } = build();
    const issue = store.issue(SCOPE, { chatId: '-100200' });
    const revoked = store.revoke(issue.token, { chatId: '-999' });
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.code).toBe('SCOPE_CONFIRMATION_CHAT_MISMATCH');

    // A confirmacao continua valida no chat de origem.
    expect(store.consume(issue.token, SCOPE, { chatId: '-100200' }).ok).toBe(true);
  });

  it('token emitido cabe no callback_data de 64 bytes do Telegram', () => {
    const store = new ScopeConfirmationStore();
    const issue = store.issue(SCOPE);
    // prefixo `rmx:`/`rmc:` + token precisa caber no limite do Telegram.
    expect(Buffer.byteLength('rmx:' + issue.token, 'utf8')).toBeLessThanOrEqual(64);
  });
});
