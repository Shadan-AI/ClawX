/**
 * after-pack.cjs
 *
 * electron-builder afterPack hook.
 *
 * Problem: electron-builder respects .gitignore when copying extraResources.
 * Since .gitignore contains "node_modules/", the openclaw bundle's
 * node_modules directory is silently skipped during the extraResources copy.
 *
 * Solution: This hook runs AFTER electron-builder finishes packing. It manually
 * copies build/openclaw/node_modules/ into the output resources directory,
 * bypassing electron-builder's glob filtering entirely.
 *
 * Additionally it performs two rounds of cleanup:
 *   1. General cleanup — removes dev artifacts (type defs, source maps, docs,
 *      test dirs) from both the openclaw root and its node_modules.
 *   2. Platform-specific cleanup — strips native binaries for non-target
 *      platforms (koffi multi-platform prebuilds, @napi-rs/canvas, @img/sharp,
 *      @mariozechner/clipboard).
 */

const { cpSync, existsSync, readdirSync, rmSync, statSync, mkdirSync, realpathSync } = require('fs');
const { join, dirname, basename, relative } = require('path');

// On Windows, paths in pnpm's virtual store can exceed the default MAX_PATH
// limit (260 chars). Node.js 18.17+ respects the system LongPathsEnabled
// registry key, but as a safety net we normalize paths to use the \\?\ prefix
// on Windows, which bypasses the limit unconditionally.
function normWin(p) {
  if (process.platform !== 'win32') return p;
  if (p.startsWith('\\\\?\\')) return p;
  return '\\\\?\\' + p.replace(/\//g, '\\');
}

// ── Arch helpers ─────────────────────────────────────────────────────────────
// electron-builder Arch enum: 0=ia32, 1=x64, 2=armv7l, 3=arm64, 4=universal
const ARCH_MAP = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

function resolveArch(archEnum) {
  return ARCH_MAP[archEnum] || 'x64';
}

function copyWindowsVpnRuntime(resourcesDir, arch) {
  if (arch !== 'x64') {
    throw new Error(`[after-pack] Windows VPN runtime is only bundled for x64; unsupported arch=${arch}`);
  }

  const srcDir = join(__dirname, '..', 'resources', 'bin', `win32-${arch}`);
  const destDir = join(resourcesDir, 'bin');
  const requiredFiles = [
    'openme-vpn-helper.ps1',
    'wireguard-amd64-0.6.1.msi',
  ];

  for (const fileName of requiredFiles) {
    const src = join(srcDir, fileName);
    if (!existsSync(src)) {
      throw new Error(`[after-pack] Missing required Windows VPN runtime file: ${src}`);
    }
  }

  mkdirSync(destDir, { recursive: true });
  for (const fileName of requiredFiles) {
    const src = join(srcDir, fileName);
    const dest = join(destDir, fileName);
    cpSync(src, dest);
    if (!existsSync(dest)) {
      throw new Error(`[after-pack] Failed to copy Windows VPN runtime file to: ${dest}`);
    }
    console.log(`[after-pack] Bundled Windows VPN runtime: ${relative(resourcesDir, dest)}`);
  }
}

// ── General cleanup ──────────────────────────────────────────────────────────

function cleanupUnnecessaryFiles(dir) {
  let removedCount = 0;

  const REMOVE_DIRS = new Set([
    'test', 'tests', '__tests__', '.github', 'examples', 'example', 'docs', 'doc',
    'coverage', '.nyc_output',
  ]);
  const REMOVE_FILE_EXTS = ['.d.ts', '.map', '.markdown'];
  const REMOVE_FILE_NAMES = new Set([
    '.DS_Store', 'README.md', 'CHANGELOG.md', 'LICENSE.md', 'CONTRIBUTING.md',
    'tsconfig.json', '.npmignore', '.eslintrc', '.prettierrc', '.editorconfig',
  ]);

  function shouldKeepRuntimeDir(fullPath, name) {
    if (name !== 'doc') return false;
    const normalized = fullPath.replace(/\\/g, '/');
    return /\/node_modules\/yaml\/dist\/doc$/.test(normalized);
  }

  function walk(currentDir) {
    let entries;
    try { entries = readdirSync(currentDir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (shouldKeepRuntimeDir(fullPath, entry.name)) {
          walk(fullPath);
        } else if (REMOVE_DIRS.has(entry.name)) {
          try { rmSync(fullPath, { recursive: true, force: true }); removedCount++; } catch { /* */ }
        } else {
          walk(fullPath);
        }
      } else if (entry.isFile()) {
        const name = entry.name;
        if (REMOVE_FILE_NAMES.has(name) || REMOVE_FILE_EXTS.some(e => name.endsWith(e))) {
          try { rmSync(fullPath, { force: true }); removedCount++; } catch { /* */ }
        }
      }
    }
  }

  walk(dir);
  return removedCount;
}

// ── Platform-specific: koffi ─────────────────────────────────────────────────
// koffi ships 18 platform pre-builds under koffi/build/koffi/{platform}_{arch}/.
// We only need the one matching the target.

function cleanupKoffi(nodeModulesDir, platform, arch) {
  const koffiDir = join(nodeModulesDir, 'koffi', 'build', 'koffi');
  if (!existsSync(koffiDir)) return 0;

  const keepTarget = `${platform}_${arch}`;
  let removed = 0;
  for (const entry of readdirSync(koffiDir)) {
    if (entry !== keepTarget) {
      try { rmSync(join(koffiDir, entry), { recursive: true, force: true }); removed++; } catch { /* */ }
    }
  }
  return removed;
}

// ── Platform-specific: scoped native packages ────────────────────────────────
// Packages like @napi-rs/canvas-darwin-arm64, @img/sharp-linux-x64, etc.
// Only the variant matching the target platform should survive.
//
// Some packages use non-standard platform names:
//   - @node-llama-cpp: "mac" instead of "darwin", "win" instead of "win32"
//   - sqlite-vec: "windows" instead of "win32" (unscoped, handled separately)
// We normalise them before comparison.

const PLATFORM_ALIASES = {
  darwin: 'darwin', mac: 'darwin',
  linux: 'linux', linuxmusl: 'linux',
  win32: 'win32', win: 'win32', windows: 'win32',
};

// Each regex MUST have capture group 1 = platform name and group 2 = arch name.
// Compound arch suffixes (e.g. "x64-msvc", "arm64-gnu", "arm64-metal") are OK —
// we strip the suffix after the first dash to get the base arch.
const PLATFORM_NATIVE_SCOPES = {
  '@napi-rs': /^canvas-(darwin|linux|win32)-(x64|arm64)/,
  '@img': /^sharp(?:-libvips)?-(darwin|linux(?:musl)?|win32)-(x64|arm64|arm|ppc64|riscv64|s390x)/,
  '@mariozechner': /^clipboard-(darwin|linux|win32)-(x64|arm64|universal)/,
  '@snazzah': /^davey-(darwin|linux|android|freebsd|win32|wasm32)-(x64|arm64|arm|ia32|arm64-gnu|arm64-musl|x64-gnu|x64-musl|x64-msvc|arm64-msvc|ia32-msvc|arm-eabi|arm-gnueabihf|wasi)/,
  '@lydell': /^node-pty-(darwin|linux|win32)-(x64|arm64)/,
  '@reflink': /^reflink-(darwin|linux|win32)-(x64|arm64|x64-gnu|x64-musl|arm64-gnu|arm64-musl|x64-msvc|arm64-msvc)/,
  '@node-llama-cpp': /^(mac|linux|win)-(arm64|x64|armv7l)(-metal|-cuda|-cuda-ext|-vulkan)?$/,
  '@esbuild': /^(darwin|linux|win32|android|freebsd|netbsd|openbsd|sunos|aix|openharmony)-(x64|arm64|arm|ia32|loong64|mips64el|ppc64|riscv64|s390x)/,
};

// Unscoped packages that follow a <name>-<platform>-<arch> convention.
// Each entry: { prefix, pattern } where pattern captures (platform, arch).
const UNSCOPED_NATIVE_PACKAGES = [
  // sqlite-vec uses "windows" instead of "win32"
  { prefix: 'sqlite-vec-', pattern: /^sqlite-vec-(darwin|linux|windows)-(x64|arm64)$/ },
];

/**
 * Normalise the base arch from a potentially compound value.
 * e.g. "x64-msvc" → "x64", "arm64-gnu" → "arm64", "arm64-metal" → "arm64"
 */
function baseArch(rawArch) {
  const dash = rawArch.indexOf('-');
  return dash > 0 ? rawArch.slice(0, dash) : rawArch;
}

function cleanupNativePlatformPackages(nodeModulesDir, platform, arch) {
  let removed = 0;

  // 1. Scoped packages (e.g. @snazzah/davey-darwin-arm64)
  for (const [scope, pattern] of Object.entries(PLATFORM_NATIVE_SCOPES)) {
    const scopeDir = join(nodeModulesDir, scope);
    if (!existsSync(scopeDir)) continue;

    for (const entry of readdirSync(scopeDir)) {
      const match = entry.match(pattern);
      if (!match) continue; // not a platform-specific package, leave it

      const pkgPlatform = PLATFORM_ALIASES[match[1]] || match[1];
      const pkgArch = baseArch(match[2]);

      const isMatch =
        pkgPlatform === platform &&
        (pkgArch === arch || pkgArch === 'universal');

      if (!isMatch) {
        try {
          rmSync(join(scopeDir, entry), { recursive: true, force: true });
          removed++;
        } catch { /* */ }
      }
    }
  }

  // 2. Unscoped packages (e.g. sqlite-vec-darwin-arm64)
  for (const { pattern } of UNSCOPED_NATIVE_PACKAGES) {
    let entries;
    try { entries = readdirSync(nodeModulesDir); } catch { continue; }

    for (const entry of entries) {
      const match = entry.match(pattern);
      if (!match) continue;

      const pkgPlatform = PLATFORM_ALIASES[match[1]] || match[1];
      const pkgArch = baseArch(match[2]);

      const isMatch =
        pkgPlatform === platform &&
        (pkgArch === arch || pkgArch === 'universal');

      if (!isMatch) {
        try {
          rmSync(join(nodeModulesDir, entry), { recursive: true, force: true });
          removed++;
        } catch { /* */ }
      }
    }
  }

  return removed;
}

// ── Broken module patcher ─────────────────────────────────────────────────────
// Some bundled packages have transpiled CJS that sets `module.exports = exports.default`
// without ever assigning `exports.default`, leaving module.exports === undefined.
// This causes `TypeError: Cannot convert undefined or null to object` in Node.js 22+
// ESM interop (translators.js hasOwnProperty call).  We patch these after copying.

const MODULE_PATCHES = {
  // node-domexception@1.0.0: index.js sets module.exports = undefined.
  // Node.js 18+ ships DOMException as a built-in; this shim re-exports it.
  'node-domexception/index.js': [
    "'use strict';",
    '// Shim: original transpiled file sets module.exports = exports.default (undefined).',
    '// Node.js 18+ has DOMException as a built-in global.',
    'const dom = globalThis.DOMException ||',
    '  class DOMException extends Error {',
    "    constructor(msg, name) { super(msg); this.name = name || 'Error'; }",
    '  };',
    'module.exports = dom;',
    'module.exports.DOMException = dom;',
    'module.exports.default = dom;',
  ].join('\n') + '\n',
};

function patchBrokenModules(nodeModulesDir) {
  const { writeFileSync, readFileSync } = require('fs');
  let count = 0;
  for (const [rel, content] of Object.entries(MODULE_PATCHES)) {
    const target = join(nodeModulesDir, rel);
    if (existsSync(target)) {
      writeFileSync(target, content, 'utf8');
      count++;
    }
  }

  // https-proxy-agent: add a CJS `require` condition only when we can point to
  // a real CommonJS entry. Mapping `require` to an ESM file can cause
  // ERR_REQUIRE_CYCLE_MODULE in Node.js CLI/TUI flows.
  const hpaPkgPath = join(nodeModulesDir, 'https-proxy-agent', 'package.json');
  if (existsSync(hpaPkgPath)) {
    try {
      const { existsSync: fsExistsSync } = require('fs');
      const raw = readFileSync(hpaPkgPath, 'utf8');
      const pkg = JSON.parse(raw);
      const exp = pkg.exports;
      const hasRequireCondition = Boolean(
        (exp && typeof exp === 'object' && exp.require) ||
        (exp && typeof exp === 'object' && exp['.'] && exp['.'].require)
      );

      const pkgDir = dirname(hpaPkgPath);
      const mainEntry = typeof pkg.main === 'string' ? pkg.main : null;
      const dotImport = exp && typeof exp === 'object' && exp['.'] && typeof exp['.'].import === 'string'
        ? exp['.'].import
        : null;
      const rootImport = exp && typeof exp === 'object' && typeof exp.import === 'string'
        ? exp.import
        : null;
      const importEntry = dotImport || rootImport;

      const cjsCandidates = [
        mainEntry,
        importEntry && importEntry.endsWith('.js') ? importEntry.replace(/\.js$/, '.cjs') : null,
        './dist/index.cjs',
      ].filter(Boolean);

      const requireTarget = cjsCandidates.find((candidate) =>
        fsExistsSync(join(pkgDir, candidate)),
      );

      // Only patch if exports exists, lacks a CJS `require` condition, and we
      // have a verified CJS target file.
      if (exp && !hasRequireCondition && requireTarget) {
        pkg.exports = {
          '.': {
            import: importEntry || requireTarget,
            require: requireTarget,
            default: importEntry || requireTarget,
          },
        };
        writeFileSync(hpaPkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
        count++;
        console.log(`[after-pack] 🩹 Patched https-proxy-agent exports for CJS compatibility (require=${requireTarget})`);
      }
    } catch (err) {
      console.warn('[after-pack] ⚠️  Failed to patch https-proxy-agent:', err.message);
    }
  }

  // lru-cache CJS/ESM interop fix (recursive):
  // Multiple versions of lru-cache may exist in the output tree — not just
  // at node_modules/lru-cache/ but also nested inside other packages.
  // Older CJS versions (v5, v6) export the class via `module.exports = LRUCache`
  // without a named `LRUCache` property, so `import { LRUCache } from 'lru-cache'`
  // fails in Node.js 22+ ESM interop (used by Electron 40+).
  // We recursively scan the entire output for ALL lru-cache installations and
  // patch each CJS entry to ensure `exports.LRUCache` always exists.
  function patchAllLruCacheInstances(rootDir) {
    let lruCount = 0;
    const stack = [rootDir];
    while (stack.length > 0) {
      const dir = stack.pop();
      let entries;
      try { entries = readdirSync(normWin(dir), { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        let isDirectory = entry.isDirectory();
        if (!isDirectory) {
          // pnpm layout may contain symlink/junction directories on Windows.
          try { isDirectory = statSync(normWin(fullPath)).isDirectory(); } catch { isDirectory = false; }
        }
        if (!isDirectory) continue;
        if (entry.name === 'lru-cache') {
          const pkgPath = join(fullPath, 'package.json');
          if (!existsSync(normWin(pkgPath))) { stack.push(fullPath); continue; }
          try {
            const pkg = JSON.parse(readFileSync(normWin(pkgPath), 'utf8'));
            if (pkg.type === 'module') continue; // ESM version — already has named exports
            const mainFile = pkg.main || 'index.js';
            const entryFile = join(fullPath, mainFile);
            if (!existsSync(normWin(entryFile))) continue;
            const original = readFileSync(normWin(entryFile), 'utf8');
            if (!original.includes('exports.LRUCache')) {
              const patched = [
                original,
                '',
                '// OpenMe patch: add LRUCache named export for Node.js 22+ ESM interop',
                'if (typeof module.exports === "function" && !module.exports.LRUCache) {',
                '  module.exports.LRUCache = module.exports;',
                '}',
                '',
              ].join('\n');
              writeFileSync(normWin(entryFile), patched, 'utf8');
              lruCount++;
              console.log(`[after-pack] 🩹 Patched lru-cache CJS (v${pkg.version}) at ${relative(rootDir, fullPath)}`);
            }

            // lru-cache v7 ESM entry exports default only; add named export.
            const moduleFile = typeof pkg.module === 'string' ? pkg.module : null;
            if (moduleFile) {
              const esmEntry = join(fullPath, moduleFile);
              if (existsSync(normWin(esmEntry))) {
                const esmOriginal = readFileSync(normWin(esmEntry), 'utf8');
                if (
                  esmOriginal.includes('export default LRUCache') &&
                  !esmOriginal.includes('export { LRUCache')
                ) {
                  const esmPatched = [esmOriginal, '', 'export { LRUCache }', ''].join('\n');
                  writeFileSync(normWin(esmEntry), esmPatched, 'utf8');
                  lruCount++;
                  console.log(`[after-pack] 🩹 Patched lru-cache ESM (v${pkg.version}) at ${relative(rootDir, fullPath)}`);
                }
              }
            }
          } catch (err) {
            console.warn(`[after-pack] ⚠️  Failed to patch lru-cache at ${fullPath}:`, err.message);
          }
        } else {
          stack.push(fullPath);
        }
      }
    }
    return lruCount;
  }
  const lruPatched = patchAllLruCacheInstances(nodeModulesDir);
  count += lruPatched;

  if (count > 0) {
    console.log(`[after-pack] 🩹 Patched ${count} broken module(s) in ${nodeModulesDir}`);
  }
}

// ── Plugin ID mismatch patcher ───────────────────────────────────────────────
// Some plugins (e.g. wecom) have a compiled JS entry that hardcodes a different
// ID than what openclaw.plugin.json declares.  The Gateway rejects mismatches,
// so we fix them after copying.

const PLUGIN_ID_FIXES = {
  'wecom-openclaw-plugin': 'wecom',
};

/**
 * Patches eventemitter3 CJS entry to add named exports (EventEmitter etc.)
 * so that `require('eventemitter3').EventEmitter` works in Node.js 22+ ESM interop.
 * Scans recursively through nested node_modules.
 */
function patchEsmExports(nodeModulesDir) {
  const { readFileSync, writeFileSync } = require('fs');

  function patchEventEmitter3(pkgDir) {
    try {
      const pkgJsonPath = join(pkgDir, 'package.json');
      if (!existsSync(normWin(pkgJsonPath))) return;
      const pkg = JSON.parse(readFileSync(normWin(pkgJsonPath), 'utf8'));
      const exp = pkg.exports;
      const requireEntry =
        (exp && typeof exp === 'object' && exp['.'] && typeof exp['.'].require === 'string' && exp['.'].require) ||
        (exp && typeof exp === 'object' && typeof exp.require === 'string' && exp.require) ||
        (typeof pkg.main === 'string' && pkg.main) ||
        'index.js';
      const entryPath = join(pkgDir, requireEntry);
      if (!existsSync(normWin(entryPath))) return;
      const original = readFileSync(normWin(entryPath), 'utf8');
      if (original.includes('// ClawX-ee3-patch')) return;
      const patched = original + [
        '',
        '// OpenMe-ee3-patch: ensure named exports for Node.js 22+ CJS/ESM interop',
        'if (typeof module.exports === "function" && !module.exports.EventEmitter) {',
        '  module.exports.EventEmitter = module.exports;',
        '}',
        'if (typeof module.exports === "object" && module.exports !== null && !module.exports.EventEmitter && typeof module.exports.default === "function") {',
        '  module.exports.EventEmitter = module.exports.default;',
        '}',
        '',
      ].join('\n');
      writeFileSync(normWin(entryPath), patched, 'utf8');
      console.log(`[after-pack] 🩹 Patched eventemitter3 CJS named exports at ${entryPath}`);
    } catch (err) {
      console.warn(`[after-pack] ⚠️  Failed to patch eventemitter3 at ${pkgDir}:`, err.message);
    }
  }

  function walkNodeModules(nmDir) {
    let entries;
    try { entries = readdirSync(normWin(nmDir), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pkgDir = join(nmDir, entry.name);
      if (entry.name.startsWith('@')) {
        let scopeEntries;
        try { scopeEntries = readdirSync(normWin(pkgDir), { withFileTypes: true }); } catch { continue; }
        for (const sub of scopeEntries) {
          if (!sub.isDirectory()) continue;
          const subPkgDir = join(pkgDir, sub.name);
          const nestedNM = join(subPkgDir, 'node_modules');
          if (existsSync(normWin(nestedNM))) walkNodeModules(nestedNM);
        }
      } else {
        if (entry.name === 'eventemitter3') {
          patchEventEmitter3(pkgDir);
        }
        const nestedNM = join(pkgDir, 'node_modules');
        if (existsSync(normWin(nestedNM))) walkNodeModules(nestedNM);
      }
    }
  }

  walkNodeModules(nodeModulesDir);
}

function patchPluginIds(pluginDir, expectedId) {
  const { readFileSync, writeFileSync } = require('fs');

  const pkgJsonPath = join(pluginDir, 'package.json');
  if (!existsSync(pkgJsonPath)) return;

  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  const entryFiles = [pkg.main, pkg.module].filter(Boolean);

  for (const entry of entryFiles) {
    const entryPath = join(pluginDir, entry);
    if (!existsSync(entryPath)) continue;

    let content = readFileSync(entryPath, 'utf8');
    let patched = false;

    for (const [wrongId, correctId] of Object.entries(PLUGIN_ID_FIXES)) {
      if (correctId !== expectedId) continue;
      const pattern = new RegExp(`(\\bid\\s*:\\s*)(["'])${wrongId.replace(/-/g, '\\-')}\\2`, 'g');
      const replaced = content.replace(pattern, `$1$2${correctId}$2`);
      if (replaced !== content) {
        content = replaced;
        patched = true;
        console.log(`[after-pack] 🩹 Patching plugin ID in ${entry}: "${wrongId}" → "${correctId}"`);
      }
    }

    if (patched) {
      writeFileSync(entryPath, content, 'utf8');
    }
  }
}

// ── Plugin bundler ───────────────────────────────────────────────────────────
// Bundles a single OpenClaw plugin (and its transitive deps) from node_modules
// directly into the packaged resources directory.  Mirrors the logic in
// bundle-openclaw-plugins.mjs so the packaged app is self-contained even when
// build/openclaw-plugins/ was not pre-generated.

function getVirtualStoreNodeModules(realPkgPath) {
  let dir = realPkgPath;
  while (dir !== dirname(dir)) {
    if (basename(dir) === 'node_modules') return dir;
    dir = dirname(dir);
  }
  return null;
}

function listPkgs(nodeModulesDir) {
  const result = [];
  const nDir = normWin(nodeModulesDir);
  if (!existsSync(nDir)) return result;
  for (const entry of readdirSync(nDir)) {
    if (entry === '.bin') continue;
    // Use original (non-normWin) join for the logical path stored in result.fullPath,
    // so callers can still call getVirtualStoreNodeModules() on it correctly.
    const fullPath = join(nodeModulesDir, entry);
    if (entry.startsWith('@')) {
      let subs;
      try { subs = readdirSync(normWin(fullPath)); } catch { continue; }
      for (const sub of subs) {
        result.push({ name: `${entry}/${sub}`, fullPath: join(fullPath, sub) });
      }
    } else {
      result.push({ name: entry, fullPath });
    }
  }
  return result;
}

function bundlePlugin(nodeModulesRoot, npmName, destDir, sourcePath) {
  const pkgPath = sourcePath || join(nodeModulesRoot, ...npmName.split('/'));
  if (!existsSync(pkgPath)) {
    console.warn(`[after-pack] ⚠️  Plugin package not found: ${pkgPath}. Run pnpm install.`);
    return false;
  }

  let realPluginPath;
  try { realPluginPath = realpathSync(pkgPath); } catch { realPluginPath = pkgPath; }

  // Copy plugin package itself
  if (existsSync(normWin(destDir))) rmSync(normWin(destDir), { recursive: true, force: true });
  mkdirSync(normWin(destDir), { recursive: true });
  cpSync(normWin(realPluginPath), normWin(destDir), { recursive: true, dereference: true });

  // Collect transitive deps via pnpm virtual store BFS
  const collected = new Map();
  const queue = [];

  const rootVirtualNM = getVirtualStoreNodeModules(realPluginPath);
  if (!rootVirtualNM) {
    // sourcePath points to a non-pnpm directory (e.g. dist/extensions/box-im).
    // Fall back: copy direct dependencies declared in package.json from nodeModulesRoot.
    try {
      const pluginPkg = JSON.parse(require('fs').readFileSync(join(destDir, 'package.json'), 'utf8'));
      const directDeps = Object.keys(pluginPkg.dependencies || {});
      if (directDeps.length > 0) {
        const destNM = join(destDir, 'node_modules');
        mkdirSync(destNM, { recursive: true });
        let count = 0;
        for (const dep of directDeps) {
          const srcDep = join(nodeModulesRoot, dep);
          const dstDep = join(destNM, dep);
          if (existsSync(srcDep) && !existsSync(dstDep)) {
            mkdirSync(dirname(dstDep), { recursive: true });
            cpSync(srcDep, dstDep, { recursive: true, dereference: true });
            count++;
          }
        }
        console.log(`[after-pack] ✅ Plugin ${npmName}: copied ${count} direct deps (fallback) to ${destDir}`);
      }
    } catch (e) {
      console.warn(`[after-pack] ⚠️  Could not copy fallback deps for ${npmName}: ${e.message}`);
    }
    return true;
  }
  queue.push({ nodeModulesDir: rootVirtualNM, skipPkg: npmName });

  // Read peerDependencies from the plugin's package.json so we don't bundle
  // packages that are provided by the host environment (e.g. openclaw itself).
  const SKIP_PACKAGES = new Set(['typescript', '@playwright/test', '@shadanai/openclaw']);
  const SKIP_SCOPES = ['@types/'];
  try {
    const pluginPkg = JSON.parse(
      require('fs').readFileSync(join(destDir, 'package.json'), 'utf8')
    );
    for (const peer of Object.keys(pluginPkg.peerDependencies || {})) {
      SKIP_PACKAGES.add(peer);
    }
  } catch { /* ignore */ }

  while (queue.length > 0) {
    const { nodeModulesDir, skipPkg } = queue.shift();
    for (const { name, fullPath } of listPkgs(nodeModulesDir)) {
      if (name === skipPkg) continue;
      if (SKIP_PACKAGES.has(name) || SKIP_SCOPES.some(s => name.startsWith(s))) continue;
      let rp;
      try { rp = realpathSync(fullPath); } catch { continue; }
      if (collected.has(rp)) continue;
      collected.set(rp, name);
      const depVirtualNM = getVirtualStoreNodeModules(rp);
      if (depVirtualNM && depVirtualNM !== nodeModulesDir) {
        queue.push({ nodeModulesDir: depVirtualNM, skipPkg: name });
      }
    }
  }

  // Copy flattened deps into destDir/node_modules
  const destNM = join(destDir, 'node_modules');
  mkdirSync(destNM, { recursive: true });
  const copiedNames = new Set();
  let count = 0;
  for (const [rp, pkgName] of collected) {
    if (copiedNames.has(pkgName)) continue;
    copiedNames.add(pkgName);
    const d = join(destNM, pkgName);
    try {
      mkdirSync(normWin(dirname(d)), { recursive: true });
      cpSync(normWin(rp), normWin(d), { recursive: true, dereference: true });
      count++;
    } catch (e) {
      console.warn(`[after-pack]   Skipped dep ${pkgName}: ${e.message}`);
    }
  }
  console.log(`[after-pack] ✅ Plugin ${npmName}: copied ${count} deps to ${destDir}`);
  return true;
}

// ── Main hook ────────────────────────────────────────────────────────────────

exports.default = async function afterPack(context) {
  const appOutDir = context.appOutDir;
  const platform = context.electronPlatformName; // 'win32' | 'darwin' | 'linux'
  const arch = resolveArch(context.arch);

  console.log(`[after-pack] Target: ${platform}/${arch}`);

  const src = join(__dirname, '..', 'build', 'openclaw', 'node_modules');

  let resourcesDir;
  if (platform === 'darwin') {
    const appName = context.packager.appInfo.productFilename;
    resourcesDir = join(appOutDir, `${appName}.app`, 'Contents', 'Resources');
  } else {
    resourcesDir = join(appOutDir, 'resources');
  }

  const openclawRoot = join(resourcesDir, 'openclaw');
  const dest = join(openclawRoot, 'node_modules');
  const nodeModulesRoot = join(__dirname, '..', 'node_modules');
  const pluginsDestRoot = join(resourcesDir, 'openclaw-plugins');

  if (platform === 'win32') {
    copyWindowsVpnRuntime(resourcesDir, arch);
  }

  if (!existsSync(src)) {
    console.warn('[after-pack] ⚠️  build/openclaw/node_modules not found. Run bundle-openclaw first.');
    return;
  }

  // 1. Copy node_modules (electron-builder skips it due to .gitignore)
  const depCount = readdirSync(src, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== '.bin')
    .length;

  console.log(`[after-pack] Copying ${depCount} openclaw dependencies to ${dest} ...`);
  cpSync(src, dest, { recursive: true });
  console.log('[after-pack] ✅ openclaw node_modules copied.');

  // Patch broken modules whose CJS transpiled output sets module.exports = undefined,
  // causing TypeError in Node.js 22+ ESM interop.
  patchBrokenModules(dest);

  // Also strip ESM "import" conditions from openclaw's top-level node_modules so
  // CJS require() always resolves to the CJS build (fixes eventemitter3 v5, p-queue, etc.)
  patchEsmExports(dest);

  // 1.1 Bundle OpenClaw plugins directly from node_modules into packaged resources.
  //     This is intentionally done in afterPack (not extraResources) because:
  //     - electron-builder silently skips extraResources entries whose source
  //       directory doesn't exist (build/openclaw-plugins/ may not be pre-generated)
  //     - node_modules/ is excluded by .gitignore so the deps copy must be manual
  const BUNDLED_PLUGINS = [
    { npmName: '@soimy/dingtalk', pluginId: 'dingtalk' },
    { npmName: '@wecom/wecom-openclaw-plugin', pluginId: 'wecom' },
    { npmName: '@larksuite/openclaw-lark', pluginId: 'feishu-openclaw-plugin' },
    { npmName: '@tencent-weixin/openclaw-weixin', pluginId: 'openclaw-weixin' },
    {
      npmName: '@openclaw/box-im',
      pluginId: 'box-im',
      // Use the compiled dist/ output, not the raw TypeScript sources under extensions/
      sourcePath: join(__dirname, '..', 'node_modules', '@shadanai', 'openclaw', 'dist', 'extensions', 'box-im'),
    },
  ];

  mkdirSync(pluginsDestRoot, { recursive: true });
  for (const { npmName, pluginId, sourcePath } of BUNDLED_PLUGINS) {
    const pluginDestDir = join(pluginsDestRoot, pluginId);
    console.log(`[after-pack] Bundling plugin ${npmName} -> ${pluginDestDir}`);
    const ok = bundlePlugin(nodeModulesRoot, npmName, pluginDestDir, sourcePath);
    if (ok) {
      const pluginNM = join(pluginDestDir, 'node_modules');
      cleanupUnnecessaryFiles(pluginDestDir);
      if (existsSync(pluginNM)) {
        cleanupKoffi(pluginNM, platform, arch);
        cleanupNativePlatformPackages(pluginNM, platform, arch);
        patchEsmExports(pluginNM);
      }
      // Fix hardcoded plugin ID mismatches in compiled JS
      patchPluginIds(pluginDestDir, pluginId);
    }
  }

  // 1.2 Copy built-in extension node_modules that electron-builder skipped.
  //     OpenClaw 3.31+ ships built-in extensions (discord, qqbot, etc.) under
  //     dist/extensions/<ext>/node_modules/. These are skipped by extraResources
  //     because .gitignore contains "node_modules/".
  //
  //     Extension code is loaded via shared chunks in dist/ (e.g. outbound-*.js)
  //     which resolve modules from the top-level openclaw/node_modules/, NOT from
  //     the extension's own node_modules/. So we must merge extension deps into
  //     the top-level node_modules/ as well.
  const buildExtDir = join(__dirname, '..', 'build', 'openclaw', 'dist', 'extensions');
  const packExtDir = join(openclawRoot, 'dist', 'extensions');
  if (existsSync(buildExtDir)) {
    let extNMCount = 0;
    let mergedPkgCount = 0;
    for (const extEntry of readdirSync(buildExtDir, { withFileTypes: true })) {
      if (!extEntry.isDirectory()) continue;
      const srcNM = join(buildExtDir, extEntry.name, 'node_modules');
      if (!existsSync(srcNM)) continue;

      // Copy to extension's own node_modules (for direct requires from extension code)
      const destExtNM = join(packExtDir, extEntry.name, 'node_modules');
      if (!existsSync(destExtNM)) {
        cpSync(srcNM, destExtNM, { recursive: true });
      }
      extNMCount++;

      // Merge into top-level openclaw/node_modules/ (for shared chunks in dist/)
      for (const pkgEntry of readdirSync(srcNM, { withFileTypes: true })) {
        if (!pkgEntry.isDirectory() || pkgEntry.name === '.bin') continue;
        const srcPkg = join(srcNM, pkgEntry.name);
        const destPkg = join(dest, pkgEntry.name);

        if (pkgEntry.name.startsWith('@')) {
          // Scoped package — iterate sub-entries
          for (const scopeEntry of readdirSync(srcPkg, { withFileTypes: true })) {
            if (!scopeEntry.isDirectory()) continue;
            const srcScoped = join(srcPkg, scopeEntry.name);
            const destScoped = join(destPkg, scopeEntry.name);
            if (!existsSync(destScoped)) {
              mkdirSync(dirname(destScoped), { recursive: true });
              cpSync(srcScoped, destScoped, { recursive: true });
              mergedPkgCount++;
            }
          }
        } else {
          if (!existsSync(destPkg)) {
            cpSync(srcPkg, destPkg, { recursive: true });
            mergedPkgCount++;
          }
        }
      }
    }
    if (extNMCount > 0) {
      console.log(`[after-pack] ✅ Copied node_modules for ${extNMCount} built-in extension(s), merged ${mergedPkgCount} packages into top-level.`);
    }
  }

  // 2. General cleanup on the full openclaw directory (not just node_modules)
  console.log('[after-pack] 🧹 Cleaning up unnecessary files ...');
  const removedRoot = cleanupUnnecessaryFiles(openclawRoot);
  console.log(`[after-pack] ✅ Removed ${removedRoot} unnecessary files/directories.`);

  // 3. Platform-specific: strip koffi non-target platform binaries
  const koffiRemoved = cleanupKoffi(dest, platform, arch);
  if (koffiRemoved > 0) {
    console.log(`[after-pack] ✅ koffi: removed ${koffiRemoved} non-target platform binaries (kept ${platform}_${arch}).`);
  }

  // 4. Platform-specific: strip wrong-platform native packages
  const nativeRemoved = cleanupNativePlatformPackages(dest, platform, arch);
  if (nativeRemoved > 0) {
    console.log(`[after-pack] ✅ Removed ${nativeRemoved} non-target native platform packages.`);
  }

  // 5. Patch lru-cache in app.asar.unpacked
  //
  // Production dependencies (electron-updater → semver → lru-cache@6,
  // posthog-node → proxy agents → lru-cache@7, etc.) end up inside app.asar.
  // Older CJS versions lack the `LRUCache` named export, breaking
  // `import { LRUCache }` in Electron 40+ (Node.js 22+ ESM interop).
  //
  // electron-builder.yml lists `**/node_modules/lru-cache/**` in asarUnpack,
  // which extracts those files to app.asar.unpacked/.  We patch them here so
  // Electron's transparent asar fs layer serves the fixed version at runtime.
  const asarUnpackedDir = join(resourcesDir, 'app.asar.unpacked');
  if (existsSync(asarUnpackedDir)) {
    const { readFileSync: readFS, writeFileSync: writeFS } = require('fs');
    let asarLruCount = 0;
    const lruStack = [asarUnpackedDir];
    while (lruStack.length > 0) {
      const dir = lruStack.pop();
      let entries;
      try { entries = readdirSync(normWin(dir), { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        let isDirectory = entry.isDirectory();
        if (!isDirectory) {
          // pnpm layout may contain symlink/junction directories on Windows.
          try { isDirectory = statSync(normWin(fullPath)).isDirectory(); } catch { isDirectory = false; }
        }
        if (!isDirectory) continue;
        if (entry.name === 'lru-cache') {
          const pkgPath = join(fullPath, 'package.json');
          if (!existsSync(normWin(pkgPath))) { lruStack.push(fullPath); continue; }
          try {
            const pkg = JSON.parse(readFS(normWin(pkgPath), 'utf8'));
            if (pkg.type === 'module') continue; // ESM — already exports LRUCache
            const mainFile = pkg.main || 'index.js';
            const entryFile = join(fullPath, mainFile);
            if (!existsSync(normWin(entryFile))) continue;
            const original = readFS(normWin(entryFile), 'utf8');
            if (!original.includes('exports.LRUCache')) {
              const patched = [
                original,
                '',
                '// OpenMe patch: add LRUCache named export for Node.js 22+ ESM interop',
                'if (typeof module.exports === "function" && !module.exports.LRUCache) {',
                '  module.exports.LRUCache = module.exports;',
                '}',
                '',
              ].join('\n');
              writeFS(normWin(entryFile), patched, 'utf8');
              asarLruCount++;
              console.log(`[after-pack] 🩹 Patched lru-cache CJS (v${pkg.version}) in app.asar.unpacked at ${relative(asarUnpackedDir, fullPath)}`);
            }

            // lru-cache v7 ESM entry exports default only; add named export.
            const moduleFile = typeof pkg.module === 'string' ? pkg.module : null;
            if (moduleFile) {
              const esmEntry = join(fullPath, moduleFile);
              if (existsSync(normWin(esmEntry))) {
                const esmOriginal = readFS(normWin(esmEntry), 'utf8');
                if (
                  esmOriginal.includes('export default LRUCache') &&
                  !esmOriginal.includes('export { LRUCache')
                ) {
                  const esmPatched = [esmOriginal, '', 'export { LRUCache }', ''].join('\n');
                  writeFS(normWin(esmEntry), esmPatched, 'utf8');
                  asarLruCount++;
                  console.log(`[after-pack] 🩹 Patched lru-cache ESM (v${pkg.version}) in app.asar.unpacked at ${relative(asarUnpackedDir, fullPath)}`);
                }
              }
            }
          } catch (err) {
            console.warn(`[after-pack] ⚠️  Failed to patch lru-cache in asar.unpacked at ${fullPath}:`, err.message);
          }
        } else {
          lruStack.push(fullPath);
        }
      }
    }
    if (asarLruCount > 0) {
      console.log(`[after-pack] 🩹 Patched ${asarLruCount} lru-cache instance(s) in app.asar.unpacked`);
    }
  }
  // 6. [Windows only] Patch NSIS installer templates.
  //
  // 6a. Patch installUtil.nsh so uninstallOldVersion does not show the
  // electron-builder Retry/Cancel dialog after the old uninstaller fails.
  // That dialog only re-runs the old uninstaller; it does not re-run our
  // stronger process cleanup / stale-dir move in installer.nsh, so Retry is
  // ineffective on machines with lingering Windows file locks.  We continue
  // with overwrite install instead, which is safe because customCheckAppRunning
  // has already killed install-dir processes and moved the old $INSTDIR aside.
  if (platform === 'win32') {
    const installUtilNsh = join(
      __dirname, '..', 'node_modules', 'app-builder-lib',
      'templates', 'nsis', 'include', 'installUtil.nsh'
    );
    if (existsSync(installUtilNsh)) {
      const { readFileSync: readFS, writeFileSync: writeFS } = require('fs');
      const original = readFS(installUtilNsh, 'utf8');

      if (original.includes('OpenMe-uninstall-retry-patched')) {
        console.log('[after-pack] installUtil.nsh already patched (idempotent skip).');
      } else {
        const retryDialog = [
          '    ${if} $R5 > 5',
          '      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY OneMoreAttempt',
          '      Return',
          '    ${endIf}',
        ].join('\n');
        const retryBypass = [
          '    ${if} $R5 > 5',
          '      DetailPrint "OpenMe-uninstall-retry-patched: old uninstaller failed after retries; continuing with overwrite install."',
          '      Return',
          '    ${endIf}',
        ].join('\n');
        const patched = original.replace(retryDialog, retryBypass);

        if (patched !== original) {
          writeFS(installUtilNsh, patched, 'utf8');
          console.log('[after-pack] Patched installUtil.nsh: old-uninstaller Retry/Cancel dialog bypassed.');
        } else {
          console.warn('[after-pack] installUtil.nsh retry dialog replacement did not match; template may have changed.');
        }
      }
    }
  }

  // 6b. [Windows only] Patch NSIS extractAppPackage.nsh to skip CopyFiles
  //
  // electron-builder's extractUsing7za macro decompresses app-64.7z into a temp
  // directory, then uses CopyFiles to copy ~300MB (thousands of small files) to
  // $INSTDIR.  With Windows Defender real-time scanning each file, CopyFiles
  // alone takes 3-5 minutes and makes the installer appear frozen.
  //
  // Patch: replace the macro with a direct Nsis7z::Extract to $INSTDIR.  This is
  // safe because customCheckAppRunning in installer.nsh already renames the old
  // $INSTDIR to a _stale_ directory, so the target is always an empty dir.
  // The Nsis7z plugin streams LZMA2 data directly to disk — no temp copy needed.
  if (platform === 'win32') {
    const extractNsh = join(
      __dirname, '..', 'node_modules', 'app-builder-lib',
      'templates', 'nsis', 'include', 'extractAppPackage.nsh'
    );
    if (existsSync(extractNsh)) {
      const { readFileSync: readFS, writeFileSync: writeFS } = require('fs');
      const original = readFS(extractNsh, 'utf8');

      // Only patch once (idempotent check)
      if (original.includes('OpenMe-patched')) {
        console.log('[after-pack] extractAppPackage.nsh already patched (idempotent skip).');
      } else if (original.includes('CopyFiles')) {
        // Replace the macro body so both old and new app-builder-lib templates
        // skip the temp-folder CopyFiles stage entirely.
        const replacement = [
          '!macro extractUsing7za FILE',
          '  ; OpenMe-patched: extract directly to $OUTDIR and skip CopyFiles.',
          '  ; customCheckAppRunning already moved the old install directory aside,',
          '  ; so direct extraction avoids the slow temp-copy path under Defender.',
          '  Push $OUTDIR',
          '  ClearErrors',
          '  Nsis7z::Extract "${FILE}"',
          '  Pop $R0',
          '  SetOutPath $R0',
          '!macroend',
        ].join('\n');
        const patched = original.replace(/!macro extractUsing7za FILE[\s\S]*?!macroend/, replacement);

        if (patched !== original) {
          writeFS(extractNsh, patched, 'utf8');
          console.log('[after-pack] Patched extractAppPackage.nsh: CopyFiles eliminated, using direct Nsis7z::Extract.');
        } else {
          console.warn('[after-pack] extractAppPackage.nsh macro replacement did not match; template may have changed.');
        }
      }
    }
  }
};
