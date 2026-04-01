/**
 * Mirrors OpenClaw `stampConfigVersion` (openme `src/config/io.ts`) so config health
 * observers do not flag `missing-meta-vs-last-good` when ClawX writes `openclaw.json`.
 */
import { getOpenClawPackageVersion } from './paths';

export function stampOpenClawConfigMeta(config: Record<string, unknown>): void {
  const version = getOpenClawPackageVersion() ?? 'unknown';
  const now = new Date().toISOString();
  const prev =
    config.meta && typeof config.meta === 'object' && !Array.isArray(config.meta)
      ? (config.meta as Record<string, unknown>)
      : {};
  config.meta = {
    ...prev,
    lastTouchedVersion: version,
    lastTouchedAt: now,
  };
}
