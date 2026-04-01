import type { IncomingMessage, ServerResponse } from 'http';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PORTS } from '../../utils/config';
import { buildGatewayPluginUrl, buildOpenClawControlUiUrl } from '../../utils/openclaw-control-ui';
import { getGatewayTlsEnabledFromOpenClawConfig } from '../../utils/openclaw-gateway-tls';
import { getSetting } from '../../utils/store';
import { proxyAwareFetch, proxyAwareFetchWithTls } from '../../utils/proxy-fetch';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

interface BotInfo {
  id: number;
  userName: string;
  nickName: string;
  headImage: string;
  openclawAgentId: string;
  accessToken?: string | null;
  model?: string;
  deviceNodeId?: string;
}

async function getBoxImConfig(): Promise<{
  tokenKey: string | null;
  apiUrl: string;
  accounts: Record<string, any>;
}> {
  try {
    const configPath = join(homedir(), '.openclaw', 'openclaw.json');
    if (!existsSync(configPath)) {
      return { tokenKey: null, apiUrl: 'https://im.shadanai.com/api', accounts: {} };
    }
    const raw = await readFile(configPath, 'utf-8');
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    const channels = cfg.channels as Record<string, unknown> | undefined;
    const boxIm = channels?.['box-im'] as Record<string, unknown> | undefined;
    const ownerAuth = boxIm?.ownerAuth as Record<string, unknown> | undefined;
    const tokenKey = ownerAuth?.tokenKey;
    const apiUrl = boxIm?.apiUrl;
    const accounts = boxIm?.accounts as Record<string, any> | undefined;
    return {
      tokenKey: typeof tokenKey === 'string' && tokenKey.length > 0 ? tokenKey : null,
      apiUrl: typeof apiUrl === 'string' && apiUrl.length > 0 ? apiUrl : 'https://im.shadanai.com/api',
      accounts: accounts ?? {},
    };
  } catch (err) {
    console.error('[box-im] Failed to read config:', err);
    return { tokenKey: null, apiUrl: 'https://im.shadanai.com/api', accounts: {} };
  }
}

async function saveBoxImAccountsAndSyncAgents(accounts: Record<string, any>): Promise<void> {
  try {
    const configPath = join(homedir(), '.openclaw', 'openclaw.json');
    console.log('[box-im] saveBoxImAccountsAndSyncAgents: accounts=', Object.keys(accounts));
    const raw = await readFile(configPath, 'utf-8');
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    const channels = cfg.channels as Record<string, unknown> | undefined;
    const boxIm = channels?.['box-im'] as Record<string, unknown> | undefined;
    const agents = cfg.agents as Record<string, unknown> | undefined;
    const oldList = (agents?.list as Array<Record<string, unknown>>) ?? [];
    
    // 获取有效的 agentId 列表（来自 accounts 的 key）
    const validAgentIds = new Set(Object.keys(accounts));
    // 保留 main 和 dev 这两个系统 agent
    validAgentIds.add('main');
    validAgentIds.add('dev');
    
    // 构建现有 agent 的 map
    const existingAgentMap = new Map<string, Record<string, unknown>>();
    for (const agent of oldList) {
      existingAgentMap.set(agent.id as string, agent);
    }
    
    // 为每个 account 确保有对应的 agent
    const newList: Array<Record<string, unknown>> = [];
    const accountIds = Object.keys(accounts);
    
    for (const agentId of validAgentIds) {
      if (agentId === 'main' || agentId === 'dev') {
        // 保留系统 agent
        const existing = existingAgentMap.get(agentId);
        if (existing) {
          newList.push(existing);
        }
        continue;
      }
      
      const account = accounts[agentId];
      const existing = existingAgentMap.get(agentId);
      
      if (existing) {
        // 更新现有 agent 的名称
        existing.name = account.botName || agentId;
        newList.push(existing);
      } else {
        // 创建新的 agent
        const homeDir = homedir();
        newList.push({
          id: agentId,
          name: account.botName || agentId,
          workspace: `${homeDir}/.openclaw/workspace-${agentId}`,
          agentDir: `${homeDir}/.openclaw/agents/${agentId}/agent`,
        });
        console.log('[box-im] Created new agent:', agentId);
      }
    }
    
    console.log('[box-im] Syncing agents.list:', { old: oldList.length, new: newList.length });
    
    // 构建 bindings：每个 agent 绑定对应的 box-im account
    const oldBindings = (cfg.bindings as Array<Record<string, unknown>>) ?? [];
    const newBindings: Array<Record<string, unknown>> = [];
    
    // 保留非 box-im 的绑定
    for (const binding of oldBindings) {
      const match = binding.match as Record<string, unknown> | undefined;
      if (match?.channel !== 'box-im') {
        newBindings.push(binding);
      }
    }
    
    // 为每个 account 创建 box-im 绑定
    for (const agentId of accountIds) {
      newBindings.push({
        agentId,
        match: {
          channel: 'box-im',
          accountId: agentId,
        },
      });
    }
    
    console.log('[box-im] Syncing bindings:', { old: oldBindings.length, new: newBindings.length });
    
    // 更新 box-im channel 配置，确保启用
    const updatedBoxIm = {
      ...(boxIm ?? {}),
      accounts,
    };
    
    // 确保 plugins.entries.box-im.enabled = true
    const plugins = (cfg.plugins as Record<string, unknown>) ?? {};
    const pluginEntries = (plugins.entries as Record<string, unknown>) ?? {};
    pluginEntries['box-im'] = { enabled: true };
    const pluginAllow = Array.isArray(plugins.allow) ? plugins.allow as string[] : [];
    if (!pluginAllow.includes('box-im')) pluginAllow.push('box-im');
    cfg.plugins = { ...plugins, allow: pluginAllow, entries: pluginEntries };
    
    // 写入配置
    cfg.channels = {
      ...(channels ?? {}),
      'box-im': updatedBoxIm,
    };
    
    cfg.agents = {
      ...(agents ?? {}),
      list: newList,
    };
    
    cfg.bindings = newBindings;
    
    await writeFile(configPath, JSON.stringify(cfg, null, 2), 'utf-8');
    console.log('[box-im] Saved accounts, agents, bindings successfully');
  } catch (err) {
    console.error('[box-im] Failed to save accounts:', err);
  }
}

async function fetchBotsFromApi(apiUrl: string, tokenKey: string): Promise<BotInfo[]> {
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

async function syncBotsAndReturn(): Promise<{ bots: BotInfo[]; error?: string }> {
  const { tokenKey, apiUrl, accounts } = await getBoxImConfig();
  
  console.log('[box-im] syncBotsAndReturn: tokenKey=', tokenKey ? 'found' : 'null', 'apiUrl=', apiUrl, 'localAccounts=', Object.keys(accounts));
  
  if (!tokenKey) {
    return { bots: [], error: '未绑定用户' };
  }
  
  try {
    const bots = await fetchBotsFromApi(apiUrl, tokenKey);
    console.log('[box-im] API returned bots:', bots.map(b => ({ id: b.id, agentId: b.openclawAgentId, name: b.nickName })));
    
    // 完全覆盖本地 accounts，与 ai-im 严格同步
    const newAccounts: Record<string, any> = {};
    for (const bot of bots) {
      const agentId = bot.openclawAgentId || bot.userName || `bot-${bot.id}`;
      // 只保留 accessToken（API 不返回，需要用旧的），其他完全覆盖
      const existingAccessToken = accounts[agentId]?.accessToken;
      newAccounts[agentId] = {
        enabled: true,
        accessToken: bot.accessToken || existingAccessToken || '',
        userId: bot.id,
        botName: bot.nickName,
        headImage: bot.headImage ?? '',
        model: bot.model ?? '',
      };
    }
    
    console.log('[box-im] New accounts to save:', Object.keys(newAccounts));
    await saveBoxImAccountsAndSyncAgents(newAccounts);
    console.log(`[box-im] Synced ${bots.length} bots from API, replaced local accounts`);
    
    return { bots };
  } catch (err: any) {
    console.error('[box-im] Failed to fetch bots from API:', err.message);
    // Fallback to local accounts
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

export async function handleGatewayRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/app/gateway-info' && req.method === 'GET') {
    const status = ctx.gatewayManager.getStatus();
    const token = await getSetting('gatewayToken');
    const port = status.port || PORTS.OPENCLAW_GATEWAY;
    sendJson(res, 200, {
      wsUrl: `ws://127.0.0.1:${port}/ws`,
      token,
      port,
    });
    return true;
  }

  if (url.pathname === '/api/gateway/status' && req.method === 'GET') {
    sendJson(res, 200, ctx.gatewayManager.getStatus());
    return true;
  }

  if (url.pathname === '/api/gateway/health' && req.method === 'GET') {
    const health = await ctx.gatewayManager.checkHealth();
    sendJson(res, 200, health);
    return true;
  }

  if (url.pathname === '/api/gateway/start' && req.method === 'POST') {
    try {
      await ctx.gatewayManager.start();
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/gateway/stop' && req.method === 'POST') {
    try {
      await ctx.gatewayManager.stop();
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/gateway/restart' && req.method === 'POST') {
    try {
      await ctx.gatewayManager.restart();
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/gateway/control-ui' && req.method === 'GET') {
    try {
      const status = ctx.gatewayManager.getStatus();
      const token = await getSetting('gatewayToken');
      const port = status.port || PORTS.OPENCLAW_GATEWAY;
      const tls = await getGatewayTlsEnabledFromOpenClawConfig();
      const urlValue = buildOpenClawControlUiUrl(port, token, { tls });
      sendJson(res, 200, { success: true, url: urlValue, token, port });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/gateway/plugin-url' && req.method === 'GET') {
    try {
      const rawPath = url.searchParams.get('path')?.trim() || '';
      if (!rawPath.startsWith('/plugins/') || rawPath.includes('..')) {
        sendJson(res, 400, { success: false, error: 'path must start with /plugins/' });
        return true;
      }
      const status = ctx.gatewayManager.getStatus();
      const port = status.port || PORTS.OPENCLAW_GATEWAY;
      const tls = await getGatewayTlsEnabledFromOpenClawConfig();
      const absoluteUrl = buildGatewayPluginUrl(port, rawPath, { tls });
      sendJson(res, 200, { success: true, url: absoluteUrl, port, tls });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/chat/send-with-media' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        sessionKey: string;
        message: string;
        deliver?: boolean;
        idempotencyKey: string;
        media?: Array<{ filePath: string; mimeType: string; fileName: string }>;
      }>(req);
      const VISION_MIME_TYPES = new Set([
        'image/png', 'image/jpeg', 'image/bmp', 'image/webp',
      ]);
      const imageAttachments: Array<{ content: string; mimeType: string; fileName: string }> = [];
      const fileReferences: string[] = [];
      if (body.media && body.media.length > 0) {
        const fsP = await import('node:fs/promises');
        for (const m of body.media) {
          fileReferences.push(`[media attached: ${m.filePath} (${m.mimeType}) | ${m.filePath}]`);
          if (VISION_MIME_TYPES.has(m.mimeType)) {
            const fileBuffer = await fsP.readFile(m.filePath);
            imageAttachments.push({
              content: fileBuffer.toString('base64'),
              mimeType: m.mimeType,
              fileName: m.fileName,
            });
          }
        }
      }

      const message = fileReferences.length > 0
        ? [body.message, ...fileReferences].filter(Boolean).join('\n')
        : body.message;
      const rpcParams: Record<string, unknown> = {
        sessionKey: body.sessionKey,
        message,
        deliver: body.deliver ?? false,
        idempotencyKey: body.idempotencyKey,
      };
      if (imageAttachments.length > 0) {
        rpcParams.attachments = imageAttachments;
      }
      const result = await ctx.gatewayManager.rpc('chat.send', rpcParams, 120000);
      sendJson(res, 200, { success: true, result });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  // Handle /plugins/box-im/bots directly - sync from ai-im API and save to local config
  if (url.pathname === '/plugins/box-im/bots' && req.method === 'GET') {
    const result = await syncBotsAndReturn();
    if (result.error && result.bots.length === 0) {
      sendJson(res, 401, { error: result.error });
    } else {
      sendJson(res, 200, { bots: result.bots, warning: result.error });
    }
    return true;
  }

  if (url.pathname.startsWith('/plugins/')) {
    try {
      const status = ctx.gatewayManager.getStatus();
      const port = status.port || PORTS.OPENCLAW_GATEWAY;
      const tls = await getGatewayTlsEnabledFromOpenClawConfig();
      const scheme = tls ? 'https' : 'http';
      const targetUrl = `${scheme}://127.0.0.1:${port}${url.pathname}${url.search}`;
      
      const headers: Record<string, string> = {};
      const authHeader = req.headers.authorization;
      if (authHeader) {
        headers['Authorization'] = authHeader;
      }
      
      const { tokenKey } = await getBoxImConfig();
      if (tokenKey) {
        headers['Token-Key'] = tokenKey;
      }
      
      console.log('[gateway-proxy] Proxying to:', targetUrl, 'headers:', headers, 'tls:', tls);
      
      const fetchFn = tls ? proxyAwareFetchWithTls : proxyAwareFetch;
      const fetchOptions: Parameters<typeof proxyAwareFetchWithTls>[1] = {
        method: req.method,
        headers,
      };
      if (tls) {
        fetchOptions.rejectUnauthorized = false;
      }
      
      if (req.method === 'GET' || req.method === 'DELETE') {
        const response = await fetchFn(targetUrl, fetchOptions);
        const contentType = response.headers.get('content-type') || '';
        console.log('[gateway-proxy] Response status:', response.status, 'contentType:', contentType);
        if (contentType.includes('application/json')) {
          const json = await response.json();
          console.log('[gateway-proxy] Response json:', JSON.stringify(json).slice(0, 500));
          sendJson(res, response.status, json);
        } else {
          const text = await response.text();
          res.statusCode = response.status;
          res.setHeader('Content-Type', contentType || 'text/plain');
          res.end(text);
        }
      } else if (req.method === 'POST' || req.method === 'PUT') {
        const body = await parseJsonBody<unknown>(req);
        const response = await fetchFn(targetUrl, {
          ...fetchOptions,
          headers: {
            ...headers,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const json = await response.json();
          sendJson(res, response.status, json);
        } else {
          const text = await response.text();
          res.statusCode = response.status;
          res.setHeader('Content-Type', contentType || 'text/plain');
          res.end(text);
        }
      } else {
        sendJson(res, 405, { success: false, error: 'Method not allowed' });
      }
    } catch (error) {
      console.error('[gateway-proxy] Error:', error);
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
