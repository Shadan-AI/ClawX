/**
 * Dynamic imports for openclaw plugin-sdk subpath exports.
 *
 * openclaw is NOT in the asar's node_modules — it lives at resources/openclaw/
 * (extraResources). All plugin-sdk files are pure ESM, so we must use dynamic
 * import() rather than require(). Modules are lazily loaded on first use and cached.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getOpenClawResolvedDir } from './paths';

function resolvePluginSdkPath(subpath: string): string {
  // subpath e.g. 'openclaw/plugin-sdk/discord' -> dist/plugin-sdk/discord.js
  const exportKey = subpath.replace(/^[^/]+\//, ''); // strip package name
  const rel = exportKey.replace(/^plugin-sdk\//, 'dist/plugin-sdk/') + '.js';
  return join(getOpenClawResolvedDir(), rel);
}

async function importSdk<T>(subpath: string): Promise<T> {
  const url = pathToFileURL(resolvePluginSdkPath(subpath)).href;
  return import(url) as Promise<T>;
}

// --- SDK types ---
export type DiscordSdk = {
  listDiscordDirectoryGroupsFromConfig: (...args: unknown[]) => Promise<unknown[]>;
  listDiscordDirectoryPeersFromConfig: (...args: unknown[]) => Promise<unknown[]>;
  normalizeDiscordMessagingTarget: (target: string) => string | undefined;
};
export type TelegramSdk = {
  listTelegramDirectoryGroupsFromConfig: (...args: unknown[]) => Promise<unknown[]>;
  listTelegramDirectoryPeersFromConfig: (...args: unknown[]) => Promise<unknown[]>;
  normalizeTelegramMessagingTarget: (target: string) => string | undefined;
};
export type SlackSdk = {
  listSlackDirectoryGroupsFromConfig: (...args: unknown[]) => Promise<unknown[]>;
  listSlackDirectoryPeersFromConfig: (...args: unknown[]) => Promise<unknown[]>;
  normalizeSlackMessagingTarget: (target: string) => string | undefined;
};
export type WhatsAppSdk = {
  normalizeWhatsAppMessagingTarget: (target: string) => string | undefined;
};

// --- Lazy-loaded module cache ---
let _discord: DiscordSdk | null = null;
let _telegram: TelegramSdk | null = null;
let _slack: SlackSdk | null = null;
let _whatsapp: WhatsAppSdk | null = null;

export async function getDiscordSdk(): Promise<DiscordSdk> {
  if (!_discord) _discord = await importSdk<DiscordSdk>('openclaw/plugin-sdk/discord');
  return _discord;
}
export async function getTelegramSdk(): Promise<TelegramSdk> {
  if (!_telegram) _telegram = await importSdk<TelegramSdk>('openclaw/plugin-sdk/telegram-surface');
  return _telegram;
}
export async function getSlackSdk(): Promise<SlackSdk> {
  if (!_slack) _slack = await importSdk<SlackSdk>('openclaw/plugin-sdk/slack');
  return _slack;
}
export async function getWhatsAppSdk(): Promise<WhatsAppSdk> {
  if (!_whatsapp) _whatsapp = await importSdk<WhatsAppSdk>('openclaw/plugin-sdk/whatsapp-shared');
  return _whatsapp;
}
