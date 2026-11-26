import { describe, expect, it, vi } from 'vitest';
import { describeError } from '@crossmart/common';
import { ChatwootApiError, ChatwootClient } from './chatwoot.client.js';

describe('ChatwootClient', () => {
  it('sends api-access-token first so reverse proxies do not strip underscores', async () => {
    const client = new ChatwootClient();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ accounts: [{ id: 1, name: 'Elektrofertas' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const profile = await client.readProfile('https://chat.example.com/', 'test-token', fetchMock);

    expect(profile.accounts).toEqual([{ id: 1, name: 'Elektrofertas' }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init?.headers as Record<string, string>)['api-access-token']).toBe('test-token');
  });

  it('falls back once to api_access_token when api-access-token receives HTTP 401', async () => {
    const client = new ChatwootClient();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{"errors":["unauthorized"]}', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accounts: [{ id: 2, name: 'Direct' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const profile = await client.readProfile('https://direct.example.com', 'test-token', fetchMock);

    expect(profile.accounts).toEqual([{ id: 2, name: 'Direct' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>).api_access_token).toBe(
      'test-token',
    );
  });

  it('throws a coded ChatwootApiError that describeError preserves without leaking secrets', async () => {
    const client = new ChatwootClient();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"errors":["secret-leak"]}', { status: 401 }));

    await expect(
      client.readProfile('https://chat.example.com', 'super-secret-token', fetchMock),
    ).rejects.toThrow(ChatwootApiError);

    try {
      await client.readProfile('https://chat.example.com', 'super-secret-token', fetchMock);
    } catch (error) {
      const described = describeError(error);
      expect(described).toContain('CHATWOOT_UNAUTHORIZED');
      expect(described).not.toBe('Error');
      expect(described).not.toContain('super-secret-token');
      expect(described).not.toContain('secret-leak');
    }
  });
});
