/**
 * Read/write DATASOURCE_* keys in ~/.openclaw/openclaw.json env.vars (aligned with openme UI).
 */
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { withConfigLock } from './config-mutex';
import { stampOpenClawConfigMeta } from './openclaw-config-meta';

const OPENCLAW_CONFIG_PATH = join(homedir(), '.openclaw', 'openclaw.json');

const CONNECTORS = ['wechat', 'zhipu'] as const;

function envKey(connectorKey: string, fieldKey: string): string {
  return `DATASOURCE_${connectorKey.toUpperCase()}_${fieldKey.toUpperCase()}`;
}

function parseEnvVars(vars: Record<string, string> | undefined): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  if (!vars) return out;
  const prefix = 'DATASOURCE_';
  for (const [key, value] of Object.entries(vars)) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const sep = rest.indexOf('_');
    if (sep < 0) continue;
    const conn = rest.slice(0, sep).toLowerCase();
    const fieldUpper = rest.slice(sep + 1);
    const field =
      conn === 'wechat' && fieldUpper === 'APPID'
        ? 'appId'
        : conn === 'wechat' && fieldUpper === 'APPSECRET'
          ? 'appSecret'
          : conn === 'zhipu' && fieldUpper === 'APIKEY'
            ? 'apiKey'
            : fieldUpper.toLowerCase();
    if (!out[conn]) out[conn] = {};
    out[conn][field] = value;
  }
  return out;
}

export async function getDatasourceConnectors(): Promise<Record<string, Record<string, string>>> {
  if (!existsSync(OPENCLAW_CONFIG_PATH)) {
    return {};
  }
  try {
    const raw = await readFile(OPENCLAW_CONFIG_PATH, 'utf-8');
    const cfg = JSON.parse(raw) as { env?: { vars?: Record<string, string> } };
    return parseEnvVars(cfg.env?.vars);
  } catch {
    return {};
  }
}

export async function saveDatasourceConnector(
  connectorKey: string,
  fields: Record<string, string>,
): Promise<void> {
  await withConfigLock(async () => {
    let cfg: Record<string, unknown> = {};
    if (existsSync(OPENCLAW_CONFIG_PATH)) {
      try {
        cfg = JSON.parse(await readFile(OPENCLAW_CONFIG_PATH, 'utf-8')) as Record<string, unknown>;
      } catch {
        cfg = {};
      }
    }
    const env = (cfg.env as { vars?: Record<string, string> } | undefined) ?? {};
    const vars = { ...(env.vars ?? {}) };
    for (const [fk, val] of Object.entries(fields)) {
      vars[envKey(connectorKey, fk)] = val;
    }
    cfg.env = { ...env, vars };
    const stamped = stampOpenClawConfigMeta(cfg);
    await writeFile(OPENCLAW_CONFIG_PATH, `${JSON.stringify(stamped, null, 2)}\n`, 'utf-8');
  });
}

export const DATASOURCE_CONNECTOR_KEYS = CONNECTORS;
