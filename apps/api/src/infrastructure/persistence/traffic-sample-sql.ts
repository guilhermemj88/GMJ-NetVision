import { BASELINE_ONLY_RATE_BPS, COUNTER_RATE_TOLERANCE_RATIO } from '../snmp/traffic-rate';

/**
 * Predicado SQL da MESMA regra de validade de `traffic-rate.ts`, para os
 * leitores raw (LATERAL/SQL direto) escolherem o último sample **válido**.
 *
 * Os apelidos são fixos no código dos leitores (`m` = InterfaceMetricSample,
 * `i` = Interface), e todos os valores interpolados são constantes deste
 * módulo — nada vem de entrada do usuário.
 *
 * Efeito: a sentinela de rebase (-1) e spikes fisicamente impossíveis
 * (históricos, já persistidos) deixam de aparecer em current traffic, BGP,
 * mapa e mitigação. A linha de baseline continua visível para
 * `getLatestCounterSnapshots`, que NÃO usa este predicado.
 */
export const ACCEPTED_TRAFFIC_RATE_FACTOR = 1 + COUNTER_RATE_TOLERANCE_RATIO;

/**
 * Montagem em UMA linha por condição, com `AND` só entre as condições.
 *
 * Regressão (06/10): a versão anterior listava a abertura do parêntese
 * (`... OR (`) como item separado e fazia `.join(' AND ')`, gerando
 * `OR ( AND m."rxBps" ...` — `syntax error at or near "AND"` no Postgres, que
 * derrubava `loadLatestMetrics` e deixava o mapa vazio. O texto abaixo é
 * validado byte a byte em `traffic-sample-sql.test.ts`.
 */
export const USABLE_TRAFFIC_SAMPLE_SQL = [
  `m."rxBps" > ${BASELINE_ONLY_RATE_BPS}`,
  `m."txBps" > ${BASELINE_ONLY_RATE_BPS}`,
  `(i."speedBps" IS NULL OR i."speedBps" <= 0 OR (m."rxBps" <= i."speedBps" * ${ACCEPTED_TRAFFIC_RATE_FACTOR} AND m."txBps" <= i."speedBps" * ${ACCEPTED_TRAFFIC_RATE_FACTOR}))`,
].join(' AND ');
