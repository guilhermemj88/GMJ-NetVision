import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CredentialVault } from './credential-vault';

describe('CredentialVault', () => {
  it('encrypts authenticated credential payloads', () => {
    const vault = new CredentialVault(randomBytes(32).toString('base64'));
    const encrypted = vault.encrypt({ community: 'not-public' });
    expect(encrypted.toString('utf8')).not.toContain('not-public');
    expect(vault.decrypt(encrypted)).toEqual({ community: 'not-public' });
  });
});
