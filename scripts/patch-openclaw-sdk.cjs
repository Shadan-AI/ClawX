#!/usr/bin/env node
/**
 * Patches openclaw's root-alias.cjs to export functions that openclaw-weixin
 * expects from openclaw/plugin-sdk but are missing from the compat layer.
 */
const fs = require('fs');
const path = require('path');

const aliasPath = path.join(__dirname, 'node_modules/openclaw/dist/plugin-sdk/root-alias.cjs');
if (!fs.existsSync(aliasPath)) {
  console.log('[patch-openclaw] root-alias.cjs not found, skipping');
  process.exit(0);
}

let code = fs.readFileSync(aliasPath, 'utf8');
if (code.includes('// --- ClawX patches ---')) {
  console.log('[patch-openclaw] already patched');
  process.exit(0);
}

const patch = `
// --- ClawX patches ---
function resolvePreferredOpenClawTmpDir() {
  const os = require('node:os');
  const tmpBase = process.env.OPENCLAW_TMP_DIR || path.join(os.tmpdir(), 'openclaw');
  try { require('node:fs').mkdirSync(tmpBase, { recursive: true }); } catch {}
  return tmpBase;
}
let _accountIdMod = null;
function normalizeAccountId(id) {
  if (!_accountIdMod) _accountIdMod = getJiti(true)(path.join(__dirname, 'account-id.js'));
  return _accountIdMod.normalizeAccountId(id);
}
// --- end ClawX patches ---
`;

code = code.replace('const fastExports = {', patch + 'const fastExports = {');
code = code.replace(
  /  resolveControlCommandGate,\n};/,
  '  resolveControlCommandGate,\n  resolvePreferredOpenClawTmpDir,\n  normalizeAccountId,\n};'
);

fs.writeFileSync(aliasPath, code);
console.log('[patch-openclaw] patched root-alias.cjs');
