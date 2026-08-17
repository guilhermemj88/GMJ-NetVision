export function decodeSnmpText(value: string | number | Uint8Array | undefined): string {
  if (value === undefined) return '';
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('utf8').replace(/\0+$/g, '').trim();
  }
  return String(value).replace(/\0+$/g, '').trim();
}

/** Repairs the legacy String(Uint8Array) representation at API read time. */
export function normalizeLegacySnmpText(value: string): string {
  const parts = value.split(',');
  if (parts.length < 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return value;
  const bytes = parts.map(Number);
  if (bytes.some((byte) => byte < 0 || byte > 255)) return value;
  const decoded = Buffer.from(bytes).toString('utf8').replace(/\0+$/g, '').trim();
  return decoded && !decoded.includes('\ufffd') ? decoded : value;
}
