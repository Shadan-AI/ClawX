#!/usr/bin/env zx

/**
 * bundle-box-im.mjs
 *
 * Bundles the box-im plugin from the sibling openclaw repo into
 * build/openclaw-plugins/box-im/ for electron-builder to pick up.
 *
 * box-im is a local plugin (not on npm), so we copy it directly
 * from the openclaw source tree and install its runtime deps.
 */

import 'zx/globals';

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'build', 'openclaw-plugins', 'box-im');

// Resolve box-im source from sibling openclaw repo
const OPENCLAW_REPO = path.resolve(ROOT, '..', 'openclaw');
const BOX_IM_SRC = path.join(OPENCLAW_REPO, 'extensions', 'box-im');

if (!fs.existsSync(BOX_IM_SRC)) {
  echo`❌ box-im source not found at ${BOX_IM_SRC}`;
  echo`   Expected sibling openclaw repo at ${OPENCLAW_REPO}`;
  process.exit(1);
}

echo`📦 Bundling box-im plugin from ${BOX_IM_SRC}`;

// 1. Clean output
if (fs.existsSync(OUTPUT)) {
  fs.rmSync(OUTPUT, { recursive: true });
}
fs.mkdirSync(OUTPUT, { recursive: true });

// 2. Copy plugin source files (exclude node_modules)
const entries = fs.readdirSync(BOX_IM_SRC);
for (const entry of entries) {
  if (entry === 'node_modules') continue;
  const src = path.join(BOX_IM_SRC, entry);
  const dest = path.join(OUTPUT, entry);
  fs.cpSync(src, dest, { recursive: true });
}
echo`   ✅ Plugin source copied`;

// 3. Install runtime dependencies into plugin dir
//    box-im depends on: ws, zod (runtime), openclaw/plugin-sdk (peer, provided by gateway)
const pluginNodeModules = path.join(OUTPUT, 'node_modules');
fs.mkdirSync(pluginNodeModules, { recursive: true });

// Copy ws and zod from the main ClawX node_modules (they're already installed as openclaw deps)
const mainNodeModules = path.join(ROOT, 'node_modules');

function copyDep(name) {
  const src = path.join(mainNodeModules, ...name.split('/'));
  if (!fs.existsSync(src)) {
    // Try resolving through pnpm symlinks
    try {
      const realSrc = fs.realpathSync(src);
      const dest = path.join(pluginNodeModules, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(realSrc, dest, { recursive: true, dereference: true });
      return true;
    } catch {
      echo`   ⚠️  Dependency ${name} not found, skipping`;
      return false;
    }
  }
  const realSrc = fs.realpathSync(src);
  const dest = path.join(pluginNodeModules, name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(realSrc, dest, { recursive: true, dereference: true });
  return true;
}

// Runtime deps from box-im's package.json
copyDep('ws');
copyDep('zod');
echo`   ✅ Runtime dependencies bundled`;

// 4. Verify
const manifestPath = path.join(OUTPUT, 'openclaw.plugin.json');
if (!fs.existsSync(manifestPath)) {
  echo`❌ Missing openclaw.plugin.json in output`;
  process.exit(1);
}

echo`✅ box-im plugin bundled: ${OUTPUT}`;
