/**
 * Configuration Migration Utility
 * 
 * Handles automatic migration of user configurations when upgrading to new versions.
 * This ensures old users get the latest default settings without manual intervention.
 */

import { readOpenClawConfig, writeOpenClawConfig } from './channel-config';
import { logger } from './logger';

/**
 * Migrate deprecated model references from glm-5 to step-3.5-flash
 * 
 * This migration is necessary because:
 * 1. glm-5 is no longer available (returns 503 errors)
 * 2. Old users have glm-5 hardcoded in their config files
 * 3. New default is step-3.5-flash
 */
async function migrateGlm5ToStep(): Promise<boolean> {
  try {
    const config = await readOpenClawConfig();
    let modified = false;

    // 1. Migrate agents.defaults.model.primary
    if ((config as any).agents?.defaults?.model?.primary === 'shadan/glm-5') {
      (config as any).agents.defaults.model.primary = 'shadan/step-3.5-flash';
      modified = true;
      logger.info('[migration] Updated agents.defaults.model.primary: glm-5 -> step-3.5-flash');
    }

    // 2. Migrate individual agent models
    const agentsList = (config as any).agents?.list || [];
    for (const agent of agentsList) {
      if (agent.model?.primary === 'shadan/glm-5') {
        agent.model.primary = 'shadan/step-3.5-flash';
        modified = true;
        logger.info(`[migration] Updated agent ${agent.id} model: glm-5 -> step-3.5-flash`);
      }
    }

    // 3. Migrate box-im account models
    const boxImAccounts = (config.channels?.['box-im'] as any)?.accounts || {};
    for (const [accountId, account] of Object.entries(boxImAccounts)) {
      if ((account as any).model === 'shadan/glm-5') {
        (account as any).model = 'shadan/step-3.5-flash';
        modified = true;
        logger.info(`[migration] Updated box-im account ${accountId} model: glm-5 -> step-3.5-flash`);
      }
    }

    if (modified) {
      await writeOpenClawConfig(config);
      logger.info('[migration] Configuration migrated successfully');
      return true;
    }

    return false;
  } catch (error) {
    logger.error('[migration] Failed to migrate glm-5 to step-3.5-flash:', error);
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
    // Run all migrations
    const glm5Migrated = await migrateGlm5ToStep();

    if (glm5Migrated) {
      logger.info('[migration] ✓ Migrated deprecated glm-5 references');
    } else {
      logger.debug('[migration] No glm-5 references found, skipping migration');
    }

    logger.info('[migration] All migrations completed');
  } catch (error) {
    logger.error('[migration] Migration failed:', error);
    // Don't throw - allow app to continue even if migration fails
  }
}
