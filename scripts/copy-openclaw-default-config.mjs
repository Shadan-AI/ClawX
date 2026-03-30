#!/usr/bin/env zx

/**
 * Copies the OpenClaw fork's gateway.json into ClawX resources as openclaw-default.json.
 * On first launch, ClawX seeds ~/.openclaw/openclaw.json from this file so packaged
 * builds match your local openme configuration (models, agents, channels, plugins).
 *
 * Source: ../openme/gateway.json (relative to ClawX repo root).
 */

import 'zx/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, '..', 'openme', 'gateway.json');
const DEST = path.join(ROOT, 'resources', 'openclaw-default.json');

if (!fs.existsSync(SRC)) {
  echo`⚠️  openme gateway template missing: ${SRC}`;
  echo`   Skipping resources/openclaw-default.json — first-run seed will fall back to ../openme/gateway.json when running from source.`;
  process.exit(0);
}

fs.mkdirSync(path.dirname(DEST), { recursive: true });
fs.copyFileSync(SRC, DEST);
echo`📄 Copied gateway template -> ${DEST}`;
