import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseInterface, parseVsiFacts, resolveMplsLoopback } from './vsi-diagnostic-parser';

const fixture = (name: string) =>
  readFileSync(
    new URL(`./__fixtures__/bhe-vta-20261022/${name}.sanitized.txt`, import.meta.url),
    'utf8',
  );
describe('controlled BHE-VTA real read-only evidence, 22 October 2026', () => {
  it('accepts the complete LDP retest but does not upgrade the old paginated brief', () => {
    const ldp = fixture('ldp-retest');
    const meta = JSON.parse(
      readFileSync(
        new URL('./__fixtures__/bhe-vta-20261022/ldp-retest.metadata.json', import.meta.url),
        'utf8',
      ),
    );
    expect(meta.complete).toBe(true);
    expect(meta.cleanCompletion).toBe(true);
    expect(meta.processExitCode).toBe(0);
    expect(meta.audit.map((item: { command: string }) => item.command)).toEqual([
      'display mpls ldp',
    ]);
    expect(meta.sessionPreparation).toBeNull();
    expect(ldp).not.toContain('---- More ----');
    expect(ldp.trimEnd()).toMatch(/<BHE-VTA-6730-MPLS-01>$/);
    expect(resolveMplsLoopback(ldp, fixture('brief'))).toBeNull();
  });
  it('identifies the observed platform without treating a paginated version as complete', () => {
    const output = fixture('identified-version');
    expect(output).toContain('S6730-H48X6C');
    expect(output).toContain('V200R022C00SPC500');
    expect(output).toContain('---- More ----');
  });
  it('recognizes the real LSR and LoopBack row but rejects the incomplete full brief', () => {
    const ldp = fixture('ldp');
    const brief = fixture('brief');
    expect(ldp).toMatch(/Instance ID\s+: 0\s+VPN-Instance\s*:\s*\n/);
    const row = brief.split('\n').find((line) => /^LoopBack0\s/.test(line))!;
    expect(resolveMplsLoopback(ldp, row)).toEqual({
      address: '10.100.101.0',
      interfaceName: 'LoopBack0',
    });
    expect(resolveMplsLoopback(ldp, brief)).toBeNull();
  });
  it('does not fabricate PW/VC-ID/labels from the paginated BGP VSI header', () => {
    const output = fixture('vsi');
    expect(output).toContain('***VSI Name');
    expect(output).toMatch(/PW Signaling\s+: bgp/);
    expect(output).toMatch(/VSI State\s+: up/);
    expect(parseVsiFacts(output, '1041-IX-BH-V4')).toEqual({
      vsiId: null,
      status: null,
      peers: [],
    });
  });
  it('accepts three-star VSI names without interpreting a VSI index or label block as an ID', () => {
    const output =
      '***VSI Name : 1041-IX-BH-V4\nVSI Index : 169\nPW Signaling : bgp\nVSI State : up\nRemote Label Block : 1016584/8/1';
    expect(parseVsiFacts(output, '1041-IX-BH-V4')).toEqual({
      vsiId: null,
      status: 'UP',
      peers: [],
    });
  });
  it('parses the complete physical/logical Vlanif state without inventing VLAN/parent/counters', () => {
    const output = fixture('interface');
    expect(output).toContain('Description:1041-IX-BH-V4');
    expect(parseInterface(output, 'Vlanif1041')).toEqual({ physical: 'UP', logical: 'UP' });
    expect(parseInterface(output + '\n---- More ----', 'Vlanif1041')).toBeNull();
    expect(parseInterface(output, 'Vlanif1042')).toBeNull();
  });
});
