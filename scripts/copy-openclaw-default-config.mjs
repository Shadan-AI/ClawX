#!/usr/bin/env zx

/**
 * Copies the OpenClaw fork's gateway.json into ClawX resources as openclaw-default.json.
 * On first launch, ClawX seeds ~/.openclaw/openclaw.json from this file so packaged
 * builds match your local openme configuration (models, agents, channels, plugins).
 *
 * Source: @shadanai/openclaw package (npm) or ../openme/gateway.json when developing.
 */

import 'zx/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC_CANDIDATES = [
  path.join(ROOT, 'node_modules', '@shadanai', 'openclaw', 'gateway.json'),
  path.join(ROOT, '..', 'openme', 'gateway.json'),
];
const SRC = SRC_CANDIDATES.find((p) => fs.existsSync(p));
const DEST = path.join(ROOT, 'resources', 'openclaw-default.json');

if (!SRC) {
  echo`⚠️  gateway template missing (tried npm @shadanai/openclaw and ../openme/gateway.json)`;
  echo`   Skipping resources/openclaw-default.json`;
  process.exit(0);
}

fs.mkdirSync(path.dirname(DEST), { recursive: true });
fs.copyFileSync(SRC, DEST);
echo`📄 Copied gateway template -> ${DEST}`;
