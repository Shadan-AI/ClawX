/**
 * Root Application Component
 * Handles routing and global providers
 */
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { Component, useEffect, useRef, useState, useCallback } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Toaster } from 'sonner';
import i18n from './i18n';
import { MainLayout } from './components/layout/MainLayout';
import { ContextMenu } from './components/common/ContextMenu';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Models } from './pages/Models';
import { Chat } from './pages/Chat';
import { Agents } from './pages/Agents';
import { Channels } from './pages/Channels';
import { Skills } from './pages/Skills';
import { Cron } from './pages/Cron';
import { Settings } from './pages/Settings';
import { Setup } from './pages/Setup';
import { BoxImGate } from './pages/BoxImGate';
import { useSettingsStore } from './stores/settings';
import { useGatewayStore } from './stores/gateway';
import { useProviderStore } from './stores/providers';
import { applyGatewayTransportPreference, invokeIpc } from './lib/api-client';


/**
 * Error Boundary to catch and display React rendering errors
 */
class ErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('React Error Boundary caught error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: '40px',
          color: '#f87171',
          background: '#0f172a',
          minHeight: '100vh',
          fontFamily: 'monospace'
        }}>
          <h1 style={{ fontSize: '24px', marginBottom: '16px' }}>Something went wrong</h1>
          <pre style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            background: '#1e293b',
            padding: '16px',
            borderRadius: '8px',
            fontSize: '14px'
          }}>
            {this.state.error?.message}
            {'\n\n'}
            {this.state.error?.stack}
          </pre>
          <button
            onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }}
            style={{
              marginTop: '16px',
              padding: '8px 16px',
              background: '#3b82f6',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer'
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const skipSetupForE2E = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('e2eSkipSetup') === '1';
  const initSettings = useSettingsStore((state) => state.init);
  const theme = useSettingsStore((state) => state.theme);
  const language = useSettingsStore((state) => state.language);
  const setupComplete = useSettingsStore((state) => state.setupComplete);
  const initGateway = useGatewayStore((state) => state.init);
  const initProviders = useProviderStore((state) => state.init);
  const gatewayStatus = useGatewayStore((state) => state.status);
  // null = not yet checked, true/false = result
  const [isLoggedIn, setIsLoggedIn] = useState<boolean | null>(null);
  const checkIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const checkLoginStatus = useCallback(async () => {
    try {
      const tokenKey = await invokeIpc<string | null>('box-im:getTokenKey');
      setIsLoggedIn(!!tokenKey);
    } catch {
      setIsLoggedIn(false);
    }
  }, []);

  useEffect(() => {
    initSettings();
  }, [initSettings]);

  // Sync i18n language with persisted settings on mount
  useEffect(() => {
    if (language && language !== i18n.language) {
      i18n.changeLanguage(language);
    }
  }, [language]);

  // Initialize Gateway connection on mount
  useEffect(() => {
    initGateway();
  }, [initGateway]);

  // Initialize provider snapshot on mount
  useEffect(() => {
    initProviders();
  }, [initProviders]);

  // Check login status immediately on mount (reads openclaw.json, no gateway needed)
  useEffect(() => {
    void checkLoginStatus();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-check when gateway comes online (token may have been written during login flow)
  useEffect(() => {
    if (gatewayStatus.state !== 'running') return;
    void checkLoginStatus();
  }, [gatewayStatus.state, checkLoginStatus]);

  // Periodic login check while gateway is running
  useEffect(() => {
    if (gatewayStatus.state !== 'running') {
      if (checkIntervalRef.current) {
        clearInterval(checkIntervalRef.current);
        checkIntervalRef.current = null;
      }
      return;
    }
    checkIntervalRef.current = setInterval(() => {
      void checkLoginStatus();
    }, 5000);
    return () => {
      if (checkIntervalRef.current) {
        clearInterval(checkIntervalRef.current);
        checkIntervalRef.current = null;
      }
    };
  }, [gatewayStatus.state, checkLoginStatus]);

  // Route guard — only runs after login check completes (isLoggedIn !== null)
  useEffect(() => {
    const path = location.pathname;
    if (path.startsWith('/setup') || path === '/box-im-gate') return;

    // Still waiting for the initial IPC check — don't redirect yet
    if (isLoggedIn === null) return;

    if (isLoggedIn === false) {
      navigate('/box-im-gate', { replace: true });
      return;
    }

    if (!setupComplete && !skipSetupForE2E) {
      navigate('/setup', { replace: true });
      return;
    }
  }, [setupComplete, isLoggedIn, skipSetupForE2E, location.pathname, navigate]);

  // Listen for navigation events from main process
  useEffect(() => {
    const handleNavigate = (...args: unknown[]) => {
      const path = args[0];
      if (typeof path === 'string') {
        navigate(path);
      }
    };

    const unsubscribe = window.electron.ipcRenderer.on('navigate', handleNavigate);

    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [navigate]);

  // Apply theme
  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark');

    if (theme === 'system') {
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
      root.classList.add(systemTheme);
    } else {
      root.classList.add(theme);
    }
  }, [theme]);

  useEffect(() => {
    applyGatewayTransportPreference();
  }, []);

  return (
    <ErrorBoundary>
      <TooltipProvider delayDuration={300}>
        <Routes>
          {/* box-im plugin login gate (before setup) */}
          <Route path="/box-im-gate" element={<BoxImGate />} />
          {/* Setup wizard (shown on first launch) */}
          <Route path="/setup/*" element={<Setup />} />

          {/* Main application routes */}
          <Route element={<MainLayout />}>
            <Route path="/" element={<Chat />} />
            <Route path="/models" element={<Models />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/channels" element={<Channels />} />
            <Route path="/skills" element={<Skills />} />
            <Route path="/cron" element={<Cron />} />
            <Route path="/settings/*" element={<Settings />} />
          </Route>
        </Routes>

        {/* Global toast notifications */}
        <Toaster
          position="bottom-right"
          richColors
          closeButton
          style={{ zIndex: 99999 }}
        />

        {/* Global context menu */}
        <ContextMenu />
      </TooltipProvider>
    </ErrorBoundary>
  );
}

export default App;
