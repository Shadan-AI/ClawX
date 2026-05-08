import type { IncomingMessage, ServerResponse } from 'http';
import { ensureOwnerAccessToken, getBoxImConfig, getOneApiBaseUrl } from '../../utils/box-im-sync';
import { renderQrPngDataUrl } from '../../utils/qr-code';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

type OneApiStatusPayload = {
  top_up_link?: unknown;
  quota_per_unit?: unknown;
  display_in_currency?: unknown;
};

type OneApiEnvelope<T> = {
  success?: boolean;
  message?: string;
  data?: T;
};

type OneApiErrorPayload = {
  error?: {
    message?: string;
  };
};

type OneApiUserSelfPayload = {
  id?: unknown;
  username?: unknown;
  quota?: unknown;
  used_quota?: unknown;
};

type OneApiBillingSubscriptionPayload = {
  hard_limit_usd?: unknown;
  soft_limit_usd?: unknown;
};

type OneApiBillingUsagePayload = {
  total_usage?: unknown;
};

type OneApiRedeemRequest = {
  key?: string;
};

type OneApiRechargeRequest = {
  amount?: unknown;
};

type JeecgEnvelope<T> = {
  success?: boolean;
  message?: string;
  code?: number;
  result?: T;
};

type JeecgRechargePayload = {
  transactionId?: unknown;
  qrCodeUrl?: unknown;
  amount?: unknown;
  currency?: unknown;
  tokenAmount?: unknown;
};

function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function coerceBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
}

function coerceString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isTimeoutMessage(message?: string | null): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return lower.includes('aborted due to timeout')
    || lower.includes('timed out')
    || lower.includes('timeout');
}

function normalizeTimeoutMessage(message: string, fallback: string): string {
  return isTimeoutMessage(message) ? fallback : message;
}

function isLikelyAccessTokenError(message?: string | null): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return lower.includes('access token')
    || lower.includes('unauthorized')
    || lower.includes('未登录')
    || lower.includes('无权进行此操作');
}

async function requestJson<T>(
  url: string,
  options?: {
    authToken?: string | null;
    headers?: Record<string, string>;
    method?: 'GET' | 'POST';
    body?: unknown;
    timeoutMs?: number;
    retries?: number;
  },
): Promise<T> {
  const retries = Math.max(options?.retries ?? 0, 0);
  const timeoutMs = Math.max(options?.timeoutMs ?? 20_000, 1_000);

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const headers: Record<string, string> = {
        ...(options?.headers ?? {}),
      };
      if (options?.authToken) {
        headers.Authorization = `Bearer ${options.authToken}`;
      }
      if (options?.body !== undefined && !headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }

      const response = await fetch(url, {
        method: options?.method ?? 'GET',
        headers,
        body: options?.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      const rawText = await response.text();
      let payload: unknown = null;
      if (rawText.trim()) {
        try {
          payload = JSON.parse(rawText);
        } catch {
          payload = rawText;
        }
      }

      if (!response.ok) {
        const message = typeof payload === 'object' && payload
          ? coerceString((payload as { message?: unknown }).message)
            ?? coerceString((payload as { error?: unknown }).error)
            ?? response.statusText
          : coerceString(payload) ?? response.statusText;
        throw new Error(message || `Request failed: ${response.status}`);
      }

      const oneApiErrorMessage = typeof payload === 'object' && payload && 'error' in payload
        ? coerceString((payload as OneApiErrorPayload).error?.message)
        : null;
      if (oneApiErrorMessage) {
        throw new Error(oneApiErrorMessage);
      }

      return payload as T;
    } catch (error) {
      if (attempt >= retries) {
        throw error;
      }
    }
  }

  throw new Error('Request failed');
}

async function requestOneApiJson<T>(
  baseUrl: string,
  path: string,
  options?: {
    authToken?: string | null;
    method?: 'GET' | 'POST';
    body?: unknown;
    timeoutMs?: number;
    retries?: number;
  },
): Promise<T> {
  return await requestJson<T>(`${baseUrl}${path}`, options);
}

async function requestOneApiUserSelf(
  baseUrl: string,
  accessToken: string,
): Promise<OneApiEnvelope<OneApiUserSelfPayload>> {
  return await requestJson<OneApiEnvelope<OneApiUserSelfPayload>>(`${baseUrl}/api/user/self`, {
    headers: {
      Authorization: accessToken,
    },
    timeoutMs: 15_000,
    retries: 1,
  });
}

async function requestOneApiBillingSubscription(
  baseUrl: string,
  tokenKey: string,
): Promise<OneApiBillingSubscriptionPayload> {
  return await requestJson<OneApiBillingSubscriptionPayload>(`${baseUrl}/v1/dashboard/billing/subscription`, {
    headers: {
      Authorization: `Bearer ${tokenKey}`,
    },
    timeoutMs: 15_000,
    retries: 1,
  });
}

async function requestOneApiBillingUsage(
  baseUrl: string,
  tokenKey: string,
): Promise<OneApiBillingUsagePayload> {
  return await requestJson<OneApiBillingUsagePayload>(`${baseUrl}/v1/dashboard/billing/usage`, {
    headers: {
      Authorization: `Bearer ${tokenKey}`,
    },
    timeoutMs: 15_000,
    retries: 1,
  });
}

function unwrapJeecgResult<T>(payload: JeecgEnvelope<T>): T {
  if (!payload || typeof payload !== 'object') {
    throw new Error('充值服务返回了无效数据');
  }
  if (payload.success === false) {
    throw new Error(payload.message || '充值服务返回失败');
  }
  if (payload.result === undefined) {
    throw new Error(payload.message || '充值服务没有返回支付信息');
  }
  return payload.result;
}

function resolvePaymentBaseUrl(apiUrl: string): string {
  const trimmed = apiUrl.trim();
  if (!trimmed) return '';
  return trimmed.replace(/\/api\/?$/i, '');
}

function buildAccountSummaryPayload(params: {
  topUpLink: string | null;
  userId: number | null;
  username: string | null;
  rechargeSupported: boolean;
  quotaPerUnit: number;
  displayInCurrency: boolean;
  totalAmount: number | null;
  usedAmount: number | null;
  userSelfSupported: boolean;
  userQuota: number | null;
  userUsedQuota: number | null;
  error?: string;
}) {
  const {
    topUpLink,
    userId,
    username,
    rechargeSupported,
    quotaPerUnit,
    displayInCurrency,
    totalAmount,
    usedAmount,
    userSelfSupported,
    userQuota,
    userUsedQuota,
    error,
  } = params;

  const toAmountValue = (quota: number | null): number | null => {
    if (quota === null) return null;
    if (!displayInCurrency) return Math.round(quota);
    if (quotaPerUnit <= 0) return null;
    return quota / quotaPerUnit;
  };

  const toQuotaValue = (amount: number | null): number | null => {
    if (amount === null) return null;
    if (!displayInCurrency) return Math.round(amount);
    if (quotaPerUnit <= 0) return null;
    return Math.round(amount * quotaPerUnit);
  };

  const resolvedTotalAmount = totalAmount ?? toAmountValue(userQuota);
  const resolvedUsedAmount = usedAmount ?? toAmountValue(userUsedQuota);
  const resolvedRemainingAmount = resolvedTotalAmount !== null && resolvedUsedAmount !== null
    ? Math.max(resolvedTotalAmount - resolvedUsedAmount, 0)
    : null;
  const totalQuota = userQuota ?? toQuotaValue(totalAmount);
  const usedQuota = userUsedQuota ?? toQuotaValue(usedAmount);
  const remainingQuota = totalQuota !== null && usedQuota !== null
    ? Math.max(totalQuota - usedQuota, 0)
    : toQuotaValue(resolvedRemainingAmount);

  return {
    loggedIn: true,
    topUpLink,
    userId,
    username,
    rechargeSupported,
    quotaPerUnit,
    displayInCurrency,
    totalAmount: resolvedTotalAmount,
    usedAmount: resolvedUsedAmount,
    remainingAmount: resolvedRemainingAmount,
    totalQuota,
    usedQuota,
    remainingQuota,
    userSelfSupported,
    redeemCodeSupported: userSelfSupported,
    ...(error ? { error } : {}),
  };
}

export async function handleOneApiRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/oneapi/account-summary' && req.method === 'GET') {
    const { tokenKey, accessToken, apiUrl, ownerUserId } = await getBoxImConfig();
    const baseUrl = await getOneApiBaseUrl();
    const rechargeSupported = !!tokenKey
      && typeof ownerUserId === 'number'
      && ownerUserId > 0
      && !!resolvePaymentBaseUrl(apiUrl);
    if (!tokenKey) {
      sendJson(res, 200, {
        loggedIn: false,
        topUpLink: null,
        userId: null,
        username: null,
        rechargeSupported: false,
        quotaPerUnit: 0,
        displayInCurrency: false,
        totalAmount: null,
        usedAmount: null,
        remainingAmount: null,
        totalQuota: null,
        usedQuota: null,
        remainingQuota: null,
        userSelfSupported: false,
        redeemCodeSupported: false,
      });
      return true;
    }

    const statusPromise = requestOneApiJson<OneApiEnvelope<OneApiStatusPayload>>(baseUrl, '/api/status', {
      timeoutMs: 15_000,
      retries: 1,
    }).catch(() => null);
    const billingSummaryPromise = (async () => {
      try {
        const [subscription, usage] = await Promise.all([
          requestOneApiBillingSubscription(baseUrl, tokenKey),
          requestOneApiBillingUsage(baseUrl, tokenKey),
        ]);
        const totalAmount = coerceNumber(subscription.hard_limit_usd)
          ?? coerceNumber(subscription.soft_limit_usd);
        const totalUsage = coerceNumber(usage.total_usage);

        return {
          totalAmount,
          usedAmount: totalUsage === null ? null : totalUsage / 100,
          userSelf: null as OneApiEnvelope<OneApiUserSelfPayload> | null,
        };
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();
    const userSelfPromise = (async () => {
      const billingSummary = await billingSummaryPromise;
      if (typeof billingSummary !== 'string') {
        return billingSummary;
      }
      const resolvedAccessToken = accessToken || await ensureOwnerAccessToken();
      if (!resolvedAccessToken) {
        return billingSummary;
      }
      if (!resolvedAccessToken) {
        return '当前账号缺少 OneAPI access token，请重新登录后再查看余额';
      }

      try {
        return {
          totalAmount: null,
          usedAmount: null,
          userSelf: await requestOneApiUserSelf(baseUrl, resolvedAccessToken),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isLikelyAccessTokenError(message)) {
          return message;
        }

        const refreshedAccessToken = await ensureOwnerAccessToken(true);
        if (!refreshedAccessToken || refreshedAccessToken === resolvedAccessToken) {
          return message;
        }

        try {
          return {
            totalAmount: null,
            usedAmount: null,
            userSelf: await requestOneApiUserSelf(baseUrl, refreshedAccessToken),
          };
        } catch (retryError) {
          return retryError instanceof Error ? retryError.message : String(retryError);
        }
      }
    })();

    const [statusPayload, userSelfResult] = await Promise.all([statusPromise, userSelfPromise]);

    const statusData = statusPayload?.data;
    const topUpLink = coerceString(statusData?.top_up_link);
    const quotaPerUnit = coerceNumber(statusData?.quota_per_unit) ?? 0;
    const displayInCurrency = coerceBoolean(statusData?.display_in_currency, false);

    const userSelfPayload = typeof userSelfResult !== 'string' ? userSelfResult.userSelf : null;
    const billingSupported = typeof userSelfResult !== 'string' && userSelfResult.userSelf === null;
    const userSelfSupported = !!userSelfPayload && userSelfPayload.success === true;
    const userId = billingSupported
      ? ownerUserId
      : userSelfSupported
        ? coerceNumber(userSelfPayload.data?.id)
        : null;
    const username = userSelfSupported ? coerceString(userSelfPayload.data?.username) : null;
    const userQuota = userSelfSupported ? coerceNumber(userSelfPayload.data?.quota) : null;
    const userUsedQuota = userSelfSupported ? coerceNumber(userSelfPayload.data?.used_quota) : null;
    const userSelfError = typeof userSelfResult === 'string' ? userSelfResult : undefined;
    const totalAmount = typeof userSelfResult !== 'string' ? userSelfResult.totalAmount : null;
    const usedAmount = typeof userSelfResult !== 'string' ? userSelfResult.usedAmount : null;

    sendJson(res, 200, buildAccountSummaryPayload({
      topUpLink,
      userId,
      username,
      rechargeSupported,
      quotaPerUnit,
      displayInCurrency,
      totalAmount,
      usedAmount,
      userSelfSupported,
      userQuota,
      userUsedQuota,
      error: userSelfError,
    }));
    return true;
  }

  if (url.pathname === '/api/oneapi/recharge-order' && req.method === 'POST') {
    const { tokenKey, apiUrl, ownerUserId } = await getBoxImConfig();
    if (!tokenKey) {
      sendJson(res, 401, { success: false, error: '请先登录账号' });
      return true;
    }
    if (typeof ownerUserId !== 'number' || ownerUserId <= 0) {
      sendJson(res, 400, { success: false, error: '当前账号缺少充值用户信息，请重新登录后重试' });
      return true;
    }

    const paymentBaseUrl = resolvePaymentBaseUrl(apiUrl);
    if (!paymentBaseUrl) {
      sendJson(res, 400, { success: false, error: '当前没有可用的充值服务地址' });
      return true;
    }

    const body = await parseJsonBody<OneApiRechargeRequest>(req);
    const amount = coerceNumber(body.amount);
    const amountYuan = amount === null ? null : Math.round(amount);
    if (amountYuan === null || !Number.isInteger(amountYuan) || amountYuan <= 0) {
      sendJson(res, 400, { success: false, error: '请选择有效的充值金额' });
      return true;
    }

    const amountCents = amountYuan * 100;
    const quota = amountCents * 5000;

    try {
      const payload = await requestJson<JeecgEnvelope<JeecgRechargePayload>>(
        `${paymentBaseUrl}/wxpay/tokens/purchase`,
        {
          method: 'POST',
          headers: {
            'X-Access-Token': tokenKey,
          },
          authToken: tokenKey,
          body: {
            userId: String(ownerUserId),
            packageId: `oneapi-topup-${amountYuan}`,
            packageName: tokenKey,
            tokenAmount: quota,
            bonusAmount: 0,
            price: amountCents,
            paymentMethod: 'WECHAT',
          },
          timeoutMs: 20_000,
          retries: 0,
        },
      );

      const result = unwrapJeecgResult(payload);
      const qrCodeUrl = coerceString(result.qrCodeUrl);
      if (!qrCodeUrl) {
        throw new Error('充值服务没有返回微信二维码');
      }

      const qrCodeDataUrl = await renderQrPngDataUrl(qrCodeUrl, { scale: 6, marginModules: 4 });
      sendJson(res, 200, {
        success: true,
        amount: amountYuan,
        amountCents,
        currency: coerceString(result.currency) ?? 'CNY',
        orderNo: coerceString(result.transactionId),
        quota: coerceNumber(result.tokenAmount) ?? quota,
        qrCodeUrl,
        qrCodeDataUrl,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, {
        success: false,
        error: normalizeTimeoutMessage(message, '微信充值接口响应超时，请稍后重试'),
      });
    }
    return true;
  }

  if (url.pathname === '/api/oneapi/redeem-code' && req.method === 'POST') {
    const { tokenKey } = await getBoxImConfig();
    if (!tokenKey) {
      sendJson(res, 401, { success: false, error: '请先登录 Box-IM 账号' });
      return true;
    }

    const body = await parseJsonBody<OneApiRedeemRequest>(req);
    const redeemKey = (body.key || '').trim();
    if (!redeemKey) {
      sendJson(res, 400, { success: false, error: '请输入兑换码' });
      return true;
    }

    try {
      const baseUrl = await getOneApiBaseUrl();
      const payload = await requestOneApiJson<OneApiEnvelope<number>>(baseUrl, '/api/user/topup', {
        authToken: tokenKey,
        method: 'POST',
        body: { key: redeemKey },
        timeoutMs: 20_000,
      });

      if (payload.success !== true) {
        throw new Error(payload.message || '兑换失败');
      }

      sendJson(res, 200, {
        success: true,
        quota: coerceNumber(payload.data),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, {
        success: false,
        error: normalizeTimeoutMessage(message, '兑换接口响应超时，请稍后重试'),
      });
    }
    return true;
  }

  return false;
}
