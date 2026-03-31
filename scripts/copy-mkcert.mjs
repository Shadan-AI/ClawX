#!/usr/bin/env zx

/**
 * Bundles openme's mkcert.exe into ClawX resources for Windows packaged builds.
 * Source: @shadanai/openclaw package (npm) or ../openme/mkcert.exe when developing.
 */

import 'zx/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC_CANDIDATES = [
  path.join(ROOT, 'node_modules', '@shadanai', 'openclaw', 'mkcert.exe'),
  path.join(ROOT, '..', 'openme', 'mkcert.exe'),
];
const SRC = SRC_CANDIDATES.find((p) => fs.existsSync(p));
const DEST = path.join(ROOT, 'resources', 'tools', 'mkcert.exe');

if (!SRC) {
  echo`⚠️  mkcert.exe not found (tried npm package and ../openme/) — skip resources/tools/mkcert.exe`;
  process.exit(0);
}

fs.mkdirSync(path.dirname(DEST), { recursive: true });
fs.copyFileSync(SRC, DEST);
echo`🔐 Copied mkcert.exe -> ${DEST}`;
