import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerMplsRoutes } from './mpls-routes';

const huawei = {
  id: 'h1',
  name: 'NE40',
  vendor: 'Huawei',
  model: 'NE40E-X8A',
  deviceType: 'ROUTER',
};
const juniper = {
  id: 'h2',
  name: 'MX204',
  vendor: 'Juniper',
  model: 'MX204',
  deviceType: 'ROUTER',
};

function build(options: {
  host?: Record<string, unknown> | null;
  role?: 'ADMIN' | 'OPERATOR' | null;
  enabled?: boolean;
  canWrite?: boolean;
  canAudit?: boolean;
  protection?: { protected: boolean; by?: string; detail?: string };
}) {
  const setSshFallbackEnabled = vi.fn(async () => undefined);
  const recordSshFallbackAudit = vi.fn(async () => undefined);
  const app = Fastify();
  registerMplsRoutes(app as never, {
    hosts: {
      getHost: async () => (options.host === null ? null : (options.host ?? huawei)),
    } as never,
    mpls: {
      getHostOverview: async () => ({}),
      listVsis: async () => [],
      listPws: async () => [],
      listEvents: async () => [],
      isSshFallbackEnabled: async () => options.enabled === true,
      ...(options.canWrite === false ? {} : { setSshFallbackEnabled }),
      ...(options.canAudit === false ? {} : { recordSshFallbackAudit }),
    } as never,
    currentUser: async () =>
      options.role === null
        ? null
        : ({ id: 'u1', username: 'operador', role: options.role ?? 'ADMIN' } as never),
    ...(options.protection
      ? {
          autoAllProtection: async () =>
            options.protection!.protected
              ? {
                  protected: true as const,
                  by: (options.protection!.by ?? 'SINGLE_PILOT_F1A') as never,
                  detail: options.protection!.detail ?? 'piloto',
                }
              : { protected: false as const },
        }
      : {}),
  });
  return { app, setSshFallbackEnabled, recordSshFallbackAudit };
}

describe('P6 — opt-in do fallback CLI MPLS pela API', () => {
  it('default false quando nao ha habilitacao gravada', async () => {
    const { app } = build({ enabled: false });
    const response = await app.inject({ method: 'GET', url: '/api/hosts/h1/mpls/ssh-fallback' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      hostId: 'h1',
      sshFallbackEnabled: false,
      configurable: true,
      autoAllProtected: false,
      protectionBy: null,
    });
    await app.close();
  });

  it('PUT sem usuario autenticado responde 401 e nao grava', async () => {
    const { app, setSshFallbackEnabled } = build({ role: null });
    const response = await app.inject({
      method: 'PUT',
      url: '/api/hosts/h1/mpls/ssh-fallback',
      payload: { enabled: true },
    });
    expect(response.statusCode).toBe(401);
    expect(setSshFallbackEnabled).not.toHaveBeenCalled();
    await app.close();
  });

  it('PUT de OPERATOR responde 403 e nao grava', async () => {
    const { app, setSshFallbackEnabled } = build({ role: 'OPERATOR' });
    const response = await app.inject({
      method: 'PUT',
      url: '/api/hosts/h1/mpls/ssh-fallback',
      payload: { enabled: true },
    });
    expect(response.statusCode).toBe(403);
    expect(setSshFallbackEnabled).not.toHaveBeenCalled();
    await app.close();
  });

  it('ADMIN habilita em Huawei VRP identificado', async () => {
    const { app, setSshFallbackEnabled } = build({ host: huawei });
    const response = await app.inject({
      method: 'PUT',
      url: '/api/hosts/h1/mpls/ssh-fallback',
      payload: { enabled: true },
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).sshFallbackEnabled).toBe(true);
    expect(setSshFallbackEnabled).toHaveBeenCalledWith('h1', true);
    await app.close();
  });

  it('ADMIN nao consegue habilitar em Juniper (409) — falha fechada', async () => {
    const { app, setSshFallbackEnabled } = build({ host: juniper });
    const response = await app.inject({
      method: 'PUT',
      url: '/api/hosts/h2/mpls/ssh-fallback',
      payload: { enabled: true },
    });
    expect(response.statusCode).toBe(409);
    expect(setSshFallbackEnabled).not.toHaveBeenCalled();
    await app.close();
  });

  it('desabilitar e sempre permitido, inclusive em Juniper', async () => {
    const { app, setSshFallbackEnabled } = build({ host: juniper });
    const response = await app.inject({
      method: 'PUT',
      url: '/api/hosts/h2/mpls/ssh-fallback',
      payload: { enabled: false },
    });
    expect(response.statusCode).toBe(200);
    expect(setSshFallbackEnabled).toHaveBeenCalledWith('h2', false);
    await app.close();
  });

  it('host inexistente responde 404', async () => {
    const { app } = build({ host: null });
    const response = await app.inject({
      method: 'PUT',
      url: '/api/hosts/h1/mpls/ssh-fallback',
      payload: { enabled: true },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('repositorio sem suporte a gravacao responde 501', async () => {
    const { app } = build({ canWrite: false });
    const response = await app.inject({
      method: 'PUT',
      url: '/api/hosts/h1/mpls/ssh-fallback',
      payload: { enabled: true },
    });
    expect(response.statusCode).toBe(501);
    await app.close();
  });

  it('A1-e: sem trilha de auditoria a alteracao e recusada (fail-closed)', async () => {
    const { app, setSshFallbackEnabled } = build({ canAudit: false });
    const response = await app.inject({
      method: 'PUT',
      url: '/api/hosts/h1/mpls/ssh-fallback',
      payload: { enabled: true },
    });
    expect(response.statusCode).toBe(501);
    expect(setSshFallbackEnabled).not.toHaveBeenCalled();
    await app.close();
  });

  it('A1-e: equipamento do AUTO-ALL (F1A) nao pode ser habilitado', async () => {
    const { app, setSshFallbackEnabled, recordSshFallbackAudit } = build({
      protection: { protected: true, by: 'SINGLE_PILOT_F1A', detail: 'piloto AUTO-ALL (F1A)' },
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/hosts/h1/mpls/ssh-fallback',
      payload: { enabled: true },
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).code).toBe('AUTO_ALL_PROTECTED_DEVICE');
    expect(setSshFallbackEnabled).not.toHaveBeenCalled();
    expect(recordSshFallbackAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: 'h1',
        actorId: 'u1',
        actorUsername: 'operador',
        previousValue: false,
        newValue: true,
        result: 'DENIED_AUTO_ALL',
      }),
    );
    await app.close();
  });

  it('A1-e: DESABILITAR em equipamento protegido continua permitido', async () => {
    const { app, setSshFallbackEnabled, recordSshFallbackAudit } = build({
      enabled: true,
      protection: { protected: true, by: 'MITIGATION_ALLOWLIST', detail: 'allowlist' },
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/hosts/h1/mpls/ssh-fallback',
      payload: { enabled: false },
    });

    expect(response.statusCode).toBe(200);
    expect(setSshFallbackEnabled).toHaveBeenCalledWith('h1', false);
    expect(recordSshFallbackAudit).toHaveBeenCalledWith(
      expect.objectContaining({ previousValue: true, newValue: false, result: 'ALLOWED' }),
    );
    await app.close();
  });

  it('A1-e: trilha registra autorizacao negada por papel e por plataforma', async () => {
    const negadoPorPapel = build({ role: 'OPERATOR' });
    await negadoPorPapel.app.inject({
      method: 'PUT',
      url: '/api/hosts/h1/mpls/ssh-fallback',
      payload: { enabled: true },
    });
    expect(negadoPorPapel.recordSshFallbackAudit).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'DENIED_NOT_ADMIN' }),
    );
    await negadoPorPapel.app.close();

    const negadoPorPlataforma = build({ host: juniper });
    await negadoPorPlataforma.app.inject({
      method: 'PUT',
      url: '/api/hosts/h2/mpls/ssh-fallback',
      payload: { enabled: true },
    });
    expect(negadoPorPlataforma.recordSshFallbackAudit).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: 'h2', result: 'DENIED_PLATFORM' }),
    );
    await negadoPorPlataforma.app.close();
  });

  it('A1-e: habilitacao autorizada e registrada antes de persistir', async () => {
    const { app, setSshFallbackEnabled, recordSshFallbackAudit } = build({
      protection: { protected: false },
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/hosts/h1/mpls/ssh-fallback',
      payload: { enabled: true },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ sshFallbackEnabled: true, previousValue: false });
    expect(recordSshFallbackAudit).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'ALLOWED', actorUsername: 'operador' }),
    );
    expect(setSshFallbackEnabled).toHaveBeenCalledWith('h1', true);
    await app.close();
  });
});
