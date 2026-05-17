import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  RefreshCw,
  Wallet,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useGatewayStore } from '@/stores/gateway';
import { useSettingsStore } from '@/stores/settings';
import { hostApiFetch } from '@/lib/host-api';
import { trackUiEvent } from '@/lib/telemetry';
import { ProvidersSettings } from '@/components/settings/ProvidersSettings';
import { FeedbackState } from '@/components/common/FeedbackState';
import {
  filterUsageHistoryByWindow,
  groupUsageHistory,
  resolveStableUsageHistory,
  resolveVisibleUsageHistory,
  type UsageGroupBy,
  type UsageHistoryEntry,
  type UsageWindow,
} from './usage-history';

const DEFAULT_USAGE_FETCH_MAX_ATTEMPTS = 2;
const WINDOWS_USAGE_FETCH_MAX_ATTEMPTS = 3;
const USAGE_FETCH_RETRY_DELAY_MS = 1500;
const USAGE_AUTO_REFRESH_INTERVAL_MS = 15_000;
const HIDDEN_USAGE_MARKERS = ['gateway-injected', 'delivery-mirror'];
const RECHARGE_STATUS_POLL_INTERVAL_MS = 3_000;
const RECHARGE_STATUS_POLL_TIMEOUT_MS = 180_000;

type OneApiAccountSummary = {
  loggedIn: boolean;
  topUpLink: string | null;
  userId: number | null;
  username: string | null;
  rechargeSupported?: boolean;
  quotaPerUnit: number;
  displayInCurrency: boolean;
  totalAmount: number | null;
  usedAmount: number | null;
  remainingAmount: number | null;
  totalQuota: number | null;
  usedQuota: number | null;
  remainingQuota: number | null;
  userSelfSupported: boolean;
  redeemCodeSupported: boolean;
  error?: string;
};

type RedeemCodeResponse = {
  success: boolean;
  quota?: number | null;
};

type RechargeOrderResponse = {
  success: boolean;
  amount: number;
  amountCents: number;
  currency: string | null;
  orderNo: string | null;
  quota: number | null;
  qrCodeUrl: string;
  qrCodeDataUrl: string;
};

type FetchState = {
  status: 'idle' | 'loading' | 'done';
  data: UsageHistoryEntry[];
  stableData: UsageHistoryEntry[];
};

type FetchAction =
  | { type: 'start' }
  | { type: 'done'; data: UsageHistoryEntry[] }
  | { type: 'failed' }
  | { type: 'reset' };

function isHiddenUsageSource(source?: string): boolean {
  if (!source) return false;
  const normalizedSource = source.trim().toLowerCase();
  return HIDDEN_USAGE_MARKERS.some((marker) => normalizedSource.includes(marker));
}

function formatUsageSource(source?: string): string | undefined {
  if (!source) return undefined;
  if (isHiddenUsageSource(source)) return undefined;
  return source;
}

function shouldHideUsageEntry(entry: UsageHistoryEntry): boolean {
  return isHiddenUsageSource(entry.provider) || isHiddenUsageSource(entry.model);
}

function formatTokenCount(value: number): string {
  return Intl.NumberFormat().format(value);
}

function getUsageTotalClass(entry: UsageHistoryEntry): string {
  if (entry.usageStatus === 'error') return 'text-[15px] font-bold text-red-500 dark:text-red-400';
  if (entry.usageStatus === 'missing') return 'text-[15px] font-bold text-muted-foreground';
  return 'text-[15px] font-bold';
}

function formatUsageTotal(entry: UsageHistoryEntry): string {
  if (entry.usageStatus === 'error') return 'x';
  if (entry.usageStatus === 'missing') return '-';
  return formatTokenCount(entry.totalTokens);
}

function formatUsageTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatAccountMetric(value: number | null, displayInCurrency: boolean): string {
  if (value === null || !Number.isFinite(value)) return '--';
  return displayInCurrency
    ? value.toFixed(2)
    : Intl.NumberFormat().format(Math.round(value));
}

function formatQuotaMetric(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '--';
  return Intl.NumberFormat().format(Math.max(Math.round(value), 0));
}

function formatRechargeAmount(value: number): string {
  if (!Number.isFinite(value)) return '0.00';
  return value.toFixed(2);
}

function parseRechargeAmountInput(value: string): number | null {
  const normalized = value.trim().replace(/[^\d.]/g, '');
  if (!normalized) return null;
  if (!/^\d+(\.\d{0,2})?$/.test(normalized)) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed * 100) / 100;
}

function getRechargeBalanceSignals(summary: OneApiAccountSummary | null): number[] {
  if (!summary) return [];
  return [
    summary.totalAmount,
    summary.remainingAmount,
    summary.totalQuota,
    summary.remainingQuota,
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function hasRechargeBalanceIncreased(
  before: OneApiAccountSummary | null,
  after: OneApiAccountSummary | null,
): boolean {
  const beforeSignals = getRechargeBalanceSignals(before);
  const afterSignals = getRechargeBalanceSignals(after);
  if (beforeSignals.length === 0 || afterSignals.length === 0) return false;

  return afterSignals.some((value, index) => {
    const previous = beforeSignals[index];
    return typeof previous === 'number' && value > previous + 0.000001;
  });
}

function buildRechargeUrl(_summary?: OneApiAccountSummary, _amount?: number): string | null {
  return null;
}

function isTimeoutMessage(message?: string | null): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return lower.includes('aborted due to timeout')
    || lower.includes('timed out')
    || lower.includes('timeout');
}

function normalizeActionError(action: string, message: string): string {
  if (isTimeoutMessage(message)) {
    return `${action}接口响应超时，请稍后重试`;
  }
  return message;
}

function normalizeAccountError(summary: OneApiAccountSummary | null): string | null {
  const message = summary?.error?.trim();
  if (!message) return null;

  if (isTimeoutMessage(message)) {
    if (summary?.totalQuota !== null || summary?.remainingQuota !== null || summary?.usedQuota !== null) {
      return '余额详情接口响应较慢，当前先显示基础余额，你可以稍后再刷新。';
    }
    return '余额接口响应超时，请稍后刷新重试。';
  }

  return message;
}

export function Models() {
  const { t } = useTranslation('dashboard');
  const gatewayStatus = useGatewayStore((state) => state.status);
  const devModeUnlocked = useSettingsStore((state) => state.devModeUnlocked);
  const isGatewayRunning = gatewayStatus.state === 'running';
  const usageFetchMaxAttempts = window.electron.platform === 'win32'
    ? WINDOWS_USAGE_FETCH_MAX_ATTEMPTS
    : DEFAULT_USAGE_FETCH_MAX_ATTEMPTS;

  const [accountSummary, setAccountSummary] = useState<OneApiAccountSummary | null>(null);
  const [accountLoading, setAccountLoading] = useState(false);
  const [redeemCode, setRedeemCode] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [rechargeDialogOpen, setRechargeDialogOpen] = useState(false);
  const [rechargeAmount, setRechargeAmount] = useState<number>(50);
  const [customRechargeAmount, setCustomRechargeAmount] = useState('');
  const [rechargeLoading, setRechargeLoading] = useState(false);
  const [rechargeOrder, setRechargeOrder] = useState<RechargeOrderResponse | null>(null);

  const [usageGroupBy, setUsageGroupBy] = useState<UsageGroupBy>('model');
  const [usageWindow, setUsageWindow] = useState<UsageWindow>('7d');
  const [usagePage, setUsagePage] = useState(1);
  const [selectedUsageEntry, setSelectedUsageEntry] = useState<UsageHistoryEntry | null>(null);
  const [usageRefreshNonce, setUsageRefreshNonce] = useState(0);

  const [fetchState, dispatchFetch] = useReducer(
    (state: FetchState, action: FetchAction): FetchState => {
      switch (action.type) {
        case 'start':
          return { ...state, status: 'loading' };
        case 'done':
          return {
            status: 'done',
            data: action.data,
            stableData: resolveStableUsageHistory(state.stableData, action.data),
          };
        case 'failed':
          return { ...state, status: 'done' };
        case 'reset':
          return { status: 'idle', data: [], stableData: [] };
        default:
          return state;
      }
    },
    { status: 'idle', data: [], stableData: [] },
  );

  const usageFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const usageFetchGenerationRef = useRef(0);
  const usageFetchStatusRef = useRef<FetchState['status']>('idle');
  const rechargeBaselineRef = useRef<OneApiAccountSummary | null>(null);
  const rechargePollTimerRef = useRef<number | null>(null);
  const rechargePollStartedAtRef = useRef(0);

  const stopRechargePolling = useCallback(() => {
    if (rechargePollTimerRef.current) {
      window.clearInterval(rechargePollTimerRef.current);
      rechargePollTimerRef.current = null;
    }
  }, []);

  const _loadAccountSummary = useCallback(async (options?: {
    silent?: boolean;
    showToastOnError?: boolean;
  }) => {
    const silent = options?.silent ?? false;
    const showToastOnError = options?.showToastOnError ?? false;

    if (!silent) {
      setAccountLoading(true);
    }

    try {
      const summary = await hostApiFetch<OneApiAccountSummary>('/api/oneapi/account-summary');
      setAccountSummary(summary);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAccountSummary((current) => current ? { ...current, error: message } : null);
      if (showToastOnError) {
        toast.error(`余额加载失败: ${message}`);
      }
    } finally {
      if (!silent) {
        setAccountLoading(false);
      }
    }
  }, []);

  const refreshAccountSummary = useCallback(async (options?: {
    silent?: boolean;
    showToastOnError?: boolean;
  }) => {
    const silent = options?.silent ?? false;
    const showToastOnError = options?.showToastOnError ?? false;

    if (!silent) {
      setAccountLoading(true);
    }

    try {
      const summary = await hostApiFetch<OneApiAccountSummary>('/api/oneapi/account-summary');
      setAccountSummary(summary);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAccountSummary((current) => current ? { ...current, error: message } : null);
      if (showToastOnError) {
        toast.error(`余额加载失败: ${normalizeActionError('余额', message)}`);
      }
    } finally {
      if (!silent) {
        setAccountLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    usageFetchStatusRef.current = fetchState.status;
  }, [fetchState.status]);

  useEffect(() => {
    trackUiEvent('models.page_viewed');
    void refreshAccountSummary();
  }, [refreshAccountSummary]);

  const closeRechargeDialog = useCallback(async (options?: {
    refresh?: boolean;
    paid?: boolean;
  }) => {
    stopRechargePolling();
    setRechargeDialogOpen(false);
    setRechargeOrder(null);
    setCustomRechargeAmount('');
    rechargeBaselineRef.current = null;

    if (options?.refresh) {
      await refreshAccountSummary({ silent: false, showToastOnError: true });
    }
    if (options?.paid) {
      toast.success('支付成功，余额已刷新');
    }
  }, [refreshAccountSummary, stopRechargePolling]);

  useEffect(() => {
    stopRechargePolling();

    if (!rechargeDialogOpen || !rechargeOrder) {
      return undefined;
    }

    rechargePollStartedAtRef.current = Date.now();
    rechargePollTimerRef.current = window.setInterval(() => {
      void (async () => {
        if (Date.now() - rechargePollStartedAtRef.current > RECHARGE_STATUS_POLL_TIMEOUT_MS) {
          stopRechargePolling();
          return;
        }

        try {
          const summary = await hostApiFetch<OneApiAccountSummary>('/api/oneapi/account-summary');
          setAccountSummary(summary);
          if (hasRechargeBalanceIncreased(rechargeBaselineRef.current, summary)) {
            await closeRechargeDialog({ paid: true });
          }
        } catch {
          // Keep polling quietly; users can still close the dialog to refresh manually.
        }
      })();
    }, RECHARGE_STATUS_POLL_INTERVAL_MS);

    return () => {
      stopRechargePolling();
    };
  }, [closeRechargeDialog, rechargeDialogOpen, rechargeOrder, stopRechargePolling]);

  useEffect(() => {
    if (!isGatewayRunning) {
      return;
    }

    const requestRefresh = () => {
      if (usageFetchStatusRef.current === 'loading') return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      setUsageRefreshNonce((value) => value + 1);
    };

    const intervalId = window.setInterval(requestRefresh, USAGE_AUTO_REFRESH_INTERVAL_MS);
    const handleFocus = () => requestRefresh();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        requestRefresh();
      }
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isGatewayRunning]);

  useEffect(() => {
    if (usageFetchTimerRef.current) {
      clearTimeout(usageFetchTimerRef.current);
      usageFetchTimerRef.current = null;
    }

    if (!isGatewayRunning) {
      dispatchFetch({ type: 'reset' });
      return;
    }

    dispatchFetch({ type: 'start' });
    const generation = usageFetchGenerationRef.current + 1;
    usageFetchGenerationRef.current = generation;
    const restartMarker = `${gatewayStatus.pid ?? 'na'}:${gatewayStatus.connectedAt ?? 'na'}`;
    trackUiEvent('models.token_usage_fetch_started', {
      generation,
      restartMarker,
    });

    const safetyTimeout = setTimeout(() => {
      if (usageFetchGenerationRef.current !== generation) return;
      trackUiEvent('models.token_usage_fetch_safety_timeout', {
        generation,
        restartMarker,
      });
      dispatchFetch({ type: 'failed' });
    }, 30_000);

    const fetchUsageHistoryWithRetry = async (attempt: number) => {
      trackUiEvent('models.token_usage_fetch_attempt', {
        generation,
        attempt,
        restartMarker,
      });
      try {
        const entries = await hostApiFetch<UsageHistoryEntry[]>('/api/usage/recent-token-history?limit=200');
        if (usageFetchGenerationRef.current !== generation) return;

        const normalized = Array.isArray(entries) ? entries : [];
        setUsagePage(1);
        trackUiEvent('models.token_usage_fetch_succeeded', {
          generation,
          attempt,
          records: normalized.length,
          restartMarker,
        });

        if (normalized.length === 0 && attempt < usageFetchMaxAttempts) {
          trackUiEvent('models.token_usage_fetch_retry_scheduled', {
            generation,
            attempt,
            reason: 'empty',
            restartMarker,
          });
          usageFetchTimerRef.current = setTimeout(() => {
            void fetchUsageHistoryWithRetry(attempt + 1);
          }, USAGE_FETCH_RETRY_DELAY_MS);
          return;
        }

        if (normalized.length === 0) {
          trackUiEvent('models.token_usage_fetch_exhausted', {
            generation,
            attempt,
            reason: 'empty',
            restartMarker,
          });
        }
        dispatchFetch({ type: 'done', data: normalized });
      } catch (error) {
        if (usageFetchGenerationRef.current !== generation) return;
        trackUiEvent('models.token_usage_fetch_failed_attempt', {
          generation,
          attempt,
          restartMarker,
          message: error instanceof Error ? error.message : String(error),
        });
        if (attempt < usageFetchMaxAttempts) {
          trackUiEvent('models.token_usage_fetch_retry_scheduled', {
            generation,
            attempt,
            reason: 'error',
            restartMarker,
          });
          usageFetchTimerRef.current = setTimeout(() => {
            void fetchUsageHistoryWithRetry(attempt + 1);
          }, USAGE_FETCH_RETRY_DELAY_MS);
          return;
        }
        dispatchFetch({ type: 'failed' });
        trackUiEvent('models.token_usage_fetch_exhausted', {
          generation,
          attempt,
          reason: 'error',
          restartMarker,
        });
      }
    };

    void fetchUsageHistoryWithRetry(1);

    return () => {
      clearTimeout(safetyTimeout);
      if (usageFetchTimerRef.current) {
        clearTimeout(usageFetchTimerRef.current);
        usageFetchTimerRef.current = null;
      }
    };
  }, [isGatewayRunning, gatewayStatus.connectedAt, gatewayStatus.pid, usageFetchMaxAttempts, usageRefreshNonce]);

  const handleOpenTopUp = async (urlOverride?: string | null) => {
    const target = (urlOverride || accountSummary?.topUpLink || '').trim();
    if (!target) {
      toast.error('当前没有可用的充值入口');
      return;
    }
    await window.electron.openExternal(target);
  };

  const _handleOpenRechargeDialog = () => {
    if (!accountSummary?.topUpLink) {
      toast.error('当前没有可用的充值入口');
      return;
    }
    setRechargeDialogOpen(true);
  };

  const _handleStartWechatRecharge = () => {
    if (!accountSummary) {
      toast.error('余额信息还没加载出来');
      return;
    }
    const paymentUrl = buildRechargeUrl(accountSummary, rechargeAmount);
    if (!paymentUrl) {
      toast.error('当前没有可用的充值入口');
      return;
    }
  };


  void _loadAccountSummary;
  void _handleOpenRechargeDialog;
  void _handleStartWechatRecharge;

  const openRechargeDialog = () => {
    if (!accountSummary?.rechargeSupported) {
      toast.error('当前账号暂时无法使用充值');
      return;
    }
    setCustomRechargeAmount('');
    setRechargeOrder(null);
    setRechargeDialogOpen(true);
  };

  const startWechatRecharge = async () => {
    if (!accountSummary) {
      toast.error('余额信息还没加载出来');
      return;
    }

    const customAmount = parseRechargeAmountInput(customRechargeAmount);
    const finalAmount = customRechargeAmount.trim() ? customAmount : rechargeAmount;
    if (finalAmount === null || finalAmount < 0.01) {
      toast.error('请输入有效金额，最小支持 0.01 元');
      return;
    }

    setRechargeLoading(true);
    try {
      const result = await hostApiFetch<RechargeOrderResponse>('/api/oneapi/recharge-order', {
        method: 'POST',
        body: JSON.stringify({ amount: finalAmount }),
      });
      if (!result.success) {
        throw new Error('微信充值失败');
      }
      rechargeBaselineRef.current = accountSummary;
      setRechargeOrder(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(normalizeActionError('微信充值', message));
    } finally {
      setRechargeLoading(false);
    }
  };

  const handleRedeemCode = async () => {
    const key = redeemCode.trim();
    if (!key) {
      toast.error('请输入兑换码');
      return;
    }

    setRedeeming(true);
    try {
      const result = await hostApiFetch<RedeemCodeResponse>('/api/oneapi/redeem-code', {
        method: 'POST',
        body: JSON.stringify({ key }),
      });
      if (!result.success) {
        throw new Error('兑换失败');
      }
      toast.success('兑换成功');
      setRedeemCode('');
      await refreshAccountSummary({ silent: true });
    } catch (error) {
      toast.error(`兑换失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRedeeming(false);
    }
  };

  void handleRedeemCode;

  const usageHistory = isGatewayRunning
    ? fetchState.data.filter((entry) => !shouldHideUsageEntry(entry))
    : [];
  const stableUsageHistory = isGatewayRunning
    ? fetchState.stableData.filter((entry) => !shouldHideUsageEntry(entry))
    : [];
  const visibleUsageHistory = resolveVisibleUsageHistory(usageHistory, stableUsageHistory, {
    preferStableOnEmpty: isGatewayRunning && fetchState.status === 'loading',
  });
  const filteredUsageHistory = filterUsageHistoryByWindow(visibleUsageHistory, usageWindow);
  const usageGroups = groupUsageHistory(filteredUsageHistory, usageGroupBy);
  const usagePageSize = 5;
  const usageTotalPages = Math.max(1, Math.ceil(filteredUsageHistory.length / usagePageSize));
  const safeUsagePage = Math.min(usagePage, usageTotalPages);
  const pagedUsageHistory = filteredUsageHistory.slice((safeUsagePage - 1) * usagePageSize, safeUsagePage * usagePageSize);
  const usageLoading = isGatewayRunning && fetchState.status === 'loading' && visibleUsageHistory.length === 0;
  const usageRefreshing = isGatewayRunning && fetchState.status === 'loading' && visibleUsageHistory.length > 0;

  const hasAccountMetrics = !!accountSummary && (
    accountSummary.totalAmount !== null
    || accountSummary.usedAmount !== null
    || accountSummary.remainingAmount !== null
    || accountSummary.totalQuota !== null
    || accountSummary.usedQuota !== null
    || accountSummary.remainingQuota !== null
  );

  const metricUnit = accountSummary?.displayInCurrency ? '元' : '额度';
  const remainingLabel = accountSummary?.displayInCurrency ? '账户余额' : '剩余额度';
  const usedLabel = accountSummary?.displayInCurrency ? '已用金额' : '已用额度';
  const totalLabel = accountSummary?.displayInCurrency ? '总额度' : '总额度';
  const accountErrorMessage = normalizeAccountError(accountSummary);
  const rechargeAmountOptions = [0.01, 1, 10, 20, 50, 100];

  return (
    <div data-testid="models-page" className="flex flex-col -m-6 h-[calc(100vh-2.5rem)] overflow-hidden dark:bg-background">
      <div className="mx-auto flex h-full w-full max-w-5xl flex-col p-10 pt-16">
        <div className="mb-12 flex shrink-0 flex-col justify-between gap-4 md:flex-row md:items-start">
          <div>
            <h1
              data-testid="models-page-title"
              className="mb-3 text-5xl font-serif font-normal tracking-tight text-foreground md:text-6xl"
              style={{ fontFamily: 'Georgia, Cambria, "Times New Roman", Times, serif' }}
            >
              {t('models.title')}
            </h1>
            <p className="text-[17px] font-medium text-foreground/70">
              {t('models.subtitle')}
            </p>
          </div>
        </div>

        <div className="flex-1 space-y-12 overflow-y-auto pb-10 pr-2 -mr-2 min-h-0">
          <section className="rounded-3xl border border-black/10 bg-card/40 p-6 backdrop-blur-sm dark:border-white/10">
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
              <div>
                <h2
                  className="mb-2 text-3xl font-serif font-normal tracking-tight text-foreground"
                  style={{ fontFamily: 'Georgia, Cambria, "Times New Roman", Times, serif' }}
                >
                  余额
                </h2>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void refreshAccountSummary({ showToastOnError: true })}
                  disabled={accountLoading}
                  className="h-9 rounded-full border-black/10 bg-transparent px-4 hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
                >
                  <RefreshCw className={`mr-1.5 h-4 w-4 ${accountLoading ? 'animate-spin' : ''}`} />
                  刷新余额
                </Button>
                <Button
                  size="sm"
                  onClick={openRechargeDialog}
                  disabled={!accountSummary?.rechargeSupported || rechargeLoading}
                  className="h-9 rounded-full px-4"
                >
                  <Wallet className="mr-1.5 h-4 w-4" />
                  充值
                </Button>
              </div>
            </div>

            <div className="mt-6">
              {accountLoading && !accountSummary ? (
                <FeedbackState state="loading" title="正在加载余额..." />
              ) : !accountSummary ? (
                <FeedbackState state="error" title="余额信息暂时加载失败，请稍后重试" />
              ) : !accountSummary.loggedIn ? (
                <FeedbackState state="empty" title="请先登录账号后再查看余额" />
              ) : (
                <div className="space-y-5">
                  {accountErrorMessage && (
                    <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-800 dark:text-amber-200">
                      {accountErrorMessage}
                    </div>
                  )}

                  {hasAccountMetrics ? (
                    <div className="grid gap-4 md:grid-cols-3">
                      <AccountMetricCard
                        label={remainingLabel}
                        value={`${formatAccountMetric(accountSummary.remainingAmount, accountSummary.displayInCurrency)} ${metricUnit}`}
                        hint={`约 ${formatQuotaMetric(accountSummary.remainingQuota)} 点额度`}
                      />
                      <AccountMetricCard
                        label={usedLabel}
                        value={`${formatAccountMetric(accountSummary.usedAmount, accountSummary.displayInCurrency)} ${metricUnit}`}
                        hint={`累计已用 ${formatQuotaMetric(accountSummary.usedQuota)} 点额度`}
                      />
                      <AccountMetricCard
                        label={totalLabel}
                        value={`${formatAccountMetric(accountSummary.totalAmount, accountSummary.displayInCurrency)} ${metricUnit}`}
                        hint={`总额度约 ${formatQuotaMetric(accountSummary.totalQuota)} 点`}
                      />
                    </div>
                  ) : (
                    <FeedbackState state="empty" title="当前还没有拿到可展示的余额数据" />
                  )}

                  <div className="hidden rounded-2xl border border-black/10 bg-background/60 p-4 dark:border-white/10">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
                      <div className="flex-1 space-y-2">
                        <p className="text-[14px] font-semibold text-foreground">兑换码充值</p>
                        <div className="flex flex-col gap-3 sm:flex-row">
                          <Input
                            value={redeemCode}
                            onChange={(event) => setRedeemCode(event.target.value)}
                            placeholder="输入兑换码后直接充值"
                            className="h-11 rounded-xl border-black/10 bg-white/80 dark:border-white/10 dark:bg-background"
                          />
                          <Button
                            onClick={() => void handleRedeemCode()}
                            disabled={redeeming || redeemCode.trim().length === 0}
                            className="h-11 rounded-xl px-5"
                          >
                            {redeeming ? '充值中...' : '立即充值'}
                          </Button>
                        </div>
                        <p className="text-[12px] leading-5 text-muted-foreground">
                          {accountSummary.redeemCodeSupported
                            ? '可以直接输入兑换码充值。'
                            : '如果兑换码提交失败，就用上面的充值入口。'}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>

          <ProvidersSettings />

          <section>
            <h2
              className="mb-6 text-3xl font-serif font-normal tracking-tight text-foreground"
              style={{ fontFamily: 'Georgia, Cambria, "Times New Roman", Times, serif' }}
            >
              {t('recentTokenHistory.title', 'Token Usage History')}
            </h2>
            <div>
              {usageLoading ? (
                <div className="flex items-center justify-center rounded-3xl border border-dashed border-transparent bg-black/5 py-12 text-muted-foreground dark:bg-white/5">
                  <FeedbackState state="loading" title={t('recentTokenHistory.loading')} />
                </div>
              ) : visibleUsageHistory.length === 0 ? (
                <div className="flex items-center justify-center rounded-3xl border border-dashed border-transparent bg-black/5 py-12 text-muted-foreground dark:bg-white/5">
                  <FeedbackState state="empty" title={t('recentTokenHistory.empty')} />
                </div>
              ) : filteredUsageHistory.length === 0 ? (
                <div className="flex items-center justify-center rounded-3xl border border-dashed border-transparent bg-black/5 py-12 text-muted-foreground dark:bg-white/5">
                  <FeedbackState state="empty" title={t('recentTokenHistory.emptyForWindow')} />
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="flex rounded-xl border border-black/10 bg-transparent p-1 dark:border-white/10">
                        <Button
                          variant={usageGroupBy === 'model' ? 'secondary' : 'ghost'}
                          size="sm"
                          onClick={() => {
                            setUsageGroupBy('model');
                            setUsagePage(1);
                          }}
                          className={usageGroupBy === 'model'
                            ? 'rounded-lg bg-black/5 text-foreground dark:bg-white/10'
                            : 'rounded-lg text-muted-foreground'}
                        >
                          {t('recentTokenHistory.groupByModel')}
                        </Button>
                        <Button
                          variant={usageGroupBy === 'day' ? 'secondary' : 'ghost'}
                          size="sm"
                          onClick={() => {
                            setUsageGroupBy('day');
                            setUsagePage(1);
                          }}
                          className={usageGroupBy === 'day'
                            ? 'rounded-lg bg-black/5 text-foreground dark:bg-white/10'
                            : 'rounded-lg text-muted-foreground'}
                        >
                          {t('recentTokenHistory.groupByTime')}
                        </Button>
                      </div>
                      <div className="flex rounded-xl border border-black/10 bg-transparent p-1 dark:border-white/10">
                        <Button
                          variant={usageWindow === '7d' ? 'secondary' : 'ghost'}
                          size="sm"
                          onClick={() => {
                            setUsageWindow('7d');
                            setUsagePage(1);
                          }}
                          className={usageWindow === '7d'
                            ? 'rounded-lg bg-black/5 text-foreground dark:bg-white/10'
                            : 'rounded-lg text-muted-foreground'}
                        >
                          {t('recentTokenHistory.last7Days')}
                        </Button>
                        <Button
                          variant={usageWindow === '30d' ? 'secondary' : 'ghost'}
                          size="sm"
                          onClick={() => {
                            setUsageWindow('30d');
                            setUsagePage(1);
                          }}
                          className={usageWindow === '30d'
                            ? 'rounded-lg bg-black/5 text-foreground dark:bg-white/10'
                            : 'rounded-lg text-muted-foreground'}
                        >
                          {t('recentTokenHistory.last30Days')}
                        </Button>
                        <Button
                          variant={usageWindow === 'all' ? 'secondary' : 'ghost'}
                          size="sm"
                          onClick={() => {
                            setUsageWindow('all');
                            setUsagePage(1);
                          }}
                          className={usageWindow === 'all'
                            ? 'rounded-lg bg-black/5 text-foreground dark:bg-white/10'
                            : 'rounded-lg text-muted-foreground'}
                        >
                          {t('recentTokenHistory.allTime')}
                        </Button>
                      </div>
                    </div>
                    <p className="text-[13px] font-medium text-muted-foreground">
                      {usageRefreshing
                        ? t('recentTokenHistory.loading')
                        : t('recentTokenHistory.showingLast', { count: filteredUsageHistory.length })}
                    </p>
                  </div>

                  <UsageBarChart
                    groups={usageGroups}
                    emptyLabel={t('recentTokenHistory.empty')}
                    totalLabel={t('recentTokenHistory.totalTokens')}
                    inputLabel={t('recentTokenHistory.inputShort')}
                    outputLabel={t('recentTokenHistory.outputShort')}
                    cacheLabel={t('recentTokenHistory.cacheShort')}
                  />

                  <div className="space-y-3 pt-2">
                    {pagedUsageHistory.map((entry) => (
                      <div
                        key={`${entry.sessionId}-${entry.timestamp}`}
                        data-testid="token-usage-entry"
                        className="rounded-xl border border-border/60 bg-card/50 p-5 shadow-sm backdrop-blur-sm transition-all duration-200 hover:border-border hover:bg-accent/30 hover:shadow"
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[15px] font-semibold leading-tight text-foreground">
                              {entry.model || t('recentTokenHistory.unknownModel')}
                            </p>
                            <p className="mt-1 truncate text-[13px] text-muted-foreground/80">
                              {[formatUsageSource(entry.provider), formatUsageSource(entry.agentId), entry.sessionId]
                                .filter(Boolean)
                                .join(' - ')}
                            </p>
                          </div>
                          <div className="shrink-0 text-right">
                            <p className={getUsageTotalClass(entry)}>
                              {formatUsageTotal(entry)}
                            </p>
                            {entry.usageStatus === 'missing' && (
                              <p className="mt-0.5 text-[12px] text-muted-foreground/70">
                                {t('recentTokenHistory.noUsage')}
                              </p>
                            )}
                            {entry.usageStatus === 'error' && (
                              <p className="mt-0.5 text-[12px] text-destructive/90">
                                {t('recentTokenHistory.usageParseError')}
                              </p>
                            )}
                            <p className="mt-1 text-[12px] text-muted-foreground/70">
                              {formatUsageTimestamp(entry.timestamp)}
                            </p>
                          </div>
                        </div>
                        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[13px] font-medium">
                          {entry.usageStatus === 'available' || entry.usageStatus === undefined ? (
                            <>
                              <span className="flex items-center gap-2">
                                <span className="h-2.5 w-2.5 rounded-full bg-sky-500 shadow-sm" />
                                <span className="text-foreground/80">
                                  {t('recentTokenHistory.input', { value: formatTokenCount(entry.inputTokens) })}
                                </span>
                              </span>
                              <span className="flex items-center gap-2">
                                <span className="h-2.5 w-2.5 rounded-full bg-violet-500 shadow-sm" />
                                <span className="text-foreground/80">
                                  {t('recentTokenHistory.output', { value: formatTokenCount(entry.outputTokens) })}
                                </span>
                              </span>
                              {entry.cacheReadTokens > 0 && (
                                <span className="flex items-center gap-2">
                                  <span className="h-2.5 w-2.5 rounded-full bg-amber-500 shadow-sm" />
                                  <span className="text-foreground/80">
                                    {t('recentTokenHistory.cacheRead', { value: formatTokenCount(entry.cacheReadTokens) })}
                                  </span>
                                </span>
                              )}
                              {entry.cacheWriteTokens > 0 && (
                                <span className="flex items-center gap-2">
                                  <span className="h-2.5 w-2.5 rounded-full bg-orange-500 shadow-sm" />
                                  <span className="text-foreground/80">
                                    {t('recentTokenHistory.cacheWrite', { value: formatTokenCount(entry.cacheWriteTokens) })}
                                  </span>
                                </span>
                              )}
                            </>
                          ) : (
                            <span className="text-[13px] text-muted-foreground">
                              {entry.usageStatus === 'missing'
                                ? t('recentTokenHistory.noUsage')
                                : t('recentTokenHistory.usageParseError')}
                            </span>
                          )}
                          {typeof entry.costUsd === 'number' && Number.isFinite(entry.costUsd) && (
                            <span className="ml-auto rounded-lg border border-primary/20 bg-primary/10 px-3 py-1 font-semibold text-foreground">
                              ${entry.costUsd.toFixed(4)}
                            </span>
                          )}
                          {devModeUnlocked && entry.content && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-6 rounded-full border-black/10 px-2.5 text-[11.5px] dark:border-white/10"
                              onClick={() => setSelectedUsageEntry(entry)}
                            >
                              {t('recentTokenHistory.viewContent')}
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="flex items-center justify-between gap-3 pt-2">
                    <p className="text-[13px] font-medium text-muted-foreground">
                      {t('recentTokenHistory.page', { current: safeUsagePage, total: usageTotalPages })}
                    </p>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setUsagePage((page) => Math.max(1, page - 1))}
                        disabled={safeUsagePage <= 1}
                        className="h-9 rounded-full border-black/10 bg-transparent px-4 hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
                      >
                        <ChevronLeft className="mr-1 h-4 w-4" />
                        {t('recentTokenHistory.prev')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setUsagePage((page) => Math.min(usageTotalPages, page + 1))}
                        disabled={safeUsagePage >= usageTotalPages}
                        className="h-9 rounded-full border-black/10 bg-transparent px-4 hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
                      >
                        {t('recentTokenHistory.next')}
                        <ChevronRight className="ml-1 h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>

      {devModeUnlocked && selectedUsageEntry && (
        <UsageContentPopup
          entry={selectedUsageEntry}
          onClose={() => setSelectedUsageEntry(null)}
          title={t('recentTokenHistory.contentDialogTitle')}
          closeLabel={t('recentTokenHistory.close')}
          unknownModelLabel={t('recentTokenHistory.unknownModel')}
        />
      )}

      {rechargeDialogOpen && (
        <RechargePopup
          amount={rechargeAmount}
          amountOptions={rechargeAmountOptions}
          onAmountChange={setRechargeAmount}
          customAmount={customRechargeAmount}
          onCustomAmountChange={setCustomRechargeAmount}
          loading={rechargeLoading}
          order={rechargeOrder}
          onClose={() => {
            void closeRechargeDialog({ refresh: !!rechargeOrder });
          }}
          onConfirm={() => void startWechatRecharge()}
          onBack={() => {
            setRechargeOrder(null);
          }}
          onOpenExternal={() => void handleOpenTopUp(rechargeOrder?.qrCodeUrl)}
        />
      )}
    </div>
  );
}

function AccountMetricCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-2xl border border-black/10 bg-background/60 p-4 dark:border-white/10">
      <p className="text-[13px] font-medium text-muted-foreground">{label}</p>
      <p className="mt-2 break-words text-[24px] font-semibold tracking-tight text-foreground">{value}</p>
      <p className="mt-2 text-[12px] leading-5 text-muted-foreground">{hint}</p>
    </div>
  );
}

function UsageBarChart({
  groups,
  emptyLabel,
  totalLabel,
  inputLabel,
  outputLabel,
  cacheLabel,
}: {
  groups: Array<{
    label: string;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
  }>;
  emptyLabel: string;
  totalLabel: string;
  inputLabel: string;
  outputLabel: string;
  cacheLabel: string;
}) {
  if (groups.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-black/10 p-8 text-center text-[14px] font-medium text-muted-foreground dark:border-white/10">
        {emptyLabel}
      </div>
    );
  }

  const maxTokens = Math.max(...groups.map((group) => group.totalTokens), 1);

  return (
    <div className="space-y-4 rounded-2xl border border-black/10 bg-transparent p-5 dark:border-white/10">
      <div className="mb-2 flex flex-wrap gap-4 text-[13px] font-medium text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-sky-500" />
          {inputLabel}
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-violet-500" />
          {outputLabel}
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
          {cacheLabel}
        </span>
      </div>
      {groups.map((group) => (
        <div key={group.label} className="space-y-1.5">
          <div className="flex items-center justify-between gap-3 text-[13.5px]">
            <span className="truncate font-semibold text-foreground">{group.label}</span>
            <span className="font-medium text-muted-foreground">
              {totalLabel}: {formatTokenCount(group.totalTokens)}
            </span>
          </div>
          <div className="h-3.5 overflow-hidden rounded-full bg-black/5 dark:bg-white/5">
            <div
              className="flex h-full overflow-hidden rounded-full"
              style={{
                width: group.totalTokens > 0
                  ? `${Math.max((group.totalTokens / maxTokens) * 100, 6)}%`
                  : '0%',
              }}
            >
              {group.inputTokens > 0 && (
                <div
                  className="h-full bg-sky-500"
                  style={{ width: `${(group.inputTokens / group.totalTokens) * 100}%` }}
                />
              )}
              {group.outputTokens > 0 && (
                <div
                  className="h-full bg-violet-500"
                  style={{ width: `${(group.outputTokens / group.totalTokens) * 100}%` }}
                />
              )}
              {group.cacheTokens > 0 && (
                <div
                  className="h-full bg-amber-500"
                  style={{ width: `${(group.cacheTokens / group.totalTokens) * 100}%` }}
                />
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function UsageContentPopup({
  entry,
  onClose,
  title,
  closeLabel,
  unknownModelLabel,
}: {
  entry: UsageHistoryEntry;
  onClose: () => void;
  title: string;
  closeLabel: string;
  unknownModelLabel: string;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-3xl rounded-2xl border border-black/10 bg-background shadow-xl dark:border-white/10">
        <div className="flex items-start justify-between gap-3 border-b border-black/10 px-5 py-4 dark:border-white/10">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">{title}</p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {(entry.model || unknownModelLabel)} - {formatUsageTimestamp(entry.timestamp)}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-full"
            onClick={onClose}
            aria-label={closeLabel}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="max-h-[65vh] overflow-y-auto px-5 py-4">
          <pre className="whitespace-pre-wrap break-words font-mono text-sm text-foreground">
            {entry.content}
          </pre>
        </div>
        <div className="flex justify-end border-t border-black/10 px-5 py-3 dark:border-white/10">
          <Button variant="outline" onClick={onClose}>
            {closeLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

function _LegacyRechargePopup({
  amount,
  amountOptions,
  onAmountChange,
  loading,
  order,
  onConfirm,
  onBack,
  onOpenExternal,
  onClose,
}: {
  amount: number;
  amountOptions: number[];
  onAmountChange: (value: number) => void;
  loading: boolean;
  order: RechargeOrderResponse | null;
  onConfirm: () => void;
  onBack: () => void;
  onOpenExternal: () => void;
  onClose: () => void;
}) {
  const isReady = !!order;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-[540px] overflow-hidden rounded-[32px] border border-black/10 bg-background shadow-2xl dark:border-white/10">
        <div className="flex items-start justify-between gap-3 border-b border-black/10 px-5 py-4 dark:border-white/10">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">余额充值</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {isReady ? '请使用微信扫码完成支付。' : '选择金额后生成微信支付二维码。'}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-full"
            onClick={onClose}
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {!isReady ? (
          <div className="space-y-5 px-5 py-5">
            <div className="grid grid-cols-3 gap-3">
              {amountOptions.map((option) => (
                <Button
                  key={option}
                  variant={amount === option ? 'default' : 'outline'}
                  className={`h-12 rounded-2xl border transition-all ${
                    amount === option
                      ? 'border-black bg-black text-white hover:bg-black/90'
                      : 'border-black/10 bg-white hover:border-black/20 hover:bg-black/[0.03] dark:bg-background'
                  }`}
                  onClick={() => onAmountChange(option)}
                  disabled={loading}
                >
                  {option} 元
                </Button>
              ))}
            </div>

            <div className="rounded-3xl border border-black/10 bg-gradient-to-br from-black/[0.03] to-transparent p-4 dark:border-white/10">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-[13px] text-muted-foreground">本次充值</p>
                  <p className="mt-1 text-3xl font-semibold tracking-tight text-foreground">¥{amount}</p>
                </div>
                <div className="rounded-2xl border border-black/10 bg-white px-4 py-3 text-right dark:border-white/10 dark:bg-background">
                  <p className="text-[12px] text-muted-foreground">到账方式</p>
                  <p className="mt-1 text-sm font-medium text-foreground">微信扫码支付</p>
                </div>
              </div>
            </div>

            {loading && (
              <div className="rounded-2xl border border-black/10 bg-black/[0.03] px-4 py-6 text-center dark:border-white/10 dark:bg-white/[0.03]">
                <div className="mx-auto mb-3 h-9 w-9 animate-spin rounded-full border-2 border-black/15 border-t-black dark:border-white/15 dark:border-t-white" />
                <p className="text-sm font-medium text-foreground">正在生成支付二维码...</p>
                <p className="mt-1 text-xs text-muted-foreground">通常只需要几秒，如果网络慢会稍微久一点。</p>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>
                取消
              </Button>
              <Button onClick={onConfirm} disabled={loading} className="min-w-28 rounded-2xl">
                {loading ? '生成中...' : '立即充值'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-5 px-5 py-5">
            <div className="rounded-[28px] border border-black/10 bg-gradient-to-b from-black/[0.03] to-transparent p-5 text-center dark:border-white/10">
              <div className="mx-auto flex w-fit items-center rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-[12px] font-medium text-emerald-700 dark:text-emerald-300">
                支付二维码已生成
              </div>
              <div className="mx-auto mt-4 flex h-[264px] w-[264px] items-center justify-center rounded-[28px] bg-white p-4 shadow-sm">
                <img
                  src={order.qrCodeDataUrl}
                  alt="微信支付二维码"
                  className="h-full w-full rounded-[20px] object-contain"
                />
              </div>
              <p className="mt-4 text-3xl font-semibold tracking-tight text-foreground">¥{order.amount}</p>
              {order.orderNo && (
                <p className="mt-2 text-xs text-muted-foreground">订单号：{order.orderNo}</p>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <div className="flex-1 rounded-2xl border border-black/10 bg-background/60 px-4 py-3 dark:border-white/10">
                <p className="text-[12px] text-muted-foreground">支付说明</p>
                <p className="mt-1 text-sm text-foreground">使用微信扫一扫完成付款，支付成功后再回到这里刷新余额。</p>
              </div>
            </div>

            <div className="flex justify-between gap-2">
              <Button variant="outline" onClick={onBack} className="rounded-2xl">
                更换金额
              </Button>
              <div className="flex gap-2">
                <Button variant="outline" onClick={onOpenExternal} className="rounded-2xl">
                  <ExternalLink className="mr-1.5 h-4 w-4" />
                  浏览器打开
                </Button>
                <Button onClick={onClose} className="rounded-2xl">
                  完成
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function RechargePopup({
  amount,
  amountOptions,
  onAmountChange,
  customAmount,
  onCustomAmountChange,
  loading,
  order,
  onConfirm,
  onBack,
  onOpenExternal,
  onClose,
}: {
  amount: number;
  amountOptions: number[];
  onAmountChange: (value: number) => void;
  customAmount: string;
  onCustomAmountChange: (value: string) => void;
  loading: boolean;
  order: RechargeOrderResponse | null;
  onConfirm: () => void;
  onBack: () => void;
  onOpenExternal: () => void;
  onClose: () => void;
}) {
  const isReady = !!order;
  const customValue = parseRechargeAmountInput(customAmount);
  const effectiveAmount = customAmount.trim() ? customValue : amount;
  const effectiveAmountDisplay = effectiveAmount !== null ? formatRechargeAmount(effectiveAmount) : '--';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4 backdrop-blur-sm transition-opacity duration-200" role="dialog" aria-modal="true">
      <div className="w-full max-w-[620px] transform-gpu overflow-hidden rounded-[36px] border border-black/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.96),rgba(248,247,244,0.98))] shadow-[0_24px_80px_rgba(0,0,0,0.22)] transition-[transform,opacity,box-shadow] duration-200 ease-out will-change-transform dark:border-white/10 dark:bg-[linear-gradient(180deg,rgba(28,28,28,0.98),rgba(20,20,20,0.98))]">
        <div className="flex items-start justify-between gap-3 border-b border-black/10 px-6 py-5 dark:border-white/10">
          <div className="min-w-0">
            <p className="text-base font-semibold text-foreground">余额充值</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {isReady ? '请使用微信扫码完成支付。' : '选择金额后生成微信支付二维码。'}
            </p>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full" onClick={onClose} aria-label="关闭">
            <X className="h-4 w-4" />
          </Button>
        </div>

        {!isReady ? (
          <div className="space-y-5 px-6 py-6">
            <div className="rounded-[28px] border border-black/10 bg-white/70 p-4 shadow-sm dark:border-white/10 dark:bg-white/[0.03]">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-foreground">选择金额</p>
                  <p className="mt-1 text-xs text-muted-foreground">支持快捷金额，也支持自定义到分。</p>
                </div>
                <div className="rounded-full bg-black/[0.04] px-3 py-1 text-xs text-muted-foreground dark:bg-white/[0.06]">
                  最低 0.01 元
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                {amountOptions.map((option) => (
                  <Button
                    key={option}
                    variant={customAmount.trim().length === 0 && amount === option ? 'default' : 'outline'}
                    className={cn(
                      'h-12 rounded-2xl border transition-all',
                      customAmount.trim().length === 0 && amount === option
                        ? 'border-black bg-black text-white hover:bg-black/90 dark:border-white dark:bg-white dark:text-black dark:hover:bg-white/90'
                        : 'border-black/10 bg-white/90 hover:border-black/20 hover:bg-black/[0.03] dark:border-white/10 dark:bg-background dark:hover:bg-white/[0.05]',
                    )}
                    onClick={() => {
                      onCustomAmountChange('');
                      onAmountChange(option);
                    }}
                    disabled={loading}
                  >
                    ¥{formatRechargeAmount(option)}
                  </Button>
                ))}
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-[1fr_180px]">
                <div>
                  <p className="mb-2 text-[13px] font-medium text-foreground/80">自定义金额</p>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">¥</span>
                    <Input
                      inputMode="decimal"
                      placeholder="比如 0.01"
                      value={customAmount}
                      onChange={(event) => onCustomAmountChange(event.target.value)}
                      className="h-12 rounded-2xl border-black/10 bg-background pl-9 text-base dark:border-white/10"
                    />
                  </div>
                </div>
                <div className="rounded-3xl border border-black/10 bg-gradient-to-br from-[#f6f3ea] to-white p-4 dark:border-white/10 dark:from-white/[0.06] dark:to-white/[0.02]">
                  <p className="text-[12px] text-muted-foreground">本次支付</p>
                  <p className="mt-2 text-3xl font-semibold tracking-tight text-foreground">¥{effectiveAmountDisplay}</p>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">自定义金额优先；不填时使用快捷金额。</p>
                </div>
              </div>
            </div>

            {loading && (
              <div className="rounded-3xl border border-black/10 bg-black/[0.03] px-4 py-6 text-center dark:border-white/10 dark:bg-white/[0.03]">
                <div className="mx-auto mb-3 h-9 w-9 animate-spin rounded-full border-2 border-black/15 border-t-black dark:border-white/15 dark:border-t-white" />
                <p className="text-sm font-medium text-foreground">正在生成支付二维码...</p>
                <p className="mt-1 text-xs text-muted-foreground">通常只需要几秒，网络较慢时会稍微久一点。</p>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>
                取消
              </Button>
              <Button
                onClick={onConfirm}
                disabled={loading || effectiveAmount === null || effectiveAmount < 0.01}
                className="min-w-28 rounded-2xl"
              >
                {loading ? '生成中...' : '立即充值'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-5 px-6 py-6">
            <div className="rounded-[30px] border border-black/10 bg-gradient-to-b from-[#f8f6ef] to-white p-6 text-center dark:border-white/10 dark:from-white/[0.06] dark:to-white/[0.02]">
              <div className="mx-auto flex w-fit items-center rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-[12px] font-medium text-emerald-700 dark:text-emerald-300">
                支付二维码已生成
              </div>
              <div className="mx-auto mt-5 flex h-[280px] w-[280px] items-center justify-center rounded-[30px] bg-white p-4 shadow-[0_10px_30px_rgba(0,0,0,0.08)] transition-transform duration-200 ease-out">
                <img
                  src={order.qrCodeDataUrl}
                  alt="微信支付二维码"
                  className="h-full w-full rounded-[20px] object-contain"
                  loading="eager"
                  decoding="async"
                />
              </div>
              <p className="mt-5 text-4xl font-semibold tracking-tight text-foreground">¥{formatRechargeAmount(order.amount)}</p>
              {order.orderNo && (
                <p className="mt-2 text-xs text-muted-foreground">订单号：{order.orderNo}</p>
              )}
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-2xl border border-black/10 bg-background/70 px-4 py-3 dark:border-white/10">
                <p className="text-[12px] text-muted-foreground">支付说明</p>
                <p className="mt-1 text-sm text-foreground">请使用微信扫一扫完成付款，支付成功后回到这里刷新余额即可。</p>
              </div>
              <div className="rounded-2xl border border-black/10 bg-background/70 px-4 py-3 dark:border-white/10">
                <p className="text-[12px] text-muted-foreground">本次到账</p>
                <p className="mt-1 text-sm text-foreground">{order.quota ? `${formatQuotaMetric(order.quota)} 点额度` : '以下单结果为准'}</p>
              </div>
            </div>

            <div className="flex justify-between gap-2">
              <Button variant="outline" onClick={onBack} className="rounded-2xl">
                更换金额
              </Button>
              <div className="flex gap-2">
                <Button variant="outline" onClick={onOpenExternal} className="rounded-2xl">
                  <ExternalLink className="mr-1.5 h-4 w-4" />
                  浏览器打开
                </Button>
                <Button onClick={onClose} className="rounded-2xl">
                  完成
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default Models;
