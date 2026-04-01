import type { IncomingMessage, ServerResponse } from 'http';
import { getDatasourceConnectors, saveDatasourceConnector } from '../../utils/datasource-config';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

export async function handleDatasourceRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/datasources' && req.method === 'GET') {
    try {
      const connectors = await getDatasourceConnectors();
      sendJson(res, 200, { success: true, connectors });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/datasources/save' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ connectorKey?: string; fields?: Record<string, string> }>(req);
      const connectorKey = body.connectorKey?.trim();
      const fields = body.fields;
      if (!connectorKey || !fields || typeof fields !== 'object') {
        sendJson(res, 400, { success: false, error: 'connectorKey and fields required' });
        return true;
      }
      await saveDatasourceConnector(connectorKey, fields);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
