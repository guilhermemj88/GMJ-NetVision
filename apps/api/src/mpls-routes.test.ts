import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerMplsRoutes } from './mpls-routes';

const overview = {
  supported: true,
  capabilities: { vsi: true, pw: true, ac: true },
  source: 'SNMP',
  lastPollingAt: null,
  lastSuccessAt: null,
  lastErrorSafe: null,
  summary: { vsiTotal: 0, vsiUp: 0, vsiDown: 0, vsiDegraded: 0, vsiAdminDown: 0, vsiUnknown: 0, pwTotal: 0, pwUp: 0, pwDown: 0 },
  vsis: [],
};

function build() {
  const app = Fastify();
  registerMplsRoutes(app as never, {
    hosts: { getHost: async () => ({ id: 'h1', name: 'PE' }) } as never,
    mpls: {
      getHostOverview: async () => overview,
      listVsis: async () => [],
      listPws: async () => [],
      listEvents: async () => [],
    } as never,
  });
  return app;
}

const previous = process.env.VSI_DIAGNOSTIC_ENABLED;
afterEach(() => {
  if (previous === undefined) delete process.env.VSI_DIAGNOSTIC_ENABLED;
  else process.env.VSI_DIAGNOSTIC_ENABLED = previous;
});

describe('overview MPLS — estado do diagnostico VSI em runtime', () => {
  it('reporta diagnosticEnabled=false sem a flag', async () => {
    delete process.env.VSI_DIAGNOSTIC_ENABLED;
    const app = build();
    const response = await app.inject({ method: 'GET', url: '/api/hosts/h1/mpls' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.diagnosticEnabled).toBe(false);
    expect(body.diagnosticTrust).toBe('UNAVAILABLE');
    expect(body.supported).toBe(true);
    await app.close();
  });

  it('reporta diagnosticEnabled=true com a flag, sem alterar o resto do overview', async () => {
    process.env.VSI_DIAGNOSTIC_ENABLED = 'true';
    const app = build();
    const response = await app.inject({ method: 'GET', url: '/api/hosts/h1/mpls' });
    const body = JSON.parse(response.body);
    expect(body.diagnosticEnabled).toBe(true);
    expect(body.summary).toEqual(overview.summary);
    await app.close();
  });
});
