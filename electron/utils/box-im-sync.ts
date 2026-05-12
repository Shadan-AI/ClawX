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

/**
 * Copy or create auth-profiles.json for bot agent.
 * This ensures each digital worker has access to API keys.
 * IMPORTANT: Always use unified 'shadan' provider name.
 */
async function copyAuthProfiles(agentId: string): Promise<void> {
  try {
    const home = homedir();
    const mainAuthPath = join(home, '.openclaw/agents/main/agent/auth-profiles.json');
    const botAgentDir = join(home, `.openclaw/agents/${agentId}/agent`);
    const botAuthPath = join(botAgentDir, 'auth-profiles.json');

    // Create bot agent directory if it doesn't exist
    await mkdir(botAgentDir, { recursive: true });

    // Try to copy from main agent first
    try {
      const authContent = await readFile(mainAuthPath, 'utf-8');
      const authData = JSON.parse(authContent);
      
      // Normalize to use 'shadan' provider only (remove custom-shadan for consistency)
      const normalizedProfiles: Record<string, any> = {};
      const normalizedOrder: Record<string, string[]> = {};
      const normalizedLastGood: Record<string, string> = {};
      
      // Extract API key from either shadan or custom-shadan
      let apiKey: string | undefined;
      if (authData.profiles?.['shadan:default']?.key) {
        apiKey = authData.profiles['shadan:default'].key;
      } else if (authData.profiles?.['custom-shadan:default']?.key) {
        apiKey = authData.profiles['custom-shadan:default'].key;
        logger.info(`[box-im] Migrating custom-shadan to shadan for ${agentId}`);
      }
      
      if (apiKey) {
        normalizedProfiles['shadan:default'] = {
          type: 'api_key',
          provider: 'shadan',
          key: apiKey,
        };
        normalizedOrder.shadan = ['shadan:default'];
        normalizedLastGood.shadan = 'shadan:default';
      }
      
      // Copy other providers as-is
      for (const [profileId, profile] of Object.entries(authData.profiles || {})) {
        if (!profileId.startsWith('shadan:') && !profileId.startsWith('custom-shadan:')) {
          normalizedProfiles[profileId] = profile;
          const providerName = profileId.split(':')[0];
          if (!normalizedOrder[providerName]) {
            normalizedOrder[providerName] = authData.order?.[providerName] || [profileId];
          }
          if (!normalizedLastGood[providerName]) {
            normalizedLastGood[providerName] = authData.lastGood?.[providerName] || profileId;
          }
        }
      }
      
      const normalizedAuthData = {
        version: authData.version || 1,
        profiles: normalizedProfiles,
        order: normalizedOrder,
        lastGood: normalizedLastGood,
      };
      
      await writeFile(botAuthPath, JSON.stringify(normalizedAuthData, null, 2), 'utf-8');
      logger.info(`[box-im] Copied and normalized auth-profiles.json to ${agentId}`);
      return;
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
      logger.info(`[box-im] Main agent auth-profiles.json not found, creating from openclaw.json for ${agentId}`);
    }

    // Fallback: create auth-profiles.json from openclaw.json
    const cfg = await readOpenClawConfig();
    const models = (cfg as any).models as Record<string, unknown> | undefined;
    const providers = (models?.providers ?? {}) as Record<string, unknown>;
    
    const profiles: Record<string, any> = {};
    const order: Record<string, string[]> = {};
    const lastGood: Record<string, string> = {};
    
    // Always use 'shadan' as the unified provider name
    for (const [providerName, providerConfig] of Object.entries(providers)) {
      if (typeof providerConfig === 'object' && providerConfig !== null) {
        const config = providerConfig as Record<string, unknown>;
        if (config.apiKey && typeof config.apiKey === 'string' && config.apiKey.length > 0) {
          // Normalize: use 'shadan' for both 'shadan' and 'custom-shadan'
          const normalizedName = (providerName === 'custom-shadan') ? 'shadan' : providerName;
          const profileId = `${normalizedName}:default`;
          
          profiles[profileId] = {
            type: 'api_key',
            provider: normalizedName,
            key: config.apiKey,
          };
          order[normalizedName] = [profileId];
          lastGood[normalizedName] = profileId;
          logger.info(`[box-im] Found API key for provider: ${providerName} (normalized to ${normalizedName})`);
        }
      }
    }
    
    if (Object.keys(profiles).length > 0) {
      const authProfiles = {
        version: 1,
        profiles,
        order,
        lastGood,
      };
      await writeFile(botAuthPath, JSON.stringify(authProfiles, null, 2), 'utf-8');
      logger.info(`[box-im] Created auth-profiles.json for ${agentId} with ${Object.keys(profiles).length} provider(s)`);
    } else {
      logger.warn(`[box-im] No API keys found in openclaw.json providers, cannot create auth-profiles.json for ${agentId}`);
    }
  } catch (err) {
    logger.warn(`[box-im] Failed to setup auth-profiles.json for agent ${agentId}:`, err);
  }
}

// ── Constants ────────────────────────────────────────────────────

const CHANNEL_ID = 'box-im';
const SYSTEM_AGENTS = new Set(['main', 'dev']);
const DEFAULT_API_URL = 'https://im.shadanai.com/api';
const DEFAULT_ONEAPI_BASE_URL = 'https://one-api.shadanai.com';
const SAFE_FALLBACK_MODEL_ID = 'glm-5';

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
  templateId?: number | null; // 添加 templateId 字段
}

export interface BoxImSyncResult {
  bots: BotInfo[];
  error?: string;
}

async function fetchAvailableOneApiModelIds(tokenKey: string): Promise<Set<string> | null> {
  try {
    const resp = await fetch(`${DEFAULT_ONEAPI_BASE_URL}/v1/models`, {
      headers: { Authorization: `Bearer ${tokenKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      logger.warn(`[box-im] Failed to fetch OneAPI models for validation: ${resp.status}`);
      return null;
    }
    const payload = await resp.json() as { data?: Array<{ id?: unknown }> };
    const ids = new Set(
      (payload.data ?? [])
        .map((model) => typeof model.id === 'string' ? model.id.trim() : '')
        .filter(Boolean),
    );
    return ids.size > 0 ? ids : null;
  } catch (error) {
    logger.warn('[box-im] Failed to fetch OneAPI models for validation:', error);
    return null;
  }
}

function resolveSupportedModelId(rawModel: string | undefined, availableModelIds: Set<string> | null): string | undefined {
  const modelId = rawModel?.replace(/^shadan\//, '').trim();
  if (!modelId) return undefined;
  if (!availableModelIds || availableModelIds.has(modelId)) {
    return modelId;
  }

  const fallback = availableModelIds.has(SAFE_FALLBACK_MODEL_ID)
    ? SAFE_FALLBACK_MODEL_ID
    : [...availableModelIds][0];
  logger.warn(`[box-im] Bot model "${modelId}" is not available in OneAPI; using "${fallback}" instead`);
  return fallback;
}

export interface ProfileFileInfo {
  filename: string;
  content: string;
  hash: string;
  source: 'USER' | 'TEMPLATE' | 'DEFAULT';
  isModified: boolean;
  templateId?: number | null;
}

export interface ProfileSyncStatus {
  filename: string;
  localHash: string | null;
  remoteHash: string | null;
  needsSync: boolean;
  direction: 'download' | 'upload' | 'none';
}

interface BoxImOwnerAuth {
  tokenKey?: string;
  accessToken?: string;
  openid?: string;
  userId?: number;
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
  model?: { primary?: string; fallbacks?: string[] };
  skills?: string[];
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
  accessToken: string | null;
  openid: string | null;
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
    const accessToken = typeof ownerAuth.accessToken === 'string' && ownerAuth.accessToken.length > 0
      ? ownerAuth.accessToken : null;
    const openid = typeof ownerAuth.openid === 'string' && ownerAuth.openid.length > 0
      ? ownerAuth.openid : null;
    const apiUrl = typeof boxIm.apiUrl === 'string' && boxIm.apiUrl.length > 0
      ? boxIm.apiUrl : DEFAULT_API_URL;
    const ownerUserId = typeof ownerAuth.userId === 'number' ? ownerAuth.userId : null;
    const accounts = (boxIm.accounts ?? {}) as Record<string, BoxImAccount>;
    return { tokenKey, accessToken, openid, apiUrl, ownerUserId, accounts };
  } catch (err) {
    logger.error('[box-im] Failed to read config:', err);
    return { tokenKey: null, accessToken: null, openid: null, apiUrl: DEFAULT_API_URL, ownerUserId: null, accounts: {} };
  }
}

export async function ensureOwnerAccessToken(forceRefresh = false): Promise<string | null> {
  const { tokenKey, accessToken, openid, apiUrl } = await getBoxImConfig();
  if (!forceRefresh && accessToken) return accessToken;

  try {
    let refreshedUserId: number | undefined;
    let refreshedTokenKey: string | undefined;
    let nextAccessToken: string | null = null;

    if (tokenKey) {
      const loginResp = await fetch(`${apiUrl}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Token-Key': tokenKey },
        body: JSON.stringify({
          userName: '__token_key_login__',
          password: '__token_key_login__',
          terminal: 0,
          terminalNo: 0,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!loginResp.ok) {
        logger.warn(`[box-im] Failed to refresh owner accessToken via tokenKey login: ${loginResp.status}`);
      } else {
        const loginPayload = await loginResp.json() as {
          data?: {
            id?: number;
            accessToken?: string;
            tokenKey?: string;
          };
        };
        nextAccessToken = typeof loginPayload.data?.accessToken === 'string' && loginPayload.data.accessToken.trim().length > 0
          ? loginPayload.data.accessToken.trim()
          : null;
        refreshedUserId = typeof loginPayload.data?.id === 'number' && loginPayload.data.id > 0
          ? loginPayload.data.id
          : undefined;
        refreshedTokenKey = typeof loginPayload.data?.tokenKey === 'string' && loginPayload.data.tokenKey.trim().length > 0
          ? loginPayload.data.tokenKey.trim()
          : undefined;
      }
    }

    if (!nextAccessToken && openid) {
      const resp = await fetch(`${apiUrl}/findUserByOpenid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ openid, terminalNo: 0 }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        logger.warn(`[box-im] Failed to refresh owner accessToken via openid lookup: ${resp.status}`);
      } else {
        const payload = await resp.json() as {
          data?: {
            id?: number;
            accessToken?: string;
            tokenKey?: string;
          };
        };
        nextAccessToken = typeof payload.data?.accessToken === 'string' && payload.data.accessToken.trim().length > 0
          ? payload.data.accessToken.trim()
          : null;
        refreshedUserId = typeof payload.data?.id === 'number' && payload.data.id > 0
          ? payload.data.id
          : refreshedUserId;
        refreshedTokenKey = typeof payload.data?.tokenKey === 'string' && payload.data.tokenKey.trim().length > 0
          ? payload.data.tokenKey.trim()
          : refreshedTokenKey;
      }
    }

    if (!nextAccessToken) return null;

    const cfg = await readOpenClawConfig();
    if (!cfg.channels) cfg.channels = {};
    const boxIm = (cfg.channels[CHANNEL_ID] ?? {}) as Record<string, unknown>;
    const ownerAuth = (boxIm.ownerAuth && typeof boxIm.ownerAuth === 'object'
      ? boxIm.ownerAuth as Record<string, unknown>
      : {}) as Record<string, unknown>;

    ownerAuth.accessToken = nextAccessToken;
    if (typeof refreshedUserId === 'number' && refreshedUserId > 0) {
      ownerAuth.userId = refreshedUserId;
    }
    if (typeof refreshedTokenKey === 'string' && refreshedTokenKey.trim().length > 0) {
      ownerAuth.tokenKey = refreshedTokenKey.trim();
    }

    boxIm.ownerAuth = ownerAuth;
    cfg.channels[CHANNEL_ID] = boxIm;
    await writeOpenClawConfig(cfg);
    logger.info('[box-im] Refreshed owner accessToken');
    return nextAccessToken;
  } catch (err) {
    logger.warn('[box-im] Failed to auto-repair owner accessToken:', err);
    return null;
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
  const raw = new TextDecoder('utf-8').decode(await resp.arrayBuffer());
  const result = JSON.parse(raw) as { code?: number; data?: any[]; message?: string };
  if (result.code !== 200) throw new Error(`bot list failed: ${result.message}`);
  
  logger.debug(`[box-im] Bot API returned ${result.data?.length ?? 0} record(s)`);
  
  return (result.data ?? []).map((b: any) => {
    const botInfo = {
      id: b.id,
      userName: b.userName ?? '',
      nickName: b.nickName ?? '',
      headImage: b.headImage ?? '',
      openclawAgentId: b.openclawAgentId ?? b.agentId ?? b.userName ?? '',
      accessToken: b.accessToken ?? null,
      model: b.model ?? undefined,
      deviceNodeId: b.deviceNodeId ?? b.nodeId ?? undefined,
      skills: b.skills ? (typeof b.skills === 'string' ? JSON.parse(b.skills) : b.skills) : undefined,
      templateId: b.templateId ?? null,
    };
    logger.debug(`[box-im] Parsed bot ${b.id}: model="${b.model}" -> "${botInfo.model}"`);
    return botInfo;
  });
}

// ── Reconciliation ───────────────────────────────────────────────

function buildAccountsFromBots(
  bots: BotInfo[],
  existing: Record<string, BoxImAccount>,
  availableModelIds: Set<string> | null = null,
): Record<string, BoxImAccount> {
  const accounts: Record<string, BoxImAccount> = {};
  for (const bot of bots) {
    const agentId = bot.openclawAgentId || bot.userName || `bot-${bot.id}`;
    const supportedModelId = resolveSupportedModelId(bot.model, availableModelIds);
    const modelValue = supportedModelId ? `shadan/${supportedModelId}` : '';
    
    logger.debug(`[box-im-sync] Building account for ${agentId}: bot.model="${bot.model}", final model="${modelValue}"`);
    
    accounts[agentId] = {
      enabled: true,
      accessToken: bot.accessToken || existing[agentId]?.accessToken || '',
      userId: bot.id,
      botName: bot.nickName,
      headImage: bot.headImage ?? '',
      model: modelValue,
      skills: bot.skills ?? existing[agentId]?.skills ?? undefined,
    };
  }
  return accounts;
}

async function reconcileAgents(
  oldList: AgentEntry[],
  accounts: Record<string, BoxImAccount>,
): Promise<AgentEntry[]> {
  const keep = new Map<string, AgentEntry>();
  for (const a of oldList) keep.set(a.id, a);

  const result: AgentEntry[] = [];

  for (const id of SYSTEM_AGENTS) {
    const existing = keep.get(id);
    if (existing) result.push(existing);
  }

  // 读取默认模型配置
  const cfg = await readOpenClawConfig();
  const defaultModel = ((cfg as any).agents?.defaults?.model?.primary) as string | undefined;

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
        // 从数据库同步 model（数据库优先）
        if (acct.model && acct.model.length > 0) {
          existing.model = { primary: acct.model };
          logger.info(`[box-im] Set model for ${agentId}: ${acct.model} (from database)`);
        } else if (defaultModel) {
          // 数据库中没有 model,使用默认模型
          existing.model = { primary: defaultModel };
          logger.info(`[box-im] Set model for ${agentId}: ${defaultModel} (default)`);
        }
        result.push(existing);
      }
    } else {
      const home = process.env.HOME || process.env.USERPROFILE || '';
      const agentConfig: AgentEntry = {
        id: agentId,
        name: acct.botName || agentId,
        workspace: `${home}/.openclaw/workspace-${agentId}`,
        agentDir: `${home}/.openclaw/agents/${agentId}/agent`,
        skills: acct.skills,
      };
      // 从数据库同步 model（如果有）
      if (acct.model && acct.model.length > 0) {
        agentConfig.model = { primary: acct.model };
        logger.info(`[box-im] Set model for new agent ${agentId}: ${acct.model} (from database)`);
      } else if (defaultModel) {
        // 数据库中没有 model,使用默认模型
        agentConfig.model = { primary: defaultModel };
        logger.info(`[box-im] Set model for new agent ${agentId}: ${defaultModel} (default)`);
      }
      result.push(agentConfig);
    }
  }
  return result;
}

function reconcileBindings(
  oldBindings: Binding[],
  accountIds: string[],
): Binding[] {
  const result = oldBindings.filter(b => b.match?.channel !== CHANNEL_ID);
  logger.debug(`[box-im] reconcileBindings: creating bindings for ${accountIds.length} accounts`);
  for (const agentId of accountIds) {
    logger.debug(`[box-im] Creating binding for agent: ${agentId}`);
    result.push({ agentId, match: { channel: CHANNEL_ID, accountId: agentId } });
  }
  logger.debug(`[box-im] Total bindings after reconciliation: ${result.length}`);
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
  const newList = await reconcileAgents(oldList, accounts);
  (cfg as any).agents = { ...agents, list: newList };

  const oldBindings = ((cfg as any).bindings ?? []) as Binding[];
  const accountIds = Object.keys(accounts);
  logger.debug(`[box-im] saveBoxImAccounts: ${accountIds.length} accounts to sync (${accountIds.join(', ')})`);
  (cfg as any).bindings = reconcileBindings(oldBindings, accountIds);

  // Pre-create agent directories so Gateway can initialize them on startup.
  // Without these dirs, Gateway skips the agent and the channel plugin never starts.
  for (const entry of newList) {
    if (!entry.agentDir) continue;
    try {
      await mkdir(entry.agentDir, { recursive: true });
      // Seed a minimal auth-profiles.json so Gateway recognizes this as a valid agent
      const authProfilesPath = join(entry.agentDir, 'auth-profiles.json');
      try {
        await readFile(authProfilesPath, 'utf-8');
      } catch {
        await writeFile(authProfilesPath, JSON.stringify({ version: 1, profiles: {} }, null, 2), 'utf-8');
      }
    } catch (err) {
      logger.warn(`[box-im] Failed to pre-create agent dir ${entry.agentDir}:`, err);
    }
  }

  await writeOpenClawConfig(cfg);
  logger.info(`[box-im] Saved ${Object.keys(accounts).length} accounts, ${newList.length} agents`);
}

// ── Public entry point ───────────────────────────────────────────

/**
 * 迁移函数：修复缺失的 model 配置
 * 检查所有 agent,如果 model 为空但数据库中有值,则从 API 重新获取并更新
 * 如果数据库中也是空的,则使用默认模型(从 agents.defaults.model 获取)
 */
async function migrateAgentModels(): Promise<void> {
  try {
    const { tokenKey, apiUrl } = await getBoxImConfig();
    if (!tokenKey) return;

    const cfg = await readOpenClawConfig();
    const agentsList = ((cfg as any).agents?.list ?? []) as AgentEntry[];
    const defaultModel = ((cfg as any).agents?.defaults?.model?.primary) as string | undefined;
    
    // 检查是否有 agent 缺少 model 配置
    const needsMigration = agentsList.some(agent => {
      if (SYSTEM_AGENTS.has(agent.id)) return false;
      return !agent.model || !agent.model.primary;
    });

    if (!needsMigration) {
      logger.info('[box-im] All agents have model configured, skipping migration');
      return;
    }

    logger.info('[box-im] Detected agents with missing model, fetching from API...');
    
    // 从 API 获取最新的 bot 列表
    const bots = await fetchBotsFromApi(apiUrl, tokenKey);
    const botMap = new Map(bots.map(b => [b.openclawAgentId || `bot-${b.id}`, b]));
    
    let updated = false;
    for (const agent of agentsList) {
      if (SYSTEM_AGENTS.has(agent.id)) continue;
      
      // 如果 agent 已经有 model 配置,跳过
      if (agent.model && agent.model.primary) continue;
      
      const bot = botMap.get(agent.id);
      if (bot && bot.model && bot.model.length > 0) {
        // 数据库中有 model,使用数据库的值
        const modelValue = `shadan/${bot.model}`;
        agent.model = { primary: modelValue };
        updated = true;
        logger.info(`[box-im] Migrated model for ${agent.id}: ${modelValue} (from database)`);
      } else if (defaultModel) {
        // 数据库中没有 model,使用默认模型
        agent.model = { primary: defaultModel };
        updated = true;
        logger.info(`[box-im] Migrated model for ${agent.id}: ${defaultModel} (default)`);
      } else {
        logger.warn(`[box-im] No model found for ${agent.id}, and no default model configured`);
      }
    }

    if (updated) {
      (cfg as any).agents = { ...((cfg as any).agents ?? {}), list: agentsList };
      await writeOpenClawConfig(cfg);
      logger.info('[box-im] Agent model migration completed');
    }
  } catch (err) {
    logger.warn('[box-im] Agent model migration failed (non-fatal):', err);
  }
}

// Mutex to prevent concurrent syncBots() calls from corrupting openclaw.json
let syncBotsInProgress = false;
let syncBotsQueue: Array<{ resolve: (result: BoxImSyncResult) => void; reject: (error: Error) => void }> = [];

export async function syncBots(): Promise<BoxImSyncResult> {
  // 先执行迁移,修复缺失的 model 配置
  await migrateAgentModels();
  
  // If sync is already in progress, queue this call and wait for the current sync to complete
  if (syncBotsInProgress) {
    logger.info('[box-im] Sync already in progress, queuing this request...');
    return new Promise((resolve, reject) => {
      syncBotsQueue.push({ resolve, reject });
    });
  }

  syncBotsInProgress = true;
  try {
    const result = await syncBotsInternal();
    
    // Resolve all queued requests with the same result
    while (syncBotsQueue.length > 0) {
      const queued = syncBotsQueue.shift();
      if (queued) {
        queued.resolve(result);
      }
    }
    
    return result;
  } catch (error) {
    // Reject all queued requests with the same error
    while (syncBotsQueue.length > 0) {
      const queued = syncBotsQueue.shift();
      if (queued) {
        queued.reject(error as Error);
      }
    }
    throw error;
  } finally {
    syncBotsInProgress = false;
  }
}

async function syncBotsInternal(): Promise<BoxImSyncResult> {
  const { tokenKey, apiUrl, accounts } = await getBoxImConfig();

  logger.debug(`[box-im-sync] syncBotsInternal start (tokenKey=${tokenKey ? 'exists' : 'missing'}, apiUrl=${apiUrl})`);

  if (!tokenKey) {
    return { bots: [], error: '未绑定用户' };
  }

  try {
    logger.info('[box-im] Starting bot sync...');
    const bots = await fetchBotsFromApi(apiUrl, tokenKey);
    const availableModelIds = await fetchAvailableOneApiModelIds(tokenKey);
    logger.info(`[box-im] Fetched ${bots.length} bots from API`);
    
    const newAccounts = buildAccountsFromBots(bots, accounts, availableModelIds);
    logger.debug(`[box-im] Built ${Object.keys(newAccounts).length} accounts: ${Object.keys(newAccounts).join(', ')}`);

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

    // Update IDENTITY.md and copy auth-profiles.json for each bot
    for (const bot of bots) {
      const agentId = bot.openclawAgentId || bot.userName || `bot-${bot.id}`;
      const acct = newAccounts[agentId];
      const nickName = bot.nickName || agentId;
      const workspace = acct ? `${process.env.HOME || process.env.USERPROFILE || homedir()}/.openclaw/workspace-${agentId}` : undefined;
      await updateAgentIdentityMd(agentId, nickName, workspace);
      
      // Copy auth-profiles.json from main agent
      await copyAuthProfiles(agentId);
      
      // Sync Profile files (AGENTS.md, SOUL.md, TOOLS.md, etc.)
      try {
        const profileResult = await syncProfileFiles(agentId);
        logger.info(`[box-im] Profile sync for ${agentId}: ${profileResult.synced} synced, ${profileResult.errors} errors`);
      } catch (err) {
        logger.warn(`[box-im] Profile sync failed for ${agentId}:`, err);
      }
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

// ── Profile Sync ─────────────────────────────────────────────────

const PROFILE_FILES = ['AGENTS.md', 'SOUL.md', 'TOOLS.md', 'IDENTITY.md', 'USER.md', 'HEARTBEAT.md'];

/**
 * Calculate SHA-256 hash of file content
 */
async function calculateFileHash(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Get workspace directory for an agent
 */
function getAgentWorkspace(agentId: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  return join(home, `.openclaw/workspace-${agentId}`);
}

/**
 * Read profile file from local workspace
 */
async function readLocalProfileFile(agentId: string, filename: string): Promise<{ content: string; hash: string } | null> {
  try {
    const workspace = getAgentWorkspace(agentId);
    const filePath = join(workspace, filename);
    const content = await readFile(filePath, 'utf-8');
    const hash = await calculateFileHash(content);
    return { content, hash };
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return null; // File doesn't exist
    }
    throw err;
  }
}

/**
 * Write profile file to local workspace
 */
async function writeLocalProfileFile(agentId: string, filename: string, content: string): Promise<void> {
  const workspace = getAgentWorkspace(agentId);
  await mkdir(workspace, { recursive: true });
  const filePath = join(workspace, filename);
  await writeFile(filePath, content, 'utf-8');
  logger.info(`[box-im] Wrote profile file: ${agentId}/${filename}`);
}

/**
 * Fetch profile file from API
 */
async function fetchProfileFile(apiUrl: string, tokenKey: string, userId: number, filename: string): Promise<ProfileFileInfo | null> {
  try {
    const resp = await fetch(`${apiUrl}/employee/profile/${filename}`, {
      method: 'GET',
      headers: { 'Token-Key': tokenKey },
      signal: AbortSignal.timeout(10000),
    });
    
    if (!resp.ok) {
      logger.warn(`[box-im] Failed to fetch profile ${filename}: ${resp.status}`);
      return null;
    }
    
    const result = await resp.json() as { code?: number; data?: any; message?: string };
    if (result.code !== 200 || !result.data) {
      logger.warn(`[box-im] Profile API error for ${filename}: ${result.message}`);
      return null;
    }
    
    const data = result.data;
    return {
      filename,
      content: data.content || '',
      hash: data.hash || '',
      source: data.source || 'DEFAULT',
      isModified: data.isModified || false,
      templateId: data.templateId,
    };
  } catch (err) {
    logger.error(`[box-im] Error fetching profile ${filename}:`, err);
    return null;
  }
}

/**
 * Upload profile file to API
 */
async function uploadProfileFile(apiUrl: string, tokenKey: string, userId: number, filename: string, content: string): Promise<boolean> {
  try {
    const resp = await fetch(`${apiUrl}/employee/profile/${filename}`, {
      method: 'POST',
      headers: {
        'Token-Key': tokenKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content }),
      signal: AbortSignal.timeout(10000),
    });
    
    if (!resp.ok) {
      logger.warn(`[box-im] Failed to upload profile ${filename}: ${resp.status}`);
      return false;
    }
    
    const result = await resp.json() as { code?: number; message?: string };
    if (result.code !== 200) {
      logger.warn(`[box-im] Profile upload error for ${filename}: ${result.message}`);
      return false;
    }
    
    logger.info(`[box-im] Uploaded profile file: ${filename}`);
    return true;
  } catch (err) {
    logger.error(`[box-im] Error uploading profile ${filename}:`, err);
    return false;
  }
}

/**
 * Check sync status for all profile files
 */
export async function checkProfileSync(agentId: string): Promise<ProfileSyncStatus[]> {
  const { tokenKey, apiUrl, ownerUserId } = await getBoxImConfig();
  
  if (!tokenKey || !ownerUserId) {
    throw new Error('Not logged in');
  }
  
  const statuses: ProfileSyncStatus[] = [];
  
  for (const filename of PROFILE_FILES) {
    // Read local file
    const local = await readLocalProfileFile(agentId, filename);
    
    // Fetch remote file info
    const remote = await fetchProfileFile(apiUrl, tokenKey, ownerUserId, filename);
    
    const status: ProfileSyncStatus = {
      filename,
      localHash: local?.hash || null,
      remoteHash: remote?.hash || null,
      needsSync: false,
      direction: 'none',
    };
    
    if (!local && !remote) {
      // Both don't exist - no sync needed
      status.needsSync = false;
    } else if (!local && remote) {
      // Remote exists, local doesn't - download
      status.needsSync = true;
      status.direction = 'download';
    } else if (local && !remote) {
      // Local exists, remote doesn't - upload
      status.needsSync = true;
      status.direction = 'upload';
    } else if (local && remote && local.hash !== remote.hash) {
      // Both exist but different - prefer remote (cloud wins)
      status.needsSync = true;
      status.direction = 'download';
    }
    
    statuses.push(status);
  }
  
  return statuses;
}

/**
 * Sync all profile files for an agent (download only)
 * Note: Upload is handled automatically when saving files
 */
export async function syncProfileFiles(agentId: string): Promise<{ synced: number; errors: number }> {
  const { tokenKey, apiUrl, ownerUserId } = await getBoxImConfig();
  
  if (!tokenKey || !ownerUserId) {
    throw new Error('Not logged in');
  }
  
  logger.info(`[box-im] Starting profile sync (download) for agent: ${agentId}`);
  
  let synced = 0;
  let errors = 0;
  
  // Download all profile files from cloud
  for (const filename of PROFILE_FILES) {
    try {
      // Fetch remote file
      const remote = await fetchProfileFile(apiUrl, tokenKey, ownerUserId, filename);
      
      if (remote && remote.content) {
        // Read local file to compare
        const local = await readLocalProfileFile(agentId, filename);
        
        // Only download if different or doesn't exist locally
        if (!local || local.hash !== remote.hash) {
          await writeLocalProfileFile(agentId, filename, remote.content);
          synced++;
          logger.info(`[box-im] Downloaded profile: ${agentId}/${filename} (source: ${remote.source})`);
        }
      }
    } catch (err) {
      logger.error(`[box-im] Error syncing profile ${filename}:`, err);
      errors++;
    }
  }
  
  logger.info(`[box-im] Profile sync complete for ${agentId}: ${synced} downloaded, ${errors} errors`);
  return { synced, errors };
}

/**
 * Download a single profile file
 */
export async function downloadProfileFile(agentId: string, filename: string): Promise<boolean> {
  const { tokenKey, apiUrl, ownerUserId } = await getBoxImConfig();
  
  if (!tokenKey || !ownerUserId) {
    throw new Error('Not logged in');
  }
  
  const remote = await fetchProfileFile(apiUrl, tokenKey, ownerUserId, filename);
  if (!remote || !remote.content) {
    return false;
  }
  
  await writeLocalProfileFile(agentId, filename, remote.content);
  logger.info(`[box-im] Downloaded profile: ${agentId}/${filename} (source: ${remote.source})`);
  return true;
}

/**
 * Upload a single profile file
 */
export async function uploadProfileFile_Single(agentId: string, filename: string): Promise<boolean> {
  const { tokenKey, apiUrl, ownerUserId } = await getBoxImConfig();
  
  if (!tokenKey || !ownerUserId) {
    throw new Error('Not logged in');
  }
  
  const local = await readLocalProfileFile(agentId, filename);
  if (!local) {
    return false;
  }
  
  return await uploadProfileFile(apiUrl, tokenKey, ownerUserId, filename, local.content);
}

