import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const getBoxImConfigMock = vi.fn();
const getOneApiBaseUrlMock = vi.fn();
const ensureOwnerAccessTokenMock = vi.fn();
const sendJsonMock = vi.fn();

vi.mock('@electron/utils/box-im-sync', () => ({
  getBoxImConfig: (...args: unknown[]) => getBoxImConfigMock(...args),
  getOneApiBaseUrl: (...args: unknown[]) => getOneApiBaseUrlMock(...args),
  ensureOwnerAccessToken: (...args: unknown[]) => ensureOwnerAccessTokenMock(...args),
}));

vi.mock('@electron/api/route-utils', () => ({
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
  parseJsonBody: vi.fn(),
}));

describe('handleOneApiRoutes account summary', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getOneApiBaseUrlMock.mockResolvedValue('https://one-api.example.com');
    vi.stubGlobal('fetch', vi.fn());
  });

  it('prefers the OneAPI billing endpoints with tokenKey', async () => {
    getBoxImConfigMock.mockResolvedValue({
      tokenKey: 'token-key',
      accessToken: 'owner-access-token',
      openid: 'openid-1',
      apiUrl: 'https://im.shadanai.com/api',
      ownerUserId: 325,
      accounts: {},
    });

    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === 'https://one-api.example.com/api/status') {
        return new Response(JSON.stringify({
          data: {
            top_up_link: 'https://pay.example.com',
            quota_per_unit: 500000,
            display_in_currency: true,
          },
        }), { status: 200 });
      }

      if (url === 'https://one-api.example.com/v1/dashboard/billing/subscription') {
        expect((init?.headers as Record<string, string>)?.Authorization).toBe('Bearer token-key');
        return new Response(JSON.stringify({
          hard_limit_usd: 1500,
        }), { status: 200 });
      }

      if (url === 'https://one-api.example.com/v1/dashboard/billing/usage') {
        expect((init?.headers as Record<string, string>)?.Authorization).toBe('Bearer token-key');
        return new Response(JSON.stringify({
          total_usage: 2500,
        }), { status: 200 });
      }

      throw new Error(`unexpected url: ${url}`);
    });

    const { handleOneApiRoutes } = await import('@electron/api/routes/oneapi');
    const handled = await handleOneApiRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:13210/api/oneapi/account-summary'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(ensureOwnerAccessTokenMock).not.toHaveBeenCalled();
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        loggedIn: true,
        userId: 325,
        username: null,
        totalAmount: 1500,
        usedAmount: 25,
        remainingAmount: 1475,
        totalQuota: 750000000,
        usedQuota: 12500000,
        remainingQuota: 737500000,
        userSelfSupported: false,
      }),
    );
  });

  it('falls back to owner access token when billing endpoints fail', async () => {
    getBoxImConfigMock.mockResolvedValue({
      tokenKey: 'token-key',
      accessToken: null,
      openid: 'openid-2',
      apiUrl: 'https://im.shadanai.com/api',
      ownerUserId: 502,
      accounts: {},
    });
    ensureOwnerAccessTokenMock.mockResolvedValue('repaired-access-token');

    let usageCalled = false;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === 'https://one-api.example.com/api/status') {
        return new Response(JSON.stringify({
          data: {
            top_up_link: 'https://pay.example.com',
            quota_per_unit: 500000,
            display_in_currency: true,
          },
        }), { status: 200 });
      }

      if (url === 'https://one-api.example.com/v1/dashboard/billing/subscription') {
        return new Response(JSON.stringify({
          error: { message: 'invalid token' },
        }), { status: 401 });
      }

      if (url === 'https://one-api.example.com/v1/dashboard/billing/usage') {
        usageCalled = true;
        return new Response(JSON.stringify({
          total_usage: 999,
        }), { status: 200 });
      }

      if (url === 'https://one-api.example.com/api/user/self') {
        expect((init?.headers as Record<string, string>)?.Authorization).toBe('repaired-access-token');
        return new Response(JSON.stringify({
          success: true,
          data: {
            id: 502,
            username: 'repaired-user',
            quota: 500000,
            used_quota: 100000,
          },
        }), { status: 200 });
      }

      throw new Error(`unexpected url: ${url}`);
    });

    const { handleOneApiRoutes } = await import('@electron/api/routes/oneapi');
    await handleOneApiRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:13210/api/oneapi/account-summary'),
      {} as never,
    );

    expect(usageCalled).toBe(true);
    expect(ensureOwnerAccessTokenMock).toHaveBeenCalledWith();
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        userId: 502,
        username: 'repaired-user',
        totalAmount: 1,
        usedAmount: 0.2,
        remainingAmount: 0.8,
        userSelfSupported: true,
      }),
    );
  });

  it('refreshes and retries the owner access token when fallback user self is invalid', async () => {
    getBoxImConfigMock.mockResolvedValue({
      tokenKey: 'token-key',
      accessToken: 'stale-access-token',
      openid: 'openid-3',
      apiUrl: 'https://im.shadanai.com/api',
      ownerUserId: 601,
      accounts: {},
    });
    ensureOwnerAccessTokenMock.mockResolvedValue('fresh-access-token');

    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === 'https://one-api.example.com/api/status') {
        return new Response(JSON.stringify({
          data: {
            top_up_link: 'https://pay.example.com',
            quota_per_unit: 500000,
            display_in_currency: false,
          },
        }), { status: 200 });
      }

      if (url === 'https://one-api.example.com/v1/dashboard/billing/subscription') {
        return new Response(JSON.stringify({
          error: { message: 'invalid token' },
        }), { status: 401 });
      }

      if (url === 'https://one-api.example.com/v1/dashboard/billing/usage') {
        return new Response(JSON.stringify({
          total_usage: 0,
        }), { status: 200 });
      }

      if (url === 'https://one-api.example.com/api/user/self') {
        const auth = (init?.headers as Record<string, string>)?.Authorization;
        if (auth === 'stale-access-token') {
          return new Response(JSON.stringify({
            message: '无权进行此操作，access token 无效',
          }), { status: 401 });
        }

        expect(auth).toBe('fresh-access-token');
        return new Response(JSON.stringify({
          success: true,
          data: {
            id: 601,
            username: 'fresh-user',
            quota: 3000,
            used_quota: 1000,
          },
        }), { status: 200 });
      }

      throw new Error(`unexpected url: ${url}`);
    });

    const { handleOneApiRoutes } = await import('@electron/api/routes/oneapi');
    await handleOneApiRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:13210/api/oneapi/account-summary'),
      {} as never,
    );

    expect(ensureOwnerAccessTokenMock).toHaveBeenCalledWith(true);
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        userId: 601,
        username: 'fresh-user',
        remainingQuota: 2000,
      }),
    );
  });
});
