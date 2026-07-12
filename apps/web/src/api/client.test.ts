import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './client';

describe('API client', () => {
  beforeEach(() => {
    document.cookie = 'relaydock_csrf=csrf-token; path=/';
  });

  afterEach(() => {
    document.cookie = 'relaydock_csrf=; Max-Age=0; path=/';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('treats an unauthenticated session as signed out', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Sign in required' } }),
        {
          status: 401,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.session()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/session',
      expect.objectContaining({ credentials: 'include', method: 'GET' }),
    );
  });

  it('adds JSON and CSRF headers to authenticated mutations', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 'ABCD-EFGH', expiresAt: '2026-07-12T10:10:00.000Z' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.pairDevice();

    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(call[1].headers);
    expect(call[0]).toBe('/api/devices/pairing-codes');
    expect(call[1].credentials).toBe('include');
    expect(call[1].method).toBe('POST');
    expect(headers.get('x-csrf-token')).toBe('csrf-token');
  });

  it('surfaces the server error message and request id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 'DEVICE_OFFLINE',
              message: 'The agent is offline.',
              requestId: 'request-7',
            },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const request = api.createRepository('device-1', {
      name: 'MVP',
      absolutePath: '/tmp/mvp',
    });
    await expect(request).rejects.toMatchObject({
      status: 409,
      code: 'DEVICE_OFFLINE',
      message: 'The agent is offline.',
      requestId: 'request-7',
    });
  });

  it('paginates retained terminal output by sequence', async () => {
    const firstPage = Array.from({ length: 1_000 }, (_, sequence) => ({
      sequence,
      stream: 'stdout',
      data: `${sequence}\n`,
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ chunks: firstPage }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ chunks: [{ sequence: 1_000, stream: 'stdout', data: 'done\n' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const chunks = await api.output('job-1');

    expect(chunks).toHaveLength(1_001);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/jobs/job-1/output?afterSequence=-1',
      '/api/jobs/job-1/output?afterSequence=999',
    ]);
  });
});
