import { describe, expect, it, vi } from 'vitest';
import { diagnoseAutoPrecheckFailure, runAutoPrecheck } from './auto-precheck-diagnosis';

describe('P4-b — diagnostico do pre-check do AUTO', () => {
  it('veredito de plataforma e o UNICO caso de inelegibilidade', () => {
    const diagnosis = diagnoseAutoPrecheckFailure(
      new Error('HUAWEI_CLI_PLATFORM_NOT_SUPPORTED: leitura de configuracao recusada — JUNIPER_JUNOS'),
    );
    expect(diagnosis).toMatchObject({ code: 'PLATFORM_NOT_SUPPORTED', ineligible: true });
  });

  it('falha de autenticacao nao julga o fabricante', () => {
    expect(diagnoseAutoPrecheckFailure(new Error('SSH authentication failed'))).toMatchObject({
      code: 'SSH_AUTH',
      ineligible: false,
    });
  });

  it('timeout e timeout, nao incompatibilidade', () => {
    expect(diagnoseAutoPrecheckFailure(new Error('SSH connection timeout'))).toMatchObject({
      code: 'SSH_TIMEOUT',
      ineligible: false,
    });
  });

  it('conexao recusada e inalcancavel ficam separadas', () => {
    expect(diagnoseAutoPrecheckFailure(new Error('connect ECONNREFUSED 10.0.0.1:22')).code).toBe(
      'SSH_REFUSED',
    );
    expect(diagnoseAutoPrecheckFailure(new Error('SSH host is unreachable')).code).toBe(
      'SSH_UNREACHABLE',
    );
  });

  it('sessao encerrada antes da resposta e erro generico ficam classificados', () => {
    expect(diagnoseAutoPrecheckFailure(new Error('connection lost')).code).toBe('SSH_NO_RESPONSE');
    expect(diagnoseAutoPrecheckFailure(new Error('algo inesperado')).code).toBe('SSH_ERROR');
  });

  it('erro de autorizacao nao vira inelegibilidade', () => {
    expect(
      diagnoseAutoPrecheckFailure(new Error('device not allowed: MITIGATION_ALLOWED_DEVICE_IDS')),
    ).toMatchObject({ code: 'AUTHORIZATION', ineligible: false });
  });

  it('erro de banco e transitorio', () => {
    const error = Object.assign(new Error('connection pool timeout'), { code: 'P1001' });
    expect(diagnoseAutoPrecheckFailure(error)).toMatchObject({
      code: 'TRANSIENT',
      ineligible: false,
    });
  });

  it('somente PLATFORM_NOT_SUPPORTED e marcado como ineligible', () => {
    const casos = [
      'SSH authentication failed',
      'SSH connection timeout',
      'ECONNREFUSED',
      'unreachable',
      'not allowed',
      'qualquer coisa',
    ];
    for (const message of casos) {
      expect(diagnoseAutoPrecheckFailure(new Error(message)).ineligible).toBe(false);
    }
  });
});

describe('P4-b — runAutoPrecheck mantem fail-closed com diagnostico', () => {
  it('devolve o valor quando a leitura funciona', async () => {
    const onFailure = vi.fn();
    const value = await runAutoPrecheck(async () => ({ ok: true }), onFailure);
    expect(value).toEqual({ ok: true });
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('devolve null e reporta o codigo quando a leitura falha', async () => {
    const onFailure = vi.fn();
    const value = await runAutoPrecheck(async () => {
      throw new Error('SSH connection timeout');
    }, onFailure);
    expect(value).toBeNull();
    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'SSH_TIMEOUT', ineligible: false }),
    );
  });
});
