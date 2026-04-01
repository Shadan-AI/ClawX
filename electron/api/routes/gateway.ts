import type { IncomingMessage, ServerResponse } from 'http';
import { PORTS } from '../../utils/config';
import { buildGatewayPluginUrl, buildOpenClawControlUiUrl } from '../../utils/openclaw-control-ui';
import { getGatewayTlsEnabledFromOpenClawConfig } from '../../utils/openclaw-gateway-tls';
import { getSetting } from '../../utils/store';
import { proxyAwareFetch, proxyAwareFetchWithTls } from '../../utils/proxy-fetch';
import { syncBots, getBoxImConfig } from '../../utils/box-im-sync';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

export async function handleGatewayRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  // ── Gateway lifecycle ────────────────────────────────────────

  if (url.pathname === '/api/app/gateway-info' && req.method === 'GET') {
    const status = ctx.gatewayManager.getStatus();
    const token = await getSetting('gatewayToken');
    const port = status.port || PORTS.OPENCLAW_GATEWAY;
    sendJson(res, 200, { wsUrl: `ws://127.0.0.1:${port}/ws`, token, port });
    return true;
  }

  if (url.pathname === '/api/gateway/status' && req.method === 'GET') {
    sendJson(res, 200, ctx.gatewayManager.getStatus());
    return true;
  }

  if (url.pathname === '/api/gateway/health' && req.method === 'GET') {
    sendJson(res, 200, await ctx.gatewayManager.checkHealth());
    return true;
  }

  if (url.pathname === '/api/gateway/start' && req.method === 'POST') {
    try { await ctx.gatewayManager.start(); sendJson(res, 200, { success: true }); }
    catch (error) { sendJson(res, 500, { success: false, error: String(error) }); }
    return true;
  }

  if (url.pathname === '/api/gateway/stop' && req.method === 'POST') {
    try { await ctx.gatewayManager.stop(); sendJson(res, 200, { success: true }); }
    catch (error) { sendJson(res, 500, { success: false, error: String(error) }); }
    return true;
  }

  if (url.pathname === '/api/gateway/restart' && req.method === 'POST') {
    try { await ctx.gatewayManager.restart(); sendJson(res, 200, { success: true }); }
    catch (error) { sendJson(res, 500, { success: false, error: String(error) }); }
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
      sendJson(res, 200, { success: true, url: buildGatewayPluginUrl(port, rawPath, { tls }), port, tls });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  // ── Chat with media ──────────────────────────────────────────

  if (url.pathname === '/api/chat/send-with-media' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        sessionKey: string;
        message: string;
        deliver?: boolean;
        idempotencyKey: string;
        media?: Array<{ filePath: string; mimeType: string; fileName: string }>;
      }>(req);
      const VISION_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/bmp', 'image/webp']);
      const imageAttachments: Array<{ content: string; mimeType: string; fileName: string }> = [];
      const fileReferences: string[] = [];
      if (body.media?.length) {
        const fsP = await import('node:fs/promises');
        for (const m of body.media) {
          fileReferences.push(`[media attached: ${m.filePath} (${m.mimeType}) | ${m.filePath}]`);
          if (VISION_MIME_TYPES.has(m.mimeType)) {
            const buf = await fsP.readFile(m.filePath);
            imageAttachments.push({ content: buf.toString('base64'), mimeType: m.mimeType, fileName: m.fileName });
          }
        }
      }
      const message = fileReferences.length > 0
        ? [body.message, ...fileReferences].filter(Boolean).join('\n')
        : body.message;
      const rpcParams: Record<string, unknown> = {
        sessionKey: body.sessionKey, message, deliver: body.deliver ?? false, idempotencyKey: body.idempotencyKey,
      };
      if (imageAttachments.length > 0) rpcParams.attachments = imageAttachments;
      const result = await ctx.gatewayManager.rpc('chat.send', rpcParams, 120000);
      sendJson(res, 200, { success: true, result });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  // ── Box-IM bot sync ──────────────────────────────────────────

  if (url.pathname === '/plugins/box-im/bots' && req.method === 'GET') {
    const result = await syncBots();
    if (result.error && result.bots.length === 0) {
      sendJson(res, 401, { error: result.error });
    } else {
      sendJson(res, 200, { bots: result.bots, warning: result.error });
    }
    return true;
  }

  // ── Generic plugin proxy ─────────────────────────────────────

  if (url.pathname.startsWith('/plugins/')) {
    try {
      const status = ctx.gatewayManager.getStatus();
      const port = status.port || PORTS.OPENCLAW_GATEWAY;
      const tls = await getGatewayTlsEnabledFromOpenClawConfig();
      const targetUrl = `${tls ? 'https' : 'http'}://127.0.0.1:${port}${url.pathname}${url.search}`;

      const headers: Record<string, string> = {};
      if (req.headers.authorization) headers['Authorization'] = req.headers.authorization;
      const { tokenKey } = await getBoxImConfig();
      if (tokenKey) headers['Token-Key'] = tokenKey;

      const fetchFn = tls ? proxyAwareFetchWithTls : proxyAwareFetch;
      const fetchOpts: Parameters<typeof proxyAwareFetchWithTls>[1] = { method: req.method, headers };
      if (tls) fetchOpts.rejectUnauthorized = false;

      if (req.method === 'POST' || req.method === 'PUT') {
        fetchOpts.headers = { ...headers, 'Content-Type': 'application/json' };
        fetchOpts.body = JSON.stringify(await parseJsonBody<unknown>(req));
      }

      const response = await fetchFn(targetUrl, fetchOpts);
      const ct = response.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        sendJson(res, response.status, await response.json());
      } else {
        res.statusCode = response.status;
        res.setHeader('Content-Type', ct || 'text/plain');
        res.end(await response.text());
      }
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
