/**
 * Data sources: external connectors (DATASOURCE_* env vars), aligned with openme Control UI.
 */
import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Database, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { hostApiFetch } from '@/lib/host-api';
import { useGatewayStore } from '@/stores/gateway';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

type ConnectorDef = {
  key: string;
  nameKey: string;
  descKey: string;
  icon: string;
  fields: { key: string; labelKey: string; placeholderKey: string; password?: boolean }[];
};

const CONNECTORS: ConnectorDef[] = [
  {
    key: 'wechat',
    nameKey: 'connectors.wechat.name',
    descKey: 'connectors.wechat.description',
    icon: '💬',
    fields: [
      { key: 'appId', labelKey: 'fields.appId', placeholderKey: 'placeholders.appId' },
      { key: 'appSecret', labelKey: 'fields.appSecret', placeholderKey: 'placeholders.appSecret', password: true },
    ],
  },
  {
    key: 'zhipu',
    nameKey: 'connectors.zhipu.name',
    descKey: 'connectors.zhipu.description',
    icon: '🧠',
    fields: [{ key: 'apiKey', labelKey: 'fields.apiKey', placeholderKey: 'placeholders.apiKey', password: true }],
  },
];

export function Datasources() {
  const { t } = useTranslation('datasources');
  const gatewayStatus = useGatewayStore((s) => s.status);
  const [connectors, setConnectors] = useState<Record<string, Record<string, string>>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await hostApiFetch<{ success?: boolean; connectors?: Record<string, Record<string, string>> }>(
        '/api/datasources',
      );
      if (res.success && res.connectors) {
        setConnectors(res.connectors);
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const updateField = (connectorKey: string, fieldKey: string, value: string) => {
    setConnectors((prev) => ({
      ...prev,
      [connectorKey]: { ...(prev[connectorKey] ?? {}), [fieldKey]: value },
    }));
  };

  const saveConnector = async (connectorKey: string, fields: ConnectorDef['fields']) => {
    const values = connectors[connectorKey] ?? {};
    const payload: Record<string, string> = {};
    for (const f of fields) {
      payload[f.key] = (values[f.key] ?? '').trim();
    }
    if (!fields.every((f) => payload[f.key])) {
      toast.error(t('toast.fillAll'));
      return;
    }
    setSaving(connectorKey);
    try {
      const res = await hostApiFetch<{ success?: boolean; error?: string }>('/api/datasources/save', {
        method: 'POST',
        body: JSON.stringify({ connectorKey, fields: payload }),
      });
      if (!res.success) {
        throw new Error(res.error || 'save failed');
      }
      toast.success(t('toast.saved', { name: t(CONNECTORS.find((c) => c.key === connectorKey)!.nameKey) }));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(null);
    }
  };

  const running = gatewayStatus.state === 'running';

  return (
    <div className="flex flex-col -m-6 dark:bg-background min-h-[calc(100vh-2.5rem)] overflow-y-auto">
      <div className="w-full max-w-3xl mx-auto p-10 pt-16 space-y-8">
        <div className="flex items-start gap-2">
          <Database className="h-8 w-8 text-muted-foreground shrink-0 mt-1" />
          <div>
            <h1 className="text-4xl font-serif font-normal tracking-tight">{t('title')}</h1>
            <p className="text-muted-foreground mt-2 text-[15px] leading-relaxed">{t('subtitle')}</p>
          </div>
        </div>

        {!running && (
          <div className="rounded-xl border border-yellow-500/40 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-800 dark:text-yellow-200">
            {t('gatewayWarning')}
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-6">
            {CONNECTORS.map((c) => {
              const vals = connectors[c.key] ?? {};
              const filled = c.fields.every((f) => (vals[f.key] ?? '').trim() !== '');
              return (
                <Card key={c.key} className="rounded-2xl border-black/10 dark:border-white/10">
                  <CardHeader>
                    <div className="flex items-center gap-3">
                      <span className="text-3xl">{c.icon}</span>
                      <div>
                        <CardTitle className="text-lg">{t(c.nameKey)}</CardTitle>
                        <CardDescription>{t(c.descKey)}</CardDescription>
                      </div>
                      <span
                        className={cn(
                          'ml-auto text-xs px-2 py-0.5 rounded-full border',
                          filled
                            ? 'text-green-700 bg-green-500/10 border-green-500/30'
                            : 'text-muted-foreground bg-muted border-transparent',
                        )}
                      >
                        {filled ? t('status.configured') : t('status.notConfigured')}
                      </span>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {c.fields.map((f) => (
                        <div key={f.key} className="space-y-2">
                          <Label>{t(f.labelKey)}</Label>
                          <Input
                            type={f.password ? 'password' : 'text'}
                            value={vals[f.key] ?? ''}
                            placeholder={t(f.placeholderKey)}
                            onChange={(e) => updateField(c.key, f.key, e.target.value)}
                            className="rounded-xl"
                          />
                        </div>
                      ))}
                    </div>
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        disabled={!filled || !running || saving === c.key}
                        onClick={() => void saveConnector(c.key, c.fields)}
                      >
                        {saving === c.key ? <Loader2 className="h-4 w-4 animate-spin" /> : t('save')}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default Datasources;
