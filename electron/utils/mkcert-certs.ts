/**
 * Windows: generate ~/.openclaw/certs/localhost.pem + localhost-key.pem via bundled mkcert
 * (localhost + 127.0.0.1 + ::1 + private LAN IPv4), aligned with openme/start-npm.ps1.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { getResourcesDir } from './paths';
import { logger } from './logger';

const OPENCLAW_CERT_DIR = () => join(homedir(), '.openclaw', 'certs');
const CERT_FILE = () => join(OPENCLAW_CERT_DIR(), 'localhost.pem');
const KEY_FILE = () => join(OPENCLAW_CERT_DIR(), 'localhost-key.pem');

/** Private IPv4 (RFC1918-style ranges) for LAN HTTPS. */
function listPrivateLanIPv4(): string[] {
  const nets = networkInterfaces();
  const out = new Set<string>();
  const re = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/;
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      const fam = net.family;
      if (fam !== 'IPv4' && fam !== 4) continue;
      if (net.internal) continue;
      if (!re.test(net.address)) continue;
      out.add(net.address);
    }
  }
  return [...out].sort();
}

function resolveBundledMkcertExe(): string | null {
  const bundled = join(getResourcesDir(), 'tools', 'mkcert.exe');
  if (existsSync(bundled)) {
    return bundled;
  }
  // Dev: ClawX repo layout — openme is sibling of ClawX folder
  const devOpenme = join(__dirname, '../../../openme/mkcert.exe');
  if (existsSync(devOpenme)) {
    return devOpenme;
  }
  return null;
}

export type MkcertEnsureResult = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
  certDir?: string;
};

/**
 * Run on Windows before Gateway start when certs are missing.
 * Set CLAWX_SKIP_MKCERT=1 to skip. Set CLAWX_REGENERATE_MKCERT=1 to force re-issue.
 */
export function ensureOpenClawMkcertCertsWindows(): MkcertEnsureResult {
  if (process.platform !== 'win32') {
    return { ok: true, skipped: true, reason: 'not-windows' };
  }
  if (process.env.CLAWX_SKIP_MKCERT === '1') {
    return { ok: true, skipped: true, reason: 'CLAWX_SKIP_MKCERT' };
  }

  const certFile = CERT_FILE();
  const keyFile = KEY_FILE();
  const certDir = OPENCLAW_CERT_DIR();

  if (existsSync(certFile) && existsSync(keyFile) && process.env.CLAWX_REGENERATE_MKCERT !== '1') {
    return { ok: true, skipped: true, reason: 'certs-exist', certDir };
  }

  const mkcert = resolveBundledMkcertExe();
  if (!mkcert) {
    const msg =
      'mkcert.exe not found (run pnpm build: copy from openme, or place openme/mkcert.exe for dev)';
    logger.warn(`[mkcert] ${msg}`);
    return { ok: false, error: msg };
  }

  mkdirSync(certDir, { recursive: true });
  const lan = listPrivateLanIPv4();
  const hosts = ['localhost', '127.0.0.1', '::1', ...lan];
  logger.info(`[mkcert] generating certs for: ${hosts.join(', ')}`);

  try {
    execFileSync(mkcert, ['-install'], { stdio: 'pipe', windowsHide: true });
  } catch (err) {
    logger.warn('[mkcert] -install (non-fatal):', err);
  }

  try {
    execFileSync(mkcert, ['-cert-file', certFile, '-key-file', keyFile, ...hosts], {
      stdio: 'pipe',
      windowsHide: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('[mkcert] certificate generation failed:', err);
    return { ok: false, error: message };
  }

  logger.info(`[mkcert] wrote ${certFile}`);
  return { ok: true, certDir };
}
