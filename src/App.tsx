/**
 * Root Application Component
 * Handles routing and global providers
 */
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { Component, useEffect, useRef } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Toaster } from 'sonner';
import { ContextMenu } from '@/components/common/ContextMenu';
import i18n from './i18n';
import { MainLayout } from './components/layout/MainLayout';
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
import { Datasources } from './pages/Datasources';
import { useSettingsStore } from './stores/settings';
import { useGatewayStore } from './stores/gateway';
import { useProviderStore } from './stores/providers';
import { useModelsStore } from './stores/models';
import { applyGatewayTransportPreference } from './lib/api-client';


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

const LOGIN_CHECK_INTERVAL = 5000;

function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const initSettings = useSettingsStore((state) => state.init);
  const theme = useSettingsStore((state) => state.theme);
  const language = useSettingsStore((state) => state.language);
  const setupComplete = useSettingsStore((state) => state.setupComplete);
  const boxImGateComplete = useSettingsStore((state) => state.boxImGateComplete);
  const initGateway = useGatewayStore((state) => state.init);
  const initProviders = useProviderStore((state) => state.init);
  const gatewayStatus = useGatewayStore((state) => state.status);
  const isLoggedIn = useModelsStore((state) => state.isLoggedIn);
  const checkLoginStatus = useModelsStore((state) => state.checkLoginStatus);
  const checkIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    initSettings();
  }, [initSettings]);

  useEffect(() => {
    if (language && language !== i18n.language) {
      i18n.changeLanguage(language);
    }
  }, [language]);

  useEffect(() => {
    initGateway();
  }, [initGateway]);

  useEffect(() => {
    initProviders();
  }, [initProviders]);

  useEffect(() => {
    if (gatewayStatus.state !== 'running') return;
    checkLoginStatus();
  }, [gatewayStatus.state, checkLoginStatus]);

  useEffect(() => {
    if (gatewayStatus.state !== 'running') {
      if (checkIntervalRef.current) {
        clearInterval(checkIntervalRef.current);
        checkIntervalRef.current = null;
      }
      return;
    }

    checkIntervalRef.current = setInterval(() => {
      checkLoginStatus();
    }, LOGIN_CHECK_INTERVAL);

    return () => {
      if (checkIntervalRef.current) {
        clearInterval(checkIntervalRef.current);
        checkIntervalRef.current = null;
      }
    };
  }, [gatewayStatus.state, checkLoginStatus]);

  useEffect(() => {
    const path = location.pathname;
    console.log('[App] route check: path=', path, 'setupComplete=', setupComplete, 'boxImGateComplete=', boxImGateComplete, 'isLoggedIn=', isLoggedIn);
    if (path.startsWith('/setup') || path === '/box-im-gate') {
      return;
    }
    if (setupComplete && isLoggedIn === true) {
      return;
    }
    if (!boxImGateComplete) {
      console.log('[App] navigating to /box-im-gate');
      navigate('/box-im-gate', { replace: true });
      return;
    }
    if (!setupComplete) {
      console.log('[App] navigating to /setup');
      navigate('/setup', { replace: true });
      return;
    }
  }, [setupComplete, boxImGateComplete, isLoggedIn, location.pathname, navigate]);

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
          {/* First launch: box-im plugin login (before setup) */}
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
            <Route path="/datasources" element={<Datasources />} />
            <Route path="/cron" element={<Cron />} />
            <Route path="/settings/*" element={<Settings />} />
          </Route>
        </Routes>

        {/* Global context menu */}
        <ContextMenu />
        {/* Global toast notifications */}
        <Toaster
          position="top-center"
          richColors
          duration={1500}
          style={{ zIndex: 99999 }}
        />
      </TooltipProvider>
    </ErrorBoundary>
  );
}

export default App;
