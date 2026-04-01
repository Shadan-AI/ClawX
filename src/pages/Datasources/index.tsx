/**
 * Data sources: external connectors (DATASOURCE_* env vars), aligned with openme Control UI.
 */
import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Eye, EyeOff, Check, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { hostApiFetch } from '@/lib/host-api';
import { useGatewayStore } from '@/stores/gateway';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import wechatIcon from '@/assets/channels/wechat.svg';

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
    icon: 'wechat',
    fields: [
      { key: 'appId', labelKey: 'fields.appId', placeholderKey: 'placeholders.appId' },
      { key: 'appSecret', labelKey: 'fields.appSecret', placeholderKey: 'placeholders.appSecret', password: true },
    ],
  },
  {
    key: 'zhipu',
    nameKey: 'connectors.zhipu.name',
    descKey: 'connectors.zhipu.description',
    icon: 'zhipu',
    fields: [{ key: 'apiKey', labelKey: 'fields.apiKey', placeholderKey: 'placeholders.apiKey', password: true }],
  },
];

function PasswordInput({ value, onChange, placeholder, className }: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  className?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        type={show ? 'text' : 'password'}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={cn('pr-10', className)}
      />
      <button
        type="button"
        onClick={() => setShow(!show)}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground transition-colors"
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

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
    <div className="flex flex-col -m-6 dark:bg-background h-[calc(100vh-2.5rem)] overflow-hidden">
      <div className="w-full max-w-5xl mx-auto flex flex-col h-full p-10 pt-16">

        {/* Header — matches Agents/Channels style */}
        <div className="flex flex-col md:flex-row md:items-start justify-between mb-12 shrink-0 gap-4">
          <div>
            <h1
              className="text-5xl md:text-6xl font-serif text-foreground mb-3 font-normal tracking-tight"
              style={{ fontFamily: 'Georgia, Cambria, "Times New Roman", Times, serif' }}
            >
              {t('title')}
            </h1>
            <p className="text-[17px] text-foreground/70 font-medium">{t('subtitle')}</p>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto pr-2 pb-10 min-h-0 -mr-2">
          {gatewayStatus.state !== 'running' && gatewayStatus.state !== 'starting' && (
            <div className="mb-8 p-4 rounded-xl border border-yellow-500/50 bg-yellow-500/10 flex items-center gap-3">
              <AlertCircle className="h-5 w-5 text-yellow-600 dark:text-yellow-400" />
              <span className="text-yellow-700 dark:text-yellow-400 text-sm font-medium">
                {t('gatewayWarning')}
              </span>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-4">
              {CONNECTORS.map((c, idx) => {
                const vals = connectors[c.key] ?? {};
                const filled = c.fields.every((f) => (vals[f.key] ?? '').trim() !== '');
                return (
                  <div
                    key={c.key}
                    className="animate-in fade-in-0 duration-500 ease-out"
                    style={{ animationDelay: `${idx * 80}ms`, animationFillMode: 'both' }}
                  >
                    <div className={cn(
                      'group rounded-2xl border p-5 transition-all duration-200',
                      'hover:shadow-md hover:border-black/15 dark:hover:border-white/15',
                      filled
                        ? 'border-green-500/20 bg-black/[0.03] dark:bg-white/[0.04]'
                        : 'border-black/10 dark:border-white/10 bg-black/[0.03] dark:bg-white/[0.03]'
                    )}>
                      {/* Top row: icon + name + status */}
                      <div className="flex items-center gap-3 mb-4">
                        <div className="h-10 w-10 shrink-0 flex items-center justify-center rounded-full bg-black/5 dark:bg-white/5">
                          {c.icon === 'wechat' ? (
                            <img src={wechatIcon} alt="WeChat" className="h-5 w-5 dark:invert" />
                          ) : c.icon === 'zhipu' ? (
                            <span className="text-[15px] font-bold text-foreground/70">AI</span>
                          ) : (
                            <span className="text-xl">{c.icon}</span>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <h3 className="text-[15px] font-semibold text-foreground">{t(c.nameKey)}</h3>
                          <p className="text-[13px] text-muted-foreground">{t(c.descKey)}</p>
                        </div>
                        <span className={cn(
                          'inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full font-medium transition-all duration-300',
                          filled
                            ? 'text-green-700 dark:text-green-400 bg-green-500/10'
                            : 'text-muted-foreground bg-black/5 dark:bg-white/8'
                        )}>
                          {filled && <Check className="h-3 w-3" />}
                          {filled ? t('status.configured') : t('status.notConfigured')}
                        </span>
                      </div>

                      {/* Fields */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                        {c.fields.map((f) => (
                          <div key={f.key} className="space-y-1.5">
                            <Label className="text-[13px] text-foreground/70 font-medium">{t(f.labelKey)}</Label>
                            {f.password ? (
                              <PasswordInput
                                value={vals[f.key] ?? ''}
                                onChange={(v) => updateField(c.key, f.key, v)}
                                placeholder={t(f.placeholderKey)}
                                className="h-10 rounded-xl border-black/10 dark:border-white/10 bg-background text-sm"
                              />
                            ) : (
                              <Input
                                value={vals[f.key] ?? ''}
                                placeholder={t(f.placeholderKey)}
                                onChange={(e) => updateField(c.key, f.key, e.target.value)}
                                className="h-10 rounded-xl border-black/10 dark:border-white/10 bg-background text-sm"
                              />
                            )}
                          </div>
                        ))}
                      </div>

                      {/* Save button */}
                      <div className="flex justify-end">
                        <Button
                          type="button"
                          disabled={!filled || !running || saving === c.key}
                          onClick={() => void saveConnector(c.key, c.fields)}
                          className="h-9 text-[13px] font-medium rounded-full px-5 shadow-none active:scale-95 transition-all"
                        >
                          {saving === c.key ? (
                            <Loader2 className="h-4 w-4 animate-spin mr-2" />
                          ) : null}
                          {t('save')}
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default Datasources;
