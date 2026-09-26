'use client';

export interface AsnTone {
  background: string;
  color: string;
  border: string;
}

/**
 * Deterministic ASN palette.
 *
 * The tones deliberately avoid the product's UP/DOWN semantics
 * (`--green`/`--red`), so an AS-PATH chip can never be mistaken for a session
 * status. The same ASN always receives the same tone in every row.
 */
export const ASN_TONES: readonly AsnTone[] = [
  { background: 'rgba(125, 211, 230, 0.14)', color: '#a5dfee', border: 'rgba(125, 211, 230, 0.42)' },
  { background: 'rgba(150, 201, 242, 0.15)', color: '#b6d7f7', border: 'rgba(150, 201, 242, 0.42)' },
  { background: 'rgba(159, 180, 242, 0.16)', color: '#bcc9f8', border: 'rgba(159, 180, 242, 0.42)' },
  { background: 'rgba(176, 176, 245, 0.16)', color: '#cbccf9', border: 'rgba(176, 176, 245, 0.42)' },
  { background: 'rgba(201, 179, 247, 0.15)', color: '#d9c9fa', border: 'rgba(201, 179, 247, 0.40)' },
  { background: 'rgba(231, 169, 214, 0.14)', color: '#f0bfe4', border: 'rgba(231, 169, 214, 0.40)' },
  { background: 'rgba(147, 163, 205, 0.15)', color: '#c3cee6', border: 'rgba(147, 163, 205, 0.40)' },
  { background: 'rgba(179, 196, 206, 0.16)', color: '#cbd8df', border: 'rgba(179, 196, 206, 0.40)' },
];

/** FNV-1a over the ASN string, mapped onto the fixed palette. */
export function asnToneIndex(asn: string): number {
  let hash = 2166136261;
  for (let index = 0; index < asn.length; index += 1) {
    hash ^= asn.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % ASN_TONES.length;
}

export function asnTone(asn: string): AsnTone {
  return ASN_TONES[asnToneIndex(asn)] as AsnTone;
}

/** One ASN of an AS-PATH. The local ASN is visually distinguished. */
export function AsnChip({ asn, localAs }: { asn: string; localAs?: string | null }) {
  const tone = asnTone(asn);
  const isLocal = Boolean(localAs) && asn === localAs;
  return (
    <span
      className={`bgp-asn-chip${isLocal ? ' bgp-asn-chip--local' : ''}`}
      style={{ background: tone.background, color: tone.color, borderColor: tone.border }}
      title={isLocal ? `ASN ${asn} · ASN local` : `ASN ${asn}`}
    >
      {asn}
    </span>
  );
}

/**
 * Local prepend marker. Zero renders the neutral dash, never a "PREPEND 0"
 * badge that would imply a policy that does not exist.
 */
export function PrependBadge({ value }: { value: number }) {
  if (!value) return <span className="bgp-adv__muted">—</span>;
  return (
    <span
      className="bgp-prepend-badge"
      title={`${value} repetição(ões) adicional(is) do ASN local no início do AS-PATH`}
    >
      PREPEND {value}
    </span>
  );
}
