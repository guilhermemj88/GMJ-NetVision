// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { pollHost } from './api';

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
