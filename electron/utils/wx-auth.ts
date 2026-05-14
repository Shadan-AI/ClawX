/**
 * WeChat QR login — runs directly in the Electron main process,
 * no dependency on the OpenClaw Gateway or box-im plugin.
 *
 * Mirrors the logic in:
 *   node_modules/@shadanai/openclaw/extensions/box-im/src/wx-auth.ts
 */
import { randomUUID } from 'node:crypto';
import { networkInterfaces, homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { syncBots } from './box-im-sync';
import { ensureVncOriginsInConfig } from './openclaw-auth';
import { getSetting } from './store';
import { storeApiKey } from './secure-storage';
import { ensureOpenClawMkcertCertsWindows } from './mkcert-certs';
import {
  getOrCreateWireGuardKeys,
  registerWireGuardDevice,
  startWireGuard,
  type WireGuardRegistration,
  writeWireGuardConfig,
} from './wireguard-vpn';

const WX_API = 'https://shadan.web.service.thinkgs.cn/jeecg-boot/sys';
const DEFAULT_API_URL = 'https://im.shadanai.com/api';

function resolveImApiUrl(configured?: unknown): string {
  const envUrl = process.env.CLAWX_IM_API_URL?.trim();
  const configUrl = typeof configured === 'string' ? configured.trim() : '';
  return (envUrl || configUrl || DEFAULT_API_URL).replace(/\/+$/, '');
}

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
  | { needPhone: true; isNewUser: boolean; openid: string; nickname?: string; avatar?: string };

export async function findOrCreateImUser(
  openid: string,
  nickname?: string,
  avatar?: string,
  apiUrl = resolveImApiUrl(),
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

  if (!user) {
    // No account at all — needs full registration
    return { needPhone: true, isNewUser: true, openid, nickname, avatar };
  }

  if (!user.phone) {
    // Account exists but no phone bound
    return { needPhone: true, isNewUser: false, openid, nickname, avatar };
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
  apiUrl = resolveImApiUrl(),
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

// ── Register new user ────────────────────────────────────────────

/**
 * Full registration flow for brand-new users (no existing account).
 * 1. Verify SMS code
 * 2. POST /register with userName, nickName, password, phone, openid
 * 3. findUserByOpenid to get the token
 */
export async function registerNewUser(
  openid: string,
  userName: string,
  nickName: string,
  password: string,
  phone: string,
  code: string,
  avatar?: string,
  apiUrl = resolveImApiUrl(),
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

  // 2. Register account (POST /register with openid)
  const regRes = await fetch(`${apiUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userName, nickName, password, confirmPassword: password, phone, openid, terminalNo: 0 }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!regRes.ok) {
    const errText = await regRes.text().catch(() => '');
    let errMsg = '注册失败，请重试';
    try { const j = JSON.parse(errText) as { message?: string }; if (j.message) errMsg = j.message; } catch { /* ignore */ }
    throw new Error(errMsg);
  }
  const regData = (await regRes.json()) as { success?: boolean; message?: string; code?: number };
  console.log('[registerNewUser] /register response:', JSON.stringify(regData));
  // Handle both { success: false } and { code: non-200 } style error responses
  if (regData?.success === false || (regData?.code !== undefined && regData.code !== 200 && regData.code !== 0)) {
    throw new Error(regData?.message || '注册失败，请重试');
  }

  // 3. Login with userName+password to get token
  const loginRes = await fetch(`${apiUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userName, password, terminal: 0, terminalNo: 0 }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!loginRes.ok) throw new Error(`login after register failed: ${loginRes.status}`);
  const loginData = (await loginRes.json()) as { data?: { id?: number; accessToken?: string; tokenKey?: string } };
  console.log('[registerNewUser] /login response:', JSON.stringify(loginData));
  const loginUser = loginData?.data;
  if (!loginUser?.accessToken || !loginUser?.tokenKey) throw new Error('注册成功但登录失败，请重新扫码登录');

  // 4. Bind openid via PUT /user/update2 (no auth required, matches im-web Login.vue flow)
  const updateRes = await fetch(`${apiUrl}/user/update2`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: loginUser.id, userName, phone, openid, nickName }),
    signal: AbortSignal.timeout(10_000),
  });
  const updateText = await updateRes.text().catch(() => '');
  console.log(`[registerNewUser] update2 status=${updateRes.status} body=${updateText}`);
  if (!updateRes.ok) {
    console.warn(`[registerNewUser] update2 failed: ${updateRes.status} ${updateText}`);
  }

  // 5. Auto-create a default digital worker (bot) for the new user.
  //    POST /bot/register — writes is_bot, openclaw_agent_id, owner_id, node_id, model
  //    into im_user. syncBots() in persistLoginResult will then pull it into openclaw.json.
  try {
    const nodeId = await getOrCreateDeviceId(loginUser.id);
    const defaultAgentId = `agent_${loginUser.id}`;
    const botRes = await fetch(`${apiUrl}/bot/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Token-Key': loginUser.tokenKey },
      body: JSON.stringify({
        agentId: defaultAgentId,
        nickName: 'OpenClaw助手',
        headImage: avatar ?? '',
        model: 'glm-5',
        nodeId,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const botData = (await botRes.json()) as { code?: number; message?: string };
    console.log('[registerNewUser] /bot/register response:', JSON.stringify(botData));
    if (botData?.code !== 200) {
      console.warn('[registerNewUser] bot register non-200:', botData?.message);
    }
  } catch (err) {
    console.warn('[registerNewUser] auto bot creation failed (non-fatal):', err);
  }

  return {
    userId: loginUser.id ?? 0,
    accessToken: loginUser.accessToken ?? '',
    tokenKey: loginUser.tokenKey,
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
  const imApiUrl = resolveImApiUrl(boxImCfg.apiUrl);
  const existingModels = ((cfg as any).models ?? {}) as Record<string, unknown>;
  const existingProviders = (existingModels.providers ?? {}) as Record<string, unknown>;

  cfg.channels = {
    ...(cfg.channels ?? {}),
    [CHANNEL_ID]: {
      ...boxImCfg,
      apiUrl: imApiUrl,
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

  // 4. Update main agent's auth-profiles.json to use unified 'shadan' provider
  try {
    const mainAgentDir = join(homedir(), '.openclaw/agents/main/agent');
    await mkdir(mainAgentDir, { recursive: true });
    const mainAuthPath = join(mainAgentDir, 'auth-profiles.json');
    
    const authData = {
      version: 1,
      profiles: {
        'shadan:default': {
          type: 'api_key',
          provider: 'shadan',
          key: tokenKey,
        },
      },
      order: {
        shadan: ['shadan:default'],
      },
      lastGood: {
        shadan: 'shadan:default',
      },
    };

    await writeFile(mainAuthPath, JSON.stringify(authData, null, 2), 'utf-8');
    console.log('[wx-auth] Created/updated main agent auth-profiles.json with unified shadan provider');
  } catch (err) {
    console.warn('[wx-auth] Failed to update main agent auth-profiles.json:', err);
  }

  // 5. Store API key to secure storage so Gateway can load it
  try {
    await storeApiKey('shadan', tokenKey);
    console.log('[wx-auth] Stored shadan API key to secure storage');
  } catch (err) {
    console.warn('[wx-auth] Failed to store API key (non-fatal):', err);
  }

  // 6. Sync bot accounts (best-effort)
  try {
    await syncBots();
  } catch (err) {
    console.warn('[wx-auth] Bot sync failed (non-fatal):', err);
  }

  // 6. Register this machine as a WireGuard peer and start the tunnel (best-effort).
  let vpnRegistration: WireGuardRegistration | undefined;
  try {
    const { privateKey, publicKey } = await getOrCreateWireGuardKeys();
    const vpnApiUrl = process.env.CLAWX_VPN_API_URL || imApiUrl;
    vpnRegistration = await registerWireGuardDevice({
      apiUrl: vpnApiUrl,
      tokenKey,
      nodeId,
      deviceName: hostname(),
      publicKey,
    });
    const configPath = await writeWireGuardConfig(privateKey, vpnRegistration);
    const startMode = await startWireGuard(configPath);
    if (startMode === 'opened-app') {
      console.log(`[wx-auth] WireGuard.app opened and config revealed in Finder for import: ${configPath}`);
    } else if (startMode === 'config-written') {
      console.log(`[wx-auth] WireGuard config written for manual import/start: ${configPath}`);
    } else {
      console.log(`[wx-auth] WireGuard VPN started: ${vpnRegistration.clientAddress} via ${vpnRegistration.serverEndpoint}`);
    }
    const vpnIp = normalizeWireGuardIp(vpnRegistration);
    if (process.platform === 'win32' && vpnIp) {
      try {
        const certResult = await ensureOpenClawMkcertCertsWindows({ extraHosts: [vpnIp] });
        if (certResult.ok && certResult.regenerated) {
          console.log(`[wx-auth] Gateway TLS cert regenerated with VPN IP: ${vpnIp}`);
        }
      } catch (certErr) {
        console.warn('[wx-auth] Failed to regenerate Gateway TLS cert with VPN IP (non-fatal):', certErr);
      }
    }
  } catch (err) {
    console.warn('[wx-auth] WireGuard VPN setup failed (non-fatal):', err);
  }

  // 6. Inject user-specific VNC origins into gateway.controlUi.allowedOrigins (best-effort)
  if (userId && userId > 0) {
    try {
      await ensureVncOriginsInConfig(userId, 18789);
    } catch (err) {
      console.warn('[wx-auth] VNC origins inject failed (non-fatal):', err);
    }
  }

  // 6. Register device with IM server so it can build the iframe URL:
  //    https://<accessip>:18789/#token=<gatewayToken>
  try {
    await registerDeviceWithImServer(tokenKey, nodeId, userId, imApiUrl, vpnRegistration);
  } catch (err) {
    console.warn('[wx-auth] Device registration failed (non-fatal):', err);
  }
}

// ── Device registration ──────────────────────────────────────────

const GATEWAY_PORT = 18789;

/** Detect the first private LAN IPv4 address on this machine. */
function detectLanIp(): string | undefined {
  const nets = networkInterfaces();
  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces ?? []) {
      if (
        iface.family === 'IPv4' &&
        !iface.internal &&
        /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(iface.address)
      ) {
        return iface.address;
      }
    }
  }
  return undefined;
}

/**
 * Register this device with the IM server so it can build the iframe URL:
 *   https://<accessip>:18789/#token=<gatewayToken>
 */
async function registerDeviceWithImServer(
  tokenKey: string,
  nodeId: string,
  userId?: number,
  apiUrl = resolveImApiUrl(),
  vpnRegistration?: WireGuardRegistration,
): Promise<void> {
  // Read the same token that Settings → Gateway displays (electron-store, clawx-<hex> format)
  const gatewayToken = await getSetting('gatewayToken');

  // buildOpenClawControlUiUrl always uses https (feature2 branch hardcodes it).
  // Use the same protocol so probeGatewayUrl on the IM side builds the correct URL.
  const protocol = 'https';
  const lanIp = detectLanIp();
  const vpnIp = normalizeWireGuardIp(vpnRegistration);

  // Detect WAN IP (best-effort, short timeout)
  let wanIp: string | undefined;
  try {
    const r = await fetch('https://api.ipify.org?format=text', { signal: AbortSignal.timeout(3000) });
    if (r.ok) wanIp = (await r.text()).trim();
  } catch { /* ignore */ }

  const cfg = await readOpenClawConfig();
  const openid = (cfg.channels?.[CHANNEL_ID] as any)?.ownerAuth?.openid ?? '';

  const registration = {
    openid,
    nodeId,
    nodeName: nodeId,
    lanIp,
    wanIp,
    vpnIp,
    openclawPort: GATEWAY_PORT,
    protocol,       // always 'https' — matches buildOpenClawControlUiUrl behavior
    gatewayToken,   // clawx-<hex> from electron-store, same as Settings → Gateway shows
    ...(userId ? { userId } : {}),
  };

  const res = await fetch(`${apiUrl}/device/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Token-Key': tokenKey },
    body: JSON.stringify(registration),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Device register failed: ${res.status} ${text}`);
  }
  console.log(`[wx-auth] Device registered: ${protocol}://${vpnIp ?? lanIp ?? 'unknown'}:${GATEWAY_PORT}/#token=${gatewayToken}`);
}

function normalizeWireGuardIp(registration?: WireGuardRegistration): string | undefined {
  const raw = registration?.vpnIp || registration?.clientAddress;
  if (!raw) return undefined;
  return raw.split('/')[0]?.trim() || undefined;
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
