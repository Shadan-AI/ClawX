#!/usr/bin/env bash
# openme's dist/ is gitignored; ClawX links file:../openme — CI must build before pnpm install.
set -euo pipefail
: "${GITHUB_WORKSPACE:?}"
PARENT="$(dirname "$GITHUB_WORKSPACE")"
OPENME="$PARENT/openme"
cd "$OPENME"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}"
echo "Building openme at $OPENME (pnpm install + pnpm run build)..."
pnpm install
pnpm run build

node <<'VERIFY'
const fs = require('fs');
const path = require('path');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
function binPaths(bin) {
  if (typeof bin === 'string') return [bin];
  if (bin && typeof bin === 'object') return Object.values(bin).filter((v) => typeof v === 'string');
  return [];
}
const hasGateway =
  (pkg.main && fs.existsSync(pkg.main)) ||
  fs.existsSync(path.join('dist', 'index.js')) ||
  fs.existsSync(path.join('dist', 'entry.js'));
const bins = binPaths(pkg.bin);
const hasCli =
  bins.some((rel) => fs.existsSync(rel)) ||
  fs.existsSync('openclaw.mjs') ||
  fs.existsSync('openme.mjs');
const missing = [];
if (!hasGateway) missing.push('gateway (main or dist/index.js or dist/entry.js)');
if (!hasCli) missing.push('CLI (bin paths or openclaw.mjs / openme.mjs)');
if (missing.length) {
  console.error('openme build output incomplete:', missing.join('; '));
  process.exit(1);
}
console.log('openme build artifacts OK (CLI + gateway).');
VERIFY

echo "openme build finished."
