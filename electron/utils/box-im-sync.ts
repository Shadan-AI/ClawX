/**
 * Box-IM digital worker sync — reads bots from the ai-im API and
 * reconciles local openclaw.json (agents, bindings, channels, plugins).
 *
 * Reuses the project's existing config helpers so we never hand-craft
 * JSON writes that can corrupt the config file.
 */
import { readOpenClawConfig, writeOpenClawConfig } from './channel-config';
import { logger } from './logger';

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

const CHANNEL_ID = 'box-im';
const SYSTEM_AGENTS = new Set(['main', 'dev']);
const DEFAULT_API_URL = 'https://im.shadanai.com/api';

// ── Config reading ───────────────────────────────────────────────

export async function getBoxImConfig(): Promise<{
  tokenKey: string | null;
  apiUrl: string;
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
    const accounts = (boxIm.accounts ?? {}) as Record<string, BoxImAccount>;
    return { tokenKey, apiUrl, accounts };
  } catch (err) {
    logger.error('[box-im] Failed to read config:', err);
    return { tokenKey: null, apiUrl: DEFAULT_API_URL, accounts: {} };
  }
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

  // System agents first
  for (const id of SYSTEM_AGENTS) {
    const existing = keep.get(id);
    if (existing) result.push(existing);
  }

  // Bot agents
  for (const [agentId, acct] of Object.entries(accounts)) {
    if (SYSTEM_AGENTS.has(agentId)) continue;
    const existing = keep.get(agentId);
    if (existing) {
      existing.name = acct.botName || agentId;
      result.push(existing);
    } else {
      const home = process.env.HOME || process.env.USERPROFILE || '';
      result.push({
        id: agentId,
        name: acct.botName || agentId,
        workspace: `${home}/.openclaw/workspace-${agentId}`,
        agentDir: `${home}/.openclaw/agents/${agentId}/agent`,
      });
    }
  }
  return result;
}

function reconcileBindings(
  oldBindings: Binding[],
  accountIds: string[],
): Binding[] {
  // Keep non-box-im bindings
  const result = oldBindings.filter(b => b.match?.channel !== CHANNEL_ID);
  // Add one binding per account
  for (const agentId of accountIds) {
    result.push({ agentId, match: { channel: CHANNEL_ID, accountId: agentId } });
  }
  return result;
}

/**
 * Write reconciled bot data to openclaw.json using the project's
 * standard read/write helpers (handles meta stamping, restart flag, etc.).
 */
export async function saveBoxImAccounts(accounts: Record<string, BoxImAccount>): Promise<void> {
  const cfg = await readOpenClawConfig();

  // channels.box-im
  const boxIm = (cfg.channels?.[CHANNEL_ID] ?? {}) as Record<string, unknown>;
  if (!cfg.channels) cfg.channels = {};
  cfg.channels[CHANNEL_ID] = { ...boxIm, accounts, enabled: true };

  // plugins
  if (!cfg.plugins) cfg.plugins = {};
  const allow = Array.isArray(cfg.plugins.allow) ? cfg.plugins.allow as string[] : [];
  if (!allow.includes(CHANNEL_ID)) cfg.plugins.allow = [...allow, CHANNEL_ID];
  if (!cfg.plugins.entries) cfg.plugins.entries = {};
  cfg.plugins.entries[CHANNEL_ID] = { enabled: true };

  // agents
  const agents = (cfg as any).agents ?? {};
  const oldList = (agents.list ?? []) as AgentEntry[];
  const newList = reconcileAgents(oldList, accounts);
  (cfg as any).agents = { ...agents, list: newList };

  // bindings
  const oldBindings = ((cfg as any).bindings ?? []) as Binding[];
  (cfg as any).bindings = reconcileBindings(oldBindings, Object.keys(accounts));

  await writeOpenClawConfig(cfg);
  logger.info(`[box-im] Saved ${Object.keys(accounts).length} accounts, ${newList.length} agents`);
}

// ── Public entry point ───────────────────────────────────────────

/**
 * Fetch bots from ai-im API, reconcile with local config, persist.
 * Falls back to local accounts on API failure.
 */
export async function syncBots(): Promise<BoxImSyncResult> {
  const { tokenKey, apiUrl, accounts } = await getBoxImConfig();

  if (!tokenKey) {
    return { bots: [], error: '未绑定用户' };
  }

  try {
    const bots = await fetchBotsFromApi(apiUrl, tokenKey);
    const newAccounts = buildAccountsFromBots(bots, accounts);
    await saveBoxImAccounts(newAccounts);
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
