/**
 * Box-IM digital worker sync — reads bots from the ai-im API and
 * reconciles local openclaw.json (agents, bindings, channels, plugins).
 *
 * Reuses the project's existing config helpers so we never hand-craft
 * JSON writes that can corrupt the config file.
 */
import { readOpenClawConfig, writeOpenClawConfig } from './channel-config';
import { logger } from './logger';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Update IDENTITY.md for a bot with its nickName.
 * This ensures each digital worker has a proper identity file in their workspace.
 */
async function updateAgentIdentityMd(agentId: string, nickName: string, workspace?: string): Promise<void> {
  try {
    const wsDir = workspace || join(homedir(), `.openclaw/workspace-${agentId}`);
    await mkdir(wsDir, { recursive: true });
    const identityPath = join(wsDir, 'IDENTITY.md');

    // Read existing content if any, otherwise use template
    let content: string;
    try {
      content = await readFile(identityPath, 'utf-8');
      // Replace the Name line
      content = content.replace(/^- \*\*Name:\*\*.+$/m, `- **Name:** ${nickName}`);
    } catch {
      // File doesn't exist, create from template
      content = `# IDENTITY.md - Who Am I?\n\n- **Name:** ${nickName}\n- **Creature:** AI digital worker\n- **Vibe:** Professional, helpful, focused on tasks.\n`;
    }

    await writeFile(identityPath, content, 'utf-8');
    logger.info(`[box-im] Updated IDENTITY.md for agent ${agentId} with name: ${nickName}`);
  } catch (err) {
    logger.warn(`[box-im] Failed to update IDENTITY.md for agent ${agentId}:`, err);
  }
}

// ── Constants ────────────────────────────────────────────────────

const CHANNEL_ID = 'box-im';
const SYSTEM_AGENTS = new Set(['main', 'dev']);
const DEFAULT_API_URL = 'https://im.shadanai.com/api';
const DEFAULT_ONEAPI_BASE_URL = 'https://one-api.shadanai.com';

// ── Types ────────────────────────────────────────────────────────

export interface BotInfo {
  id: number;
  userName: string;
  nickName: string;
  headImage: string;
  openclawAgentId: string;
  accessToken?: string | null;
  model?: string;
  deviceNodeId?: string;
  skills?: string[];
}

export interface BoxImSyncResult {
  bots: BotInfo[];
  error?: string;
}

interface BoxImOwnerAuth {
  tokenKey?: string;
  [key: string]: unknown;
}

interface BoxImAccount {
  enabled?: boolean;
  accessToken?: string;
  userId?: number;
  botName?: string;
  headImage?: string;
  model?: string;
  [key: string]: unknown;
}

interface AgentEntry {
  id: string;
  name?: string;
  default?: boolean;
  identity?: unknown;
  workspace?: string;
  agentDir?: string;
  [key: string]: unknown;
}

interface Binding {
  agentId: string;
  match: { channel: string; accountId?: string; [key: string]: unknown };
  [key: string]: unknown;
}

// ── Config reading ───────────────────────────────────────────────

export async function getBoxImConfig(): Promise<{
  tokenKey: string | null;
  apiUrl: string;
  ownerUserId: number | null;
  accounts: Record<string, BoxImAccount>;
}> {
  try {
    const cfg = await readOpenClawConfig();
    const boxIm = (cfg.channels?.[CHANNEL_ID] ?? {}) as Record<string, unknown>;
    const ownerAuth = (boxIm.ownerAuth ?? {}) as BoxImOwnerAuth;
    const tokenKey = typeof ownerAuth.tokenKey === 'string' && ownerAuth.tokenKey.length > 0
      ? ownerAuth.tokenKey : null;
    const apiUrl = typeof boxIm.apiUrl === 'string' && boxIm.apiUrl.length > 0
      ? boxIm.apiUrl : DEFAULT_API_URL;
    const ownerUserId = typeof ownerAuth.userId === 'number' ? ownerAuth.userId : null;
    const accounts = (boxIm.accounts ?? {}) as Record<string, BoxImAccount>;
    return { tokenKey, apiUrl, ownerUserId, accounts };
  } catch (err) {
    logger.error('[box-im] Failed to read config:', err);
    return { tokenKey: null, apiUrl: DEFAULT_API_URL, ownerUserId: null, accounts: {} };
  }
}

/**
 * Read tokenKey from openclaw.json — single source of truth for login status.
 */
export async function getTokenKey(): Promise<string | null> {
  const { tokenKey } = await getBoxImConfig();
  return tokenKey;
}

/**
 * Read OneAPI base URL from openclaw.json models.providers.shadan.baseUrl,
 * falling back to the default public endpoint.
 */
export async function getOneApiBaseUrl(): Promise<string> {
  try {
    const cfg = await readOpenClawConfig();
    const models = (cfg as any).models as Record<string, unknown> | undefined;
    const providers = (models?.providers ?? {}) as Record<string, unknown>;
    const shadan = (providers.shadan ?? {}) as Record<string, unknown>;
    const baseUrl = shadan.baseUrl;
    if (typeof baseUrl === 'string' && baseUrl.length > 0) {
      return baseUrl.replace(/\/v1\/?$/, '');
    }
  } catch { /* ignore */ }
  return DEFAULT_ONEAPI_BASE_URL;
}

/**
 * Logout: clear ownerAuth, accounts, and shadan provider from config.
 */
export async function logoutBoxIm(): Promise<void> {
  const cfg = await readOpenClawConfig();

  const boxIm = (cfg.channels?.[CHANNEL_ID] ?? {}) as Record<string, unknown>;
  delete boxIm.ownerAuth;
  delete boxIm.accounts;
  boxIm.loggedIn = false;
  if (cfg.channels) cfg.channels[CHANNEL_ID] = boxIm;

  const models = ((cfg as any).models ?? {}) as Record<string, unknown>;
  const providers = (models.providers ?? {}) as Record<string, unknown>;
  delete providers.shadan;
  models.providers = providers;
  (cfg as any).models = models;

  const agents = ((cfg as any).agents ?? {}) as Record<string, unknown>;
  const oldList = (agents.list ?? []) as Array<Record<string, unknown>>;
  agents.list = oldList.filter(a => SYSTEM_AGENTS.has(a.id as string));
  (cfg as any).agents = agents;

  const oldBindings = ((cfg as any).bindings ?? []) as Array<Record<string, unknown>>;
  (cfg as any).bindings = oldBindings.filter(b => {
    const match = b.match as Record<string, unknown> | undefined;
    return match?.channel !== CHANNEL_ID;
  });

  await writeOpenClawConfig(cfg);
  logger.info('[box-im] Logged out, cleared ownerAuth, accounts, agents, bindings, and shadan provider');
}

// ── API ──────────────────────────────────────────────────────────

export async function fetchBotsFromApi(apiUrl: string, tokenKey: string): Promise<BotInfo[]> {
  const resp = await fetch(`${apiUrl}/bot/list`, {
    method: 'GET',
    headers: { 'Token-Key': tokenKey },
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`bot list error: ${resp.status}`);
  const result = await resp.json() as { code?: number; data?: any[]; message?: string };
  if (result.code !== 200) throw new Error(`bot list failed: ${result.message}`);
  return (result.data ?? []).map((b: any) => ({
    id: b.id,
    userName: b.userName ?? '',
    nickName: b.nickName ?? '',
    headImage: b.headImage ?? '',
    openclawAgentId: b.openclawAgentId ?? b.agentId ?? b.userName ?? '',
    accessToken: b.accessToken ?? null,
    model: b.model ?? undefined,
    deviceNodeId: b.deviceNodeId ?? b.nodeId ?? undefined,
    skills: b.skills ? (typeof b.skills === 'string' ? JSON.parse(b.skills) : b.skills) : undefined,
  }));
}

// ── Reconciliation ───────────────────────────────────────────────

function buildAccountsFromBots(
  bots: BotInfo[],
  existing: Record<string, BoxImAccount>,
): Record<string, BoxImAccount> {
  const accounts: Record<string, BoxImAccount> = {};
  for (const bot of bots) {
    const agentId = bot.openclawAgentId || bot.userName || `bot-${bot.id}`;
    accounts[agentId] = {
      enabled: true,
      accessToken: bot.accessToken || existing[agentId]?.accessToken || '',
      userId: bot.id,
      botName: bot.nickName,
      headImage: bot.headImage ?? '',
      model: bot.model ?? '',
      skills: bot.skills ?? existing[agentId]?.skills ?? undefined,
    };
  }
  return accounts;
}

function reconcileAgents(
  oldList: AgentEntry[],
  accounts: Record<string, BoxImAccount>,
): AgentEntry[] {
  const keep = new Map<string, AgentEntry>();
  for (const a of oldList) keep.set(a.id, a);

  const result: AgentEntry[] = [];

  for (const id of SYSTEM_AGENTS) {
    const existing = keep.get(id);
    if (existing) result.push(existing);
  }

  for (const [agentId, acct] of Object.entries(accounts)) {
    if (agentId !== 'main' && SYSTEM_AGENTS.has(agentId)) continue;
    const existing = keep.get(agentId);
    if (existing) {
      if (SYSTEM_AGENTS.has(agentId)) {
        existing.name = existing.name || acct.botName || agentId;
      } else {
        existing.name = acct.botName || agentId;
        // 从数据库同步 skills（数据库优先）
        if (acct.skills) {
          existing.skills = acct.skills;
        }
        result.push(existing);
      }
    } else {
      const home = process.env.HOME || process.env.USERPROFILE || '';
      result.push({
        id: agentId,
        name: acct.botName || agentId,
        workspace: `${home}/.openclaw/workspace-${agentId}`,
        agentDir: `${home}/.openclaw/agents/${agentId}/agent`,
        skills: acct.skills,
      });
    }
  }
  return result;
}

function reconcileBindings(
  oldBindings: Binding[],
  accountIds: string[],
): Binding[] {
  const result = oldBindings.filter(b => b.match?.channel !== CHANNEL_ID);
  for (const agentId of accountIds) {
    result.push({ agentId, match: { channel: CHANNEL_ID, accountId: agentId } });
  }
  return result;
}

export async function saveBoxImAccounts(accounts: Record<string, BoxImAccount>): Promise<void> {
  const cfg = await readOpenClawConfig();

  const boxIm = (cfg.channels?.[CHANNEL_ID] ?? {}) as Record<string, unknown>;
  if (!cfg.channels) cfg.channels = {};
  cfg.channels[CHANNEL_ID] = { ...boxIm, accounts, enabled: true };

  if (!cfg.plugins) cfg.plugins = {};
  const allow = Array.isArray(cfg.plugins.allow) ? cfg.plugins.allow as string[] : [];
  if (!allow.includes(CHANNEL_ID)) cfg.plugins.allow = [...allow, CHANNEL_ID];
  if (!cfg.plugins.entries) cfg.plugins.entries = {};
  cfg.plugins.entries[CHANNEL_ID] = { enabled: true };

  const agents = (cfg as any).agents ?? {};
  const oldList = (agents.list ?? []) as AgentEntry[];
  const newList = reconcileAgents(oldList, accounts);
  (cfg as any).agents = { ...agents, list: newList };

  const oldBindings = ((cfg as any).bindings ?? []) as Binding[];
  (cfg as any).bindings = reconcileBindings(oldBindings, Object.keys(accounts));

  await writeOpenClawConfig(cfg);
  logger.info(`[box-im] Saved ${Object.keys(accounts).length} accounts, ${newList.length} agents`);
}

// ── Public entry point ───────────────────────────────────────────

export async function syncBots(): Promise<BoxImSyncResult> {
  const { tokenKey, apiUrl, accounts } = await getBoxImConfig();

  if (!tokenKey) {
    return { bots: [], error: '未绑定用户' };
  }

  try {
    const bots = await fetchBotsFromApi(apiUrl, tokenKey);
    const newAccounts = buildAccountsFromBots(bots, accounts);

    for (const [agentId, acct] of Object.entries(newAccounts)) {
      if (!acct.accessToken) {
        try {
          const resp = await fetch(`${apiUrl}/bot/token/${agentId}`, {
            method: 'POST',
            headers: { 'Token-Key': tokenKey },
            signal: AbortSignal.timeout(5000),
          });
          if (resp.ok) {
            const result = await resp.json() as any;
            if (result.code === 200 && result.data?.accessToken) {
              acct.accessToken = result.data.accessToken;
              acct.userId = result.data.id;
            }
          }
        } catch { /* best-effort */ }
      }
    }

    await saveBoxImAccounts(newAccounts);

    // Update IDENTITY.md for each bot with their nickName
    for (const bot of bots) {
      const agentId = bot.openclawAgentId || bot.userName || `bot-${bot.id}`;
      const acct = newAccounts[agentId];
      const nickName = bot.nickName || agentId;
      const workspace = acct ? `${process.env.HOME || process.env.USERPROFILE || homedir()}/.openclaw/workspace-${agentId}` : undefined;
      await updateAgentIdentityMd(agentId, nickName, workspace);
    }

    try {
      const friendResp = await fetch(`${apiUrl}/friend/list`, {
        headers: { 'Token-Key': tokenKey },
        signal: AbortSignal.timeout(5000),
      });
      const friendData = friendResp.ok ? await friendResp.json() as any : null;
      const friendIds = new Set((friendData?.data ?? []).map((f: any) => f.id));
      for (const bot of bots) {
        if (!friendIds.has(bot.id)) {
          try {
            await fetch(`${apiUrl}/friend/add?friendId=${bot.id}`, {
              method: 'POST',
              headers: { 'Token-Key': tokenKey },
              signal: AbortSignal.timeout(3000),
            });
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore friend sync errors */ }

    logger.info(`[box-im] Synced ${bots.length} bots from API`);
    return { bots };
  } catch (err: any) {
    logger.error('[box-im] API sync failed, using local cache:', err.message);
    const bots: BotInfo[] = Object.entries(accounts).map(([agentId, acct]) => ({
      id: acct.userId ?? 0,
      userName: agentId,
      nickName: acct.botName ?? agentId,
      headImage: acct.headImage ?? '',
      openclawAgentId: agentId,
      accessToken: acct.accessToken ?? null,
      model: acct.model ?? undefined,
    }));
    return { bots, error: `API失败，使用本地缓存: ${err.message}` };
  }
}

/**
 * Write tokenKey into openclaw.json channels.box-im.ownerAuth.
 * Called after a successful WeChat QR login from the main process.
 */
export async function writeBoxImTokenKey(tokenKey: string, userId?: number): Promise<void> {
  const cfg = await readOpenClawConfig();
  if (!cfg.channels) cfg.channels = {};
  const boxIm = (cfg.channels[CHANNEL_ID] ?? {}) as Record<string, unknown>;
  const ownerAuth = (boxIm.ownerAuth && typeof boxIm.ownerAuth === 'object'
    ? boxIm.ownerAuth as Record<string, unknown>
    : {}) as Record<string, unknown>;
  ownerAuth.tokenKey = tokenKey;
  if (userId !== undefined) ownerAuth.userId = userId;
  boxIm.ownerAuth = ownerAuth;
  boxIm.loggedIn = true;
  cfg.channels[CHANNEL_ID] = boxIm;
  await writeOpenClawConfig(cfg);
  logger.info('[box-im] Persisted tokenKey to openclaw.json');
}
