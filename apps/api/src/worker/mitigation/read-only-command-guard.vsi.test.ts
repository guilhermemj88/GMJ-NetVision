import { describe, expect, it } from 'vitest';
import { validateReadOnlyCommand } from './read-only-command-guard';

describe('allowlist: descoberta VSI/VPLS e LDP', () => {
  it('aceita os comandos de leitura de VSI, LDP e l2vc', () => {
    for (const command of [
      'display vsi',
      'display vsi verbose',
      'display vsi name VSI-GERENCIA verbose',
      'display mpls ldp session',
      'display mpls ldp remote-peer',
      'display mpls l2vc',
    ]) {
      expect(validateReadOnlyCommand(command), command).toMatchObject({ allowed: true });
    }
  });

  it('recusa comandos de escrita, encadeamento e redirecionamento', () => {
    for (const command of [
      'reset mpls ldp',
      'undo vsi VSI-GERENCIA',
      'display vsi verbose; reset mpls ldp',
      'display vsi verbose && reset mpls ldp',
      'display mpls l2vc > /tmp/x',
      'system-view',
      'display vsi;reset saved-configuration',
    ]) {
      expect(validateReadOnlyCommand(command).allowed, command).toBe(false);
    }
  });

  it('aceita filtro de leitura com pipe, como nos demais comandos display', () => {
    // O guard ja permite `display x | include y`; VSI segue a mesma regra.
    expect(validateReadOnlyCommand('display vsi name VSI-GERENCIA verbose | include up')).toMatchObject(
      { allowed: true },
    );
  });
});
