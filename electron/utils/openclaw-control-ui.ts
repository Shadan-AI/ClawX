/**
 * Build the external OpenClaw Control UI URL.
 *
 * Uses the machine's first private LAN IPv4 address with https:// so the
 * URL works from other devices on the same network.
 * Falls back to https://127.0.0.1 if no LAN IP is found.
 *
 * OpenClaw 2026.3.13 imports one-time auth tokens from the URL fragment
 * (`#token=...`) and strips them after load.
 */
import { networkInterfaces } from 'os';

function getFirstLanIPv4(): string {
  const nets = networkInterfaces();
  const re = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/;
  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal && re.test(iface.address)) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

export function buildOpenClawControlUiUrl(port: number, token: string): string {
  const ip = getFirstLanIPv4();
  const url = new URL(`https://${ip}:${port}/`);
  const trimmedToken = token.trim();

  if (trimmedToken) {
    url.hash = new URLSearchParams({ token: trimmedToken }).toString();
  }

  return url.toString();
}
