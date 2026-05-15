import { app } from 'electron';
import path from 'path';
import { existsSync, readFileSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

function fsPath(filePath: string): string {
  if (process.platform !== 'win32') return filePath;
  if (!filePath) return filePath;
  if (filePath.startsWith('\\\\?\\')) return filePath;
  const windowsPath = filePath.replace(/\//g, '\\');
  if (!path.win32.isAbsolute(windowsPath)) return windowsPath;
  if (windowsPath.startsWith('\\\\')) {
    return `\\\\?\\UNC\\${windowsPath.slice(2)}`;
  }
  return `\\\\?\\${windowsPath}`;
}
import { getAllSettings } from '../utils/store';
import { getApiKey, getDefaultProvider, getProvider } from '../utils/secure-storage';
import { getProviderEnvVar, getKeyableProviderTypes } from '../utils/provider-registry';
import { getOpenClawDir, getOpenClawEntryPath, isOpenClawPresent } from '../utils/paths';
import { getUvMirrorEnv } from '../utils/uv-env';
import { cleanupDanglingWeChatPluginState, listConfiguredChannels, readOpenClawConfig } from '../utils/channel-config';
import { sanitizeOpenClawConfig } from '../utils/openclaw-auth';
import { startOpenClawConfigLanReconciliationWatcher } from '../utils/openclaw-config-watch';
import { buildProxyEnv, resolveProxySettings } from '../utils/proxy';
import { syncProxyConfigToOpenClaw } from '../utils/openclaw-proxy';
import { normalizeOpenClawConfigHealthBaseline } from '../utils/openclaw-config-health';
import { logger } from '../utils/logger';
import { prependPathEntry } from '../utils/env-path';
import { copyPluginFromNodeModules, fixupPluginManifest, cpSyncSafe } from '../utils/plugin-install';
import { stripSystemdSupervisorEnv } from './config-sync-env';
import { SKILL_MARKET_BASE_URL } from '../utils/skill-market';


export interface GatewayLaunchContext {
  appSettings: Awaited<ReturnType<typeof getAllSettings>>;
  openclawDir: string;
  entryScript: string;
  gatewayArgs: string[];
  forkEnv: Record<string, string | undefined>;
  mode: 'dev' | 'packaged';
  binPathExists: boolean;
  loadedProviderKeyCount: number;
  proxySummary: string;
  channelStartupSummary: string;
}

// ── Auto-upgrade bundled plugins on startup ──────────────────────

const CHANNEL_PLUGIN_MAP: Record<string, { dirName: string; npmName: string }> = {
  dingtalk: { dirName: 'dingtalk', npmName: '@soimy/dingtalk' },
  wecom: { dirName: 'wecom', npmName: '@wecom/wecom-openclaw-plugin' },
  feishu: { dirName: 'feishu-openclaw-plugin', npmName: '@larksuite/openclaw-lark' },
  'openclaw-weixin': { dirName: 'openclaw-weixin', npmName: '@tencent-weixin/openclaw-weixin' },
};

/**
 * OpenClaw 3.22+ ships Discord, Telegram, and other channels as built-in
 * extensions.  If a previous ClawX version copied one of these into
 * ~/.openclaw/extensions/, the broken copy overrides the working built-in
 * plugin and must be removed.
 */
const BUILTIN_CHANNEL_EXTENSIONS = ['discord', 'telegram'];

function cleanupStaleBuiltInExtensions(): void {
  for (const ext of BUILTIN_CHANNEL_EXTENSIONS) {
    const extDir = join(homedir(), '.openclaw', 'extensions', ext);
    if (existsSync(fsPath(extDir))) {
      logger.info(`[plugin] Removing stale built-in extension copy: ${ext}`);
      try {
        rmSync(fsPath(extDir), { recursive: true, force: true });
      } catch (err) {
        logger.warn(`[plugin] Failed to remove stale extension ${ext}:`, err);
      }
    }
  }
}

function readPluginVersion(pkgJsonPath: string): string | null {
  try {
    const raw = readFileSync(fsPath(pkgJsonPath), 'utf-8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? null;
  } catch {
    return null;
  }
}

function timeGatewayPrep<T>(label: string, fn: () => T): T {
  const startedAt = Date.now();
  try {
    return fn();
  } finally {
    logger.debug(`[gateway-prep] ${label} completed in ${Date.now() - startedAt}ms`);
  }
}

async function timeGatewayPrepAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    logger.debug(`[gateway-prep] ${label} completed in ${Date.now() - startedAt}ms`);
  }
}

function buildBundledPluginSources(pluginDirName: string): string[] {
  return app.isPackaged
    ? [
      join(process.resourcesPath, 'openclaw-plugins', pluginDirName),
      join(process.resourcesPath, 'app.asar.unpacked', 'build', 'openclaw-plugins', pluginDirName),
      join(process.resourcesPath, 'app.asar.unpacked', 'openclaw-plugins', pluginDirName),
    ]
    : [
      join(app.getAppPath(), 'build', 'openclaw-plugins', pluginDirName),
      join(process.cwd(), 'build', 'openclaw-plugins', pluginDirName),
    ];
}

/**
 * Auto-upgrade all configured channel plugins before Gateway start.
 * - Packaged mode: uses bundled plugins from resources/ (includes deps)
 * - Dev mode: falls back to node_modules/ with pnpm-aware dep collection
 */
function ensureConfiguredPluginsUpgraded(configuredChannels: string[]): void {
  for (const channelType of configuredChannels) {
    const pluginInfo = CHANNEL_PLUGIN_MAP[channelType];
    if (!pluginInfo) continue;
    const { dirName, npmName } = pluginInfo;

    const targetDir = join(homedir(), '.openclaw', 'extensions', dirName);
    const targetManifest = join(targetDir, 'openclaw.plugin.json');
    const isInstalled = existsSync(fsPath(targetManifest));
    const installedVersion = isInstalled ? readPluginVersion(join(targetDir, 'package.json')) : null;

    // Try bundled sources first (packaged mode or if bundle-plugins was run)
    const bundledSources = buildBundledPluginSources(dirName);
    const bundledDir = bundledSources.find((dir) => existsSync(fsPath(join(dir, 'openclaw.plugin.json'))));

    if (bundledDir) {
      const sourceVersion = readPluginVersion(join(bundledDir, 'package.json'));
      // Install or upgrade if version differs or plugin not installed
      if (!isInstalled || (sourceVersion && installedVersion && sourceVersion !== installedVersion)) {
        logger.info(`[plugin] ${isInstalled ? 'Auto-upgrading' : 'Installing'} ${channelType} plugin${isInstalled ? `: ${installedVersion} → ${sourceVersion}` : `: ${sourceVersion}`} (bundled)`);
        try {
          const copyStartedAt = Date.now();
          mkdirSync(fsPath(join(homedir(), '.openclaw', 'extensions')), { recursive: true });
          rmSync(fsPath(targetDir), { recursive: true, force: true });
          cpSyncSafe(bundledDir, targetDir);
          fixupPluginManifest(targetDir);
          logger.info(`[plugin] ${channelType} bundled plugin copy completed in ${Date.now() - copyStartedAt}ms`);
        } catch (err) {
          logger.warn(`[plugin] Failed to ${isInstalled ? 'auto-upgrade' : 'install'} ${channelType} plugin:`, err);
        }
      } else if (isInstalled) {
        // Same version already installed — still patch manifest ID in case it was
        // never corrected (e.g. installed before MANIFEST_ID_FIXES included this plugin).
        fixupPluginManifest(targetDir);
      }
      continue;
    }

    // Dev mode fallback: copy from node_modules/ with pnpm dep resolution
    if (!app.isPackaged) {
      const npmPkgPath = join(process.cwd(), 'node_modules', ...npmName.split('/'));
      if (!existsSync(fsPath(join(npmPkgPath, 'openclaw.plugin.json')))) continue;
      const sourceVersion = readPluginVersion(join(npmPkgPath, 'package.json'));
      if (!sourceVersion) continue;
      // Skip only if installed AND same version — but still patch manifest ID.
      if (isInstalled && installedVersion && sourceVersion === installedVersion) {
        fixupPluginManifest(targetDir);
        continue;
      }

      logger.info(`[plugin] ${isInstalled ? 'Auto-upgrading' : 'Installing'} ${channelType} plugin${isInstalled ? `: ${installedVersion} → ${sourceVersion}` : `: ${sourceVersion}`} (dev/node_modules)`);

      try {
        mkdirSync(fsPath(join(homedir(), '.openclaw', 'extensions')), { recursive: true });
        copyPluginFromNodeModules(npmPkgPath, targetDir, npmName);
        fixupPluginManifest(targetDir);
      } catch (err) {
        logger.warn(`[plugin] Failed to ${isInstalled ? 'auto-upgrade' : 'install'} ${channelType} plugin from node_modules:`, err);
      }
    }
  }
}

/**
 * Ensure extension-specific packages are resolvable from shared dist/ chunks.
 *
 * OpenClaw's Rollup bundler creates shared chunks in dist/ (e.g.
 * sticker-cache-*.js) that eagerly `import "grammy"`.  ESM bare specifier
 * resolution walks from the importing file's directory upward:
 *   dist/node_modules/ → openclaw/node_modules/ → …
 * It does NOT search `dist/extensions/telegram/node_modules/`.
 *
 * NODE_PATH only works for CJS require(), NOT for ESM import statements.
 *
 * Fix: create symlinks in openclaw/node_modules/ pointing to packages in
 * dist/extensions/<ext>/node_modules/.  This makes the standard ESM
 * resolution algorithm find them.  Skip-if-exists avoids overwriting
 * openclaw's own deps (they take priority).
 */
function ensureExtensionDepsResolvable(openclawDir: string): void {
  const packageVersion = readPluginVersion(join(openclawDir, 'package.json')) ?? 'unknown';
  const cacheFile = join(app.getPath('userData'), 'gateway-extension-deps-cache.json');
  if (app.isPackaged) {
    try {
      if (existsSync(fsPath(cacheFile))) {
        const cached = JSON.parse(readFileSync(fsPath(cacheFile), 'utf-8')) as {
          openclawDir?: string;
          packageVersion?: string;
        };
        if (cached.openclawDir === openclawDir && cached.packageVersion === packageVersion) {
          logger.debug(`[extension-deps] Skipped dependency scan for OpenClaw ${packageVersion} (cached)`);
          return;
        }
      }
    } catch {
      // Corrupt cache should not block startup; just rebuild it below.
    }
  }

  const extDir = join(openclawDir, 'dist', 'extensions');
  const topNM = join(openclawDir, 'node_modules');
  let linkedCount = 0;

  // Build a set of packages already provided by openclaw's own pnpm virtual
  // store node_modules (the real store, not the top-level symlink dir).
  // We must NOT overwrite these with extension deps — openclaw's own version
  // takes priority (e.g. file-type@21 must not be shadowed by whatsapp's v16).
  const openclawRealDir = (() => {
    try { return require('fs').realpathSync(openclawDir); } catch { return openclawDir; }
  })();
  const openclawVirtualNM = join(openclawRealDir, 'node_modules');
  const ownedByOpenclaw = new Set<string>();
  try {
    for (const entry of readdirSync(openclawVirtualNM, { withFileTypes: true })) {
      if (entry.name.startsWith('@')) {
        try {
          for (const sub of readdirSync(join(openclawVirtualNM, entry.name), { withFileTypes: true })) {
            ownedByOpenclaw.add(`${entry.name}/${sub.name}`);
          }
        } catch { /* ignore */ }
      } else {
        ownedByOpenclaw.add(entry.name);
      }
    }
  } catch { /* virtual store NM may not exist */ }

  try {
    if (!existsSync(extDir)) return;

    for (const ext of readdirSync(extDir, { withFileTypes: true })) {
      if (!ext.isDirectory()) continue;
      const extNM = join(extDir, ext.name, 'node_modules');
      if (!existsSync(extNM)) continue;

      for (const pkg of readdirSync(extNM, { withFileTypes: true })) {
        if (pkg.name === '.bin') continue;

        if (pkg.name.startsWith('@')) {
          // Scoped package — iterate sub-entries
          const scopeDir = join(extNM, pkg.name);
          let scopeEntries;
          try { scopeEntries = readdirSync(scopeDir, { withFileTypes: true }); } catch { continue; }
          for (const sub of scopeEntries) {
            if (!sub.isDirectory()) continue;
            const scopedName = `${pkg.name}/${sub.name}`;
            if (ownedByOpenclaw.has(scopedName)) continue; // openclaw owns this dep
            const dest = join(topNM, pkg.name, sub.name);
            if (existsSync(dest)) continue;
            try {
              mkdirSync(join(topNM, pkg.name), { recursive: true });
              symlinkSync(join(scopeDir, sub.name), dest);
              linkedCount++;
            } catch { /* skip on error — non-fatal */ }
          }
        } else {
          const dest = join(topNM, pkg.name);
          if (ownedByOpenclaw.has(pkg.name)) continue; // openclaw owns this dep
          if (existsSync(dest)) continue;          try {
            mkdirSync(topNM, { recursive: true });
            symlinkSync(join(extNM, pkg.name), dest);
            linkedCount++;
          } catch { /* skip on error — non-fatal */ }
        }
      }
    }
  } catch {
    // extensions dir may not exist or be unreadable — non-fatal
  }

  if (linkedCount > 0) {
    logger.info(`[extension-deps] Linked ${linkedCount} extension packages into ${topNM}`);
  }

  if (app.isPackaged) {
    try {
      writeFileSync(
        fsPath(cacheFile),
        JSON.stringify({ openclawDir, packageVersion, updatedAt: new Date().toISOString() }, null, 2),
        'utf-8',
      );
    } catch {
      // Cache is an optimization only.
    }
  }
}

// ── Pre-launch sync ──────────────────────────────────────────────

export async function syncGatewayConfigBeforeLaunch(
  appSettings: Awaited<ReturnType<typeof getAllSettings>>,
): Promise<void> {
  await syncProxyConfigToOpenClaw(appSettings, { preserveExistingWhenDisabled: true });

  try {
    await sanitizeOpenClawConfig();
  } catch (err) {
    logger.warn('Failed to sanitize openclaw.json:', err);
  }

  try {
    await cleanupDanglingWeChatPluginState();
  } catch (err) {
    logger.warn('Failed to clean dangling WeChat plugin state before launch:', err);
  }

  // Remove stale copies of built-in extensions (Discord, Telegram) that
  // override OpenClaw's working built-in plugins and break channel loading.
  try {
    cleanupStaleBuiltInExtensions();
  } catch (err) {
    logger.warn('Failed to clean stale built-in extensions:', err);
  }

  // Auto-upgrade installed plugins before Gateway starts so that
  // the plugin manifest ID matches what sanitize wrote to the config.
  try {
    const configuredChannels = await listConfiguredChannels();

    // Also ensure plugins referenced in plugins.allow are installed even if
    // they have no channels.X section yet (e.g. qqbot added via plugins.allow
    // but never fully saved through ClawX UI).
    try {
      const rawCfg = await readOpenClawConfig();
      const allowList = Array.isArray(rawCfg.plugins?.allow) ? (rawCfg.plugins!.allow as string[]) : [];
      // Build reverse maps: dirName → channelType AND known manifest IDs → channelType
      const pluginIdToChannel: Record<string, string> = {};
      for (const [channelType, info] of Object.entries(CHANNEL_PLUGIN_MAP)) {
        pluginIdToChannel[info.dirName] = channelType;
      }
      // Known manifest IDs that differ from their dirName/channelType

      pluginIdToChannel['openclaw-lark'] = 'feishu';
      pluginIdToChannel['feishu-openclaw-plugin'] = 'feishu';

      for (const pluginId of allowList) {
        const channelType = pluginIdToChannel[pluginId] ?? pluginId;
        if (CHANNEL_PLUGIN_MAP[channelType] && !configuredChannels.includes(channelType)) {
          configuredChannels.push(channelType);
        }
      }

    } catch (err) {
      logger.warn('[plugin] Failed to augment channel list from plugins.allow:', err);
    }

    ensureConfiguredPluginsUpgraded(configuredChannels);
  } catch (err) {
    logger.warn('Failed to auto-upgrade plugins:', err);
  }

  // Batch all config writes into a single atomic operation to avoid conflicts with Gateway
  // and improve startup performance
  try {
    await batchSyncGatewayConfig(appSettings);
  } catch (err) {
    logger.warn('Failed to batch sync gateway config:', err);
  }

  await normalizeOpenClawConfigHealthBaseline();

  // Start watcher to prevent Gateway from overwriting models.providers baseUrl.
  startOpenClawConfigLanReconciliationWatcher();
}

/**
 * Batch all gateway config sync operations into a single atomic write.
 * This prevents file conflicts with Gateway and improves startup performance.
 */
async function batchSyncGatewayConfig(appSettings: Awaited<ReturnType<typeof getAllSettings>>): Promise<void> {
  const { withConfigLock } = await import('../utils/config-mutex');
  const { readOpenClawJson, writeOpenClawJson } = await import('../utils/openclaw-auth');
  const { networkInterfaces } = await import('os');
  const { getTokenKey } = await import('../utils/box-im-sync');

  await withConfigLock(async () => {
    const config = await readOpenClawJson();
    let modified = false;

    // 1. Sync gateway token
    try {
      const gateway = (
        config.gateway && typeof config.gateway === 'object'
          ? { ...(config.gateway as Record<string, unknown>) }
          : {}
      ) as Record<string, unknown>;

      const auth = (
        gateway.auth && typeof gateway.auth === 'object'
          ? { ...(gateway.auth as Record<string, unknown>) }
          : {}
      ) as Record<string, unknown>;

      if (auth.mode !== 'token') {
        auth.mode = 'token';
        modified = true;
      }
      if (auth.token !== appSettings.gatewayToken) {
        auth.token = appSettings.gatewayToken;
        modified = true;
      }
      if (gateway.auth !== auth) {
        gateway.auth = auth;
      }

      const controlUi = (
        gateway.controlUi && typeof gateway.controlUi === 'object'
          ? { ...(gateway.controlUi as Record<string, unknown>) }
          : {}
      ) as Record<string, unknown>;
      const allowedOrigins = Array.isArray(controlUi.allowedOrigins)
        ? (controlUi.allowedOrigins as unknown[]).filter((value): value is string => typeof value === 'string')
        : [];
      if (!allowedOrigins.includes('file://')) {
        controlUi.allowedOrigins = [...allowedOrigins, 'file://'];
        modified = true;
      }
      if (gateway.controlUi !== controlUi) {
        gateway.controlUi = controlUi;
      }

      if (!gateway.mode) {
        gateway.mode = 'local';
        modified = true;
      }
      if (config.gateway !== gateway) {
        config.gateway = gateway;
      }
    } catch (err) {
      logger.warn('Failed to sync gateway token in batch:', err);
    }

    // 2. Windows: ensure gateway.tls is enabled
    if (process.platform === 'win32') {
      try {
        if (!config.gateway || typeof config.gateway !== 'object') {
          config.gateway = {};
        }
        const gw = config.gateway as Record<string, unknown>;
        const certBase = '~/.openclaw/certs';
        const tls = (gw.tls && typeof gw.tls === 'object' ? gw.tls : {}) as Record<string, unknown>;
        let tlsChanged = false;
        if (tls.enabled !== true) { tls.enabled = true; tlsChanged = true; }
        if (!tls.certPath) { tls.certPath = `${certBase}/localhost.pem`; tlsChanged = true; }
        if (!tls.keyPath) { tls.keyPath = `${certBase}/localhost-key.pem`; tlsChanged = true; }
        if (!tls.autoGenerate) { tls.autoGenerate = true; tlsChanged = true; }
        if (tlsChanged) {
          gw.tls = tls;
          modified = true;
        }
        if (!gw.bind) {
          gw.bind = 'lan';
          modified = true;
        }
        if (!gw.controlUi || typeof gw.controlUi !== 'object') {
          gw.controlUi = {};
        }
        const cui = gw.controlUi as Record<string, unknown>;
        if (cui.dangerouslyAllowHostHeaderOriginFallback !== true) {
          cui.dangerouslyAllowHostHeaderOriginFallback = true;
          modified = true;
        }
        if (cui.allowInsecureAuth !== true) {
          cui.allowInsecureAuth = true;
          modified = true;
        }
        if (cui.dangerouslyDisableDeviceAuth !== true) {
          cui.dangerouslyDisableDeviceAuth = true;
          modified = true;
        }
      } catch (err) {
        logger.warn('Failed to ensure gateway TLS in batch:', err);
      }
    }

    // 3. Inject LAN IPs into controlUi.allowedOrigins
    try {
      const nets = networkInterfaces();
      const lanIps: string[] = [];
      const re = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/;
      for (const ifaces of Object.values(nets)) {
        for (const iface of ifaces ?? []) {
          if (iface.family === 'IPv4' && !iface.internal && re.test(iface.address)) {
            lanIps.push(iface.address);
          }
        }
      }
      if (lanIps.length > 0 && config.gateway && typeof config.gateway === 'object') {
        const gw = config.gateway as Record<string, unknown>;
        if (!gw.controlUi || typeof gw.controlUi !== 'object') {
          gw.controlUi = {};
        }
        const cui = gw.controlUi as Record<string, unknown>;
        const existing = Array.isArray(cui.allowedOrigins)
          ? (cui.allowedOrigins as unknown[]).filter((x): x is string => typeof x === 'string')
          : [];
        const toAdd = lanIps.flatMap((ip) => [
          `https://${ip}:18789`,
          `http://${ip}:18789`,
        ]).filter((o) => !existing.includes(o));
        if (toAdd.length > 0) {
          cui.allowedOrigins = [...existing, ...toAdd];
          modified = true;
        }
      }
    } catch (err) {
      logger.warn('Failed to inject LAN origins in batch:', err);
    }

    // 4. Ensure static origins
    try {
      if (config.gateway && typeof config.gateway === 'object') {
        const gw = config.gateway as Record<string, unknown>;
        if (!gw.controlUi || typeof gw.controlUi !== 'object') {
          gw.controlUi = {};
        }
        const cui = gw.controlUi as Record<string, unknown>;
        const existing = Array.isArray(cui.allowedOrigins)
          ? (cui.allowedOrigins as unknown[]).filter((x): x is string => typeof x === 'string')
          : [];
        const staticOrigins = [
          'https://im.shadanai.com',
          'https://shadanai.com',
        ];
        const toAdd = staticOrigins.filter((o) => !existing.includes(o));
        if (toAdd.length > 0) {
          cui.allowedOrigins = [...existing, ...toAdd];
          modified = true;
        }
      }
    } catch (err) {
      logger.warn('Failed to inject static origins in batch:', err);
    }

    // 5. Sync browser config
    try {
      const browser = (
        config.browser && typeof config.browser === 'object'
          ? { ...(config.browser as Record<string, unknown>) }
          : {}
      ) as Record<string, unknown>;

      if (browser.enabled === undefined) {
        browser.enabled = true;
        modified = true;
      }

      if (browser.defaultProfile === undefined) {
        browser.defaultProfile = 'openclaw';
        modified = true;
      }

      config.browser = browser;
    } catch (err) {
      logger.warn('Failed to sync browser config in batch:', err);
    }

    // 6. Sync session idle minutes
    try {
      const DEFAULT_IDLE_MINUTES = 10_080; // 7 days
      const session = (
        config.session && typeof config.session === 'object'
          ? { ...(config.session as Record<string, unknown>) }
          : {}
      ) as Record<string, unknown>;

      if (session.idleMinutes === undefined &&
          session.reset === undefined &&
          session.resetByType === undefined &&
          session.resetByChannel === undefined) {
        session.idleMinutes = DEFAULT_IDLE_MINUTES;
        config.session = session;
        modified = true;
      }
    } catch (err) {
      logger.warn('Failed to sync session idle minutes in batch:', err);
    }

    // 7. Re-apply box-im tokenKey
    try {
      const tokenKey = await getTokenKey();
      if (tokenKey) {
        const channels = (config.channels && typeof config.channels === 'object'
          ? config.channels as Record<string, unknown>
          : {});
        const boxIm = (channels['box-im'] && typeof channels['box-im'] === 'object'
          ? channels['box-im'] as Record<string, unknown>
          : {});
        const ownerAuth = (boxIm.ownerAuth && typeof boxIm.ownerAuth === 'object'
          ? boxIm.ownerAuth as Record<string, unknown>
          : {});
        
        if (ownerAuth.tokenKey !== tokenKey) {
          ownerAuth.tokenKey = tokenKey;
          boxIm.ownerAuth = ownerAuth;
          channels['box-im'] = boxIm;
          config.channels = channels;
          modified = true;
        }
      }
    } catch (err) {
      logger.warn('Failed to re-apply tokenKey in batch:', err);
    }

    // Write once if any changes were made
    if (modified) {
      await writeOpenClawJson(config);
      logger.info('[config-sync] Batch synced gateway config in single write');
    } else {
      logger.debug('[config-sync] No config changes needed');
    }
  });
}

async function loadProviderEnv(): Promise<{ providerEnv: Record<string, string>; loadedProviderKeyCount: number }> {
  const providerEnv: Record<string, string> = {};
  const providerTypes = getKeyableProviderTypes();
  let loadedProviderKeyCount = 0;

  try {
    const defaultProviderId = await getDefaultProvider();
    if (defaultProviderId) {
      const defaultProvider = await getProvider(defaultProviderId);
      const defaultProviderType = defaultProvider?.type;
      const defaultProviderKey = await getApiKey(defaultProviderId);
      if (defaultProviderType && defaultProviderKey) {
        const envVar = getProviderEnvVar(defaultProviderType);
        if (envVar) {
          providerEnv[envVar] = defaultProviderKey;
          loadedProviderKeyCount++;
        }
      }
    }
  } catch (err) {
    logger.warn('Failed to load default provider key for environment injection:', err);
  }

  for (const providerType of providerTypes) {
    try {
      const key = await getApiKey(providerType);
      if (key) {
        const envVar = getProviderEnvVar(providerType);
        if (envVar) {
          providerEnv[envVar] = key;
          loadedProviderKeyCount++;
        }
      }
    } catch (err) {
      logger.warn(`Failed to load API key for ${providerType}:`, err);
    }
  }

  return { providerEnv, loadedProviderKeyCount };
}

async function resolveChannelStartupPolicy(): Promise<{
  skipChannels: boolean;
  channelStartupSummary: string;
}> {
  try {
    const configuredChannels = await listConfiguredChannels();
    if (configuredChannels.length === 0) {
      return {
        skipChannels: true,
        channelStartupSummary: 'skipped(no configured channels)',
      };
    }

    return {
      skipChannels: false,
      channelStartupSummary: `enabled(${configuredChannels.join(',')})`,
    };
  } catch (error) {
    logger.warn('Failed to determine configured channels for gateway launch:', error);
    return {
      skipChannels: false,
      channelStartupSummary: 'enabled(unknown)',
    };
  }
}

export async function prepareGatewayLaunchContext(port: number): Promise<GatewayLaunchContext> {
  const openclawDir = getOpenClawDir();
  const entryScript = getOpenClawEntryPath();

  if (!isOpenClawPresent()) {
    throw new Error(`OpenClaw package not found at: ${openclawDir}`);
  }

  const appSettings = await timeGatewayPrepAsync('load settings', () => getAllSettings());
  await timeGatewayPrepAsync('sync config before launch', () => syncGatewayConfigBeforeLaunch(appSettings));

  if (!existsSync(entryScript)) {
    throw new Error(`OpenClaw entry script not found at: ${entryScript}`);
  }

  const gatewayArgs = ['gateway', '--port', String(port), '--token', appSettings.gatewayToken, '--allow-unconfigured'];
  const mode = app.isPackaged ? 'packaged' : 'dev';

  const platform = process.platform;
  const arch = process.arch;
  const target = `${platform}-${arch}`;
  const binPath = app.isPackaged
    ? path.join(process.resourcesPath, 'bin')
    : path.join(process.cwd(), 'resources', 'bin', target);
  const binPathExists = existsSync(binPath);

  const { providerEnv, loadedProviderKeyCount } = await timeGatewayPrepAsync('load provider env', () => loadProviderEnv());
  const { skipChannels, channelStartupSummary } = await timeGatewayPrepAsync('resolve channel startup policy', () => resolveChannelStartupPolicy());
  const uvEnv = await timeGatewayPrepAsync('load uv mirror env', () => getUvMirrorEnv());
  const proxyEnv = buildProxyEnv(appSettings);
  const resolvedProxy = resolveProxySettings(appSettings);
  const proxySummary = appSettings.proxyEnabled
    ? `http=${resolvedProxy.httpProxy || '-'}, https=${resolvedProxy.httpsProxy || '-'}, all=${resolvedProxy.allProxy || '-'}`
    : 'disabled';

  const { NODE_OPTIONS: _nodeOptions, ...baseEnv } = process.env;
  const baseEnvRecord = baseEnv as Record<string, string | undefined>;
  const baseEnvPatched = binPathExists
    ? prependPathEntry(baseEnvRecord, binPath).env
    : baseEnvRecord;
  const forkEnv: Record<string, string | undefined> = {
    ...stripSystemdSupervisorEnv(baseEnvPatched),
    ...providerEnv,
    ...uvEnv,
    ...proxyEnv,
    OPENCLAW_GATEWAY_TOKEN: appSettings.gatewayToken,
    OPENCLAW_SKIP_CHANNELS: skipChannels ? '1' : '',
    CLAWDBOT_SKIP_CHANNELS: skipChannels ? '1' : '',
    OPENCLAW_NO_RESPAWN: '1',
    OPENCLAW_DISABLE_AGENT_HEARTBEAT: '1',
    OPENCLAW_SKILL_MARKET_URL: SKILL_MARKET_BASE_URL,
  };

  // Ensure extension-specific packages (e.g. grammy from the telegram
  // extension) are resolvable by shared dist/ chunks via symlinks in
  // openclaw/node_modules/.  NODE_PATH does NOT work for ESM imports.
  timeGatewayPrep('ensure extension deps resolvable', () => ensureExtensionDepsResolvable(openclawDir));

  return {
    appSettings,
    openclawDir,
    entryScript,
    gatewayArgs,
    forkEnv,
    mode,
    binPathExists,
    loadedProviderKeyCount,
    proxySummary,
    channelStartupSummary,
  };
}
