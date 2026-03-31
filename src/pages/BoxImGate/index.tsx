/**
 * First-run gate: scan WeChat QR on gateway box-im login page before Setup wizard.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ExternalLink, RefreshCw, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSettingsStore } from '@/stores/settings';
import { useGatewayStore } from '@/stores/gateway';
import { hostApiFetch } from '@/lib/host-api';

export function BoxImGate() {
  const { t } = useTranslation('boxImGate');
  const navigate = useNavigate();
  const markBoxImGateComplete = useSettingsStore((s) => s.markBoxImGateComplete);
  const gatewayStatus = useGatewayStore((s) => s.status);
  const startGateway = useGatewayStore((s) => s.start);

  const [pluginUrl, setPluginUrl] = useState<string | null>(null);
  const [pluginErr, setPluginErr] = useState<string | null>(null);
  const [iframeKey, setIframeKey] = useState(0);

  useEffect(() => {
    if (gatewayStatus.state === 'starting') {
      setPluginUrl(null);
      setPluginErr(null);
      return;
    }
    if (gatewayStatus.state !== 'running') {
      setPluginUrl(null);
      setPluginErr(t('gatewayRequired'));
      return;
    }
    let cancelled = false;
    setPluginErr(null);
    (async () => {
      try {
        const res = await hostApiFetch<{ success?: boolean; url?: string; error?: string }>(
          `/api/gateway/plugin-url?path=${encodeURIComponent('/plugins/box-im/login')}`,
        );
        if (cancelled) return;
        if (res.success && res.url) {
          setPluginUrl(res.url);
        } else {
          setPluginUrl(null);
          setPluginErr(res.error || t('loadUrlFailed'));
        }
      } catch {
        if (!cancelled) {
          setPluginUrl(null);
          setPluginErr(t('loadUrlFailed'));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gatewayStatus.state, t]);

  const continueSetup = () => {
    markBoxImGateComplete();
    navigate('/setup', { replace: true });
  };

  const openExternal = () => {
    if (!pluginUrl) return;
    try {
      if (window.electron?.openExternal) {
        window.electron.openExternal(pluginUrl);
      } else {
        window.open(pluginUrl, '_blank');
      }
    } catch {
      window.open(pluginUrl, '_blank');
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-[#f3f1e9] dark:bg-background">
      <div className="w-full max-w-lg space-y-6 text-center">
        <h1 className="text-3xl font-serif font-normal tracking-tight text-foreground">{t('title')}</h1>
        <p className="text-[15px] text-muted-foreground leading-relaxed">{t('subtitle')}</p>

        {gatewayStatus.state !== 'running' && gatewayStatus.state !== 'starting' && (
          <div className="flex flex-col items-center gap-3">
            <p className="text-sm text-destructive">{t('startGatewayHint')}</p>
            <Button type="button" variant="outline" onClick={() => void startGateway()}>
              {t('startGateway')}
            </Button>
          </div>
        )}

        {(gatewayStatus.state === 'running' || gatewayStatus.state === 'starting') &&
          !pluginUrl &&
          !pluginErr && (
            <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin" />
              <span>{t('loadingPlugin')}</span>
            </div>
          )}

        {pluginErr && (
          <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {pluginErr}
          </div>
        )}

        {pluginUrl && !pluginErr && (
          <>
            <div className="rounded-2xl border border-black/10 dark:border-white/10 overflow-hidden bg-background shadow-sm">
              <iframe
                key={`${pluginUrl}-${gatewayStatus.connectedAt ?? 0}-${iframeKey}`}
                title={t('iframeTitle')}
                src={pluginUrl}
                className="w-full min-h-[420px] border-0 bg-background"
              />
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setIframeKey((k) => k + 1)}>
                <RefreshCw className="h-4 w-4 mr-2" />
                {t('refresh')}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={openExternal}>
                <ExternalLink className="h-4 w-4 mr-2" />
                {t('openInBrowser')}
              </Button>
            </div>
          </>
        )}

        <div className="flex flex-col sm:flex-row gap-3 justify-center pt-4">
          <Button type="button" className="rounded-full" onClick={continueSetup}>
            {t('continue')}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default BoxImGate;
