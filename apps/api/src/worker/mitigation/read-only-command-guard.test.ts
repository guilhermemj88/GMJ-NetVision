import { describe, expect, it } from 'vitest';
import { assertReadOnlyCommand, validateReadOnlyCommand } from './read-only-command-guard';

describe('read-only command guard', () => {
  it('aceita os displays de leitura previstos no desenho', () => {
    const allowed = [
      'screen-length 0 temporary',
      'display interface brief',
      'display bgp peer',
      'display current-configuration configuration bgp',
      'display ip routing-table',
      'display ip routing-table 10.0.0.0',
      'display interface brief | include UP',
    ];
    for (const command of allowed) {
      expect(validateReadOnlyCommand(command), command).toMatchObject({ allowed: true });
    }
  });

  it('rejeita comandos de escrita/configuração mesmo fora do allowlist', () => {
    const forbidden = [
      'system-view',
      'commit',
      'undo route-policy PL-HORIZONTES_IPv4-IN permit node 3',
      'route-policy PL-HORIZONTES_IPv4-IN permit node 3',
      'apply extcommunity rt 268568:660 additive',
      'peer 10.0.0.1 ignore',
      'save',
      'reset bgp all',
      'interface Eth-Trunk1',
      'undo shutdown',
    ];
    for (const command of forbidden) {
      const verdict = validateReadOnlyCommand(command);
      expect(verdict.allowed, command).toBe(false);
      if (!verdict.allowed) expect(verdict.reason).toBe('FORBIDDEN_WRITE_COMMAND');
    }
  });

  it('rejeita command injection, multilinha e redirecionamento', () => {
    expect(validateReadOnlyCommand('display bgp peer; system-view')).toEqual({
      allowed: false,
      reason: 'SHELL_METACHARACTER_NOT_ALLOWED',
    });
    expect(validateReadOnlyCommand('display bgp peer\r\nsystem-view')).toEqual({
      allowed: false,
      reason: 'MULTILINE_NOT_ALLOWED',
    });
    expect(validateReadOnlyCommand('display bgp peer > file.txt')).toEqual({
      allowed: false,
      reason: 'REDIRECTION_NOT_ALLOWED',
    });
    expect(validateReadOnlyCommand('display bgp peer && system-view')).toEqual({
      allowed: false,
      reason: 'SHELL_METACHARACTER_NOT_ALLOWED',
    });
  });

  it('rejeita display fora do allowlist e comando vazio/longo demais', () => {
    expect(validateReadOnlyCommand('display running-config')).toEqual({
      allowed: false,
      reason: 'COMMAND_NOT_IN_ALLOWLIST',
    });
    expect(validateReadOnlyCommand('   ')).toEqual({ allowed: false, reason: 'EMPTY_COMMAND' });
    expect(validateReadOnlyCommand(`display bgp peer ${'x'.repeat(600)}`)).toEqual({
      allowed: false,
      reason: 'COMMAND_TOO_LONG',
    });
  });

  it('normaliza espaços e devolve o comando pronto para envio', () => {
    expect(validateReadOnlyCommand('  display   interface   brief  ')).toEqual({
      allowed: true,
      normalized: 'display interface brief',
    });
  });

  it('assert lança para comando proibido', () => {
    expect(() => assertReadOnlyCommand('system-view')).toThrow(/READ_ONLY_VIOLATION/);
    expect(assertReadOnlyCommand('display bgp peer')).toBe('display bgp peer');
  });
});
