import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  READ_ONLY_WRITE_ALLOWED_MODELS,
  READ_ONLY_WRITE_OPERATIONS,
  ReadOnlyViolationError,
  assertOperationAllowed,
  isReadOnlyMode,
  isReadOnlyRequestBlocked,
  parseReadOnlyFlag,
  readOnlyPathOf,
  registerReadOnlyGuard,
} from './read-only';

describe('flag de read-only', () => {
  it('só ativa com valor explícito', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on', ' sim ']) {
      expect(parseReadOnlyFlag(value)).toBe(true);
    }
    for (const value of [undefined, null, '', '0', 'false', 'off', 'no', 'talvez']) {
      expect(parseReadOnlyFlag(value)).toBe(false);
    }
    expect(isReadOnlyMode({})).toBe(false);
    expect(isReadOnlyMode({ NETVISION_READ_ONLY: '1' })).toBe(true);
    expect(isReadOnlyMode({ NETVISION_READ_ONLY: '0' })).toBe(false);
  });
});

describe('trava HTTP do modo read-only', () => {
  it('permite leitura', () => {
    for (const method of ['GET', 'get', 'HEAD', 'OPTIONS']) {
      expect(isReadOnlyRequestBlocked(method, '/api/maps')).toBe(false);
      expect(isReadOnlyRequestBlocked(method, '/api/maps/abc/links?limit=10')).toBe(false);
    }
  });

  it('bloqueia qualquer escrita', () => {
    const cases: [string, string][] = [
      ['POST', '/api/maps'],
      ['PATCH', '/api/maps/abc'],
      ['PUT', '/api/maps/abc/nodes/node-1'],
      ['DELETE', '/api/links/link-1'],
      ['POST', '/api/discovery/run'],
      ['POST', '/api/mitigation/execute'],
      ['POST', '/api/bgp/peers/p1/admin-state'],
      ['POST', '/api/physical/ports/p1'],
      ['POST', '/api/users'],
    ];
    for (const [method, url] of cases) {
      expect(isReadOnlyRequestBlocked(method, url), `${method} ${url}`).toBe(true);
    }
  });

  it('mantém o login/logout como escrita tolerada', () => {
    expect(isReadOnlyRequestBlocked('POST', '/api/auth/login')).toBe(false);
    expect(isReadOnlyRequestBlocked('POST', '/api/auth/login?next=map')).toBe(false);
    expect(isReadOnlyRequestBlocked('POST', '/api/auth/login/')).toBe(false);
    expect(isReadOnlyRequestBlocked('POST', '/api/auth/logout')).toBe(false);
    // Nada além da autenticação.
    expect(isReadOnlyRequestBlocked('POST', '/api/auth/login-extra')).toBe(true);
    expect(isReadOnlyRequestBlocked('POST', '/api/auth/login/../logout')).toBe(true);
    expect(isReadOnlyRequestBlocked('POST', '/api/users')).toBe(true);
  });

  it('normaliza a URL antes de comparar', () => {
    expect(readOnlyPathOf('/api/auth/login?u=1#x')).toBe('/api/auth/login');
    expect(readOnlyPathOf('/api/auth/login')).toBe('/api/auth/login');
  });
});

describe('trava de escrita no Prisma', () => {
  it('lista todas as operações de escrita conhecidas', () => {
    for (const operation of [
      'create',
      'createMany',
      'update',
      'updateMany',
      'upsert',
      'delete',
      'deleteMany',
      'executeRaw',
      'executeRawUnsafe',
    ]) {
      expect(READ_ONLY_WRITE_OPERATIONS).toContain(operation);
    }
  });

  it('lança para escrita e passa para leitura', () => {
    for (const operation of READ_ONLY_WRITE_OPERATIONS) {
      expect(() => assertOperationAllowed(operation)).toThrow(ReadOnlyViolationError);
      expect(() => assertOperationAllowed(operation, 'Map')).toThrow(ReadOnlyViolationError);
      expect(() => assertOperationAllowed(operation, 'Link')).toThrow(ReadOnlyViolationError);
      expect(() => assertOperationAllowed(operation, 'User')).toThrow(ReadOnlyViolationError);
    }
    for (const operation of [
      'findMany',
      'findFirst',
      'findUnique',
      'count',
      'aggregate',
      'groupBy',
      'queryRaw',
    ]) {
      expect(() => assertOperationAllowed(operation)).not.toThrow();
      expect(() => assertOperationAllowed(operation, 'Map')).not.toThrow();
    }
  });

  it('tolera escrita APENAS na sessão de autenticação', () => {
    expect(READ_ONLY_WRITE_ALLOWED_MODELS).toEqual(['Session']);
    expect(() => assertOperationAllowed('create', 'Session')).not.toThrow();
    expect(() => assertOperationAllowed('deleteMany', 'Session')).not.toThrow();
    // Nenhum outro modelo passa, nem com o mesmo verbo.
    for (const model of ['Map', 'MapNode', 'Link', 'Device', 'Alarm', 'User', 'Host']) {
      expect(() => assertOperationAllowed('create', model)).toThrow(ReadOnlyViolationError);
    }
  });

  it('SQL cru continua bloqueado (sem modelo)', () => {
    expect(() => assertOperationAllowed('executeRaw')).toThrow(ReadOnlyViolationError);
    expect(() => assertOperationAllowed('executeRawUnsafe')).toThrow(ReadOnlyViolationError);
  });

  it('o erro identifica a operação barrada', () => {
    try {
      assertOperationAllowed('updateMany', 'Map');
      throw new Error('deveria ter lançado');
    } catch (error) {
      expect(error).toBeInstanceOf(ReadOnlyViolationError);
      expect((error as ReadOnlyViolationError).operation).toBe('updateMany');
      expect((error as ReadOnlyViolationError).model).toBe('Map');
      expect((error as Error).name).toBe('ReadOnlyViolationError');
    }
  });
});

describe('guarda HTTP registrada no Fastify', () => {
  async function appWithGuard(readOnly: boolean) {
    const app = Fastify();
    registerReadOnlyGuard(app, readOnly ? { NETVISION_READ_ONLY: '1' } : {});
    app.get('/api/maps', async () => ({ ok: true }));
    app.post('/api/maps', async () => ({ ok: true }));
    app.post('/api/auth/login', async () => ({ ok: true }));
    app.patch('/api/links/:id', async () => ({ ok: true }));
    await app.ready();
    return app;
  }

  it('sem a flag nada muda (produção intacta)', async () => {
    const app = await appWithGuard(false);
    expect((await app.inject({ method: 'POST', url: '/api/maps' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: '/api/links/l1' })).statusCode).toBe(200);
    await app.close();
  });

  it('com a flag só leitura e login passam', async () => {
    const app = await appWithGuard(true);

    expect((await app.inject({ method: 'GET', url: '/api/maps' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'HEAD', url: '/api/maps' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login' })).statusCode).toBe(200);

    const blocked = await app.inject({ method: 'POST', url: '/api/maps' });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ readOnly: true });

    expect((await app.inject({ method: 'PATCH', url: '/api/links/l1' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: '/api/links/l1' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/links/l1' })).statusCode).toBe(403);
    await app.close();
  });
});
