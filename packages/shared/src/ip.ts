export type IpAddressFamily = 'IPV4' | 'IPV6';

const IPV4_EXACT = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * IPv6 canonicalisation deliberately delegates to the WHATWG URL parser: both
 * Node and browsers ship the same spec-defined IPv6 serialisation algorithm
 * (lower-case hex, no leading zeros, longest zero run compressed). Equivalent
 * forms such as `2001:0db8::1`, `2001:DB8:0:0:0:0:0:1` and `[2001:db8::1]`
 * therefore collapse into the same persisted peer key, without a hand-written
 * parser.
 */
export function normalizeIpv6(value: string | null | undefined): string | null {
  const trimmed = value?.trim().replace(/^\[|\]$/g, '');
  if (!trimmed || !trimmed.includes(':')) return null;
  try {
    const { hostname } = new URL(`http://[${trimmed}]/`);
    if (!hostname.startsWith('[') || !hostname.endsWith(']')) return null;
    return hostname.slice(1, -1).toLowerCase();
  } catch {
    return null;
  }
}

export function normalizeIpv4(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const match = IPV4_EXACT.exec(trimmed);
  if (!match) return null;
  const octets = match.slice(1, 5).map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet > 255)) return null;
  return octets.join('.');
}

export function isIpv4Address(value: string | null | undefined): boolean {
  return normalizeIpv4(value) !== null;
}

export function isIpv6Address(value: string | null | undefined): boolean {
  return normalizeIpv6(value) !== null;
}

export function ipAddressFamily(value: string | null | undefined): IpAddressFamily | null {
  if (normalizeIpv4(value) !== null) return 'IPV4';
  if (normalizeIpv6(value) !== null) return 'IPV6';
  return null;
}

/** Returns the canonical form of an IPv4 or IPv6 address, or null when invalid. */
export function normalizeIpAddress(value: string | null | undefined): string | null {
  const ipv4 = normalizeIpv4(value);
  if (ipv4 !== null) return ipv4;
  return normalizeIpv6(value);
}
