import { describe, expect, it } from 'vitest';
import {
  diagnosticSessionPreparation,
  confirmedDiagnosticPreparation,
  type DiagnosticPreparationProfile,
} from './diagnostic-session-preparation';
import { parseVsiAccessProfile } from '../mpls/vsi-diagnostic-ssh';

describe('private typed temporary pagination', () => {
  it('builds exactly one literal only with an explicit private flag', () => {
    expect(diagnosticSessionPreparation({ disablePagingTemporary: true })).toBe(
      'screen-length 0 temporary',
    );
    expect(diagnosticSessionPreparation({})).toBeUndefined();
  });
  it.each([
    'screen-length 0',
    'screen-length 24 temporary',
    'screen-length 0 permanent',
    'screen-length 0 temporary | display version',
    'screen-length 0 temporary\nsave',
    'screen-length 0 temporary;save',
    'screen-length 0 temporary && reboot',
    'screen-length 0 temporary\rsystem-view',
  ])('rejects nonliteral preparation %j', (value) => {
    expect(() =>
      diagnosticSessionPreparation({ sessionPreparation: value } as DiagnosticPreparationProfile),
    ).toThrow();
  });
  it.each([false, 'true', 1, null])('rejects a nonliteral profile flag %j', (value) => {
    expect(() =>
      diagnosticSessionPreparation({
        disablePagingTemporary: value,
      } as DiagnosticPreparationProfile),
    ).toThrow();
  });
  it('validates the private profile flag and rejects arbitrary fields or variants', () => {
    const profile = {
      hostId: 'unit',
      endpoint: '192.0.2.1',
      port: 2222,
      username: 'read',
      context: null,
      fingerprint: 'SHA256:' + 'A'.repeat(43),
      initialPrompt: '<UNIT>',
      expectedPrompt: '<UNIT>',
      routingContext: 'GLOBAL',
      firmwareEvidence: 'unit VRP',
      vendor: 'HUAWEI',
      disablePagingTemporary: true,
      validFrom: '2026-10-22T00:00:00Z',
      expiresAt: '2026-10-23T00:00:00Z',
      operations: ['VSI'],
    };
    expect(parseVsiAccessProfile(profile).disablePagingTemporary).toBe(true);
    expect(() => parseVsiAccessProfile({ ...profile, disablePagingTemporary: false })).toThrow();
    expect(() =>
      parseVsiAccessProfile({ ...profile, sessionPreparation: 'screen-length 0' }),
    ).toThrow();
    expect(() => parseVsiAccessProfile({ ...profile, command: 'system-view' })).toThrow();
  });
  it('requires an approved preparation response and prompt without accepting arbitrary Info or OK', () => {
    expect(confirmedDiagnosticPreparation('screen-length 0 temporary\r\n<UNIT>', '<UNIT>')).toBe(
      true,
    );
    expect(
      confirmedDiagnosticPreparation(
        'screen-length 0 temporary\nInfo: The configuration takes effect on the current user terminal interface only.\n<UNIT>',
        '<UNIT>',
      ),
    ).toBe(true);
    for (const response of [
      'OK',
      'Info: Unknown response',
      'Continue? [Y/N]:',
      'Permission denied',
      '---- More ----',
    ])
      expect(
        confirmedDiagnosticPreparation(
          'screen-length 0 temporary\n' + response + '\n<UNIT>',
          '<UNIT>',
        ),
      ).toBe(false);
    expect(confirmedDiagnosticPreparation('screen-length 0 temporary\n<OTHER>', '<UNIT>')).toBe(
      false,
    );
  });
});
