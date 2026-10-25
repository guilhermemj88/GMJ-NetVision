import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { utils } from 'ssh2';
import { describe, expect, it } from 'vitest';

const base = './__fixtures__/bhe-vta-hostkey/';
const key = readFileSync(new URL(base + 'hostkey.pub', import.meta.url), 'utf8').trim();
const evidence = JSON.parse(
  readFileSync(new URL(base + 'reconciliation.json', import.meta.url), 'utf8'),
);

describe('BHE-VTA public host key reconciled offline before authentication', () => {
  it('binds the canonical SHA256 fingerprint to the real ECDSA public wire blob', () => {
    const [algorithm, encoded] = key.split(' ');
    expect(algorithm).toBe('ecdsa-sha2-nistp521');
    const parsed = utils.parseKey(key);
    if (parsed instanceof Error || Array.isArray(parsed))
      throw new Error('Invalid public key fixture');
    const wire = Buffer.from(encoded!, 'base64');
    expect(parsed.getPublicSSH()).toEqual(wire);
    const calculated =
      'SHA256:' + createHash('sha256').update(wire).digest('base64').replace(/=+$/, '');
    expect(calculated).toBe(evidence.canonicalFingerprint);
    expect(calculated).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });
  it('matches the original approval, historical verifier and report without accepting an abbreviated prefix', () => {
    expect(new Set(Object.values(evidence.sourceComparisons))).toEqual(
      new Set([evidence.canonicalFingerprint]),
    );
    expect(evidence.approvalQuestion).toContain(evidence.canonicalFingerprint);
    expect(evidence.approvalQuestion).not.toContain('SHA256:+OoG3kp');
    expect(evidence.canonicalFingerprint).not.toBe(evidence.apparentDivergence.citedFragment);
    expect(evidence.approvalCallId).toBe('call_721b371dc83543b9a346c9e55a889e59');
  });
  it('retains the historical evidence gap and rejects any claim of authentication during reconciliation', () => {
    expect(evidence.historicalPublicKeyBlobRetained).toBe(false);
    expect(evidence.publicKeyCaptureIsNewUnauthenticatedExchange).toBe(true);
    expect(evidence.devicePasswordSentDuringReconciliation).toBe(false);
    expect(evidence.distinctFingerprints).toBe(1);
  });
});
