import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  observeMplsLoopback,
  observeVsi,
  isCompleteObservation,
} from './vsi-diagnostic-observation';
import { correlateReciprocalVsi, interfaceFromReciprocalVsi } from './vsi-diagnostic-reciprocal';
import { parseInterface } from './vsi-diagnostic-parser';
const remoteFolder = new URL('./__fixtures__/bhe-vta-remote-20261022/', import.meta.url);
const localFolder = new URL('./__fixtures__/bhe-vta-local-full-20261022/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('r4-retest-metadata.json', remoteFolder), 'utf8'));
const localMeta = JSON.parse(readFileSync(new URL('metadata.json', localFolder), 'utf8'));
function remote(name: string) {
  const item = meta.outputs.find(
    (o: { fixture: string }) => o.fixture === `r4-retest-${name}.sanitized.txt`,
  );
  return { ...item, stdout: readFileSync(new URL(item.fixture, remoteFolder), 'utf8') };
}
function local(name: string) {
  const item = localMeta.outputs.find(
    (o: { fixture: string }) => o.fixture === `${name}.sanitized.txt`,
  );
  return { ...item, stdout: readFileSync(new URL(item.fixture, localFolder), 'utf8') };
}
const name = '1041-IX-BH-V4',
  prompt = '<BHE-VTA-S6750-MPLS-01>',
  localPrompt = '<BHE-VTA-6730-MPLS-01>';
const endpoints = () => ({
  left: {
    evidence: local('vsi'),
    name,
    prompt: localPrompt,
    loopback: observeMplsLoopback(local('ldp'), local('brief'), localPrompt),
  },
  right: {
    evidence: remote('vsi'),
    name,
    prompt,
    loopback: observeMplsLoopback(remote('ldp'), remote('brief'), prompt),
  },
});
describe('independent complete real remote VSI homologation, explicitly approved R4 retest', () => {
  it('preserves six complete outputs and durable audited conditional AC ordering in one session', () => {
    expect(meta.cleanCompletion).toBe(true);
    expect(meta.processExitCode).toBe(0);
    expect(meta.stderrPresent).toBe(false);
    expect(meta.routerSessions).toBe(1);
    expect(meta.automaticRetries).toBe(0);
    expect(meta.newWindowApproval.questionCallId).toBe('call_324cb6c76b984e70a51ec94ad227f510');
    expect(meta.newWindowApproval.answerVerbatimFromUserReply).toBe(
      'Autorizo uma nova sessão R4 completa',
    );
    expect(meta.ping + meta.tracert + meta.configurationWrites + meta.restorationCommands).toBe(0);
    expect(meta.roleAAA).toBe('NOT_VERIFIED');
    expect(
      meta.audit
        .filter((a: { event: string }) => a.event === 'BEFORE_SEND')
        .map((a: { command: string }) => a.command),
    ).toEqual([
      'screen-length 0 temporary',
      'display version',
      'display mpls ldp',
      'display ip interface brief',
      'display vsi name 1041-IX-BH-V4 verbose',
      'display interface Vlanif1041',
    ]);
    const vsiComplete = meta.audit.findIndex(
      (a: { event: string; command: string }) =>
        a.event === 'COMPLETE' && a.command.includes('display vsi name'),
    );
    const acProof = meta.audit.findIndex(
      (a: { event: string }) => a.event === 'CONDITIONAL_AC_PROVEN',
    );
    const acSend = meta.audit.findIndex(
      (a: { event: string; command: string }) =>
        a.event === 'BEFORE_SEND' && a.command === 'display interface Vlanif1041',
    );
    expect(acProof).toBeGreaterThan(vsiComplete);
    expect(acSend).toBeGreaterThan(acProof);
    for (const item of meta.outputs) {
      const raw = readFileSync(new URL(item.fixture, remoteFolder));
      expect(createHash('sha256').update(raw).digest('hex')).toBe(item.sha256);
      expect(isCompleteObservation({ ...item, stdout: raw.toString('utf8') }, prompt)).toBe(true);
    }
  });
  it('proves the actual remote global LoopBack from fresh LDP/brief without substituting the management address', () => {
    expect(endpoints().right.loopback).toEqual({
      status: 'CONFIRMED_LOOPBACK',
      address: '10.100.101.255',
      interfaceName: 'LoopBack0',
      routingContext: 'GLOBAL',
    });
    expect(
      observeMplsLoopback(remote('ldp'), { ...remote('brief'), complete: false }, prompt),
    ).toEqual({ status: 'INSUFFICIENT_DATA' });
  });
  it('extracts real reciprocal BGP PW labels, keeping VSI Index, site ID and label blocks distinct from VC-ID', () => {
    expect(observeVsi(remote('vsi'), name, prompt)).toMatchObject({
      name,
      status: 'UP',
      vsiId: null,
      signaling: 'BGP',
      rd: '268568:51041',
      mtu: 1500,
      peers: [
        {
          address: '10.100.101.0',
          state: 'UP',
          vcId: null,
          inboundLabel: 1016584,
          outboundLabel: 40943,
          tunnel: '0x0000000001004c4b81',
          tunnelType: 'ldp',
          outInterface: null,
        },
      ],
      attachments: [{ interfaceName: 'Vlanif1041', state: 'UP' }],
      bgpLabelBlocks: { local: '0/1016584/8/1', remote: '40919/30/1' },
      tunnelPolicy: null,
    });
    expect(interfaceFromReciprocalVsi(remote('vsi'), name, prompt, '10.100.101.0')).toBe(
      'display interface Vlanif1041',
    );
  });
  it('recognizes the real V600 interface header with ifindex while rejecting unknown suffixes and unrelated interfaces', () => {
    const output = remote('interface').stdout;
    expect(output).toContain('Vlanif1041 current state : UP (ifindex: 69)');
    expect(parseInterface(output, 'Vlanif1041')).toEqual({ physical: 'UP', logical: 'UP' });
    expect(
      parseInterface(output.replace('UP (ifindex: 69)', 'DOWN (ifindex: 69)'), 'Vlanif1041'),
    ).toEqual({ physical: 'DOWN', logical: 'UP' });
    for (const text of [
      output.replace('(ifindex: 69)', '(unknown: 69)'),
      output.replace('(ifindex: 69)', '(ifindex: bad)'),
      output + '\n---- More ----',
    ])
      expect(parseInterface(text, 'Vlanif1041')).toBeNull();
    expect(parseInterface(output, 'Vlanif900')).toBeNull();
  });
  it('matches the two explicit label directions between real reciprocal peer blocks with both source timestamps', () => {
    const { left, right } = endpoints();
    const result = correlateReciprocalVsi(left, right);
    expect(result.status).toBe('CONFIRMED_RECIPROCAL_VSI');
    expect(result.labelComparisons).toEqual([
      {
        direction: 'LOCAL.inbound / REMOTE.outbound',
        localLabel: 40943,
        remoteLabel: 40943,
        classification: 'MATCH',
        localObservedAt: left.evidence.completedAt,
        remoteObservedAt: right.evidence.completedAt,
        assertsNetworkFailure: false,
      },
      {
        direction: 'LOCAL.outbound / REMOTE.inbound',
        localLabel: 1016584,
        remoteLabel: 1016584,
        classification: 'MATCH',
        localObservedAt: left.evidence.completedAt,
        remoteObservedAt: right.evidence.completedAt,
        assertsNetworkFailure: false,
      },
    ]);
  });
  it('does not force real reciprocal correlation on peer mismatch or missing explicit label semantics', () => {
    const { left, right } = endpoints();
    const mismatch = {
      ...right,
      evidence: {
        ...right.evidence,
        stdout: right.evidence.stdout.replace(
          'Peer Ip Address        : 10.100.101.0',
          'Peer Ip Address        : 10.100.101.99',
        ),
      },
    };
    expect(correlateReciprocalVsi(left, mismatch).status).toBe('INSUFFICIENT_DATA');
    const noLabel = {
      ...right,
      evidence: {
        ...right.evidence,
        stdout: right.evidence.stdout.replace('Local VC Label', 'Unrelated Label'),
      },
    };
    expect(
      correlateReciprocalVsi(left, noLabel).labelComparisons.map((c) => c.classification),
    ).toEqual(['NOT_COMPARABLE', 'NOT_COMPARABLE']);
  });
});
