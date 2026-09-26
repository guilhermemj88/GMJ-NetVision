import type { BgpAddressFamily } from './bgp';

/**
 * Origin of an advertised prefix, exactly as BGP prints it and VRP echoes it:
 * `i` = IGP, `e` = EGP, `?` = incomplete. `null` means the output did not
 * state the origin — never guessed from the AS-PATH.
 */
export type BgpRouteOrigin = 'i' | 'e' | '?';

/**
 * One prefix announced to a specific peer (`display bgp routing-table peer
 * <PEER> advertised-routes`). Every field that can be absent in the CLI output
 * is `null` instead of a fabricated default.
 */
export interface BgpAdvertisedRouteDto {
  prefix: string;
  nextHop: string | null;
  med: number | null;
  localPreference: number | null;
  preferredValue: number | null;
  /** AS-PATH in the order printed by the device, one entry per ASN. */
  asPath: string[];
  origin: BgpRouteOrigin | null;
  /** Extra repetitions of the local ASN at the start of the AS-PATH. */
  prependLocal: number;
}

/**
 * On-demand SSH read of the routes this device advertises to one peer.
 * Nothing here is persisted: the backend collects and returns, the operator
 * decides whether to collect again.
 */
export interface BgpAdvertisedRoutesResponse {
  peerId: string;
  deviceId: string;
  peerAddress: string;
  addressFamily: BgpAddressFamily;
  /** Local ASN used to compute `prependLocal`; resolved by the backend. */
  localAs: string | null;
  fetchedAt: string;
  routes: BgpAdvertisedRouteDto[];
  /**
   * Total explicitly reported by the CLI itself, when the output states one.
   * `null` when the device does not print a total — the UI must not invent it.
   */
  reportedTotal: number | null;
  /** Non-fatal problems: unparsable rows, unsupported columns, etc. */
  warnings: string[];
}

/** Normalizes an ASN token so `' 268568 '` and `'268568'` compare equal. */
function normalizeAsnToken(value: string | number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

/**
 * AS-PATH local prepend counter.
 *
 * Only the *additional consecutive repetitions of the local ASN at the very
 * beginning* of the path count. Everything else is deliberately ignored:
 *
 * - the first ASN must be the local ASN, otherwise there is no local prepend;
 * - a third-party repetition (`268568 268633 268633`) is not a local prepend;
 * - the local ASN reappearing after another ASN does not count;
 * - the total AS-PATH length is never used as a prepend value.
 *
 * Examples with `localAs = '268568'`:
 *
 * ```
 * 268568 271034                          => 0
 * 268568 268568 271034                   => 1
 * 268568 268568 268568 271034            => 2
 * 268568 268633 268633                   => 0
 * 268568 271034 271034 271034            => 0
 * 268568 268568 268568 268568 268568 268568 268884 => 5
 * ```
 */
export function computeLocalPrepend(
  asPath: readonly string[] | null | undefined,
  localAs: string | number | null | undefined,
): number {
  const local = normalizeAsnToken(localAs);
  if (!local) return 0;
  const path = Array.isArray(asPath) ? asPath : [];
  if (path.length === 0) return 0;
  if (normalizeAsnToken(path[0]) !== local) return 0;

  let repetitions = 0;
  for (let index = 1; index < path.length; index += 1) {
    if (normalizeAsnToken(path[index]) !== local) break;
    repetitions += 1;
  }
  return repetitions;
}
