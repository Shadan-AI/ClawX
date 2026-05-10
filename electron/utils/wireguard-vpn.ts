import { app } from 'electron';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface WireGuardRegistration {
  vpnIp: string;
  clientAddress: string;
  serverPublicKey: string;
  serverEndpoint: string;
  allowedIps: string[];
  persistentKeepalive?: number;
}

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

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
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
  if (await fileExists(keyPath)) {
    privateKey = (await readFile(keyPath, 'utf8')).trim();
  } else {
    privateKey = await execFileText('wg', ['genkey']);
    await writeFile(keyPath, `${privateKey}\n`, { mode: 0o600 });
    try { await chmod(keyPath, 0o600); } catch { /* ignore */ }
  }
  const publicKey = await execFileText('wg', ['pubkey'], `${privateKey}\n`);
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
  return payload;
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

export async function startWireGuard(configPath: string): Promise<void> {
  try {
    await execFileText('wg-quick', ['down', configPath]);
  } catch {
    // The tunnel may not be up yet.
  }
  await execFileText('wg-quick', ['up', configPath]);
}
