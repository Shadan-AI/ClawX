import { app } from 'electron';
import { execFile } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, extname, join } from 'node:path';

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

function execFileText(command: string, args: string[], input?: string, timeout = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { timeout }, (error, stdout, stderr) => {
      const output = String(stdout).trim();
      const errorOutput = String(stderr).trim();
      if (error) {
        reject(new Error(`${command} ${args.join(' ')} failed: ${errorOutput || output || error.message}`));
        return;
      }
      resolve(output);
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

function defaultWireGuardConfigPath(): string {
  return join(vpnDir(), 'clawx-wg0.conf');
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
  const configPath = defaultWireGuardConfigPath();
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
    return await startWireGuardWindows(configPath);
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

export async function stopWireGuard(configPath = defaultWireGuardConfigPath()): Promise<'stopped' | 'not-configured'> {
  if (process.platform === 'win32') {
    return await stopWireGuardWindows(configPath);
  }

  if (!await fileAccessible(configPath)) {
    return 'not-configured';
  }

  const wgQuick = await resolveWgQuickCommand();
  try {
    await execFileText(wgQuick, ['down', configPath], undefined, 30_000);
  } catch {
    // The tunnel may already be down.
  }
  return 'stopped';
}

async function startWireGuardWindows(configPath: string): Promise<'started' | 'config-written'> {
  const helperCandidates = windowsVpnHelperPathCandidates();
  const helperPath = await resolveWindowsVpnHelperPath(helperCandidates);
  if (!helperPath) {
    throw new Error(`Windows VPN helper was not found. Checked: ${helperCandidates.join(', ')}`);
  }

  const powershell = getWindowsPowerShellPath();
  console.log(`[wireguard-vpn] Starting Windows tunnel via helper: ${helperPath}`);
  try {
    const output = await execFileText(
      powershell,
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        helperPath,
        '-Action',
        'install-start',
        '-ConfigPath',
        configPath,
      ],
      undefined,
      180_000,
    );
    if (output) {
      console.log(`[wireguard-vpn] Windows helper output:\n${output}`);
    }
    const status = await verifyWindowsTunnelService(configPath);
    console.log(`[wireguard-vpn] Windows tunnel service verified:\n${status}`);
  } catch (error) {
    const helperLog = await readWindowsVpnHelperLogTail();
    const suffix = helperLog ? `\nHelper log tail:\n${helperLog}` : '';
    throw new Error(`${(error as Error).message}${suffix}`, { cause: error });
  }
  return 'started';
}

async function stopWireGuardWindows(configPath: string): Promise<'stopped' | 'not-configured'> {
  const helperCandidates = windowsVpnHelperPathCandidates();
  const helperPath = await resolveWindowsVpnHelperPath(helperCandidates);
  if (!helperPath) {
    console.warn(`[wireguard-vpn] Windows VPN helper was not found during quit. Checked: ${helperCandidates.join(', ')}`);
    return 'not-configured';
  }

  const serviceName = `WireGuardTunnel$${getTunnelNameFromConfigPath(configPath)}`;
  const statusBefore = await getWindowsTunnelServiceStatus(serviceName).catch(() => '');
  if (statusBefore.includes('state=missing')) {
    return 'not-configured';
  }

  const powershell = getWindowsPowerShellPath();
  console.log(`[wireguard-vpn] Stopping Windows tunnel via helper: ${helperPath}`);
  try {
    const output = await execFileText(
      powershell,
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        helperPath,
        '-Action',
        'uninstall',
        '-ConfigPath',
        configPath,
      ],
      undefined,
      180_000,
    );
    if (output) {
      console.log(`[wireguard-vpn] Windows helper output:\n${output}`);
    }
  } catch (error) {
    const helperLog = await readWindowsVpnHelperLogTail();
    const suffix = helperLog ? `\nHelper log tail:\n${helperLog}` : '';
    throw new Error(`${(error as Error).message}${suffix}`, { cause: error });
  }

  const statusAfter = await getWindowsTunnelServiceStatus(serviceName);
  console.log(`[wireguard-vpn] Windows tunnel service after stop:\n${statusAfter}`);
  if (!statusAfter.includes('state=missing')) {
    throw new Error(`Windows tunnel service still exists after uninstall: ${statusAfter}`);
  }
  return 'stopped';
}

function windowsVpnHelperPathCandidates(): string[] {
  return app.isPackaged
    ? [join(process.resourcesPath, 'bin', 'openme-vpn-helper.ps1')]
    : [
        join(process.cwd(), 'resources', 'bin', `win32-${process.arch}`, 'openme-vpn-helper.ps1'),
        join(dirname(process.execPath), 'resources', 'bin', `win32-${process.arch}`, 'openme-vpn-helper.ps1'),
      ];
}

async function resolveWindowsVpnHelperPath(candidates = windowsVpnHelperPathCandidates()): Promise<string | null> {
  for (const candidate of candidates) {
    if (await fileAccessible(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function verifyWindowsTunnelService(configPath: string): Promise<string> {
  const tunnelName = getTunnelNameFromConfigPath(configPath);
  const serviceName = `WireGuardTunnel$${tunnelName}`;
  const status = await getWindowsTunnelServiceStatus(serviceName);
  if (status.includes('state=missing')) {
    throw new Error(status);
  }
  if (!status.includes('state=Running')) {
    throw new Error(status);
  }
  return status;
}

async function getWindowsTunnelServiceStatus(serviceName: string): Promise<string> {
  const serviceNameLiteral = toPowerShellSingleQuotedString(serviceName);
  const command = [
    `$name = ${serviceNameLiteral}`,
    `$svc = Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $name } | Select-Object -First 1`,
    `if (-not $svc) { Write-Output ('service=' + $name + ' state=missing'); exit 0 }`,
    `Write-Output "service=$($svc.Name) state=$($svc.State) startMode=$($svc.StartMode) exitCode=$($svc.ExitCode)"`,
    `Write-Output "path=$($svc.PathName)"`,
  ].join('; ');

  return await execFileText(
    getWindowsPowerShellPath(),
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
    undefined,
    30_000,
  );
}

function getTunnelNameFromConfigPath(configPath: string): string {
  const name = basename(configPath, extname(configPath)).replace(/[^A-Za-z0-9_=+.-]/g, '-');
  if (!name.trim()) {
    throw new Error(`Invalid WireGuard config name: ${configPath}`);
  }
  return name;
}

function toPowerShellSingleQuotedString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function readWindowsVpnHelperLogTail(): Promise<string> {
  const programData = process.env.ProgramData || 'C:\\ProgramData';
  const logPath = join(programData, 'OpenMe', 'vpn-helper.log');
  try {
    const content = await readFile(logPath, 'utf8');
    return content.slice(-8000).trim();
  } catch {
    return '';
  }
}

function getWindowsPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
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
