// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUser, listUsers, pollHost } from './api';

describe('pollHost API client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts to the manual poll endpoint for the requested host', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          hostId: 'huawei/s6750',
          polledAt: '2026-08-24T12:00:00.000Z',
          interfacesChecked: 42,
          interfaceSamples: 0,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await pollHost('huawei/s6750');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/hosts/huawei%2Fs6750/poll',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
      }),
    );
  });
});

describe('apiUrl resolution (client)', () => {
  const originalUrl = process.env.NEXT_PUBLIC_API_URL;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL;
    else process.env.NEXT_PUBLIC_API_URL = originalUrl;
  });

  const jsonOk = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

  it.each([
    ['', '/api/users'],
    ['http://localhost:3333', '/api/users'],
    ['http://127.0.0.1:3335/', '/api/users'],
  ])('uses same-origin URLs for NEXT_PUBLIC_API_URL=%j', async (configured, expected) => {
    process.env.NEXT_PUBLIC_API_URL = configured;
    const fetchMock = vi.fn().mockResolvedValue(jsonOk([]));
    vi.stubGlobal('fetch', fetchMock);

    await listUsers();

    expect(fetchMock).toHaveBeenCalledWith(
      expected,
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('keeps external API URLs absolute', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.example.com';
    const fetchMock = vi.fn().mockResolvedValue(jsonOk([]));
    vi.stubGlobal('fetch', fetchMock);

    await listUsers();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/api/users',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('posts create-user to the same origin', async () => {
    process.env.NEXT_PUBLIC_API_URL = '';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'u1',
          username: 'x',
          email: 'x@example.com',
          name: 'X',
          role: 'VIEWER',
          enabled: true,
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await createUser({
      username: 'x',
      email: 'x@example.com',
      name: 'X',
      password: 'secret',
      role: 'VIEWER',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/users',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
  });
});
