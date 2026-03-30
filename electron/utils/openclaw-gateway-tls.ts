/**
 * Read whether the local Gateway expects WSS (TLS) from ~/.openclaw/openclaw.json.
 * Must match OpenClaw gateway listener (HTTPS + WSS when gateway.tls.enabled).
 */
import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const OPENCLAW_CONFIG_PATH = join(homedir(), '.openclaw', 'openclaw.json');

export async function getGatewayTlsEnabledFromOpenClawConfig(): Promise<boolean> {
  try {
    const raw = await readFile(OPENCLAW_CONFIG_PATH, 'utf-8');
    const j = JSON.parse(raw) as { gateway?: { tls?: { enabled?: boolean } } };
    return j.gateway?.tls?.enabled === true;
  } catch {
    return false;
  }
}
