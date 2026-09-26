import type { BgpAddressFamily, BgpAdvertisedRouteDto, BgpRouteOrigin } from '@gmj/shared';
import { computeLocalPrepend, normalizeIpAddress } from '@gmj/shared';

export interface ParsedHuaweiAdvertisedRoutes {
  routes: BgpAdvertisedRouteDto[];
  /** Total explicitly printed by the CLI, or null when the device omits it. */
  reportedTotal: number | null;
  /** Non-fatal problems. Ambiguous rows are warned about, never guessed. */
  warnings: string[];
}

export interface HuaweiAdvertisedRoutesParseOptions {
  /** Local ASN of the BGP process; only used for `prependLocal`. */
  localAs: string | number | bigint | null;
  /** Expected family of the peer, used to reject a mismatched prefix. */
  addressFamily?: BgpAddressFamily;
}

/**
 * VRP prints one block per announced prefix:
 *
 * ```
 *  BGP routing table entry information of 45.5.248.0/23:
 *  From: 200.194.223.86 (10.200.201.18)
 *  Route Duration: 0000h02m21s
 *  Direct Out-interface: 100GE1/0/3
 *  Original nexthop: 200.194.223.86
 *  Qos information : 0x0
 *  AS-path 268568 271034, origin igp, MED 1, pref-val 0, valid, external, pre 255
 * ```
 */
const BLOCK_HEADER =
  /(?:BGP\s+)?routing[-\s]?table\s+entry\s+information\s+of\s+([0-9a-fA-F:.]+)\s*\/\s*(\d{1,3})/i;

const NEXT_HOP_KEYS = /(?:original\s+next-?hop|next-?hop)\s*[:=]\s*(\S+)/i;
const AS_PATH_KEY = /AS-?path\b/i;
const ORIGIN_KEY = /\borigin\s*[:=]?\s*([A-Za-z?]+)/i;
const MED_KEY = /\bMED\s*[:=]?\s*(\d+)/i;
const LOCAL_PREF_KEY = /\b(?:local|loc)-?pref(?:erence)?\s*[:=]?\s*(\d+)/i;
const PREF_VAL_KEY = /\bpref-?val(?:ue)?\s*[:=]?\s*(\d+)/i;
const ASN_TOKEN = /^(?:\d+(?:\.\d+)?|\{[^}]*\})$/;
/** Backspace (U+0008) left by some VRP shells when echoing over SSH. */
const BACKSPACE = String.fromCharCode(8);

/** Ordered by specificity: the first match wins. */
const REPORTED_TOTAL_KEYS = [
  /Total\s+number\s+of\s+routes\s*[:=]?\s*(\d+)/i,
  /Total\s+routes\s+of\s+this\s+peer\s*[:=]?\s*(\d+)/i,
  /Total\s+prefix(?:es)?\s*[:=]?\s*(\d+)/i,
  /Total\s+routes\s*[:=]?\s*(\d+)/i,
];
/**
 * Route-Distinguisher scoped total: only used when nothing more specific
 * exists. The RD itself contains colons (`0:0`), so the count is anchored to
 * the end of the line instead of the first colon.
 */
const REPORTED_TOTAL_RD = /Total\s+routes\s+of\s+Route\s+Distinguisher\b[^\n]*:\s*(\d+)\s*$/gim;

function stripNoise(output: string): string[] {
  return output
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.split(BACKSPACE).join('').trimEnd())
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (/^-+\s*more\s*-+$/i.test(trimmed)) return false;
      // Device prompts left in the captured shell output.
      return !/^[<[][^>\]]{1,64}[>\]]$/.test(trimmed);
    });
}

/** Cuts at the first comma that is not inside an AS_SET (`{a,b}`). */
function cutAtTopLevelComma(text: string): string {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{') depth += 1;
    else if (char === '}') depth = Math.max(0, depth - 1);
    else if (char === ',' && depth === 0) return text.slice(0, index);
  }
  return text;
}

/**
 * Reads the AS-PATH tokens that come right after the `AS-path` keyword. The
 * scan stops at the first token that cannot be an ASN or an AS_SET, so a
 * differing attribute order in another VRP version never leaks into the path.
 */
function extractAsPath(attributeText: string): string[] {
  const head = cutAtTopLevelComma(attributeText)
    .replace(/\s+origin\b[\s\S]*$/i, '')
    .trim();
  if (!head) return [];

  const path: string[] = [];
  let openSet: string | null = null;
  for (const token of head.split(/\s+/).filter(Boolean)) {
    if (openSet !== null) {
      openSet = `${openSet} ${token}`;
      if (token.includes('}')) {
        path.push(openSet.replace(/\s+/g, ''));
        openSet = null;
      }
      continue;
    }
    if (token.startsWith('{') && !token.includes('}')) {
      openSet = token;
      continue;
    }
    if (ASN_TOKEN.test(token)) {
      path.push(token);
      continue;
    }
    break;
  }
  return path;
}

export function parseHuaweiBgpOrigin(value: string | null | undefined): BgpRouteOrigin | null {
  const token = value?.trim().toLowerCase() ?? '';
  if (token === 'i' || token === 'igp') return 'i';
  if (token === 'e' || token === 'egp') return 'e';
  if (token === '?' || token === 'incomplete') return '?';
  return null;
}

function parsePrefix(
  address: string,
  length: string,
  expected: BgpAddressFamily | undefined,
): { prefix: string; addressFamily: BgpAddressFamily } | null {
  const normalized = normalizeIpAddress(address);
  if (!normalized) return null;
  const bits = Number(length);
  const family: BgpAddressFamily = normalized.includes(':') ? 'IPV6' : 'IPV4';
  const maxBits = family === 'IPV6' ? 128 : 32;
  if (!Number.isInteger(bits) || bits < 0 || bits > maxBits) return null;
  if (expected && expected !== family) return null;
  return { prefix: `${normalized}/${bits}`, addressFamily: family };
}

function extractReportedTotal(lines: string[]): { total: number | null; warning: string | null } {
  const joined = lines.join('\n');
  for (const pattern of REPORTED_TOTAL_KEYS) {
    const match = pattern.exec(joined);
    if (match) {
      const value = Number(match[1]);
      return { total: Number.isSafeInteger(value) ? value : null, warning: null };
    }
  }

  const rdTotals = new Set<number>();
  for (const match of joined.matchAll(REPORTED_TOTAL_RD)) {
    const value = Number(match[1]);
    if (Number.isSafeInteger(value)) rdTotals.add(value);
  }
  if (rdTotals.size === 0) return { total: null, warning: null };
  if (rdTotals.size > 1) {
    return {
      total: null,
      warning:
        'A CLI reportou totais diferentes por Route Distinguisher; o total reportado foi omitido.',
    };
  }
  return { total: [...rdTotals][0] ?? null, warning: null };
}

/**
 * Parses `display bgp routing-table peer <PEER> advertised-routes` for IPv4 and
 * `display bgp ipv6 routing-table peer <PEER> advertised-routes` for IPv6.
 *
 * Tolerance is intentional: missing columns, wrapped lines, extra attributes
 * and different (compatible) header wording are all accepted. Anything that
 * cannot be interpreted produces a warning or is dropped — never a value the
 * device did not print.
 */
export function parseHuaweiAdvertisedRoutes(
  output: string,
  options: HuaweiAdvertisedRoutesParseOptions,
): ParsedHuaweiAdvertisedRoutes {
  const localAs = options.localAs === null || options.localAs === undefined ? null : String(options.localAs);
  const warnings: string[] = [];
  const lines = stripNoise(output ?? '');

  if (lines.length === 0) {
    return {
      routes: [],
      reportedTotal: null,
      warnings: ['A consulta não retornou saída do equipamento.'],
    };
  }

  const blocks: Array<{ prefix: string; addressFamily: BgpAddressFamily; body: string[] }> = [];
  let current: { prefix: string; addressFamily: BgpAddressFamily; body: string[] } | null = null;
  for (const line of lines) {
    const header = BLOCK_HEADER.exec(line);
    if (header) {
      const parsed = parsePrefix(header[1] ?? '', header[2] ?? '', options.addressFamily);
      if (!parsed) {
        warnings.push(`Cabeçalho de rota ignorado (prefixo inválido ou de outra família): ${line.trim()}`);
        current = null;
        continue;
      }
      current = { prefix: parsed.prefix, addressFamily: parsed.addressFamily, body: [] };
      blocks.push(current);
      continue;
    }
    if (current) current.body.push(line.trim());
  }

  const { total: reportedTotal, warning: totalWarning } = extractReportedTotal(lines);
  if (totalWarning) warnings.push(totalWarning);

  if (blocks.length === 0) {
    // A CLI that explicitly says "0 routes" is a legitimate empty answer, not a
    // parsing failure: only an unrecognized output deserves a warning.
    if (reportedTotal === 0) return { routes: [], reportedTotal, warnings };
    warnings.push('Formato da saída não reconhecido: nenhum prefixo anunciado foi interpretado.');
    return { routes: [], reportedTotal, warnings };
  }

  const routes: BgpAdvertisedRouteDto[] = [];
  for (const block of blocks) {
    const body = block.body.join(' ').replace(/\s+/g, ' ').trim();

    const nextHopRaw = NEXT_HOP_KEYS.exec(body)?.[1] ?? null;
    const nextHop = nextHopRaw ? normalizeIpAddress(nextHopRaw) : null;
    if (nextHopRaw && !nextHop) {
      warnings.push(`Next-hop não reconhecido em ${block.prefix}: ${nextHopRaw}`);
    }

    const asPathKey = AS_PATH_KEY.exec(body);
    let asPath: string[] = [];
    let attributeText = '';
    if (asPathKey?.index !== undefined) {
      attributeText = body.slice(asPathKey.index + asPathKey[0].length);
      asPath = extractAsPath(attributeText);
      if (asPath.length === 0) {
        warnings.push(`AS-PATH não interpretável em ${block.prefix}.`);
      }
    } else {
      warnings.push(`Rota ${block.prefix} sem linha de AS-PATH; atributos ficaram nulos.`);
    }

    const originToken = ORIGIN_KEY.exec(attributeText)?.[1] ?? null;
    const origin = parseHuaweiBgpOrigin(originToken);
    if (originToken && origin === null) {
      warnings.push(`Origem não reconhecida em ${block.prefix}: ${originToken}`);
    }

    const med = MED_KEY.exec(attributeText)?.[1];
    const localPreference = LOCAL_PREF_KEY.exec(attributeText)?.[1];
    const preferredValue = PREF_VAL_KEY.exec(attributeText)?.[1];

    routes.push({
      prefix: block.prefix,
      nextHop,
      med: med === undefined ? null : Number(med),
      localPreference: localPreference === undefined ? null : Number(localPreference),
      preferredValue: preferredValue === undefined ? null : Number(preferredValue),
      asPath,
      origin,
      prependLocal: computeLocalPrepend(asPath, localAs),
    });
  }

  if (reportedTotal !== null && routes.length !== reportedTotal) {
    warnings.push(
      `A CLI reportou ${reportedTotal} rota(s) e ${routes.length} foram interpretadas; linhas ambíguas foram ignoradas.`,
    );
  }

  return { routes, reportedTotal, warnings };
}
