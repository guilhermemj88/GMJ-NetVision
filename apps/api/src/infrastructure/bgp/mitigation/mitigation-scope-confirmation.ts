import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// CONFIRMACAO DE RETIRADA POR ESCOPO FISICO.
//
// A route-policy Huawei e um objeto POR EQUIPAMENTO: um REMOVE atinge todos os
// vinculos que a compartilham. O gate `SCOPE_CONFIRMATION_REQUIRED` ja existia,
// mas o canal do Telegram/n8n nao tinha como devolver uma confirmacao valida —
// um booleano solto (`acknowledgeScopeRemoval`) nao prova que o operador viu a
// lista, nem impede replay/aprovacao de outro perfil.
//
// Este modulo emite um token de uso UNICO, com prazo, vinculado a:
//   - escopo fisico (deviceId + policyName);
//   - perfil ORIGINADOR da solicitacao;
//   - composicao EXATA dos vinculos afetados (profileId + estado de runtime).
//
// A composicao entra no hash: se qualquer membro do escopo mudar entre a
// aprovacao e a execucao, a confirmacao deixa de valer (`SCOPE_CHANGED`).

export interface ScopeConfirmationMember {
  profileId: string;
  runtimeState: string;
}

/** Escopo no momento da emissao (ou da revalidacao antes da escrita). */
export interface ScopeConfirmationScope {
  deviceId: string;
  policyName: string;
  /** Perfil pelo qual o operador pediu a retirada. */
  originProfileId: string;
  /** Vinculos ATIVOS que tambem serao retirados (sem o originador). */
  affected: readonly ScopeConfirmationMember[];
}

export type ScopeConfirmationFailure =
  | 'SCOPE_CONFIRMATION_REQUIRED'
  | 'SCOPE_CONFIRMATION_TOKEN_UNKNOWN'
  | 'SCOPE_CONFIRMATION_EXPIRED'
  | 'SCOPE_CONFIRMATION_USED'
  | 'SCOPE_CONFIRMATION_SCOPE_MISMATCH'
  | 'SCOPE_CONFIRMATION_CHAT_MISMATCH'
  | 'SCOPE_CHANGED';

export interface ScopeConfirmationIssue {
  token: string;
  scopeHash: string;
  expiresAt: string;
  ttlMs: number;
}

/**
 * Contexto do solicitante. Nao entra no hash do escopo (que descreve o alvo
 * fisico), mas impede que a confirmacao emitida em um chat/grupo seja usada por
 * outro chat que recebeu o mesmo texto de botao.
 */
export interface ScopeConfirmationRequester {
  /** Operador que PEDIU a retirada (auditoria). */
  requestedBy?: string | null;
  /** Chat/grupo do Telegram onde a solicitacao foi exibida. */
  chatId?: string | null;
}

export interface ScopeConfirmationRecord extends ScopeConfirmationIssue {
  deviceId: string;
  policyName: string;
  originProfileId: string;
  members: ScopeConfirmationMember[];
  requestedBy: string | null;
  chatId: string | null;
  createdAtMs: number;
  expiresAtMs: number;
  usedAtMs: number | null;
  confirmedBy: string | null;
}

export type ScopeConfirmationConsumeResult =
  | { ok: true; record: ScopeConfirmationRecord }
  | { ok: false; code: ScopeConfirmationFailure; message: string };

export type ScopeConfirmationRevokeResult =
  | { ok: true; record: ScopeConfirmationRecord }
  | { ok: false; code: ScopeConfirmationFailure; message: string };

export interface ScopeConfirmationStoreOptions {
  ttlMs?: number;
  /** Teto de confirmacoes pendentes (as mais antigas expiram primeiro). */
  limit?: number;
  now?: () => Date;
  createToken?: () => string;
}

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_LIMIT = 200;

function canonicalMembers(members: readonly ScopeConfirmationMember[]): ScopeConfirmationMember[] {
  return [...members]
    .map((member) => ({ profileId: member.profileId, runtimeState: member.runtimeState }))
    .sort((left, right) => left.profileId.localeCompare(right.profileId));
}

/**
 * Hash canonico do escopo. Inclui o estado de runtime de cada membro: um vinculo
 * que sai de MITIGATED para NORMAL (ou entra em RECONCILIATION_REQUIRED) muda a
 * composicao e invalida a aprovacao anterior.
 */
export function scopeConfirmationHash(scope: ScopeConfirmationScope): string {
  const payload = JSON.stringify({
    deviceId: scope.deviceId,
    policyName: scope.policyName,
    originProfileId: scope.originProfileId,
    members: canonicalMembers(scope.affected),
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

function safeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Normaliza identificadores opcionais de solicitante (operador, chat/grupo). */
function normalizeRef(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed.slice(0, 120) : null;
}

/**
 * Store em memoria das confirmacoes pendentes.
 *
 * O processo da API de mitigacao e unico (UI + n8n + AUTO na mesma instancia).
 * Um restart perde as confirmacoes pendentes — o operador recebe
 * `SCOPE_CONFIRMATION_TOKEN_UNKNOWN` e precisa solicitar de novo (fail-closed).
 */
export class ScopeConfirmationStore {
  private readonly records = new Map<string, ScopeConfirmationRecord>();
  private readonly ttlMs: number;
  private readonly limit: number;
  private readonly now: () => Date;
  private readonly createToken: () => string;

  constructor(options: ScopeConfirmationStoreOptions = {}) {
    this.ttlMs = Math.max(1_000, options.ttlMs ?? DEFAULT_TTL_MS);
    this.limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
    this.now = options.now ?? (() => new Date());
    this.createToken = options.createToken ?? (() => randomBytes(18).toString('base64url'));
  }

  /** Emite (ou reaproveita) uma confirmacao pendente para o escopo atual. */
  issue(scope: ScopeConfirmationScope, requester: ScopeConfirmationRequester = {}): ScopeConfirmationIssue {
    this.prune();
    const scopeHash = scopeConfirmationHash(scope);
    const chatId = normalizeRef(requester.chatId);
    const requestedBy = normalizeRef(requester.requestedBy);
    const nowMs = this.now().getTime();
    for (const record of this.records.values()) {
      if (
        record.usedAtMs === null &&
        record.expiresAtMs > nowMs &&
        record.scopeHash === scopeHash &&
        record.deviceId === scope.deviceId &&
        record.policyName === scope.policyName &&
        record.originProfileId === scope.originProfileId &&
        record.chatId === chatId
      ) {
        return this.issueOf(record);
      }
    }
    const token = this.createToken();
    const record: ScopeConfirmationRecord = {
      token,
      scopeHash,
      deviceId: scope.deviceId,
      policyName: scope.policyName,
      originProfileId: scope.originProfileId,
      members: canonicalMembers(scope.affected),
      requestedBy,
      chatId,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + this.ttlMs,
      expiresAt: new Date(nowMs + this.ttlMs).toISOString(),
      ttlMs: this.ttlMs,
      usedAtMs: null,
      confirmedBy: null,
    };
    this.records.set(token, record);
    while (this.records.size > this.limit) {
      const oldest = [...this.records.values()].sort((a, b) => a.createdAtMs - b.createdAtMs)[0];
      if (!oldest) break;
      this.records.delete(oldest.token);
    }
    return this.issueOf(record);
  }

  /**
   * Valida e CONSOME a confirmacao contra o escopo RECALCULADO agora.
   *
   * Consome antes da escrita (uso unico). O chamador devolve o token com
   * `release` quando nada foi escrito (preflight bloqueado, policy ocupada).
   */
  consume(
    token: string,
    current: ScopeConfirmationScope,
    meta: { confirmedBy?: string | null; chatId?: string | null } = {},
  ): ScopeConfirmationConsumeResult {
    this.prune();
    const record = this.records.get(token);
    if (!record) {
      return {
        ok: false,
        code: 'SCOPE_CONFIRMATION_TOKEN_UNKNOWN',
        message: 'Confirmacao de escopo desconhecida ou expirada; solicite a retirada novamente',
      };
    }
    if (record.usedAtMs !== null) {
      return {
        ok: false,
        code: 'SCOPE_CONFIRMATION_USED',
        message: 'Esta confirmacao ja foi utilizada; solicite a retirada novamente',
      };
    }
    if (this.now().getTime() > record.expiresAtMs) {
      this.records.delete(token);
      return {
        ok: false,
        code: 'SCOPE_CONFIRMATION_EXPIRED',
        message: 'Confirmacao expirada; solicite a retirada novamente',
      };
    }
    if (
      record.deviceId !== current.deviceId ||
      record.policyName !== current.policyName ||
      record.originProfileId !== current.originProfileId
    ) {
      return {
        ok: false,
        code: 'SCOPE_CONFIRMATION_SCOPE_MISMATCH',
        message: 'Esta confirmacao pertence a outro perfil/escopo; solicite a retirada novamente',
      };
    }
    // Vinculo com o chat de origem: o botao nao vale em outro grupo, mesmo que
    // o texto seja encaminhado por um operador autorizado.
    const currentChatId = normalizeRef(meta.chatId);
    if (record.chatId !== null && currentChatId !== null && record.chatId !== currentChatId) {
      return {
        ok: false,
        code: 'SCOPE_CONFIRMATION_CHAT_MISMATCH',
        message: 'Esta confirmacao foi emitida em outro chat/grupo; solicite a retirada novamente',
      };
    }
    const currentHash = scopeConfirmationHash(current);
    if (!safeEquals(record.scopeHash, currentHash)) {
      return {
        ok: false,
        code: 'SCOPE_CHANGED',
        message:
          'O escopo compartilhado mudou desde a aprovacao; confirme novamente com a lista atualizada',
      };
    }
    record.usedAtMs = this.now().getTime();
    record.confirmedBy = normalizeRef(meta.confirmedBy);
    return { ok: true, record };
  }

  /** Devolve a confirmacao quando NENHUMA escrita chegou ao equipamento. */
  release(token: string): void {
    const record = this.records.get(token);
    if (record) record.usedAtMs = null;
  }

  /**
   * REVOGA a confirmacao pendente (cancelamento explicito do operador).
   *
   * Diferente de `release` (que devolve o token ao operador apos um bloqueio),
   * aqui o registro e REMOVIDO: o mesmo token deixa de existir e uma tentativa
   * posterior de confirmar cai em `SCOPE_CONFIRMATION_TOKEN_UNKNOWN`, sem
   * tocar no equipamento. Idempotente na pratica: revogar de novo devolve o
   * mesmo `TOKEN_UNKNOWN`.
   */
  revoke(
    token: string,
    meta: { confirmedBy?: string | null; chatId?: string | null } = {},
  ): ScopeConfirmationRevokeResult {
    this.prune();
    const record = this.records.get(token);
    if (!record) {
      return {
        ok: false,
        code: 'SCOPE_CONFIRMATION_TOKEN_UNKNOWN',
        message: 'Confirmacao desconhecida, expirada ou ja revogada',
      };
    }
    if (record.usedAtMs !== null) {
      return {
        ok: false,
        code: 'SCOPE_CONFIRMATION_USED',
        message: 'Esta confirmacao ja foi utilizada e nao pode ser revogada',
      };
    }
    if (this.now().getTime() > record.expiresAtMs) {
      this.records.delete(token);
      return {
        ok: false,
        code: 'SCOPE_CONFIRMATION_EXPIRED',
        message: 'Confirmacao expirada',
      };
    }
    const currentChatId = normalizeRef(meta.chatId);
    if (record.chatId !== null && currentChatId !== null && record.chatId !== currentChatId) {
      return {
        ok: false,
        code: 'SCOPE_CONFIRMATION_CHAT_MISMATCH',
        message: 'Esta confirmacao foi emitida em outro chat/grupo',
      };
    }
    this.records.delete(token);
    return { ok: true, record: { ...record, confirmedBy: normalizeRef(meta.confirmedBy) } };
  }

  /** Leitura de auditoria/teste (nunca exposta por HTTP). */
  peek(token: string): ScopeConfirmationRecord | null {
    const record = this.records.get(token);
    return record ? { ...record, members: [...record.members] } : null;
  }

  prune(): void {
    const nowMs = this.now().getTime();
    for (const [token, record] of this.records) {
      // Confirmacoes usadas permanecem ate expirarem: o replay deve receber
      // `SCOPE_CONFIRMATION_USED`, nao "desconhecida".
      if (nowMs > record.expiresAtMs) this.records.delete(token);
    }
  }

  get size(): number {
    this.prune();
    return this.records.size;
  }

  private issueOf(record: ScopeConfirmationRecord): ScopeConfirmationIssue {
    return {
      token: record.token,
      scopeHash: record.scopeHash,
      expiresAt: record.expiresAt,
      ttlMs: record.ttlMs,
    };
  }
}
