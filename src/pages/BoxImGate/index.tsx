/**
 * First-run gate: native WeChat QR login before Setup wizard.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import {
  RefreshCw,
  Loader2,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { TitleBar } from '@/components/layout/TitleBar';
import { Button } from '@/components/ui/button';
import { useSettingsStore } from '@/stores/settings';
import { useGatewayStore } from '@/stores/gateway';
import { useModelsStore } from '@/stores/models';
import { invokeIpc } from '@/lib/api-client';
import clawxIcon from '@/assets/logo.svg';

interface QrScene {
  ticket: string;
  sceneId: string;
}

interface HttpProxyResponse {
  success: boolean;
  status?: number;
  ok?: boolean;
  json?: unknown;
  text?: string;
  error?: string;
}

async function httpProxy<T>(path: string, method: string = 'GET', body?: unknown): Promise<T> {
  const response = await invokeIpc<HttpProxyResponse>('gateway:httpProxy', {
    path,
    method,
    body,
    timeoutMs: 10000,
  });
  
  if (!response?.success) {
    throw new Error(response?.error || '请求失败');
  }
  
  return response.json as T;
}

export function BoxImGate() {
  const { t } = useTranslation('boxImGate');
  const navigate = useNavigate();
  const markBoxImGateComplete = useSettingsStore((s) => s.markBoxImGateComplete);
  const boxImGateComplete = useSettingsStore((s) => s.boxImGateComplete);
  const gatewayStatus = useGatewayStore((s) => s.status);
  const startGateway = useGatewayStore((s) => s.start);
  const isLoggedIn = useModelsStore((s) => s.isLoggedIn);
  const checkLoginStatus = useModelsStore((s) => s.checkLoginStatus);

  const [qrScene, setQrScene] = useState<QrScene | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'scanning' | 'success' | 'expired'>('idle');
  const [nickname, setNickname] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const attemptsRef = useRef(0);

  useEffect(() => {
    console.log('[BoxImGate] checking: boxImGateComplete=', boxImGateComplete, 'isLoggedIn=', isLoggedIn);
    if (boxImGateComplete && isLoggedIn === true) {
      console.log('[BoxImGate] already logged in, navigating to /');
      navigate('/', { replace: true });
    }
  }, [boxImGateComplete, isLoggedIn, navigate]);

  useEffect(() => {
    if (gatewayStatus.state === 'running' && boxImGateComplete && isLoggedIn === null) {
      console.log('[BoxImGate] gateway running, checking login status');
      checkLoginStatus();
    }
  }, [gatewayStatus.state, boxImGateComplete, isLoggedIn, checkLoginStatus]);

  const fetchQrCode = useCallback(async () => {
    setLoading(true);
    setError(null);
    setQrScene(null);
    setStatus('idle');
    setNickname(null);
    attemptsRef.current = 0;

    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }

    try {
      const data = await httpProxy<QrScene>('/plugins/box-im/auth/wx/scene', 'POST');
      if (data.ticket && data.sceneId) {
        setQrScene({ ticket: data.ticket, sceneId: data.sceneId });
        setStatus('scanning');
      } else {
        throw new Error('二维码数据无效');
      }
    } catch (err) {
      console.error('[BoxImGate] fetchQrCode error:', err);
      setError(err instanceof Error ? err.message : '获取二维码失败');
    } finally {
      setLoading(false);
    }
  }, []);

  const pollScanResult = useCallback(async (sceneId: string) => {
    try {
      const data = await httpProxy<{ status: string; nickname?: string }>(
        `/plugins/box-im/auth/wx/poll/${sceneId}`,
        'GET',
      );

      if (data.status === 'ok') {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
        setStatus('success');
        setNickname(data.nickname || null);

        setTimeout(async () => {
          markBoxImGateComplete();
          console.log('[BoxImGate] markBoxImGateComplete called');
          window.location.reload();
        }, 1500);
      }
    } catch {
      // Ignore polling errors
    }
  }, [markBoxImGateComplete]);

  useEffect(() => {
    if (gatewayStatus.state === 'running') {
      const timer = setTimeout(() => {
        fetchQrCode();
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [gatewayStatus.state, fetchQrCode]);

  useEffect(() => {
    if (status !== 'scanning' || !qrScene) return;

    pollRef.current = setInterval(() => {
      attemptsRef.current++;
      if (attemptsRef.current > 150) {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
        setStatus('expired');
        return;
      }
      pollScanResult(qrScene.sceneId);
    }, 2000);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [status, qrScene, pollScanResult]);

  const handleRefresh = () => {
    fetchQrCode();
  };

  const handleSkip = () => {
    markBoxImGateComplete();
    navigate('/setup', { replace: true });
  };

  const handleStartGateway = async () => {
    await startGateway();
  };

  const renderContent = () => {
    if (gatewayStatus.state !== 'running' && gatewayStatus.state !== 'starting') {
      return (
        <div className="text-center space-y-4">
          <div className="flex items-center justify-center text-yellow-400">
            <XCircle className="h-12 w-12" />
          </div>
          <h2 className="text-xl font-semibold">{t('gatewayNotRunning')}</h2>
          <p className="text-muted-foreground">{t('startGatewayHint')}</p>
          <Button variant="outline" onClick={() => void handleStartGateway()}>
            {t('startGateway')}
          </Button>
        </div>
      );
    }

    if (gatewayStatus.state === 'starting') {
      return (
        <div className="text-center space-y-4">
          <div className="flex justify-center">
            <Loader2 className="h-12 w-12 animate-spin text-primary" />
          </div>
          <h2 className="text-xl font-semibold">{t('startingGateway')}</h2>
          <p className="text-muted-foreground">{t('pleaseWait')}</p>
        </div>
      );
    }

    return (
      <div className="space-y-6">
        <AnimatePresence mode="wait">
          {loading && (
            <motion.div
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="text-center space-y-4"
            >
              <div className="flex justify-center">
                <Loader2 className="h-12 w-12 animate-spin text-primary" />
              </div>
              <p className="text-muted-foreground">{t('fetchingQrCode')}</p>
            </motion.div>
          )}

          {error && !loading && (
            <motion.div
              key="error"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="text-center space-y-4"
            >
              <div className="flex items-center justify-center text-red-400">
                <XCircle className="h-12 w-12" />
              </div>
              <h2 className="text-xl font-semibold">{t('error')}</h2>
              <p className="text-muted-foreground">{error}</p>
              <Button variant="outline" onClick={handleRefresh}>
                <RefreshCw className="h-4 w-4 mr-2" />
                {t('retry')}
              </Button>
            </motion.div>
          )}

          {status === 'scanning' && qrScene && !loading && (
            <motion.div
              key="scanning"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="text-center space-y-4"
            >
              <div className="flex justify-center">
                <div className="bg-white p-4 rounded-xl shadow-lg">
                  <img
                    src={`https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=${encodeURIComponent(qrScene.ticket)}`}
                    alt={t('wechatQrCode')}
                    className="w-48 h-48 rounded-lg"
                  />
                </div>
              </div>
              <p className="text-muted-foreground">{t('scanToLogin')}</p>
              <Button variant="ghost" size="sm" onClick={handleRefresh}>
                <RefreshCw className="h-4 w-4 mr-2" />
                {t('refreshQrCode')}
              </Button>
            </motion.div>
          )}

          {status === 'success' && (
            <motion.div
              key="success"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              className="text-center space-y-4"
            >
              <div className="flex items-center justify-center text-green-400">
                <CheckCircle2 className="h-16 w-16" />
              </div>
              <h2 className="text-xl font-semibold">{t('loginSuccess')}</h2>
              {nickname && (
                <p className="text-muted-foreground">{t('welcome', { nickname })}</p>
              )}
              <p className="text-sm text-muted-foreground">{t('redirecting')}</p>
            </motion.div>
          )}

          {status === 'expired' && (
            <motion.div
              key="expired"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="text-center space-y-4"
            >
              <div className="flex items-center justify-center text-yellow-400">
                <XCircle className="h-12 w-12" />
              </div>
              <h2 className="text-xl font-semibold">{t('qrCodeExpired')}</h2>
              <Button variant="outline" onClick={handleRefresh}>
                <RefreshCw className="h-4 w-4 mr-2" />
                {t('refreshQrCode')}
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <TitleBar />
      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-md p-8 pt-16">
          <div className="text-center mb-8">
            <div className="mb-4 flex justify-center">
              <img src={clawxIcon} alt="OpenMe" className="h-16 w-16" />
            </div>
            <h1 className="text-2xl font-semibold mb-2">{t('title')}</h1>
            <p className="text-muted-foreground">{t('subtitle')}</p>
          </div>

          {renderContent()}

          <div className="mt-8 text-center">
            <Button variant="link" className="text-muted-foreground" onClick={handleSkip}>
              {t('skip')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default BoxImGate;
