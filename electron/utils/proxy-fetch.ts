/**
 * Use Electron's network stack when available so requests honor
 * session.defaultSession.setProxy(...). Fall back to the Node global fetch
 * for non-Electron test environments.
 */

import https from 'node:https';

export async function proxyAwareFetch(
  input: string | URL,
  init?: RequestInit
): Promise<Response> {
  if (process.versions.electron) {
    try {
      const { net } = await import('electron');
      return await net.fetch(input, init);
    } catch {
      // Fall through to the global fetch.
    }
  }

  return await fetch(input, init);
}

export async function proxyAwareFetchWithTls(
  input: string | URL,
  init?: RequestInit & { rejectUnauthorized?: boolean }
): Promise<Response> {
  const url = typeof input === 'string' ? new URL(input) : input;
  const rejectUnauthorized = init?.rejectUnauthorized !== false;

  if (url.protocol === 'https:' && !rejectUnauthorized) {
    const agent = new https.Agent({ rejectUnauthorized: false });
    
    const headers = new Headers(init?.headers);
    const headersObj: Record<string, string> = {};
    headers.forEach((value, key) => {
      headersObj[key] = value;
    });

    return new Promise((resolve, reject) => {
      const req = https.request(
        url.toString(),
        {
          method: init?.method || 'GET',
          headers: headersObj,
          agent,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            resolve(new Response(data, {
              status: res.statusCode,
              statusText: res.statusMessage,
              headers: new Headers(res.headers as Record<string, string>),
            }));
          });
        }
      );
      
      req.on('error', reject);
      
      if (init?.body) {
        req.write(typeof init.body === 'string' ? init.body : JSON.stringify(init.body));
      }
      
      req.end();
    });
  }

  return proxyAwareFetch(input, init);
}
