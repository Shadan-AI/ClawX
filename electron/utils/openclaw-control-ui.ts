/**
 * Build the external OpenClaw Control UI URL.
 *
 * OpenClaw 2026.3.13 imports one-time auth tokens from the URL fragment
 * (`#token=...`) and strips them after load. Query-string tokens are removed
 * by the UI bootstrap but are not imported for auth.
 *
 * When `gateway.tls.enabled` is true, the listener is HTTPS — use `https://`
 * or the browser shows connection errors for `http://` on that port.
 */
export function buildOpenClawControlUiUrl(
  port: number,
  token: string,
  options?: { tls?: boolean },
): string {
  const scheme = options?.tls === true ? 'https' : 'http';
  const url = new URL(`${scheme}://127.0.0.1:${port}/`);
  const trimmedToken = token.trim();

  if (trimmedToken) {
    url.hash = new URLSearchParams({ token: trimmedToken }).toString();
  }

  return url.toString();
}

/**
 * Absolute URL for a Gateway-served plugin route (e.g. `/plugins/box-im/login`).
 * Respects TLS when `gateway.tls.enabled` is passed via options.
 */
export function buildGatewayPluginUrl(
  port: number,
  pathname: string,
  options?: { tls?: boolean },
): string {
  const scheme = options?.tls === true ? 'https' : 'http';
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${scheme}://127.0.0.1:${port}${path}`;
}
