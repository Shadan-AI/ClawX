import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import { resolve } from 'path';

function isMainProcessExternal(id: string): boolean {
  if (!id || id.startsWith('\0')) return false;
  if (id.startsWith('.') || id.startsWith('/') || /^[A-Za-z]:[\\/]/.test(id)) return false;
  if (id.startsWith('@/') || id.startsWith('@electron/')) return false;
  return true;
}

// Banner injected at the top of the main process bundle to ensure
// openclaw subpath imports (e.g. openclaw/plugin-sdk/minimax-portal-auth)
// resolve correctly in packaged builds where openclaw lives in
// process.resourcesPath instead of node_modules.
const mainProcessBanner = `
if (typeof process !== 'undefined' && process.resourcesPath) {
  try {
    var _Module = require('module');
    var _path = require('path');
    var _openclawDir = _path.join(process.resourcesPath, 'openclaw');
    if (require('fs').existsSync(_openclawDir)) {
      var _prevPaths = _Module.globalPaths || [];
      var _nmPath = _path.join(_openclawDir, 'node_modules');
      if (_prevPaths.indexOf(_openclawDir) === -1) _Module.globalPaths.unshift(_openclawDir);
      if (_prevPaths.indexOf(_nmPath) === -1) _Module.globalPaths.unshift(_nmPath);
      // Also register openclaw itself so require('openclaw/...') resolves
      var _parentNM = _path.dirname(_openclawDir);
      if (_prevPaths.indexOf(_parentNM) === -1) _Module.globalPaths.unshift(_parentNM);
    }
  } catch(e) {}
}
`;

// https://vitejs.dev/config/
export default defineConfig({
  // Required for Electron: all asset URLs must be relative because the renderer
  // loads via file:// in production. vite-plugin-electron-renderer sets this
  // automatically, but we declare it explicitly so the intent is clear and the
  // build remains correct even if plugin order ever changes.
  base: './',
  plugins: [
    react(),
    electron([
      {
        // Main process entry file
        entry: 'electron/main/index.ts',
        onstart(options) {
          options.startup();
        },
        vite: {
          build: {
            outDir: 'dist-electron/main',
            rollupOptions: {
              external: isMainProcessExternal,
              output: {
                banner: mainProcessBanner,
              },
            },
          },
        },
      },
      {
        // Preload scripts entry file
        entry: 'electron/preload/index.ts',
        onstart(options) {
          options.reload();
        },
        vite: {
          build: {
            outDir: 'dist-electron/preload',
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
    ]),
    renderer(),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@electron': resolve(__dirname, 'electron'),
    },
  },
  server: {
    port: 5173,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
