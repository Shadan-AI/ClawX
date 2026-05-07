/**
 * Configuration Migration Utility
 *
 * Handles automatic migration of user configurations when upgrading to new versions.
 * This ensures old users get the latest default settings without manual intervention.
 */

import { readOpenClawConfig, writeOpenClawConfig } from './channel-config';
import { logger } from './logger';

const DEPRECATED_MODEL_REF = 'shadan/step-3.5-flash';
const SAFE_MODEL_REF = 'shadan/glm-5';

/**
 * Remove deprecated model references from local config.
 *
 * The product should no longer surface `step-3.5-flash`, so any stale local
 * config still pointing to it is normalized back to a safe supported model.
 */
async function removeDeprecatedStepModel(): Promise<boolean> {
  try {
    const config = await readOpenClawConfig();
    let modified = false;

    if ((config as any).agents?.defaults?.model?.primary === DEPRECATED_MODEL_REF) {
      (config as any).agents.defaults.model.primary = SAFE_MODEL_REF;
      modified = true;
      logger.info(`[migration] Updated agents.defaults.model.primary: ${DEPRECATED_MODEL_REF} -> ${SAFE_MODEL_REF}`);
    }

    const agentsList = (config as any).agents?.list || [];
    for (const agent of agentsList) {
      if (agent.model?.primary === DEPRECATED_MODEL_REF) {
        agent.model.primary = SAFE_MODEL_REF;
        modified = true;
        logger.info(`[migration] Updated agent ${agent.id} model: ${DEPRECATED_MODEL_REF} -> ${SAFE_MODEL_REF}`);
      }
    }

    const channels = config.channels || {};
    for (const [channelType, channelConfig] of Object.entries(channels)) {
      const accounts = (channelConfig as any)?.accounts || {};
      for (const [accountId, account] of Object.entries(accounts)) {
        if ((account as any).model === DEPRECATED_MODEL_REF) {
          (account as any).model = SAFE_MODEL_REF;
          modified = true;
          logger.info(`[migration] Updated ${channelType} account ${accountId} model: ${DEPRECATED_MODEL_REF} -> ${SAFE_MODEL_REF}`);
        }
      }
    }

    if (modified) {
      await writeOpenClawConfig(config);
      logger.info('[migration] Configuration migrated successfully');
      return true;
    }

    return false;
  } catch (error) {
    logger.error('[migration] Failed to remove deprecated step model:', error);
    return false;
  }
}

/**
 * Run all configuration migrations
 *
 * This function should be called during application initialization,
 * before the Gateway starts.
 */
export async function runConfigMigrations(): Promise<void> {
  logger.info('[migration] Running configuration migrations...');

  try {
    const deprecatedModelRemoved = await removeDeprecatedStepModel();

    if (deprecatedModelRemoved) {
      logger.info('[migration] Removed deprecated step model references');
    } else {
      logger.debug('[migration] No deprecated step model references found, skipping migration');
    }

    logger.info('[migration] All migrations completed');
  } catch (error) {
    logger.error('[migration] Migration failed:', error);
    // Don't throw - allow app to continue even if migration fails
  }
}
