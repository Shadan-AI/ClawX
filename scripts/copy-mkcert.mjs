#!/usr/bin/env zx

/**
 * Bundles mkcert.exe into ClawX resources for Windows packaged builds.
 *
 * Source priority:
 *   1. ../openme/mkcert.exe  — local dev monorepo
 *   2. Download from GitHub releases (CI / machines without openme)
 */

import 'zx/globals';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LOCAL_SRC = path.join(ROOT, '..', 'openme', 'mkcert.exe');
const DEST = path.join(ROOT, 'resources', 'tools', 'mkcert.exe');

// mkcert release to download when local copy is unavailable
const MKCERT_VERSION = 'v1.4.4';
const MKCERT_URL = `https://github.com/FiloSottile/mkcert/releases/download/${MKCERT_VERSION}/mkcert-${MKCERT_VERSION}-windows-amd64.exe`;

fs.mkdirSync(path.dirname(DEST), { recursive: true });

if (fs.existsSync(LOCAL_SRC)) {
  fs.copyFileSync(LOCAL_SRC, DEST);
  echo`🔐 Copied mkcert.exe from local openme -> ${DEST}`;
  process.exit(0);
}

echo`⬇️  mkcert not found locally, downloading ${MKCERT_URL} ...`;

await new Promise((resolve, reject) => {
  function download(url, dest, redirects = 0) {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return download(res.headers.location, dest, redirects + 1);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} downloading mkcert`));
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    }).on('error', reject);
  }
  download(MKCERT_URL, DEST);
});

echo`🔐 Downloaded mkcert.exe -> ${DEST}`;
