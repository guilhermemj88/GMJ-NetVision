/**
 * Cadencia e janela de continuidade do FAST embutido — FONTE UNICA.
 *
 * O coletor e o motor de decisao precisam concordar sobre o que e "amostra
 * continua". Antes desta fonte unica o poller usava `max(15 s; 1,5 x cadencia)`
 * enquanto a decisao AUTO usava 15 s fixos: com cadencia de 15 s a confirmacao
 * virava loteria e com 30 s nunca acontecia (fail-closed, mas a configuracao de
 * cadencia simplesmente nao valia para a decisao).
 *
 * Nada aqui afrouxa limites: a janela continua sendo 1,5 x cadencia e nunca
 * menor que 15 s — o valor exato do contrato publicado para 10 s.
 */

/** Piso de continuidade: com cadencia nominal de 10 s, a janela e exatamente 15 s. */
export const FAST_MIN_CONTINUITY_MS = 15_000;

/** Fator de folga sobre a cadencia (uma amostra perdida ainda e continua). */
export const FAST_CONTINUITY_FACTOR = 1.5;

/**
 * Faixa aceita para a cadencia nominal (segundos).
 *
 * 5 s foi homologado em bancada no Huawei NE8000 F1A (23 interfaces, 1.763
 * amostras, SNMP mediano 24 ms, zero gaps e zero overruns): a cadencia agressiva
 * e um valor operacional legitimo, nao um relaxamento de limite. O piso de
 * continuidade continua em 15 s, portanto 5 s entrega 3 amostras dentro da
 * mesma janela e a deteccao segue fail-closed.
 */
export const FAST_NORMAL_SECONDS = Object.freeze({
  min: 5,
  max: 30,
  fallback: 10,
});

/** Janela de continuidade/frescor derivada da cadencia real do coletor. */
export function fastContinuityWindowMs(normalIntervalMs: number): number {
  return Math.max(FAST_MIN_CONTINUITY_MS, Math.round(normalIntervalMs * FAST_CONTINUITY_FACTOR));
}

/**
 * Le `MITIGATION_FAST_NORMAL_SECONDS` com a MESMA validacao para todo mundo.
 * Valor invalido falha no boot (nunca cai silenciosamente para o default).
 */
export function readFastNormalIntervalMs(env: Record<string, string | undefined>): number {
  const raw = env.MITIGATION_FAST_NORMAL_SECONDS;
  if (raw === undefined) return FAST_NORMAL_SECONDS.fallback * 1000;
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < FAST_NORMAL_SECONDS.min || seconds > FAST_NORMAL_SECONDS.max) {
    throw new Error('Invalid MITIGATION_FAST_NORMAL_SECONDS');
  }
  return seconds * 1000;
}
