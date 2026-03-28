#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const isTruthy = (value) => ['1', 'true', 'yes', 'on'].includes((value ?? '').toLowerCase());

const darwinMajor = Number.parseInt(os.release().split('.')[0] ?? '', 10);
const needsLegacyDmgFallback = process.platform === 'darwin' && Number.isFinite(darwinMajor) && darwinMajor < 22;
const forceDmg = isTruthy(process.env.CLAWX_FORCE_DMG);
const dryRun = process.argv.includes('--dry-run');

const packageTargets = needsLegacyDmgFallback && !forceDmg ? ['zip'] : ['dmg', 'zip'];
const pnpmArgs = ['run', 'package'];
const electronBuilderArgs = ['--mac', ...packageTargets, '--publish', 'never'];

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }

  if (result.signal) {
    console.error(`Command terminated by signal: ${result.signal}`);
    process.exit(1);
  }
}

if (needsLegacyDmgFallback && !forceDmg) {
  console.warn(
    '[package:mac] macOS 11/12 detected; defaulting to zip-only packaging because electron-builder dmgbuild uses mkfifoat, which requires macOS 13+.'
  );
  console.warn(
    '[package:mac] To force DMG creation with a compatible custom dmgbuild, run: CLAWX_FORCE_DMG=1 pnpm package:mac'
  );
}

const pnpmExecPath = process.env.npm_execpath;
if (dryRun) {
  console.log(`[package:mac] package targets: ${packageTargets.join(', ')}`);
  console.log(`[package:mac] package command: ${(pnpmExecPath ? [process.execPath, pnpmExecPath, ...pnpmArgs] : ['pnpm', ...pnpmArgs]).join(' ')}`);
  console.log(`[package:mac] electron-builder command: ${[process.execPath, require.resolve('electron-builder/cli.js'), ...electronBuilderArgs].join(' ')}`);
  process.exit(0);
}

if (pnpmExecPath) {
  run(process.execPath, [pnpmExecPath, ...pnpmArgs]);
} else {
  run('pnpm', pnpmArgs);
}

const electronBuilderCli = require.resolve('electron-builder/cli.js');
run(process.execPath, [electronBuilderCli, ...electronBuilderArgs]);
