/**
 * Electron Main Process Entry
 * Manages window creation, system tray, and IPC handlers
 */
import { app, BrowserWindow, ipcMain, nativeImage, session, shell } from 'electron';
import type { Server } from 'node:http';
import { join } from 'path';
import { GatewayManager } from '../gateway/manager';
import { registerIpcHandlers } from './ipc-handlers';
import { createTray } from './tray';
import { createMenu } from './menu';

import { appUpdater, registerUpdateHandlers } from './updater';
import { logger } from '../utils/logger';
import { warmupNetworkOptimization } from '../utils/uv-env';
import { initTelemetry } from '../utils/telemetry';

import { ClawHubService } from '../gateway/clawhub';
import { ensureClawXContext, repairClawXOnlyBootstrapFiles } from '../utils/openclaw-workspace';
import { autoInstallCliIfNeeded, generateCompletionCache, installCompletionToProfile } from '../utils/openclaw-cli';
import { isQuitting, setQuitting } from './app-state';
import { applyProxySettings } from './proxy';
import { syncLaunchAtStartupSettingFromStore } from './launch-at-startup';
import {
  clearPendingSecondInstanceFocus,
  consumeMainWindowReady,
  createMainWindowFocusState,
  requestSecondInstanceFocus,
} from './main-window-focus';
import {
  createQuitLifecycleState,
  markQuitCleanupCompleted,
  requestQuitLifecycleAction,
} from './quit-lifecycle';
import { createSignalQuitHandler } from './signal-quit';
import { acquireProcessInstanceFileLock } from './process-instance-lock';
import { getSetting, setSetting } from '../utils/store';
import { ensureBuiltinSkillsInstalled, ensurePreinstalledSkillsInstalled } from '../utils/skill-config';
import { ensureCriticalPluginsInstalled, ensureDeferredPluginsInstalled } from '../utils/plugin-install';
import { startHostApiServer } from '../api/server';
import { HostEventBus } from '../api/event-bus';
import { deviceOAuthManager } from '../utils/device-oauth';
import { browserOAuthManager } from '../utils/browser-oauth';
import { whatsAppLoginManager } from '../utils/whatsapp-login';
import { syncAllProviderAuthToRuntime } from '../services/providers/provider-runtime-sync';
import { ensureOpenClawMkcertCertsWindows } from '../utils/mkcert-certs';

const WINDOWS_APP_USER_MODEL_ID = 'app.clawx.desktop';

// Disable GPU hardware acceleration globally for maximum stability across
// all GPU configurations (no GPU, integrated, discrete).
//
// Rationale (following VS Code's philosophy):
// - Page/file loading is async data fetching — zero GPU dependency.
// - The original per-platform GPU branching was added to avoid CPU rendering
//   competing with sync I/O on Windows, but all file I/O is now async
//   (fs/promises), so that concern no longer applies.
// - Software rendering is deterministic across all hardware; GPU compositing
//   behaviour varies between vendors (Intel, AMD, NVIDIA, Apple Silicon) and
//   driver versions, making it the #1 source of rendering bugs in Electron.
//
// Users who want GPU acceleration can pass `--enable-gpu` on the CLI or
// set `"disable-hardware-acceleration": false` in the app config (future).
app.disableHardwareAcceleration();

// On Linux, set CHROME_DESKTOP so Chromium can find the correct .desktop file.
// On Wayland this maps the running window to clawx.desktop (→ icon + app grouping);
// on X11 it supplements the StartupWMClass matching.
// Must be called before app.whenReady() / before any window is created.
if (process.platform === 'linux') {
  app.setDesktopName('clawx.desktop');
}

// Prevent multiple instances of the app from running simultaneously.
// Without this, two instances each spawn their own gateway process on the
// same port, then each treats the other's gateway as "orphaned" and kills
// it — creating an infinite kill/restart loop on Windows.
// The losing process must exit immediately so it never reaches Gateway startup.
const gotElectronLock = app.requestSingleInstanceLock();
if (!gotElectronLock) {
  console.info('[ClawX] Another instance already holds the single-instance lock; exiting duplicate process');
  app.exit(0);
}
let releaseProcessInstanceFileLock: () => void = () => {};
let gotFileLock = true;
if (gotElectronLock) {
  try {
    const fileLock = acquireProcessInstanceFileLock({
      userDataDir: app.getPath('userData'),
      lockName: 'clawx',
    });
    gotFileLock = fileLock.acquired;
    releaseProcessInstanceFileLock = fileLock.release;
    if (!fileLock.acquired) {
      const ownerDescriptor = fileLock.ownerPid
        ? `${fileLock.ownerFormat ?? 'legacy'} pid=${fileLock.ownerPid}`
        : fileLock.ownerFormat === 'unknown'
          ? 'unknown lock format/content'
          : 'unknown owner';
      console.info(
        `[ClawX] Another instance already holds process lock (${fileLock.lockPath}, ${ownerDescriptor}); exiting duplicate process`,
      );
      app.exit(0);
    }
  } catch (error) {
    console.warn('[ClawX] Failed to acquire process instance file lock; continuing with Electron single-instance lock only', error);
  }
}
const gotTheLock = gotElectronLock && gotFileLock;

// Global references
let mainWindow: BrowserWindow | null = null;
let gatewayManager!: GatewayManager;
let clawHubService!: ClawHubService;
let hostEventBus!: HostEventBus;
let hostApiServer: Server | null = null;
const mainWindowFocusState = createMainWindowFocusState();
const quitLifecycleState = createQuitLifecycleState();

/**
 * Resolve the icons directory path (works in both dev and packaged mode)
 */
function getIconsDir(): string {
  if (app.isPackaged) {
    // Packaged: icons are in extraResources → process.resourcesPath/resources/icons
    return join(process.resourcesPath, 'resources', 'icons');
  }
  // Development: relative to dist-electron/main/
  return join(__dirname, '../../resources/icons');
}

/**
 * Get the app icon for the current platform
 */
function getAppIcon(): Electron.NativeImage | undefined {
  if (process.platform === 'darwin') return undefined; // macOS uses the app bundle icon

  const iconsDir = getIconsDir();
  const iconPath =
    process.platform === 'win32'
      ? join(iconsDir, 'icon.ico')
      : join(iconsDir, 'icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  return icon.isEmpty() ? undefined : icon;
}

/**
 * Create the main application window
 */
function createWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin';
  const isWindows = process.platform === 'win32';
  const useCustomTitleBar = isWindows;
  /** Vite dev server URL is set by vite-plugin-electron — only then are we in `pnpm dev`. */
  const isViteDev = Boolean(process.env.VITE_DEV_SERVER_URL);

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    icon: getAppIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webviewTag: true, // Enable <webview> for embedding OpenClaw Control UI
    },
    titleBarStyle: isMac ? 'hiddenInset' : useCustomTitleBar ? 'hidden' : 'default',
    trafficLightPosition: isMac ? { x: 16, y: 16 } : undefined,
    frame: isMac || !useCustomTitleBar,
    // Dev: show immediately so a missing/flaky ready-to-show does not leave no visible window (Windows).
    // Prod: keep false until ready-to-show to avoid a blank flash before first paint.
    show: isViteDev,
  });

  // Handle external links — only allow safe protocols to prevent arbitrary
  // command execution via shell.openExternal() (e.g. file://, ms-msdt:, etc.)
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        shell.openExternal(url);
      } else {
        logger.warn(`Blocked openExternal for disallowed protocol: ${parsed.protocol}`);
      }
    } catch {
      logger.warn(`Blocked openExternal for malformed URL: ${url}`);
    }
    return { action: 'deny' };
  });

  // Load the app
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools();
    // Bring dev window above the terminal on Windows (best-effort).
    win.webContents.once('did-finish-load', () => {
      if (win.isDestroyed()) return;
      try {
        win.focus();
      } catch {
        /* ignore */
      }
    });
  } else {
    win.loadFile(join(__dirname, '../../dist/index.html'));
  }

  return win;
}

function focusWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) {
    return;
  }

  if (win.isMinimized()) {
    win.restore();
  }

  win.show();
  win.focus();
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  clearPendingSecondInstanceFocus(mainWindowFocusState);
  focusWindow(mainWindow);
}

function createMainWindow(): BrowserWindow {
  const win = createWindow();

  win.once('ready-to-show', () => {
    if (mainWindow !== win) {
      return;
    }

    const action = consumeMainWindowReady(mainWindowFocusState);
    if (action === 'focus') {
      focusWindow(win);
      return;
    }

    win.show();
  });

  win.on('close', (event) => {
    if (!isQuitting()) {
      event.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  mainWindow = win;
  return win;
}

/**
 * Initialize the application
 */
async function initialize(): Promise<void> {
  // Initialize logger first
  logger.init();
  logger.info('=== ClawX Application Starting ===');
  logger.debug(
    `Runtime: platform=${process.platform}/${process.arch}, electron=${process.versions.electron}, node=${process.versions.node}, packaged=${app.isPackaged}, pid=${process.pid}, ppid=${process.ppid}`
  );

  // Warm up network optimization (non-blocking)
  void warmupNetworkOptimization();

  // Initialize Telemetry early
  await initTelemetry();

  // Apply persisted proxy settings before creating windows or network requests.
  await applyProxySettings();
  await syncLaunchAtStartupSettingFromStore();

  // Set application menu
  createMenu();
  logger.debug('[init] createMenu done');

  // Create the main window
  const window = createMainWindow();
  logger.debug('[init] createMainWindow done');

  // Detect first launch: check persistent store flag (not .openclaw dir existence,
  // which may already exist from a previous install or dev run).
  // CLAWX_FORCE_FIRST_LAUNCH=1 overrides for dev testing.
  const firstLaunchComplete = await getSetting('firstLaunchComplete');
  const isFirstLaunch = (!app.isPackaged && process.env.CLAWX_FORCE_FIRST_LAUNCH === '1')
    ? true
    : !firstLaunchComplete;

  // Buffer for progress events that arrive before renderer is ready
  const progressBuffer: Array<{ total: number; current: number; label: string }> = [];
  let rendererReady = false;

  if (isFirstLaunch) {
    progressBuffer.push({ total: 6, current: 0, label: '正在初始化 .openclaw 目录...' });
  }

  // Always register the handler (renderer may call before did-finish-load)
  let initDone = false;
  ipcMain.handle('init:getProgress', () => {
    rendererReady = true;
    // Once init is complete, always return false so re-mounts don't re-trigger /init
    if (initDone) return { isFirstLaunch: false, events: [] };
    return { isFirstLaunch, events: [...progressBuffer] };
  });

  /** Helper: send progress event to renderer, buffering if not yet ready */
  function sendProgress(current: number, total: number, label: string): void {
    if (!isFirstLaunch) return;
    const ev = { total, current, label };
    progressBuffer.push(ev);
    if (rendererReady && !window.isDestroyed()) {
      window.webContents.send('init:progress', ev);
    }
  }

  // Create system tray
  createTray(window);

  // Override security headers ONLY for the OpenClaw Gateway Control UI.
  // The URL filter ensures this callback only fires for gateway requests,
  // avoiding unnecessary overhead on every other HTTP response.
  session.defaultSession.webRequest.onHeadersReceived(
    {
      urls: [
        'http://127.0.0.1:18789/*',
        'http://localhost:18789/*',
        'https://127.0.0.1:18789/*',
        'https://localhost:18789/*',
      ],
    },
    (details, callback) => {
      const headers = { ...details.responseHeaders };
      delete headers['X-Frame-Options'];
      delete headers['x-frame-options'];
      if (headers['Content-Security-Policy']) {
        headers['Content-Security-Policy'] = headers['Content-Security-Policy'].map(
          (csp) => csp.replace(/frame-ancestors\s+'none'/g, "frame-ancestors 'self' *")
        );
      }
      if (headers['content-security-policy']) {
        headers['content-security-policy'] = headers['content-security-policy'].map(
          (csp) => csp.replace(/frame-ancestors\s+'none'/g, "frame-ancestors 'self' *")
        );
      }
      callback({ responseHeaders: headers });
    },
  );

  // Register IPC handlers
  registerIpcHandlers(gatewayManager, clawHubService, window);
  logger.debug('[init] registerIpcHandlers done');

  hostApiServer = startHostApiServer({
    gatewayManager,
    clawHubService,
    eventBus: hostEventBus,
    mainWindow: window,
  });
  logger.debug('[init] startHostApiServer done');

  // Register update handlers
  registerUpdateHandlers(appUpdater, window);
  logger.debug('[init] registerUpdateHandlers done');

  // Note: Auto-check for updates is driven by the renderer (update store init)
  // so it respects the user's "Auto-check for updates" setting.

  // Repair any bootstrap files that only contain ClawX markers (no OpenClaw
  // template content). This fixes a race condition where ensureClawXContext()
  // previously created the file before the gateway could seed the full template.
  void repairClawXOnlyBootstrapFiles().catch((error) => {
    logger.warn('Failed to repair bootstrap files:', error);
  });

  // Bridge gateway and host-side events before any auto-start logic runs, so
  // renderer subscribers observe the full startup lifecycle.
  gatewayManager.on('status', (status: { state: string }) => {
    hostEventBus.emit('gateway:status', status);
    if (status.state === 'running') {
      void ensureClawXContext().catch((error) => {
        logger.warn('Failed to re-merge ClawX context after gateway reconnect:', error);
      });
    }
  });

  gatewayManager.on('error', (error) => {
    hostEventBus.emit('gateway:error', { message: error.message });
  });

  gatewayManager.on('notification', (notification) => {
    hostEventBus.emit('gateway:notification', notification);
  });

  gatewayManager.on('chat:message', (data) => {
    hostEventBus.emit('gateway:chat-message', data);
  });

  gatewayManager.on('channel:status', (data) => {
    hostEventBus.emit('gateway:channel-status', data);
  });

  gatewayManager.on('exit', (code) => {
    hostEventBus.emit('gateway:exit', { code });
  });

  deviceOAuthManager.on('oauth:code', (payload) => {
    hostEventBus.emit('oauth:code', payload);
  });

  deviceOAuthManager.on('oauth:start', (payload) => {
    hostEventBus.emit('oauth:start', payload);
  });

  deviceOAuthManager.on('oauth:success', (payload) => {
    hostEventBus.emit('oauth:success', { ...payload, success: true });
  });

  deviceOAuthManager.on('oauth:error', (error) => {
    hostEventBus.emit('oauth:error', error);
  });

  browserOAuthManager.on('oauth:start', (payload) => {
    hostEventBus.emit('oauth:start', payload);
  });

  browserOAuthManager.on('oauth:code', (payload) => {
    hostEventBus.emit('oauth:code', payload);
  });

  browserOAuthManager.on('oauth:success', (payload) => {
    hostEventBus.emit('oauth:success', { ...payload, success: true });
  });

  browserOAuthManager.on('oauth:error', (error) => {
    hostEventBus.emit('oauth:error', error);
  });

  whatsAppLoginManager.on('qr', (data) => {
    hostEventBus.emit('channel:whatsapp-qr', data);
  });

  whatsAppLoginManager.on('success', (data) => {
    hostEventBus.emit('channel:whatsapp-success', data);
  });

  whatsAppLoginManager.on('error', (error) => {
    hostEventBus.emit('channel:whatsapp-error', error);
  });

  // Start Gateway and all background init tasks AFTER renderer has loaded,
  // so the window is responsive and can show the progress screen first.
  const runBackgroundInit = async () => {
    logger.debug('[init] runBackgroundInit started');

    // Windows: trusted HTTPS certs for LAN (openme mkcert) → ~/.openclaw/certs before Gateway TLS
    if (process.platform === 'win32') {
      try {
        const mk = await ensureOpenClawMkcertCertsWindows();
        if (mk.ok && !mk.skipped) {
          logger.info(`[mkcert] Gateway TLS files ready under ${mk.certDir}`);
        } else if (mk.skipped) {
          logger.debug(`[mkcert] skipped: ${mk.reason ?? 'unknown'}`);
        } else if (mk.error) {
          logger.warn(`[mkcert] ${mk.error}`);
        }
      } catch (e) {
        logger.warn('[mkcert] ensure certs failed:', e);
      }
    }

    // Repair bootstrap files
    void repairClawXOnlyBootstrapFiles().catch((error) => {
      logger.warn('Failed to repair bootstrap files:', error);
    });

    // Skills and plugins must finish BEFORE gateway starts, because
    // openclaw.json references plugin manifests that must exist on disk.
    sendProgress(2, 6, '正在安装内置技能到 ~/.openclaw/skills/...');
    await ensureBuiltinSkillsInstalled().catch((error) => {
      logger.warn('Failed to install built-in skills:', error);
    });

    sendProgress(3, 6, '正在安装预置技能到 ~/.openclaw/skills/...');
    await ensurePreinstalledSkillsInstalled().catch((error) => {
      logger.warn('Failed to install preinstalled skills:', error);
    });

    sendProgress(4, 6, '正在安装插件到 ~/.openclaw/extensions/...');
    await ensureCriticalPluginsInstalled().catch((error) => {
      logger.warn('Failed to install critical plugins:', error);
    });

    const gatewayAutoStart = await getSetting('gatewayAutoStart');
    if (gatewayAutoStart) {
      try {
        sendProgress(1, 6, '正在启动 OpenClaw Gateway，生成 ~/.openclaw/workspace/...');
        await syncAllProviderAuthToRuntime();
        logger.debug('Auto-starting Gateway...');
        await gatewayManager.start();
        logger.info('Gateway auto-start succeeded');
      } catch (error) {
        logger.error('Gateway auto-start failed:', error);
        mainWindow?.webContents.send('gateway:error', String(error));
      }
    } else {
      logger.info('Gateway auto-start disabled in settings');
    }

    // Feishu is large (~700MB), install after gateway is running
    void ensureDeferredPluginsInstalled().catch((error) => {
      logger.warn('Failed to install deferred plugins:', error);
    });

    void ensureClawXContext().then(() => {
      sendProgress(5, 6, '正在合并 ClawX 上下文到 ~/.openclaw/workspace/...');
    }).catch((error) => {
      logger.warn('Failed to merge ClawX context into workspace:', error);
    });

    const signalComplete = () => {
      initDone = true;
      // Mark first launch as complete so subsequent starts skip the init screen
      void setSetting('firstLaunchComplete', true).catch(() => {});
      if (!isFirstLaunch || window.isDestroyed()) return;
      if (rendererReady) {
        window.webContents.send('init:complete', {});
      } else {
        window.webContents.once('did-finish-load', () => {
          setTimeout(() => window.webContents.send('init:complete', {}), 300);
        });
      }
    };

    // CLI install runs in background; completion is gated on gateway running
    void autoInstallCliIfNeeded((installedPath) => {
      mainWindow?.webContents.send('openclaw:cli-installed', installedPath);
    }).then(() => {
      sendProgress(6, 6, '正在安装 openclaw CLI...');
      generateCompletionCache();
      installCompletionToProfile();
    }).catch((error) => {
      logger.warn('CLI auto-install failed:', error);
    });

    // Signal complete only when gateway is running AND box-im plugin HTTP endpoint is ready
    if (isFirstLaunch) {
      sendProgress(6, 6, '正在等待 Gateway 与 box-im 就绪...');

      const checkBoxImReady = (port: number): Promise<boolean> => {
        return new Promise((resolve) => {
          try {
            const https = require('node:https') as typeof import('https');
            const req = https.get(
              `https://127.0.0.1:${port}/plugins/box-im/login`,
              { rejectUnauthorized: false, timeout: 2000 },
              (resp) => { resolve(resp.statusCode === 200); resp.resume(); },
            );
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
          } catch {
            resolve(false);
          }
        });
      };

      const waitForBoxImReady = async () => {
        const port = gatewayManager.getStatus().port || 18789;
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          const ok = await checkBoxImReady(port);
          if (ok) {
            signalComplete();
            return;
          }
          await new Promise<void>((r) => setTimeout(r, 500));
        }
        // Timeout — complete anyway, BoxImGate will poll box-im itself
        signalComplete();
      };

      const gatewayStatus = gatewayManager.getStatus();
      if (gatewayStatus.state === 'running') {
        void waitForBoxImReady();
      } else {
        const onStatus = (status: { state: string }) => {
          if (status.state === 'running') {
            gatewayManager.off('status', onStatus);
            void waitForBoxImReady();
          } else if (status.state === 'error' || status.state === 'stopped') {
            gatewayManager.off('status', onStatus);
            signalComplete();
          }
        };
        gatewayManager.on('status', onStatus);
        // Safety timeout
        setTimeout(() => {
          gatewayManager.off('status', onStatus);
          signalComplete();
        }, 60000);
      }
    }
  };

  // Wait for renderer to finish loading before starting heavy background work.
  const scheduleBackgroundInit = () => {
    if (window.webContents.isLoading()) {
      // Listen for both dom-ready and did-finish-load — whichever fires first
      let started = false;
      const start = () => {
        if (started) return;
        started = true;
        logger.debug('[init] renderer ready, starting background init');
        void runBackgroundInit();
      };
      window.webContents.once('dom-ready', start);
      window.webContents.once('did-finish-load', start);
    } else {
      logger.debug('[init] renderer already loaded, starting background init');
      void runBackgroundInit();
    }
  };

  // Yield event loop first so renderer can start loading
  setTimeout(scheduleBackgroundInit, 0);
}

if (gotTheLock) {
  const requestQuitOnSignal = createSignalQuitHandler({
    logInfo: (message) => logger.info(message),
    requestQuit: () => app.quit(),
  });

  process.on('exit', () => {
    releaseProcessInstanceFileLock();
  });

  process.once('SIGINT', () => requestQuitOnSignal('SIGINT'));
  process.once('SIGTERM', () => requestQuitOnSignal('SIGTERM'));

  app.on('will-quit', () => {
    releaseProcessInstanceFileLock();
  });

  if (process.platform === 'win32') {
    app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
  }

  gatewayManager = new GatewayManager();
  clawHubService = new ClawHubService();
  hostEventBus = new HostEventBus();

  // When a second instance is launched, focus the existing window instead.
  app.on('second-instance', () => {
    logger.info('Second ClawX instance detected; redirecting to the existing window');

    const focusRequest = requestSecondInstanceFocus(
      mainWindowFocusState,
      Boolean(mainWindow && !mainWindow.isDestroyed()),
    );

    if (focusRequest === 'focus-now') {
      focusMainWindow();
      return;
    }

    logger.debug('Main window is not ready yet; deferring second-instance focus until ready-to-show');
  });

  // Allow self-signed TLS certs for localhost gateway (mkcert-generated)
  app.on('certificate-error', (event, _webContents, url, _error, _cert, callback) => {
    if (url.startsWith('https://127.0.0.1:') || url.startsWith('https://localhost:')) {
      event.preventDefault();
      callback(true);
    } else {
      callback(false);
    }
  });

  // Application lifecycle
  app.whenReady().then(() => {
    void initialize().catch((error) => {
      logger.error('Application initialization failed:', error);
    });

    // Register activate handler AFTER app is ready to prevent
    // "Cannot create BrowserWindow before app is ready" on macOS.
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      } else {
        focusMainWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', (event) => {
    setQuitting();
    const action = requestQuitLifecycleAction(quitLifecycleState);

    if (action === 'allow-quit') {
      return;
    }

    event.preventDefault();

    if (action === 'cleanup-in-progress') {
      logger.debug('Quit requested while cleanup already in progress; waiting for shutdown task to finish');
      return;
    }

    hostEventBus.closeAll();
    hostApiServer?.close();

    const stopPromise = gatewayManager.stop().catch((err) => {
      logger.warn('gatewayManager.stop() error during quit:', err);
    });
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), 5000);
    });

    void Promise.race([stopPromise.then(() => 'stopped' as const), timeoutPromise]).then((result) => {
      if (result === 'timeout') {
        logger.warn('Gateway shutdown timed out during app quit; proceeding with forced quit');
        void gatewayManager.forceTerminateOwnedProcessForQuit().then((terminated) => {
          if (terminated) {
            logger.warn('Forced gateway process termination completed after quit timeout');
          }
        }).catch((err) => {
          logger.warn('Forced gateway termination failed after quit timeout:', err);
        });
      }
      markQuitCleanupCompleted(quitLifecycleState);
      app.quit();
    });
  });

  // Best-effort Gateway cleanup on unexpected crashes.
  // These handlers attempt to terminate the Gateway child process within a
  // short timeout before force-exiting, preventing orphaned processes.
  const emergencyGatewayCleanup = (reason: string, error: unknown): void => {
    logger.error(`${reason}:`, error);
    try {
      void gatewayManager?.stop().catch(() => { /* ignore */ });
    } catch {
      // ignore — stop() may not be callable if state is corrupted
    }
    // Give Gateway stop a brief window, then force-exit.
    setTimeout(() => {
      process.exit(1);
    }, 3000).unref();
  };

  process.on('uncaughtException', (error) => {
    emergencyGatewayCleanup('Uncaught exception in main process', error);
  });

  process.on('unhandledRejection', (reason) => {
    emergencyGatewayCleanup('Unhandled promise rejection in main process', reason);
  });
}

// Export for testing
export { mainWindow, gatewayManager };
