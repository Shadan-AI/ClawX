/**
 * Watch ~/.openclaw for changes so we can re-apply bundled models.providers baseUrl
 * when the Gateway overwrites openclaw.json with a dev-LAN endpoint from internal state.
 */
import { existsSync, watch } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { reconcileOpenClawModelsProvidersFromBundledTemplate } from './openclaw-auth';
import { logger } from './logger';

let watcherStarted = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 450;

function scheduleReconcile(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void reconcileOpenClawModelsProvidersFromBundledTemplate().catch((err) => {
      logger.warn('[openclaw-watch] reconcile models.providers failed:', err);
    });
  }, DEBOUNCE_MS);
}

/**
 * Start a single long-lived watcher on ~/.openclaw (directory watch is reliable on Windows).
 * Idempotent; safe to call from every gateway pre-launch sync.
 */
export function startOpenClawConfigLanReconciliationWatcher(): void {
  if (watcherStarted) return;
  const dirPath = join(homedir(), '.openclaw');
  const configPath = join(dirPath, 'openclaw.json');
  if (!existsSync(dirPath)) {
    logger.debug('[openclaw-watch] skip: ~/.openclaw not found yet');
    return;
  }
  watcherStarted = true;
  try {
    const w = watch(dirPath, { persistent: false }, () => {
      if (!existsSync(configPath)) return;
      scheduleReconcile();
    });
    w.on('error', (err) => {
      logger.warn('[openclaw-watch] fs.watch error:', err);
    });
    logger.debug('[openclaw-watch] watching ~/.openclaw for openclaw.json drift');
  } catch (err) {
    watcherStarted = false;
    logger.warn('[openclaw-watch] failed to start watcher:', err);
  }
}
