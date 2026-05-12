import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const lockPath = join(ROOT, 'build', 'preinstalled-skills', '.preinstalled-lock.json');
const outputRoot = join(ROOT, 'build', 'preinstalled-skills');
const bundleScript = join(ROOT, 'scripts', 'bundle-preinstalled-skills.mjs');
const require = createRequire(import.meta.url);

function log(message) {
  process.stdout.write(`${message}\n`);
}

if (process.env.CLAWX_SKIP_PREINSTALLED_SKILLS_PREPARE === '1') {
  log('Skipping preinstalled skills prepare (CLAWX_SKIP_PREINSTALLED_SKILLS_PREPARE=1).');
  process.exit(0);
}

if (existsSync(lockPath)) {
  log('Preinstalled skills bundle already exists, skipping prepare.');
  process.exit(0);
}

log('Preinstalled skills bundle missing, preparing for dev startup...');

try {
  const zxCli = require.resolve('zx/cli.cjs');
  const result = spawnSync(process.execPath, [zxCli, bundleScript], {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`bundle-preinstalled-skills exited with code ${result.status ?? 'unknown'}`);
  }
} catch (error) {
  // Dev startup should remain available even if network-based skill fetching fails.
  if (!existsSync(lockPath)) {
    rmSync(outputRoot, { recursive: true, force: true });
  }
  log(`Warning: failed to prepare preinstalled skills for dev startup: ${error?.message || error}`);
  process.exit(0);
}
