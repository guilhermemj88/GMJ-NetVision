import { describe, expect, it } from 'vitest';
import {
  LOCK_MIN_MS_BEFORE_WRITE,
  LOCK_POST_VERIFICATION_RESERVE_MS,
} from './mitigation-command-service';
import { AUTO_TICK_LOCK_TIMEOUT_MS, POLICY_SCOPE_LOCK_TIMEOUT_MS } from './mitigation-policy-lock';
import { DEFAULT_PHYSICAL_TIMING } from './mitigation-physical-verification';

/**
 * Os prazos de 240 s (lock de ESCOPO da policy) e 180 s (lock do TICK do motor) sao mecanismos diferentes.
 * Esta suite prova que cada valor cobre o pior caso do SEU mecanismo; mudar um numero sem refazer a conta falha aqui.
 */
describe('prazos dos locks: invariantes (nenhum valor alterado sem justificativa)', () => {
  const WORST_PRE_VERIFICATION_MS = 110_000; // SSH lento: preflight + escrita + read-back, medido/documentado
  const WORST_REMOVE_WRITE_MS = 25_000; // REMOVE medido ~22-25 s

  it('lock de escopo: pior caso pre-verificacao + verificacao fisica + reserva cabe com folga', () => {
    expect(POLICY_SCOPE_LOCK_TIMEOUT_MS).toBe(240_000);
    expect(
      WORST_PRE_VERIFICATION_MS + DEFAULT_PHYSICAL_TIMING.budgetMs + LOCK_POST_VERIFICATION_RESERVE_MS,
    ).toBeLessThanOrEqual(POLICY_SCOPE_LOCK_TIMEOUT_MS);
  });

  it('a margem exigida para escrever e atingivel mesmo apos um preflight lento (so recusa quando de fato nao cabe)', () => {
    expect(POLICY_SCOPE_LOCK_TIMEOUT_MS - WORST_PRE_VERIFICATION_MS).toBeGreaterThan(
      LOCK_MIN_MS_BEFORE_WRITE,
    );
    // REMOVE nao tem verificacao fisica longa: cabe sobrando
    expect(WORST_REMOVE_WRITE_MS + LOCK_MIN_MS_BEFORE_WRITE).toBeLessThan(POLICY_SCOPE_LOCK_TIMEOUT_MS);
  });

  it('lock do tick: o prazo e o do mecanismo do tick (180 s), menor que o do escopo e muito maior que a avaliacao', () => {
    expect(AUTO_TICK_LOCK_TIMEOUT_MS).toBe(180_000);
    expect(AUTO_TICK_LOCK_TIMEOUT_MS).toBeLessThan(POLICY_SCOPE_LOCK_TIMEOUT_MS);
    // O tick de 5 s so AVALIA (o ACTIVATE roda fora dele, em asyncExecution): folga de mais de 30x o periodo.
    expect(AUTO_TICK_LOCK_TIMEOUT_MS / 5_000).toBeGreaterThan(30);
  });
});
