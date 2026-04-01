#!/usr/bin/env zx

/**
 * Bundles openme's mkcert.exe into ClawX resources for Windows packaged builds.
 * Source: ../openme/mkcert.exe (relative to ClawX repo root).
 */

import 'zx/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, '..', 'openme', 'mkcert.exe');
const DEST = path.join(ROOT, 'resources', 'tools', 'mkcert.exe');

if (!fs.existsSync(SRC)) {
  echo`⚠️  mkcert not found: ${SRC} — skip resources/tools/mkcert.exe (Windows TLS auto-gen will look for dev path)`;
  process.exit(0);
}

fs.mkdirSync(path.dirname(DEST), { recursive: true });
fs.copyFileSync(SRC, DEST);
echo`🔐 Copied mkcert.exe -> ${DEST}`;
