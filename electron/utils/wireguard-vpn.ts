import { app } from 'electron';
import { execFile } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

export interface WireGuardRegistration {
  vpnIp: string;
  clientAddress: string;
  serverPublicKey: string;
  serverEndpoint: string;
  allowedIps: string[];
  persistentKeepalive?: number;
}

const COMMON_WG_PATHS = [
  '/opt/homebrew/bin/wg',
  '/usr/local/bin/wg',
  '/usr/bin/wg',
  '/bin/wg',
  '/snap/bin/wg',
];

const COMMON_WG_QUICK_PATHS = [
  '/opt/homebrew/bin/wg-quick',
  '/usr/local/bin/wg-quick',
  '/usr/bin/wg-quick',
  '/bin/wg-quick',
  '/snap/bin/wg-quick',
];

const COMMON_WIREGUARD_APP_PATHS = [
  '/Applications/WireGuard.app',
  '/Users/david/Downloads/WireGuard.app',
];

const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

let wgCommandPromise: Promise<string> | undefined;
let wgQuickCommandPromise: Promise<string> | undefined;

function execFileText(command: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} ${args.join(' ')} failed: ${stderr || error.message}`));
        return;
      }
      resolve(String(stdout).trim());
    });
    if (input) child.stdin?.end(input);
  });
}

async function fileAccessible(path: string, mode = constants.F_OK): Promise<boolean> {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

function pathCandidates(command: string, commonPaths: string[]): string[] {
  const candidates = new Set<string>();
  for (const pathDir of (process.env.PATH ?? '').split(delimiter)) {
    if (pathDir) candidates.add(join(pathDir, command));
  }
  for (const candidate of commonPaths) candidates.add(candidate);
  return [...candidates];
}

async function resolveExecutable(command: string, envName: string, commonPaths: string[]): Promise<string> {
  const configured = process.env[envName]?.trim();
  if (configured) {
    if (await fileAccessible(configured, constants.X_OK)) return configured;
    throw new Error(`${envName} points to a non-executable file: ${configured}`);
  }

  const candidates = pathCandidates(command, commonPaths);
  for (const candidate of candidates) {
    if (await fileAccessible(candidate, constants.X_OK)) return candidate;
  }

  throw new Error(
    `WireGuard command "${command}" was not found. Install wireguard-tools ` +
    `(macOS: brew install wireguard-tools) or set ${envName}. Checked: ${candidates.join(', ')}`,
  );
}

function resolveWgCommand(): Promise<string> {
  wgCommandPromise ??= resolveExecutable('wg', 'CLAWX_WG_BIN', COMMON_WG_PATHS);
  return wgCommandPromise;
}

function resolveWgQuickCommand(): Promise<string> {
  wgQuickCommandPromise ??= resolveExecutable('wg-quick', 'CLAWX_WG_QUICK_BIN', COMMON_WG_QUICK_PATHS);
  return wgQuickCommandPromise;
}

function generateWireGuardPrivateKey(): string {
  const { privateKey } = generateKeyPairSync('x25519');
  const der = privateKey.export({ format: 'der', type: 'pkcs8' });
  return Buffer.from(der).subarray(-32).toString('base64');
}

async function getWireGuardPublicKey(privateKey: string): Promise<string> {
  try {
    const rawPrivateKey = Buffer.from(privateKey, 'base64');
    if (rawPrivateKey.length !== 32) throw new Error('private key must decode to 32 bytes');
    const keyObject = createPrivateKey({
      key: Buffer.concat([X25519_PKCS8_PREFIX, rawPrivateKey]),
      format: 'der',
      type: 'pkcs8',
    });
    const publicDer = createPublicKey(keyObject).export({ format: 'der', type: 'spki' });
    return Buffer.from(publicDer).subarray(-32).toString('base64');
  } catch (nativeError) {
    const wg = await resolveWgCommand();
    try {
      return await execFileText(wg, ['pubkey'], `${privateKey}\n`);
    } catch {
      throw nativeError;
    }
  }
}

function vpnDir(): string {
  return join(app.getPath('userData'), 'vpn');
}

async function privateKeyPath(): Promise<string> {
  const dir = vpnDir();
  await mkdir(dir, { recursive: true });
  return join(dir, 'wireguard.key');
}

export async function getOrCreateWireGuardKeys(): Promise<{ privateKey: string; publicKey: string }> {
  const keyPath = await privateKeyPath();
  let privateKey: string;
  if (await fileAccessible(keyPath)) {
    privateKey = (await readFile(keyPath, 'utf8')).trim();
  } else {
    try {
      privateKey = generateWireGuardPrivateKey();
    } catch {
      const wg = await resolveWgCommand();
      privateKey = await execFileText(wg, ['genkey']);
    }
    await writeFile(keyPath, `${privateKey}\n`, { mode: 0o600 });
    try { await chmod(keyPath, 0o600); } catch { /* ignore */ }
  }
  const publicKey = await getWireGuardPublicKey(privateKey);
  return { privateKey, publicKey };
}

export async function registerWireGuardDevice(options: {
  apiUrl: string;
  tokenKey: string;
  nodeId: string;
  deviceName?: string;
  publicKey: string;
}): Promise<WireGuardRegistration> {
  const base = options.apiUrl.replace(/\/+$/, '');
  const response = await fetch(`${base}/vpn/device/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Token-Key': options.tokenKey,
    },
    body: JSON.stringify({
      nodeId: options.nodeId,
      deviceName: options.deviceName,
      publicKey: options.publicKey,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`VPN register failed: ${response.status} ${text}`);
  }
  const payload = await response.json() as WireGuardRegistration | { code?: number; message?: string; data?: WireGuardRegistration };
  if ('data' in payload) {
    if (payload.code !== undefined && payload.code !== 200) {
      throw new Error(payload.message || `VPN register failed: code=${payload.code}`);
    }
    if (!payload.data) throw new Error('VPN register failed: empty response data');
    return payload.data;
  }
  return payload as WireGuardRegistration;
}

export async function writeWireGuardConfig(privateKey: string, registration: WireGuardRegistration): Promise<string> {
  const dir = vpnDir();
  await mkdir(dir, { recursive: true });
  const configPath = join(dir, 'clawx-wg0.conf');
  const allowedIps = registration.allowedIps?.length ? registration.allowedIps.join(', ') : registration.clientAddress;
  const keepalive = registration.persistentKeepalive ?? 25;
  const content = `[Interface]
PrivateKey = ${privateKey}
Address = ${registration.clientAddress}

[Peer]
PublicKey = ${registration.serverPublicKey}
AllowedIPs = ${allowedIps}
Endpoint = ${registration.serverEndpoint}
PersistentKeepalive = ${keepalive}
`;
  await writeFile(configPath, content, { mode: 0o600 });
  try { await chmod(configPath, 0o600); } catch { /* ignore */ }
  return configPath;
}

export async function startWireGuard(configPath: string): Promise<'started' | 'opened-app' | 'config-written'> {
  if (process.platform === 'win32') {
    void configPath;
    return 'config-written';
  }

  let wgQuick: string | undefined;
  try {
    wgQuick = await resolveWgQuickCommand();
  } catch (err) {
    if (process.platform === 'darwin') {
      await openWireGuardApp(configPath);
      return 'opened-app';
    }
    throw err;
  }

  try {
    await execFileText(wgQuick, ['down', configPath]);
  } catch {
    // The tunnel may not be up yet.
  }
  try {
    await execFileText(wgQuick, ['up', configPath]);
  } catch (err) {
    if (process.platform === 'darwin') {
      await openWireGuardApp(configPath);
      return 'opened-app';
    }
    throw err;
  }
  return 'started';
}

async function openWireGuardApp(configPath: string): Promise<void> {
  const configured = process.env.CLAWX_WIREGUARD_APP_PATH?.trim();
  const candidates = configured ? [configured] : COMMON_WIREGUARD_APP_PATHS;
  for (const candidate of candidates) {
    if (await fileAccessible(candidate)) {
      await execFileText('open', [candidate]);
      await execFileText('open', ['-R', configPath]);
      return;
    }
  }
  throw new Error(
    `WireGuard.app was not found. Install it in /Applications or set CLAWX_WIREGUARD_APP_PATH. Checked: ${candidates.join(', ')}`,
  );
}
