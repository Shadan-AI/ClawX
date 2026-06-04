import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import { getPort } from '../utils/config';
import { logger } from '../utils/logger';
import type { HostApiContext } from './context';
import { handleAppRoutes } from './routes/app';
import { handleGatewayRoutes } from './routes/gateway';
import { handleSettingsRoutes } from './routes/settings';
import { handleProviderRoutes } from './routes/providers';
import { handleAgentRoutes } from './routes/agents';
import { handleChannelRoutes } from './routes/channels';
import { handleLogRoutes } from './routes/logs';
import { handleOneApiRoutes } from './routes/oneapi';
import { handleUsageRoutes } from './routes/usage';
import { handleSkillRoutes } from './routes/skills';
import { handleFileRoutes } from './routes/files';
import { handleSessionRoutes } from './routes/sessions';
import { handleCronRoutes } from './routes/cron';
import { sendJson, setCorsHeaders, requireJsonContentType } from './route-utils';

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
) => Promise<boolean>;

const routeHandlers: RouteHandler[] = [
  handleAppRoutes,
  handleGatewayRoutes,
  handleSettingsRoutes,
  handleProviderRoutes,
  handleAgentRoutes,
  handleChannelRoutes,
  handleSkillRoutes,
  handleFileRoutes,
  handleSessionRoutes,
  handleCronRoutes,
  handleLogRoutes,
  handleOneApiRoutes,
  handleUsageRoutes,
];

/**
 * Per-session secret token used to authenticate Host API requests.
 * Generated once at server start and shared with the renderer via IPC.
 * This prevents cross-origin attackers from reading sensitive data even
 * if they can reach 127.0.0.1:13210 (the CORS wildcard alone is not
 * sufficient because browsers attach the Origin header but not a secret).
 */
let hostApiToken: string = '';
let hostApiPort = getPort('CLAWX_HOST_API');

/** Retrieve the current Host API auth token (for use by IPC proxy). */
export function getHostApiToken(): string {
  return hostApiToken;
}

/** Retrieve the actual Host API listening port. */
export function getHostApiPort(): number {
  return hostApiPort;
}

function writeUpgradeError(socket: Socket, statusCode: number, message: string): void {
  try {
    socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`);
  } catch {
    // ignore socket write failure
  } finally {
    socket.destroy();
  }
}

function proxyGatewayTerminalWebSocket(
  client: WebSocket,
  upstreamUrl: string,
  tls: boolean,
): void {
  const upstream = tls
    ? new WebSocket(upstreamUrl, { rejectUnauthorized: false })
    : new WebSocket(upstreamUrl);
  const pendingClientMessages: Array<{ data: RawData; isBinary: boolean }> = [];
  let closed = false;

  const normalizeCloseCode = (code: number) => {
    if (code >= 3000 && code <= 4999) return code;
    if (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) return code;
    return 1011;
  };

  const closeBoth = (code = 1000, reason = '') => {
    if (closed) return;
    closed = true;
    const closeCode = normalizeCloseCode(code);
    const closeReason = reason.length > 120 ? reason.slice(0, 120) : reason;
    try {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close(closeCode, closeReason);
      }
    } catch {
      // ignore
    }
    try {
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.close(closeCode, closeReason);
      }
    } catch {
      // ignore
    }
  };

  client.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
      return;
    }
    if (upstream.readyState === WebSocket.CONNECTING && pendingClientMessages.length < 100) {
      pendingClientMessages.push({ data, isBinary });
    }
  });

  upstream.on('open', () => {
    for (const message of pendingClientMessages.splice(0)) {
      if (upstream.readyState !== WebSocket.OPEN) break;
      upstream.send(message.data, { binary: message.isBinary });
    }
  });

  upstream.on('message', (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data, { binary: isBinary });
    }
  });

  client.on('close', (code, reason) => closeBoth(code, reason.toString()));
  upstream.on('close', (code, reason) => closeBoth(code, reason.toString()));

  const onError = (source: 'client' | 'gateway', error: Error) => {
    logger.warn(`[host-api] Gateway terminal WebSocket ${source} error: ${error.message}`);
    closeBoth(1011, `${source} websocket error`);
  };
  client.on('error', (error) => onError('client', error));
  upstream.on('error', (error) => onError('gateway', error));
}

export function startHostApiServer(ctx: HostApiContext, port = getPort('CLAWX_HOST_API')): Server {
  // Generate a cryptographically random token for this session.
  hostApiToken = randomBytes(32).toString('hex');
  hostApiPort = port;
  const wsServer = new WebSocketServer({ noServer: true });
  let retriedEphemeralPort = false;

  const server = createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      // ── CORS headers ─────────────────────────────────────────
      // Set origin-aware CORS headers early so every response
      // (including error responses) carries them consistently.
      const origin = req.headers.origin;
      setCorsHeaders(res, origin);

      // CORS preflight — respond before auth so browsers can negotiate.
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }

      // ── Auth gate ──────────────────────────────────────────────
      // Every non-preflight request must carry a valid Bearer token.
      // Accept via Authorization header (preferred) or ?token= query
      // parameter (for EventSource which cannot set custom headers).
      const authHeader = req.headers.authorization || '';
      const bearerToken = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : (requestUrl.searchParams.get('token') || '');
      if (bearerToken !== hostApiToken) {
        sendJson(res, 401, { success: false, error: 'Unauthorized' });
        return;
      }

      // ── Content-Type gate (anti-CSRF) ──────────────────────────
      // Mutation requests must use application/json to force a CORS
      // preflight, preventing "simple request" CSRF attacks.
      if (!requireJsonContentType(req)) {
        sendJson(res, 415, { success: false, error: 'Content-Type must be application/json' });
        return;
      }

      for (const handler of routeHandlers) {
        if (await handler(req, res, requestUrl, ctx)) {
          return;
        }
      }
      sendJson(res, 404, { success: false, error: `No route for ${req.method} ${requestUrl.pathname}` });
    } catch (error) {
      logger.error('Host API request failed:', error);
      sendJson(res, 500, { success: false, error: String(error) });
    }
  });

  server.on('upgrade', (req, socket, head) => {
    try {
      const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      if (requestUrl.pathname !== '/api/gateway/terminal') {
        writeUpgradeError(socket, 404, 'Not Found');
        return;
      }

      const token = requestUrl.searchParams.get('token') || '';
      if (token !== hostApiToken) {
        logger.warn('[host-api] Gateway terminal WebSocket rejected: invalid token');
        writeUpgradeError(socket, 401, 'Unauthorized');
        return;
      }

      const status = ctx.gatewayManager.getStatus();
      if (status.state !== 'running') {
        logger.warn(`[host-api] Gateway terminal WebSocket rejected: gateway state=${status.state}`);
        writeUpgradeError(socket, 503, 'Gateway Unavailable');
        return;
      }

      const gatewayPort = status.port || getPort('OPENCLAW_GATEWAY');
      const tls = status.tls === true;
      requestUrl.searchParams.delete('token');
      const gatewayProtocol = tls ? 'wss' : 'ws';
      const upstreamUrl = `${gatewayProtocol}://127.0.0.1:${gatewayPort}/terminal?${requestUrl.searchParams.toString()}`;
      logger.info(`[host-api] Gateway terminal WebSocket proxying to ${gatewayProtocol}://127.0.0.1:${gatewayPort}/terminal tls=${tls}`);

      wsServer.handleUpgrade(req, socket, head, (client) => {
        proxyGatewayTerminalWebSocket(client, upstreamUrl, tls);
      });
    } catch (error) {
      logger.warn('[host-api] Gateway terminal WebSocket upgrade failed:', error);
      writeUpgradeError(socket, 500, 'Internal Server Error');
    }
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EACCES' || error.code === 'EADDRINUSE') {
      if (!retriedEphemeralPort) {
        retriedEphemeralPort = true;
        logger.warn(
          `Host API server failed to bind port ${hostApiPort}: ${error.message}. ` +
          'Retrying on an available localhost port.',
        );
        setImmediate(() => {
          try {
            server.listen(0, '127.0.0.1');
          } catch (retryError) {
            logger.error('Host API server retry failed:', retryError);
          }
        });
        return;
      }
      logger.error(
        `Host API server failed to bind port ${hostApiPort}: ${error.message}. ` +
        'On Windows this is often caused by Hyper-V reserving the port range. ' +
        `Set CLAWX_PORT_CLAWX_HOST_API env var to override the default port.`,
      );
    } else {
      logger.error('Host API server error:', error);
    }
  });

  server.on('close', () => {
    wsServer.close();
  });

  server.on('listening', () => {
    const address = server.address();
    if (address && typeof address === 'object') {
      hostApiPort = address.port;
    }
    logger.info(`Host API server listening on http://127.0.0.1:${hostApiPort}`);
  });

  server.listen(port, '127.0.0.1');

  return server;
}
