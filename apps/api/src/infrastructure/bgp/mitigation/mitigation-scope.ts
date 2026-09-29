import type { NetworkInterface } from '@gmj/shared';
import { parseBandwidthBpsFromDescription } from './bandwidth-parser';
import type { BandwidthSource } from './mitigation-types';

/**
 * Escopo da mitigação DDoS.
 *
 * A interface só entra no escopo quando ALIAS ou DESCRIPTION traz uma banda
 * explícita reconhecida pelo bandwidth-parser. O nome físico (`100GE0/1/48`),
 * o `speedBps` da porta e o ifIndex NUNCA são usados como banda contratada.
 *
 * Interface sem banda explícita simplesmente fica FORA do escopo — não existe
 * profile "BLOCKED" para ela.
 */

/** Mesmo token aceito pelo parser, usado apenas para remover o sufixo do nome. */
const BANDWIDTH_TOKEN = /(\d{1,3})\s*(?:GBPS|GB|G)\b/i;

export interface MitigationInterfaceScope {
  inScope: boolean;
  detectedBandwidthBps: bigint | null;
  bandwidthSource: BandwidthSource;
  /** Texto bruto (alias tem prioridade sobre description) que originou a banda. */
  descriptionRaw: string | null;
  /** Nome exibível do cliente, derivado de forma previsível e não destrutiva. */
  customerDisplayName: string | null;
}

const OUT_OF_SCOPE: MitigationInterfaceScope = {
  inScope: false,
  detectedBandwidthBps: null,
  bandwidthSource: 'UNKNOWN',
  descriptionRaw: null,
  customerDisplayName: null,
};

export function interfaceMitigationScope(
  networkInterface: Pick<NetworkInterface, 'alias' | 'description'>,
): MitigationInterfaceScope {
  for (const candidate of [networkInterface.alias, networkInterface.description]) {
    const raw = candidate?.trim();
    if (!raw) continue;
    const parsed = parseBandwidthBpsFromDescription(raw);
    if (parsed.bps === null) continue;
    return {
      inScope: true,
      detectedBandwidthBps: parsed.bps,
      bandwidthSource: parsed.source,
      descriptionRaw: raw,
      customerDisplayName: deriveCustomerDisplayName(raw),
    };
  }
  return OUT_OF_SCOPE;
}

/**
 * Remove apenas o token de banda e separadores à direita do texto original.
 * `HORIZONTE_IP_40GB` → `HORIZONTE_IP`; `CLIENTE_Z_40 Gbps` → `CLIENTE_Z`.
 * Nunca corta o nome em pedaços agressivos — se sobrar vazio, devolve `null`
 * e o texto original continua disponível em `descriptionRaw`.
 */
export function deriveCustomerDisplayName(raw: string): string | null {
  const withoutBandwidth = raw.replace(BANDWIDTH_TOKEN, ' ');
  const cleaned = withoutBandwidth
    .replace(/[\s_\-|/]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}
