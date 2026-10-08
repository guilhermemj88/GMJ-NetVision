/**
 * EtherLike-MIB (RFC 3635) — erros de FCS/CRC por interface.
 *
 * `dot3StatsIndex` e, por definicao da RFC, o `ifIndex` da interface; a
 * correlacao e feita pelo sufixo do OID, igual ao restante do IF-MIB.
 */
export const ETHERLIKE_FCS_OIDS = {
  /** dot3HCStatsFCSErrors — Counter64 (preferido em interfaces de alta velocidade). */
  hcFcsErrors: '1.3.6.1.2.1.10.7.11.1.2',
  /** dot3StatsFCSErrors — Counter32 (fallback da EtherLike classica). */
  fcsErrors: '1.3.6.1.2.1.10.7.2.1.3',
} as const;
