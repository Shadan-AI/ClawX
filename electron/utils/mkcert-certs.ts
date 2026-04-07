/**
 * Windows: generate ~/.openclaw/certs/localhost.pem + localhost-key.pem via bundled mkcert
 * (localhost + 127.0.0.1 + ::1 + private LAN IPv4), aligned with openme/start-npm.ps1.
 *
 * On first run, always force-regenerates certs and installs the root CA so the
 * system trusts them. Completion is recorded in ~/.openclaw/.env as
 * CLAWX_CERTS_INITIALIZED=true so subsequent starts skip regeneration.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { getResourcesDir } from './paths';
import { logger } from './logger';

const OPENCLAW_DIR = () => join(homedir(), '.openclaw');
const OPENCLAW_CERT_DIR = () => join(OPENCLAW_DIR(), 'certs');
const CERT_FILE = () => join(OPENCLAW_CERT_DIR(), 'localhost.pem');
const KEY_FILE = () => join(OPENCLAW_CERT_DIR(), 'localhost-key.pem');
const ENV_FILE = () => join(OPENCLAW_DIR(), '.env');
const CERTS_INITIALIZED_KEY = 'CLAWX_CERTS_INITIALIZED';

/** Read ~/.openclaw/.env and return parsed key=value map */
function readOpenClawEnv(): Map<string, string> {
  const envFile = ENV_FILE();
  const map = new Map<string, string>();
  if (!existsSync(envFile)) return map;
  try {
    const lines = readFileSync(envFile, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      map.set(trimmed.slice(0, idx).trim(), trimmed.slice(idx + 1).trim());
    }
  } catch { /* ignore */ }
  return map;
}

/** Write key=value pairs back to ~/.openclaw/.env, preserving existing entries */
function writeOpenClawEnv(updates: Record<string, string>): void {
  const envFile = ENV_FILE();
  const existing = readOpenClawEnv();
  for (const [k, v] of Object.entries(updates)) {
    existing.set(k, v);
  }
  const lines: string[] = [];
  for (const [k, v] of existing) {
    lines.push(`${k}=${v}`);
  }
  try {
    mkdirSync(OPENCLAW_DIR(), { recursive: true });
    writeFileSync(envFile, lines.join('\n') + '\n', 'utf-8');
  } catch (err) {
    logger.warn('[mkcert] Failed to write .env:', err);
  }
}

/** Private IPv4 (RFC1918-style ranges) for LAN HTTPS. */
function listPrivateLanIPv4(): string[] {
  const nets = networkInterfaces();
  const out = new Set<string>();
  const re = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/;
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      const fam = net.family;
      if (fam !== 'IPv4') continue;
      if (net.internal) continue;
      if (!re.test(net.address)) continue;
      out.add(net.address);
    }
  }
  return [...out].sort();
}

function resolveBundledMkcertExe(): string | null {
  const bundled = join(getResourcesDir(), 'tools', 'mkcert.exe');
  if (existsSync(bundled)) return bundled;
  // Dev: ClawX repo layout — openme is sibling of ClawX folder
  const devOpenme = join(__dirname, '../../../openme/mkcert.exe');
  if (existsSync(devOpenme)) return devOpenme;
  return null;
}

export type MkcertEnsureResult = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
  certDir?: string;
};

function execFileAsync(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true }, (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

/** Run mkcert -install with windowsHide:false so UAC prompt can appear */
function execFileAsyncVisible(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: false }, (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

/**
 * Ensure mkcert-generated TLS certs exist and are trusted by the system.
 *
 * First run: force-deletes any existing certs, runs `mkcert -install` (UAC),
 * regenerates certs for all LAN IPs, then writes CLAWX_CERTS_INITIALIZED=true
 * to ~/.openclaw/.env so subsequent starts skip this step.
 *
 * Set CLAWX_SKIP_MKCERT=1 to skip entirely.
 * Set CLAWX_REGENERATE_MKCERT=1 to force re-run even if already initialized.
 */
export async function ensureOpenClawMkcertCertsWindows(): Promise<MkcertEnsureResult> {
  if (process.platform !== 'win32') {
    return { ok: true, skipped: true, reason: 'not-windows' };
  }
  if (process.env.CLAWX_SKIP_MKCERT === '1') {
    return { ok: true, skipped: true, reason: 'CLAWX_SKIP_MKCERT' };
  }

  const certDir = OPENCLAW_CERT_DIR();
  const certFile = CERT_FILE();
  const keyFile = KEY_FILE();

  // Check if already initialized (and not forced)
  const env = readOpenClawEnv();
  const alreadyInitialized = env.get(CERTS_INITIALIZED_KEY) === 'true';
  if (alreadyInitialized && process.env.CLAWX_REGENERATE_MKCERT !== '1') {
    // Still need the cert files to exist
    if (existsSync(certFile) && existsSync(keyFile)) {
      return { ok: true, skipped: true, reason: 'already-initialized', certDir };
    }
    // Files missing despite flag — fall through to regenerate
    logger.warn('[mkcert] CLAWX_CERTS_INITIALIZED=true but cert files missing, regenerating...');
  }

  const mkcert = resolveBundledMkcertExe();
  if (!mkcert) {
    const msg = 'mkcert.exe not found (run pnpm build: copy from openme, or place openme/mkcert.exe for dev)';
    logger.warn(`[mkcert] ${msg}`);
    return { ok: false, error: msg };
  }

  // Force-delete old certs so we start fresh with the new root CA
  if (existsSync(certFile)) {
    try { rmSync(certFile); } catch { /* ignore */ }
  }
  if (existsSync(keyFile)) {
    try { rmSync(keyFile); } catch { /* ignore */ }
  }

  mkdirSync(certDir, { recursive: true });
  const lan = listPrivateLanIPv4();
  const hosts = ['localhost', '127.0.0.1', '::1', ...lan];
  logger.info(`[mkcert] generating trusted certs for: ${hosts.join(', ')}`);

  // Install root CA into system trust store (shows UAC on Windows)
  try {
    await execFileAsyncVisible(mkcert, ['-install']);
    logger.info('[mkcert] root CA installed successfully');
  } catch (err) {
    logger.warn('[mkcert] -install failed (non-fatal, cert may not be trusted by browser):', err);
  }

  // Generate cert for all hosts
  try {
    await execFileAsync(mkcert, ['-cert-file', certFile, '-key-file', keyFile, ...hosts]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('[mkcert] certificate generation failed:', err);
    return { ok: false, error: message };
  }

  // Mark as initialized in ~/.openclaw/.env
  writeOpenClawEnv({ [CERTS_INITIALIZED_KEY]: 'true' });
  logger.info(`[mkcert] wrote ${certFile}, marked ${CERTS_INITIALIZED_KEY}=true in .env`);

  return { ok: true, certDir };
}
