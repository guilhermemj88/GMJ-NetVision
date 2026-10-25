import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerVsiDiagnosticRoutes, vsiDiagnosticEnabled } from '../../vsi-diagnostic-routes';

const user = { id: 'gate-operator', username: 'gate-operator', role: 'OPERATOR' as const };

function buildService(calls: string[]) {
  return {
    start: async () => {
      calls.push('start');
      return { diagnosticId: 'should-not-run' };
    },
    get: async () => {
      calls.push('get');
      return {};
    },
    cancel: async () => {
      calls.push('cancel');
      return {};
    },
  };
}

describe('gate de ativacao do diagnostico VSI', () => {
  it('e desabilitado por padrao', () => {
    expect(vsiDiagnosticEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(vsiDiagnosticEnabled({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('trata valores ambiguos como desabilitado', () => {
    expect(vsiDiagnosticEnabled({ VSI_DIAGNOSTIC_ENABLED: '1' } as NodeJS.ProcessEnv)).toBe(false);
    expect(vsiDiagnosticEnabled({ VSI_DIAGNOSTIC_ENABLED: 'yes' } as NodeJS.ProcessEnv)).toBe(false);
    expect(vsiDiagnosticEnabled({ VSI_DIAGNOSTIC_ENABLED: '' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('habilita somente com true explicito', () => {
    expect(vsiDiagnosticEnabled({ VSI_DIAGNOSTIC_ENABLED: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(vsiDiagnosticEnabled({ VSI_DIAGNOSTIC_ENABLED: ' TRUE ' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('com gate desligado responde 503 e NUNCA chama o service (zero SSH)', async () => {
    const previous = process.env.VSI_DIAGNOSTIC_ENABLED;
    delete process.env.VSI_DIAGNOSTIC_ENABLED;
    const calls: string[] = [];
    const app = Fastify();
    registerVsiDiagnosticRoutes(
      app as never,
      buildService(calls) as never,
      async () => user as never,
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/hosts/host-x/mpls/vsis/vsi-y/diagnose',
      payload: {},
    });
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body).enabled).toBe(false);
    expect(calls).toEqual([]);
    await app.close();
    if (previous !== undefined) process.env.VSI_DIAGNOSTIC_ENABLED = previous;
  });

  it('com gate ligado a rota volta a exigir o fluxo normal', async () => {
    const previous = process.env.VSI_DIAGNOSTIC_ENABLED;
    process.env.VSI_DIAGNOSTIC_ENABLED = 'true';
    const calls: string[] = [];
    const app = Fastify();
    registerVsiDiagnosticRoutes(
      app as never,
      buildService(calls) as never,
      async () => user as never,
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/hosts/host-x/mpls/vsis/vsi-y/diagnose',
      payload: {},
    });
    expect(response.statusCode).toBe(202);
    expect(calls).toEqual(['start']);
    await app.close();
    if (previous === undefined) delete process.env.VSI_DIAGNOSTIC_ENABLED;
    else process.env.VSI_DIAGNOSTIC_ENABLED = previous;
  });
});
