import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  compareCliSnmpField,
  isCompleteObservation,
  observeMplsLoopback,
  observeVsi,
} from './vsi-diagnostic-observation';
import { parseVsiFacts } from './vsi-diagnostic-parser';

const folder = new URL('./__fixtures__/bhe-vta-local-full-20261022/', import.meta.url);
const prompt = '<BHE-VTA-6730-MPLS-01>';
const meta = JSON.parse(readFileSync(new URL('metadata.json', folder), 'utf8'));
function fixture(name: string) {
  const item = meta.outputs.find((o: { fixture: string }) => o.fixture === name + '.sanitized.txt');
  return {
    command: item.command as string,
    stdout: readFileSync(new URL(item.fixture, folder), 'utf8'),
    complete: item.complete as boolean,
    completedAt: item.completedAt as string,
  };
}
describe('complete single-session local PE evidence, 22 October 2026', () => {
  it('retains all six real outputs, exact authorized sends and per-output completeness', () => {
    expect(meta.cleanCompletion).toBe(true);
    expect(meta.automaticRetries).toBe(0);
    expect(meta.remoteAccesses).toBe(0);
    expect(meta.ping + meta.tracert + meta.configurationWrites + meta.restorationCommands).toBe(0);
    expect(
      meta.audit
        .filter((e: { event: string }) => e.event === 'BEFORE_SEND')
        .map((e: { command: string }) => e.command),
    ).toEqual([
      'screen-length 0 temporary',
      'display version',
      'display mpls ldp',
      'display ip interface brief',
      'display vsi name 1041-IX-BH-V4 verbose',
      'display interface Vlanif1041',
    ]);
    for (const output of meta.outputs) {
      const bytes = readFileSync(new URL(output.fixture, folder));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(output.fixtureSha256);
      expect(
        isCompleteObservation(fixture(output.fixture.replace('.sanitized.txt', '')), prompt),
      ).toBe(true);
    }
  });
  it('confirms a unique UP/up LoopBack matching LSR, independent of interface number', () => {
    expect(observeMplsLoopback(fixture('ldp'), fixture('brief'), prompt)).toEqual({
      status: 'CONFIRMED_LOOPBACK',
      interfaceName: 'LoopBack0',
      address: '10.100.101.0',
      routingContext: 'GLOBAL',
    });
    const brief = fixture('brief');
    brief.stdout = brief.stdout.replace('LoopBack0', 'LoopBack17');
    expect(observeMplsLoopback(fixture('ldp'), brief, prompt)).toMatchObject({
      interfaceName: 'LoopBack17',
    });
  });
  it.each(['duplicate', 'down', 'protocol-down', 'pager', 'incomplete', 'wrong-final-prompt'])(
    'retains INSUFFICIENT_DATA for %s brief',
    (variant) => {
      const brief = fixture('brief');
      if (variant === 'duplicate')
        brief.stdout =
          brief.stdout.trimEnd().slice(0, -prompt.length) +
          'LoopBack9 10.100.101.0/32 up up(s)\n' +
          prompt;
      if (variant === 'down')
        brief.stdout = brief.stdout.replace(/(LoopBack0\s+10\.100\.101\.0\/32\s+)up/, '$1down');
      if (variant === 'protocol-down')
        brief.stdout = brief.stdout.replace(/(LoopBack0[^\n]+)up\(s\)/, '$1down');
      if (variant === 'pager') brief.stdout += '---- More ----';
      if (variant === 'incomplete') brief.complete = false;
      if (variant === 'wrong-final-prompt') brief.stdout = brief.stdout.trimEnd() + '\n<OTHER>';
      expect(observeMplsLoopback(fixture('ldp'), brief, prompt)).toEqual({
        status: 'INSUFFICIENT_DATA',
      });
    },
  );
  it('extracts peer-bound PW labels and tunnel, preserving absent VC-ID and distinct BGP blocks', () => {
    expect(observeVsi(fixture('vsi'), '1041-IX-BH-V4', prompt)).toMatchObject({
      name: '1041-IX-BH-V4',
      vsiId: null,
      status: 'UP',
      signaling: 'BGP',
      rd: '268568:51041',
      mtu: 1500,
      encapsulation: 'VLAN',
      tunnelPolicy: null,
      bgpLabelBlocks: { local: '0/40919/30/1', remote: '1016584/8/1' },
      attachments: [{ interfaceName: 'Vlanif1041', state: 'UP' }],
      peers: [
        {
          address: '10.100.101.255',
          vcId: null,
          state: 'UP',
          inboundLabel: 40943,
          outboundLabel: 1016584,
          tunnel: '0x480016a0',
          tunnelType: 'LSP',
          outInterface: 'Vlanif1617',
        },
      ],
    });
  });
  it('never substitutes VSI Index, generic PW ID or label blocks for VC-ID or peer labels', () => {
    const raw =
      'VSI Name : X\nVSI Index : 169\nRemote Label Block : 1016584/8/1\nPeer Ip Address : 192.0.2.1\nPW ID : 25\n';
    expect(parseVsiFacts(raw, 'X')).toMatchObject({
      vsiId: null,
      peers: [{ vcId: null, inboundLabel: null, outboundLabel: null }],
    });
    expect(
      parseVsiFacts(
        raw + 'Peer Vc Id : 1041\nLocal VC Label : 40943\nRemote VC Label : 1016584\n',
        'X',
      ),
    ).toMatchObject({ peers: [{ vcId: 1041, inboundLabel: 40943, outboundLabel: 1016584 }] });
  });
  it('does not promote partial, unrelated or ambiguous VSI bodies', () => {
    expect(observeVsi({ ...fixture('vsi'), complete: false }, '1041-IX-BH-V4', prompt)).toBeNull();
    expect(observeVsi(fixture('vsi'), 'OTHER', prompt)).toBeNull();
    const evidence = fixture('vsi');
    evidence.stdout = evidence.stdout.replace(
      '    PW Signaling',
      '    VSI Name : OTHER\n    PW Signaling',
    );
    expect(observeVsi(evidence, '1041-IX-BH-V4', prompt)).toBeNull();
  });
});
describe('CLI versus persisted SNMP field comparisons', () => {
  it.each([
    [1500, 1500, true, 'MATCH'],
    [1500, 9000, true, 'DIVERGENT'],
    [null, 1041, true, 'CLI_MISSING'],
    ['0x480016a0', null, true, 'SNMP_MISSING'],
    [null, null, true, 'NOT_COMPARABLE'],
    [null, 25, false, 'NOT_COMPARABLE'],
  ] as const)('classifies %j versus %j, comparable=%s', (cli, snmp, comparable, classification) => {
    expect(
      compareCliSnmpField({
        field: 'test',
        cli,
        snmp,
        comparable,
        cliObservedAt: '2026-10-22T18:20:48Z',
        snmpObservedAt: '2026-10-22T18:20:26.381',
      }),
    ).toMatchObject({
      classification,
      assertsNetworkFailure: false,
      cliObservedAt: '2026-10-22T18:20:48Z',
      snmpObservedAt: '2026-10-22T18:20:26.381',
    });
  });
});
