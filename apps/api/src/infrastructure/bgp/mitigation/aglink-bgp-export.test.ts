import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const evidence = JSON.parse(
  readFileSync(
    new URL('../../../../../../docs/evidence/aglink-bgp-export.json', import.meta.url),
    'utf8',
  ),
) as {
  policies: Record<string, string>;
  prefixDefinitions: string[];
  rtDefinitions: string[];
};
const prefixes = ['167.250.126.0/23', '167.250.126.0/24', '167.250.127.0/24'];
const ip = (s: string) => s.split('.').reduce((n, part) => (n << 8n) | BigInt(part), 0n);
function prefixMatch(name: string, prefix: string): boolean {
  const rows = evidence.prefixDefinitions.filter((line) =>
    line.startsWith(`ip ip-prefix ${name} `),
  );
  if (!rows.length) throw Error('Missing prefix definition: ' + name);
  const [addr, length] = prefix.split('/');
  for (const row of rows) {
    const m = /index \d+ (permit|deny) (\S+) (\d+)(.*)/.exec(row)!;
    const mask = Number(m[3]),
      tail = m[4]!;
    const low = Number(/greater-equal (\d+)/.exec(tail)?.[1] ?? mask);
    const high = Number(
      /less-equal (\d+)/.exec(tail)?.[1] ?? (tail.includes('greater-equal') ? 32 : mask),
    );
    const wildcard = m[2] === '0.0.0.0' && !tail.includes('match-network');
    const matches = wildcard || ip(addr!) >> BigInt(32 - mask) === ip(m[2]!) >> BigInt(32 - mask);
    if (matches && Number(length) >= low && Number(length) <= high) return m[1] === 'permit';
  }
  return false;
}
function rtMatch(name: string, rts: string[]): boolean {
  const rows = evidence.rtDefinitions.filter((line) =>
    new RegExp(`^ip extcommunity-filter (?:(?:basic|advanced) )?${name} index `).test(line),
  );
  if (!rows.length) throw Error('Missing RT definition: ' + name);
  for (const row of rows) {
    const m = /index \d+ (permit|deny) (.+)/.exec(row)!;
    const values = [...m[2]!.matchAll(/\brt (\d+:\d+)/g)].map((v) => v[1]!);
    const matched = values.length
      ? values.some((v) => rts.includes(v))
      : rts.some((v) => new RegExp(m[2]!).test(v));
    if (matched) return m[1] === 'permit';
  }
  return false;
}
// Static reference evaluation of captured VRP clauses, not a live announcement.
function allowed(policy: string, prefix: string, rts: string[]): boolean {
  const blocks = evidence.policies[policy]!.split(/(?=^route-policy )/m);
  for (const block of blocks) {
    const h = /^route-policy \S+ (permit|deny) node (\d+)/.exec(block);
    if (!h) continue;
    const groups = new Map<string, string[]>();
    for (const m of block.matchAll(/if-match (\S+) ([^\n]+)/g))
      groups.set(m[1]!, [...(groups.get(m[1]!) ?? []), ...m[2]!.trim().split(/\s+/)]);
    const matches = [...groups].map(([kind, values]) =>
      kind === 'ip-prefix'
        ? values.some((v) => prefixMatch(v, prefix))
        : kind === 'extcommunity-filter'
          ? values.some((v) => rtMatch(v, rts))
          : null,
    );
    if (matches.includes(false)) continue;
    if (matches.includes(null)) throw Error('Unsupported matching clause: ' + block);
    return h[1] === 'permit';
  }
  return false;
}
describe('captured IPv4 external export policies: normal announcements versus mitigation', () => {
  it.each(prefixes)(
    '%s: normal exits stop, both configured DDoS exits accept, REMOVE restores',
    (prefix) => {
      for (const name of [
        'PL-SEMPRE-IPv4-OUT',
        'PL-SEABORN-IPv4-OUT',
        'PL-SEABORN-BH-IPv4-OUT',
        'PL-CIRION-IPv4-OUT',
        'PL-TUDDO-IPv4-OUT',
        'PL-BGP_VS-IX_V4_OUT',
      ]) {
        expect(allowed(name, prefix, ['268568:140', '268568:330'])).toBe(true);
        expect(allowed(name, prefix, ['268568:660'])).toBe(false);
        expect(allowed(name, prefix, ['268568:140', '268568:330'])).toBe(true);
      }
      for (const name of ['PL-SEMPRE-DDoS-IPv4-OUT', 'PL-COMPUTIZE-IPv4-OUT']) {
        expect(allowed(name, prefix, ['268568:140', '268568:330'])).toBe(false);
        expect(allowed(name, prefix, ['268568:660'])).toBe(true);
      }
    },
  );
  it('shows why preserving the normal RT would violate the intended announcement policy', () => {
    expect(allowed('PL-CIRION-IPv4-OUT', prefixes[0]!, ['268568:140', '268568:660'])).toBe(true);
    expect(allowed('PL-COMPUTIZE-IPv4-OUT', prefixes[0]!, ['268568:140', '268568:660'])).toBe(
      false,
    );
  });
});
