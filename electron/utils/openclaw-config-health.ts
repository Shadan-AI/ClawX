import { createHash } from 'crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';
import * as logger from './logger';

const OPENCLAW_DIR = join(homedir(), '.openclaw');
const OPENCLAW_CONFIG_PATH = join(OPENCLAW_DIR, 'openclaw.json');
const CONFIG_HEALTH_PATH = join(OPENCLAW_DIR, 'logs', 'config-health.json');

type ConfigHealthFingerprint = {
  hash: string;
  bytes: number;
  mtimeMs: number | null;
  ctimeMs: number | null;
  hasMeta: boolean;
  gatewayMode: string | null;
  observedAt: string;
};

type ConfigHealthEntry = {
  lastKnownGood?: ConfigHealthFingerprint;
  lastObservedSuspiciousSignature?: string | null;
};

type ConfigHealthState = {
  entries?: Record<string, ConfigHealthEntry>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolveGatewayMode(config: Record<string, unknown>): string | null {
  const gateway = config.gateway;
  if (!isPlainObject(gateway) || typeof gateway.mode !== 'string') {
    return null;
  }
  const mode = gateway.mode.trim();
  return mode.length > 0 ? mode : null;
}

function isStructurallyHealthyOpenClawConfig(config: unknown): config is Record<string, unknown> {
  if (!isPlainObject(config)) {
    return false;
  }
  if (!isPlainObject(config.meta) || !resolveGatewayMode(config)) {
    return false;
  }

  const structuralKeys = [
    'agents',
    'models',
    'channels',
    'bindings',
    'skills',
    'tools',
    'plugins',
    'messages',
    'session',
    'commands',
    'browser',
  ];
  const structuralKeyCount = structuralKeys.filter((key) => Object.prototype.hasOwnProperty.call(config, key)).length;
  return Object.keys(config).length >= 5 && structuralKeyCount >= 3;
}

function hashRaw(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function sameFingerprint(left: ConfigHealthFingerprint | undefined, right: ConfigHealthFingerprint): boolean {
  return Boolean(left) &&
    left!.hash === right.hash &&
    left!.bytes === right.bytes &&
    left!.mtimeMs === right.mtimeMs &&
    left!.ctimeMs === right.ctimeMs &&
    left!.hasMeta === right.hasMeta &&
    left!.gatewayMode === right.gatewayMode;
}

async function readHealthState(): Promise<ConfigHealthState> {
  try {
    const raw = await readFile(CONFIG_HEALTH_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    return isPlainObject(parsed) ? parsed as ConfigHealthState : {};
  } catch {
    return {};
  }
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  try {
    await rename(tmpPath, filePath);
  } catch (error) {
    await unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

export async function normalizeOpenClawConfigHealthBaseline(): Promise<void> {
  try {
    const raw = await readFile(OPENCLAW_CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isStructurallyHealthyOpenClawConfig(parsed)) {
      logger.debug('[config-health] Skip baseline normalization because openclaw.json is not structurally healthy');
      return;
    }

    const fileStat = await stat(OPENCLAW_CONFIG_PATH).catch(() => null);
    const current: ConfigHealthFingerprint = {
      hash: hashRaw(raw),
      bytes: Buffer.byteLength(raw, 'utf-8'),
      mtimeMs: fileStat?.mtimeMs ?? null,
      ctimeMs: fileStat?.ctimeMs ?? null,
      hasMeta: true,
      gatewayMode: resolveGatewayMode(parsed),
      observedAt: new Date().toISOString(),
    };

    const state = await readHealthState();
    const entries = state.entries ?? {};
    const previous = entries[OPENCLAW_CONFIG_PATH];
    const nextEntry: ConfigHealthEntry = {
      lastKnownGood: current,
      lastObservedSuspiciousSignature: null,
    };

    if (sameFingerprint(previous?.lastKnownGood, current) && previous?.lastObservedSuspiciousSignature == null) {
      logger.debug('[config-health] OpenClaw config health baseline already current');
      return;
    }

    await writeJsonAtomic(CONFIG_HEALTH_PATH, {
      ...state,
      entries: {
        ...entries,
        [OPENCLAW_CONFIG_PATH]: nextEntry,
      },
    });

    logger.info(`[config-health] Normalized OpenClaw config baseline (${previous?.lastKnownGood?.bytes ?? 'none'} -> ${current.bytes} bytes)`);
  } catch (error) {
    logger.warn('[config-health] Failed to normalize OpenClaw config baseline:', error);
  }
}
