import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { testHome, testUserData, testAppPath } = vi.hoisted(() => {
  const suffix = Math.random().toString(36).slice(2);
  return {
    testHome: `/tmp/clawx-openclaw-resolve-${suffix}`,
    testUserData: `/tmp/clawx-openclaw-resolve-user-data-${suffix}`,
    testAppPath: `/tmp/clawx-openclaw-app-${suffix}`,
  };
});

const originalOpenClawDirEnv = process.env.CLAWX_OPENCLAW_DIR;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  const mocked = {
    ...actual,
    homedir: () => testHome,
  };
  return {
    ...mocked,
    default: mocked,
  };
});

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => testUserData,
    getVersion: () => '0.0.0-test',
    getAppPath: () => testAppPath,
  },
}));

function writeJson(filePath: string, value: unknown) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

describe('resolveOpenClawPackageJson', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.CLAWX_OPENCLAW_DIR;
    rmSync(testHome, { recursive: true, force: true });
    rmSync(testUserData, { recursive: true, force: true });
    rmSync(testAppPath, { recursive: true, force: true });
  });

  afterEach(() => {
    if (originalOpenClawDirEnv === undefined) {
      delete process.env.CLAWX_OPENCLAW_DIR;
    } else {
      process.env.CLAWX_OPENCLAW_DIR = originalOpenClawDirEnv;
    }
    rmSync(testHome, { recursive: true, force: true });
    rmSync(testUserData, { recursive: true, force: true });
    rmSync(testAppPath, { recursive: true, force: true });
  });

  it('resolves plugin-owned runtime deps from the bundled WhatsApp plugin context', async () => {
    const openclawRoot = join(testAppPath, 'node_modules', 'openclaw');
    const pluginDir = join(openclawRoot, 'dist', 'extensions', 'whatsapp');
    process.env.CLAWX_OPENCLAW_DIR = openclawRoot;

    writeJson(join(openclawRoot, 'package.json'), { name: 'openclaw' });
    mkdirSync(openclawRoot, { recursive: true });
    writeFileSync(join(openclawRoot, 'openclaw.mjs'), 'export {};\n', 'utf8');
    writeJson(join(pluginDir, 'package.json'), { name: '@openclaw/whatsapp' });
    writeJson(join(pluginDir, 'node_modules', '@whiskeysockets', 'baileys', 'package.json'), {
      name: '@whiskeysockets/baileys',
      version: '7.0.0-rc.9',
    });

    const { resolveOpenClawPackageJson } = await import('@electron/utils/openclaw-package-resolution');

    expect(realpathSync(resolveOpenClawPackageJson('@whiskeysockets/baileys'))).toBe(
      realpathSync(join(pluginDir, 'node_modules', '@whiskeysockets', 'baileys', 'package.json')),
    );
  });
});
