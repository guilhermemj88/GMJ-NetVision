import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  correlateReciprocalVsi,
  canonicalAsnRd,
  interfaceFromReciprocalVsi,
  selectRemoteCandidate,
} from './vsi-diagnostic-reciprocal';
import { isCompleteObservation, observeMplsLoopback } from './vsi-diagnostic-observation';
const remoteFolder = new URL('./__fixtures__/bhe-vta-remote-20261022/', import.meta.url);
const metadata = JSON.parse(readFileSync(new URL('r2-metadata.json', remoteFolder), 'utf8'));
const r2 = readFileSync(new URL('r2-version.sanitized.txt', remoteFolder), 'utf8');
const local = readFileSync(
  new URL('./__fixtures__/bhe-vta-local-full-20261022/vsi.sanitized.txt', import.meta.url),
  'utf8',
);
describe('remote independent platform identification and conditional service safety', () => {
  const r4meta = JSON.parse(
    readFileSync(new URL('r4-attempt1-metadata.json', remoteFolder), 'utf8'),
  );
  const captured = (kind: string) => {
    const record = r4meta.outputs.find(
      (o: { fixture: string }) => o.fixture === `r4-attempt1-${kind}.sanitized.txt`,
    );
    return { ...record, stdout: readFileSync(new URL(record.fixture, remoteFolder), 'utf8') };
  };
  it('confirms the actual remote LSR/LoopBack only with the explicit global VPN marker in a complete brief', () => {
    expect(r4meta.analysis.vsiCommandSent).toBe(false);
    expect(r4meta.analysis.interfaceCommandSent).toBe(false);
    expect(r4meta.processExitCode).toBe(2);
    expect(
      r4meta.audit
        .filter((a: { event: string }) => a.event === 'BEFORE_SEND')
        .map((a: { command: string }) => a.command),
    ).toEqual([
      'screen-length 0 temporary',
      'display version',
      'display mpls ldp',
      'display ip interface brief',
    ]);
    for (const record of r4meta.outputs) {
      const raw = readFileSync(new URL(record.fixture, remoteFolder));
      expect(createHash('sha256').update(raw).digest('hex')).toBe(record.sha256);
      expect(
        isCompleteObservation({ ...record, stdout: raw.toString('utf8') }, record.prompt),
      ).toBe(true);
    }
    const ldp = captured('ldp'),
      brief = captured('brief'),
      prompt = metadata.profile.expectedPrompt;
    expect(observeMplsLoopback(ldp, brief, prompt)).toEqual({
      status: 'CONFIRMED_LOOPBACK',
      address: '10.100.101.255',
      interfaceName: 'LoopBack0',
      routingContext: 'GLOBAL',
    });
    for (const modified of [
      brief.stdout.replace(/(LoopBack0[^\n]+)--/, '$1CUSTOMER'),
      brief.stdout.replace(/(LoopBack0[^\n]+)--/, '$1'),
      brief.stdout.replace(/(LoopBack0[^\n]+)--/, '$1-- EXTRA'),
      brief.stdout + '\n---- More ----',
    ])
      expect(observeMplsLoopback(ldp, { ...brief, stdout: modified }, prompt)).toEqual({
        status: 'INSUFFICIENT_DATA',
      });
    const duplicate =
      brief.stdout.trimEnd().slice(0, -prompt.length) +
      'LoopBack9 10.100.101.255/32 up up(s) --\n' +
      prompt;
    expect(observeMplsLoopback(ldp, { ...brief, stdout: duplicate }, prompt)).toEqual({
      status: 'INSUFFICIENT_DATA',
    });
    expect(observeMplsLoopback(ldp, { ...brief, complete: false }, prompt)).toEqual({
      status: 'INSUFFICIENT_DATA',
    });
  });
  it('retains complete real YunShan V600 identification without claiming local VRP V200 compatibility', () => {
    expect(createHash('sha256').update(r2).digest('hex')).toBe(metadata.outputs[0].sha256);
    expect(r2).toContain('Huawei YunShan OS');
    expect(r2).toContain('S6750-H36C');
    expect(r2).toContain('V600R024C00SPC500');
    expect(r2).toContain('V600R024SPH221');
    expect(r2).not.toContain('V200R022');
    expect(metadata.sessionPreparation).toBeNull();
    expect(metadata.roleAAA).toBe('NOT_VERIFIED');
    expect(
      metadata.audit
        .filter((a: { event: string }) => a.event === 'BEFORE_SEND')
        .map((a: { command: string }) => a.command),
    ).toEqual(['display version']);
    expect(metadata.approval.answer).toBe('Confirmo a fingerprint e autorizo R2');
    expect(
      isCompleteObservation(
        { ...metadata.outputs[0], stdout: r2 },
        metadata.profile.expectedPrompt,
      ),
    ).toBe(true);
    expect(metadata.canonicalFingerprint).toBe(
      'SHA256:OXJzyxUT3sO8G7u8D/gSy7kG9AAR3iV3G/wMsGNsMm8',
    );
  });
  it('normalizes ASN notation without equating a four-component IPv4 RD to an ASN', () => {
    expect(canonicalAsnRd('4.6424 : 51041')).toBe('268568:51041');
    expect(canonicalAsnRd('268568:51041')).toBe('268568:51041');
    for (const value of ['192.0.2.1:1', '65536.1:1', '4.65536:1', '268568:65536', 'garbage', null])
      expect(canonicalAsnRd(value)).toBeNull();
  });
  const service = {
    name: '1041-IX-BH-V4',
    rd: '268568:51041',
    signaling: 'BGP',
    address: '10.100.101.0',
  };
  const candidate = {
    hostId: 'REMOTE',
    name: service.name,
    rd: '4.6424 : 51041',
    signalingType: 'BGP',
    pws: [{ remoteIp: '10.100.101.0' }],
  };
  it('requires compatible service identity, correct host and exact reciprocal peer for preferred persisted candidate', () => {
    expect(selectRemoteCandidate([candidate], 'REMOTE', service).status).toBe(
      'PERSISTED_RECIPROCAL_CANDIDATE',
    );
    expect(selectRemoteCandidate([{ ...candidate, pws: null }], 'REMOTE', service).status).toBe(
      'TENTATIVE_CANDIDATE',
    );
    expect(
      selectRemoteCandidate(
        [{ ...candidate, pws: [{ remoteIp: '10.100.101.99' }] }],
        'REMOTE',
        service,
      ).status,
    ).toBe('TENTATIVE_CANDIDATE');
    expect(selectRemoteCandidate([{ ...candidate, rd: null }], 'REMOTE', service).status).toBe(
      'INSUFFICIENT_DATA',
    );
    expect(selectRemoteCandidate([candidate], 'OTHER', service).status).toBe('INSUFFICIENT_DATA');
    expect(selectRemoteCandidate([candidate, { ...candidate }], 'REMOTE', service).status).toBe(
      'AMBIGUOUS',
    );
  });
  const observation = () => ({
    command: 'display vsi name 1041-IX-BH-V4 verbose',
    stdout: local,
    complete: true,
    completedAt: '2026-10-22T18:20:48.199Z',
  });
  const prompt = '<BHE-VTA-6730-MPLS-01>';
  it('derives the AC solely from completed reciprocal CLI, independent of the VSI name or VLAN number', () => {
    const evidence = observation();
    evidence.stdout = evidence.stdout.replace(
      'Interface Name         : Vlanif1041',
      'Interface Name         : Vlanif777',
    );
    expect(interfaceFromReciprocalVsi(evidence, service.name, prompt, '10.100.101.255')).toBe(
      'display interface Vlanif777',
    );
  });
  it('refuses AC selection on reciprocal mismatch, pager, incomplete or multiple ACs', () => {
    expect(() =>
      interfaceFromReciprocalVsi(observation(), service.name, prompt, '10.100.101.99'),
    ).toThrow();
    expect(() =>
      interfaceFromReciprocalVsi(
        { ...observation(), complete: false },
        service.name,
        prompt,
        '10.100.101.255',
      ),
    ).toThrow();
    expect(() =>
      interfaceFromReciprocalVsi(
        { ...observation(), stdout: local + '\n---- More ----' },
        service.name,
        prompt,
        '10.100.101.255',
      ),
    ).toThrow();
    const evidence = observation();
    evidence.stdout = evidence.stdout.replace(
      '  **PW Information:',
      '    Interface Name : Vlanif777\n    State : up\n  **PW Information:',
    );
    expect(() =>
      interfaceFromReciprocalVsi(evidence, service.name, prompt, '10.100.101.255'),
    ).toThrow();
  });
  it('cross-compares only reciprocal explicit peer labels, preserving absent VC-ID and both timestamps', () => {
    // Synthetic unit variants of the recorded local body, not claimed as remote observations.
    const left = {
      evidence: observation(),
      name: service.name,
      prompt,
      loopback: {
        status: 'CONFIRMED_LOOPBACK' as const,
        address: '10.100.101.0',
        interfaceName: 'LoopBack0',
        routingContext: 'GLOBAL' as const,
      },
    };
    const right = {
      ...left,
      evidence: {
        ...observation(),
        completedAt: '2026-10-22T20:51:49Z',
        stdout: local
          .replace(
            'Peer Ip Address        : 10.100.101.255',
            'Peer Ip Address        : 10.100.101.0',
          )
          .replace('Local VC Label         : 40943', 'Local VC Label         : 1016584')
          .replace('Remote VC Label        : 1016584', 'Remote VC Label        : 40943'),
      },
      loopback: { ...left.loopback, address: '10.100.101.255' },
    };
    const compared = correlateReciprocalVsi(left, right);
    expect(compared.status).toBe('CONFIRMED_RECIPROCAL_VSI');
    expect(compared.labelComparisons.map((c) => c.classification)).toEqual(['MATCH', 'MATCH']);
    expect(compared.labelComparisons[0]).toMatchObject({
      localLabel: 40943,
      remoteLabel: 40943,
      localObservedAt: left.evidence.completedAt,
      remoteObservedAt: right.evidence.completedAt,
      assertsNetworkFailure: false,
    });
    const wrongLabel = {
      ...right,
      evidence: {
        ...right.evidence,
        stdout: right.evidence.stdout.replace(
          'Remote VC Label        : 40943',
          'Remote VC Label        : 40944',
        ),
      },
    };
    expect(correlateReciprocalVsi(left, wrongLabel).labelComparisons[0]?.classification).toBe(
      'DIVERGENT',
    );
    const wrongPeer = {
      ...right,
      evidence: {
        ...right.evidence,
        stdout: right.evidence.stdout.replace(
          'Peer Ip Address        : 10.100.101.0',
          'Peer Ip Address        : 10.100.101.99',
        ),
      },
    };
    expect(correlateReciprocalVsi(left, wrongPeer)).toMatchObject({
      status: 'INSUFFICIENT_DATA',
      labelComparisons: [
        { classification: 'NOT_COMPARABLE' },
        { classification: 'NOT_COMPARABLE' },
      ],
    });
    expect(
      correlateReciprocalVsi(left, { ...right, evidence: { ...right.evidence, complete: false } })
        .status,
    ).toBe('INSUFFICIENT_DATA');
  });
});
