import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { getPort } from '../utils/config';
import { logger } from '../utils/logger';

const ONEAPI_BASE_URL = 'https://one-api.shadanai.com/v1';
const CLAUDE_ALIAS_MODELS = [
  { id: 'claude-haiku-4-5', display_name: 'ClawX Haiku' },
  { id: 'claude-sonnet-4-6', display_name: 'ClawX Sonnet' },
  { id: 'claude-opus-4-7', display_name: 'ClawX Opus' },
];
const modelOverrides = new Map<string, string>();

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function sendText(res: ServerResponse, statusCode: number, text: string): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(text);
}

function stripOneMMarker(model: string): string {
  return model.trim().replace(/\s*\[1m\]\s*$/i, '');
}

function bodyDiagnostic(rawBody: Buffer) {
  let hash = 2166136261;
  for (const byte of rawBody) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return {
    bytes: rawBody.length,
    hash: (hash >>> 0).toString(16).padStart(8, '0'),
  };
}

function extractUpstreamModel(pathname: string): string | null {
  const match = pathname.match(/^\/native-claude\/([^/]+)(?:\/|$)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]).trim() || null;
  } catch {
    return null;
  }
}

function resolveUpstreamModel(routeModel: string): string {
  return modelOverrides.get(routeModel) || routeModel;
}

function upstreamPath(pathname: string): string | null {
  const match = pathname.match(/^\/native-claude\/[^/]+\/v1(\/.*)?$/);
  if (!match) return null;
  const path = match[1] || '/';
  return path.startsWith('/v1/') ? path.slice(3) : path;
}

function buildForwardHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  const contentType = req.headers['content-type'];
  const anthropicVersion = req.headers['anthropic-version'];
  const anthropicBeta = req.headers['anthropic-beta'];
  const xApiKey = req.headers['x-api-key'];
  const authorization = req.headers.authorization;

  if (typeof contentType === 'string') headers.set('content-type', contentType);
  if (typeof anthropicVersion === 'string') headers.set('anthropic-version', anthropicVersion);
  if (typeof anthropicBeta === 'string') headers.set('anthropic-beta', anthropicBeta);
  if (typeof xApiKey === 'string') {
    headers.set('x-api-key', xApiKey);
    if (!authorization) headers.set('authorization', `Bearer ${xApiKey}`);
  }
  if (typeof authorization === 'string') headers.set('authorization', authorization);

  return headers;
}

function rewriteMessagesBody(rawBody: Buffer, upstreamModel: string): Buffer {
  if (rawBody.length === 0) return rawBody;
  const body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
  body.model = stripOneMMarker(upstreamModel);
  return Buffer.from(JSON.stringify(body), 'utf8');
}

async function forwardToOneApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  upstreamModel: string,
): Promise<void> {
  const startedAt = Date.now();
  const rawBody = await readRequestBody(req);
  const body = path === '/messages' || path === '/messages/count_tokens'
    ? rewriteMessagesBody(rawBody, upstreamModel)
    : rawBody;
  const requestDiagnostic = bodyDiagnostic(body);
  logger.info('[native-claude-proxy] forwarding request', {
    method: req.method,
    path,
    upstreamModel,
    body: requestDiagnostic,
  });
  const response = await fetch(`${ONEAPI_BASE_URL}${path}`, {
    method: req.method,
    headers: buildForwardHeaders(req),
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
  });
  logger.info('[native-claude-proxy] upstream response', {
    method: req.method,
    path,
    upstreamModel,
    status: response.status,
    elapsedMs: Date.now() - startedAt,
    body: requestDiagnostic,
  });

  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'content-encoding') return;
    res.setHeader(key, value);
  });
  if (response.body) {
    Readable.fromWeb(response.body).pipe(res);
    return;
  }
  res.end();
}

function handleModels(res: ServerResponse, upstreamModel: string): void {
  sendJson(res, 200, {
    data: CLAUDE_ALIAS_MODELS.map((model) => ({
      type: 'model',
      id: model.id,
      display_name: model.id === 'claude-sonnet-4-6'
        ? stripOneMMarker(upstreamModel)
        : model.display_name,
      created_at: '2026-01-01T00:00:00Z',
    })),
  });
}

export function startClaudeNativeProxy(port = getPort('CLAWX_NATIVE_CLAUDE_PROXY')): Server {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      const upstreamModel = extractUpstreamModel(url.pathname);
      const path = upstreamPath(url.pathname);
      if (!upstreamModel) {
        sendText(res, 404, 'Not Found');
        return;
      }

      if ((req.method === 'POST' || req.method === 'PUT') && url.pathname === `/native-claude/${encodeURIComponent(upstreamModel)}/__model`) {
        const rawBody = await readRequestBody(req);
        const body = rawBody.length > 0 ? JSON.parse(rawBody.toString('utf8')) as Record<string, unknown> : {};
        const model = typeof body.model === 'string' ? stripOneMMarker(body.model) : '';
        if (!model) {
          sendJson(res, 400, { success: false, error: 'Missing model' });
          return;
        }
        modelOverrides.set(upstreamModel, model);
        sendJson(res, 200, { success: true, routeModel: upstreamModel, upstreamModel: model });
        return;
      }

      if (!path) {
        sendText(res, 404, 'Not Found');
        return;
      }

      const resolvedUpstreamModel = resolveUpstreamModel(upstreamModel);

      if (req.method === 'GET' && path === '/models') {
        handleModels(res, resolvedUpstreamModel);
        return;
      }

      if (req.method === 'POST' && (path === '/messages' || path === '/messages/count_tokens')) {
        await forwardToOneApi(req, res, path, resolvedUpstreamModel);
        return;
      }

      sendText(res, 404, 'Not Found');
    } catch (error) {
      logger.error('[native-claude-proxy] Request failed:', error);
      sendJson(res, 500, { error: { message: String(error), type: 'proxy_error' } });
    }
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EACCES' || error.code === 'EADDRINUSE') {
      logger.error(
        `Native Claude proxy failed to bind port ${port}: ${error.message}. ` +
        'Set CLAWX_PORT_CLAWX_NATIVE_CLAUDE_PROXY env var to override the default port.',
      );
    } else {
      logger.error('Native Claude proxy error:', error);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    logger.info(`Native Claude proxy listening on http://127.0.0.1:${port}`);
  });

  return server;
}
