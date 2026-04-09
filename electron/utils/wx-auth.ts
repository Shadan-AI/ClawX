/**
 * WeChat QR login — runs directly in the Electron main process,
 * no dependency on the OpenClaw Gateway or box-im plugin.
 *
 * Mirrors the logic in:
 *   node_modules/@shadanai/openclaw/extensions/box-im/src/wx-auth.ts
 */
import { randomUUID } from 'node:crypto';
import { syncBots } from './box-im-sync';
import { ensureVncOriginsInConfig } from './openclaw-auth';

const WX_API = 'https://shadan.web.service.thinkgs.cn/jeecg-boot/sys';
const DEFAULT_API_URL = 'https://im.shadanai.com/api';

// In-memory pending scans, auto-cleaned every 60 s
const pendingScans = new Map<
  string,
  { openid?: string; nickname?: string; avatar?: string; ts: number }
>();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingScans) {
    if (now - v.ts > 300_000) pendingScans.delete(k);
  }
}, 60_000).unref();

// ── Scene / QR ───────────────────────────────────────────────────

export async function createWxScene(): Promise<{ sceneId: string; ticket: string }> {
  const sceneId = randomUUID().replace(/-/g, '').slice(0, 16);
  pendingScans.set(sceneId, { ts: Date.now() });

  const res = await fetch(`${WX_API}/getWxTicket?senceId=${sceneId}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`getWxTicket failed: ${res.status}`);
  const data = (await res.json()) as { result?: string };
  if (!data?.result) throw new Error('获取微信二维码失败');
  return { sceneId, ticket: data.result };
}

// ── Poll scan result ─────────────────────────────────────────────

export type PollResult =
  | { status: 'waiting' }
  | { status: 'scanned'; nickname?: string }
  | { status: 'ok'; openid: string; nickname?: string; avatar?: string };

export async function pollWxScan(sceneId: string): Promise<PollResult> {
  const pending = pendingScans.get(sceneId);
  if (!pending) throw new Error('scene 不存在或已过期');

  if (pending.openid) {
    pendingScans.delete(sceneId);
    return { status: 'ok', openid: pending.openid, nickname: pending.nickname, avatar: pending.avatar };
  }

  const res = await fetch(`${WX_API}/signInBySenceId?senceId=${sceneId}`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`signInBySenceId failed: ${res.status}`);
  const data = (await res.json()) as { success?: boolean; result?: { userInfo?: Record<string, string> } };

  if (data?.success && data.result?.userInfo?.openid) {
    const { openid, nickname, headimgurl } = data.result.userInfo;
    pending.openid = openid;
    pending.nickname = nickname;
    pending.avatar = headimgurl;
    pendingScans.delete(sceneId);
    return { status: 'ok', openid, nickname, avatar: headimgurl };
  }

  if (data?.result?.userInfo?.nickname && !data?.result?.userInfo?.openid) {
    return { status: 'scanned', nickname: data.result.userInfo.nickname };
  }

  return { status: 'waiting' };
}

// ── Find or create IM user ───────────────────────────────────────

export type FindOrCreateResult =
  | { needPhone: false; userId: number; accessToken: string; tokenKey: string }
  | { needPhone: true; openid: string; nickname?: string; avatar?: string };

export async function findOrCreateImUser(
  openid: string,
  nickname?: string,
  avatar?: string,
  apiUrl = DEFAULT_API_URL,
): Promise<FindOrCreateResult> {
  const res = await fetch(`${apiUrl}/findUserByOpenid`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ openid, nickName: nickname, headImage: avatar, terminalNo: 0 }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`findUserByOpenid failed: ${res.status}`);
  const data = (await res.json()) as { data?: { id?: number; phone?: string; accessToken?: string; tokenKey?: string } };
  const user = data?.data;

  if (!user || !user.phone) {
    return { needPhone: true, openid, nickname, avatar };
  }

  return {
    needPhone: false,
    userId: user.id ?? 0,
    accessToken: user.accessToken ?? '',
    tokenKey: user.tokenKey ?? '',
  };
}

// ── SMS ─────────────────────────────────────────────────────────

export async function sendSmsCode(phone: string): Promise<void> {
  const res = await fetch(`${WX_API}/sendsms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mobile: phone }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`sendsms failed: ${res.status}`);
  const data = (await res.json()) as { success?: boolean; message?: string };
  if (!data?.success) throw new Error(data?.message || '验证码发送失败');
}

// ── Bind phone ───────────────────────────────────────────────────

export async function bindPhoneAndRegister(
  openid: string,
  phone: string,
  code: string,
  nickname?: string,
  avatar?: string,
  apiUrl = DEFAULT_API_URL,
): Promise<{ userId: number; accessToken: string; tokenKey: string }> {
  // 1. Verify SMS code
  const verifyRes = await fetch(`${WX_API}/verifySms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mobile: phone, code }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!verifyRes.ok) throw new Error(`verifySms failed: ${verifyRes.status}`);
  const verifyData = (await verifyRes.json()) as { success?: boolean; message?: string };
  if (!verifyData?.success) throw new Error(verifyData?.message || '验证码错误');

  // 2. Register / bind
  const res = await fetch(`${apiUrl}/findUserByOpenid`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ openid, phone, nickName: nickname, headImage: avatar, terminalNo: 0 }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status}`);
  const data = (await res.json()) as { data?: { id?: number; accessToken?: string; tokenKey?: string } };
  const user = data?.data;
  if (!user) throw new Error('注册失败，请重试');
  return {
    userId: user.id ?? 0,
    accessToken: user.accessToken ?? '',
    tokenKey: user.tokenKey ?? '',
  };
}

// ── Persist tokenKey to openclaw.json ───────────────────────────

/**
 * After a successful login, write the full owner config to openclaw.json —
 * mirrors what box-im plugin's bootstrapOwner() does, but runs in the
 * Electron main process without needing the Gateway.
 */
export async function persistLoginResult(
  tokenKey: string,
  userId?: number,
  openid?: string,
  nickname?: string,
  avatar?: string,
  accessToken?: string,
): Promise<void> {
  // 1. Fetch available models from OneAPI
  const models = await fetchOneApiModels(tokenKey);
  const defaultModelId = models.find((m: { id: string }) => m.id === 'glm-5')
    ? 'glm-5'
    : (models[0]?.id ?? 'glm-5');

  // 2. Generate a nodeId (deviceId scoped to this user+machine)
  const nodeId = await getOrCreateDeviceId(userId);

  // 3. Write full ownerAuth + shadan provider + default model to openclaw.json
  const cfg = await readOpenClawConfig();
  const boxImCfg = ((cfg.channels?.[CHANNEL_ID] ?? {}) as Record<string, unknown>);
  const existingModels = ((cfg as any).models ?? {}) as Record<string, unknown>;
  const existingProviders = (existingModels.providers ?? {}) as Record<string, unknown>;

  cfg.channels = {
    ...(cfg.channels ?? {}),
    [CHANNEL_ID]: {
      ...boxImCfg,
      loggedIn: true,
      ownerAuth: {
        openid: openid ?? '',
        userId: userId ?? 0,
        accessToken: accessToken ?? '',
        tokenKey,
        nickname: nickname ?? '',
        avatar: avatar ?? '',
        nodeId,
      },
    },
  };

  (cfg as any).agents = {
    ...((cfg as any).agents ?? {}),
    defaults: {
      ...(((cfg as any).agents?.defaults) ?? {}),
      model: { primary: `shadan/${defaultModelId}` },
    },
  };

  (cfg as any).models = {
    ...existingModels,
    providers: {
      ...existingProviders,
      shadan: {
        baseUrl: `${ONEAPI_BASE_URL}/v1`,
        apiKey: tokenKey,
        api: 'openai-completions',
        models,
      },
    },
  };

  await writeOpenClawConfig(cfg);

  // 4. Sync bot accounts (best-effort)
  try {
    await syncBots();
  } catch (err) {
    console.warn('[wx-auth] Bot sync failed (non-fatal):', err);
  }

  // 5. Inject user-specific VNC origins into gateway.controlUi.allowedOrigins (best-effort)
  if (userId && userId > 0) {
    try {
      await ensureVncOriginsInConfig(userId, 18789);
    } catch (err) {
      console.warn('[wx-auth] VNC origins inject failed (non-fatal):', err);
    }
  }
}

// ── OneAPI models ────────────────────────────────────────────────

const ONEAPI_BASE_URL = 'https://one-api.shadanai.com';

const MODEL_META: Record<string, { name?: string; reasoning?: boolean; input?: string[]; contextWindow?: number; maxTokens?: number }> = {
  'glm-5': { name: 'GLM-5', contextWindow: 202752, maxTokens: 16384 },
  'glm-5-turbo': { name: 'GLM-5 Turbo', reasoning: true, maxTokens: 65536 },
  'glm-4': { name: 'GLM-4', contextWindow: 128000, maxTokens: 8192 },
  'qwen-max': { name: 'Qwen Max', contextWindow: 131072, maxTokens: 8192 },
};

async function fetchOneApiModels(tokenKey: string): Promise<Array<{ id: string; name: string; reasoning: boolean; input: string[]; cost: object; contextWindow: number; maxTokens: number }>> {
  try {
    const res = await fetch(`${ONEAPI_BASE_URL}/v1/models`, {
      headers: { Authorization: `Bearer ${tokenKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: { id: string }[] };
    return (data.data ?? []).map((m) => {
      const meta = MODEL_META[m.id] ?? {};
      return {
        id: m.id,
        name: meta.name ?? m.id,
        reasoning: meta.reasoning ?? false,
        input: meta.input ?? ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: meta.contextWindow ?? 128000,
        maxTokens: meta.maxTokens ?? 8192,
      };
    });
  } catch {
    return [];
  }
}

// ── Device ID ────────────────────────────────────────────────────

import { createHash } from 'node:crypto';
import { readOpenClawConfig, writeOpenClawConfig } from './channel-config';

const CHANNEL_ID = 'box-im';

async function getOrCreateDeviceId(userId?: number): Promise<string> {
  const cfg = await readOpenClawConfig();
  const boxImCfg = ((cfg.channels?.[CHANNEL_ID] ?? {}) as Record<string, unknown>);

  if (userId) {
    const deviceIds = ((boxImCfg.deviceIds ?? {}) as Record<string, string>);
    const key = String(userId);
    if (deviceIds[key]) return deviceIds[key];

    const machineId = (boxImCfg.machineId as string | undefined) ?? randomUUID();
    const hash = createHash('sha256').update(`${machineId}:${userId}`).digest('hex').slice(0, 32);
    const formatted = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;

    cfg.channels = {
      ...(cfg.channels ?? {}),
      [CHANNEL_ID]: { ...boxImCfg, machineId, deviceIds: { ...deviceIds, [key]: formatted } },
    };
    await writeOpenClawConfig(cfg);
    return formatted;
  }

  if (boxImCfg.deviceId) return boxImCfg.deviceId as string;
  const deviceId = randomUUID();
  cfg.channels = {
    ...(cfg.channels ?? {}),
    [CHANNEL_ID]: { ...boxImCfg, deviceId },
  };
  await writeOpenClawConfig(cfg);
  return deviceId;
}
