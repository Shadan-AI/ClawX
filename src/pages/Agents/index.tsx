import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Bot, Check, Plus, RefreshCw, Settings2, Trash2, X, Layout, Puzzle, Building2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Switch } from '@/components/ui/switch';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useAgentsStore } from '@/stores/agents';
import { useGatewayStore } from '@/stores/gateway';
import { useProviderStore } from '@/stores/providers';
import { useModelsStore } from '@/stores/models';
import { hostApiFetch } from '@/lib/host-api';
import { subscribeHostEvent } from '@/lib/host-events';
import { CHANNEL_ICONS, CHANNEL_NAMES, type ChannelType } from '@/types/channel';
import type { AgentSummary } from '@/types/agent';
import type { ProviderAccount, ProviderVendorInfo, ProviderWithKeyInfo } from '@/lib/providers';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import telegramIcon from '@/assets/channels/telegram.svg';
import discordIcon from '@/assets/channels/discord.svg';
import whatsappIcon from '@/assets/channels/whatsapp.svg';
import wechatIcon from '@/assets/channels/wechat.svg';
import dingtalkIcon from '@/assets/channels/dingtalk.svg';
import feishuIcon from '@/assets/channels/feishu.svg';
import wecomIcon from '@/assets/channels/wecom.svg';
import qqIcon from '@/assets/channels/qq.svg';
import { TemplateManagementDialog } from '@/components/agents/TemplateManagementDialog';
import { SkillsConfigurationView } from './SkillsConfigurationView';
import { OrganizationView } from './OrganizationView';
import { ConfettiPhysics } from '@/components/agents/ConfettiPhysics';

// 全局计数器，用于生成唯一的粒子 ID
let globalParticleId = 0;

interface ChannelAccountItem {
  accountId: string;
  name: string;
  configured: boolean;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  lastError?: string;
  isDefault: boolean;
  agentId?: string;
}

interface ChannelGroupItem {
  channelType: string;
  defaultAccountId: string;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  accounts: ChannelAccountItem[];
}

interface RuntimeProviderOption {
  runtimeProviderKey: string;
  accountId: string;
  label: string;
  modelIdPlaceholder?: string;
  configuredModelId?: string;
}

function resolveRuntimeProviderKey(account: ProviderAccount): string {
  if (account.authMode === 'oauth_browser') {
    if (account.vendorId === 'google') return 'google-gemini-cli';
    if (account.vendorId === 'openai') return 'openai-codex';
  }

  if (account.vendorId === 'custom' || account.vendorId === 'ollama') {
    const suffix = account.id.replace(/-/g, '').slice(0, 8);
    return `${account.vendorId}-${suffix}`;
  }

  if (account.vendorId === 'minimax-portal-cn') {
    return 'minimax-portal';
  }

  return account.vendorId;
}

function splitModelRef(modelRef: string | null | undefined): { providerKey: string; modelId: string } | null {
  const value = (modelRef || '').trim();
  if (!value) return null;
  const separatorIndex = value.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex >= value.length - 1) return null;
  return {
    providerKey: value.slice(0, separatorIndex),
    modelId: value.slice(separatorIndex + 1),
  };
}

function hasConfiguredProviderCredentials(
  account: ProviderAccount,
  statusById: Map<string, ProviderWithKeyInfo>,
): boolean {
  if (account.authMode === 'oauth_device' || account.authMode === 'oauth_browser' || account.authMode === 'local') {
    return true;
  }
  return statusById.get(account.id)?.hasKey ?? false;
}

export function Agents() {
  const { t } = useTranslation('agents');
  const gatewayStatus = useGatewayStore((state) => state.status);
  const refreshProviderSnapshot = useProviderStore((state) => state.refreshProviderSnapshot);
  const { digitalEmployees, fetchDigitalEmployees } = useModelsStore();
  const lastGatewayStateRef = useRef(gatewayStatus.state);
  const {
    agents,
    loading,
    error,
    fetchAgents,
    createAgent,
    deleteAgent,
  } = useAgentsStore();
  const [channelGroups, setChannelGroups] = useState<ChannelGroupItem[]>([]);
  const [hasCompletedInitialLoad, setHasCompletedInitialLoad] = useState(() => agents.length > 0);

  const [showAddDialog, setShowAddDialog] = useState(false);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [agentToDelete, setAgentToDelete] = useState<AgentSummary | null>(null);
  const [showTemplateDialog, setShowTemplateDialog] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'skills' | 'organization'>('list');
  const [globalConfetti, setGlobalConfetti] = useState<Array<{ id: number; x: number; y: number; explosionX: number; explosionY: number; color: string; size: number }>>([]);
  const lastClickTimeRef = useRef<number>(0);
  const pendingConfettiRef = useRef<Set<number>>(new Set());

  const fetchChannelAccounts = useCallback(async () => {
    try {
      const response = await hostApiFetch<{ success: boolean; channels?: ChannelGroupItem[] }>('/api/channels/accounts');
      setChannelGroups(response.channels || []);
    } catch {
      // Keep the last rendered snapshot when channel account refresh fails.
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void Promise.all([
      fetchAgents(), 
      fetchChannelAccounts(), 
      refreshProviderSnapshot(),
      fetchDigitalEmployees()
    ]).finally(() => {
      if (mounted) {
        setHasCompletedInitialLoad(true);
      }
    });
    return () => {
      mounted = false;
    };
  }, [fetchAgents, fetchChannelAccounts, refreshProviderSnapshot, fetchDigitalEmployees]);

  useEffect(() => {
    const unsubscribe = subscribeHostEvent('gateway:channel-status', () => {
      void fetchChannelAccounts();
    });
    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [fetchChannelAccounts]);

  useEffect(() => {
    const previousGatewayState = lastGatewayStateRef.current;
    lastGatewayStateRef.current = gatewayStatus.state;

    if (previousGatewayState !== 'running' && gatewayStatus.state === 'running') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void fetchChannelAccounts();
    }
  }, [fetchChannelAccounts, gatewayStatus.state]);

  const activeAgent = useMemo(
    () => agents.find((agent) => agent.id === activeAgentId) ?? null,
    [activeAgentId, agents],
  );

  // 标记哪些 agent 是数字员工
  const visibleAgents = useMemo(() => {
    const digitalEmployeeIds = new Set(digitalEmployees.map(emp => emp.openclawAgentId));
    return agents.map(agent => ({
      ...agent,
      isDigitalEmployee: digitalEmployeeIds.has(agent.id),
    }));
  }, [agents, digitalEmployees]);
  
  const visibleChannelGroups = channelGroups;
  const isUsingStableValue = loading && hasCompletedInitialLoad;
  
  const handleRefresh = () => {
    void Promise.all([fetchAgents(), fetchChannelAccounts(), fetchDigitalEmployees()]);
  };
  
  const handleDigitalEmployeeClick = (event: React.MouseEvent<HTMLDivElement>) => {
    // 严格防抖：1000ms 内只能点击一次
    const now = Date.now();
    if (now - lastClickTimeRef.current < 1000) {
      return;
    }
    lastClickTimeRef.current = now;
    
    // 严格限制最大方块数量（降低到 30）
    if (globalConfetti.length >= 30) {
      return;
    }
    
    const timestamp = Date.now();
    
    // 检查是否已经在处理中
    if (pendingConfettiRef.current.has(timestamp)) {
      return;
    }
    pendingConfettiRef.current.add(timestamp);
    
    // 获取卡片在页面中的位置
    const rect = event.currentTarget.getBoundingClientRect();
    const cardCenterX = rect.left + rect.width / 2;
    const cardCenterY = rect.top + rect.height / 2;
    
    // 生成彩色像素块 - 减少到 8 个
    const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2'];
    const newConfetti = Array.from({ length: 8 }, () => {
      const angle = (Math.random() * 360) * (Math.PI / 180);
      const explosionDistance = 60 + Math.random() * 80; // 减小爆炸范围
      
      const explosionX = Math.cos(angle) * explosionDistance;
      const explosionY = Math.sin(angle) * explosionDistance;
      
      return {
        id: ++globalParticleId, // 使用全局计数器生成唯一 ID
        x: cardCenterX,
        y: cardCenterY,
        explosionX,
        explosionY,
        color: colors[Math.floor(Math.random() * colors.length)],
        size: 4 + Math.random() * 2, // 减小方块大小：4-6px
      };
    });
    
    // 追加到现有的 confetti
    setGlobalConfetti(prev => [...prev, ...newConfetti]);
    
    // 1秒后清理这个时间戳
    setTimeout(() => {
      pendingConfettiRef.current.delete(timestamp);
    }, 1000);
  };

  if (loading && !hasCompletedInitialLoad) {
    return (
      <div className="flex flex-col -m-6 dark:bg-background min-h-[calc(100vh-2.5rem)] items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div data-testid="agents-page" className="flex flex-col -m-6 dark:bg-background h-[calc(100vh-2.5rem)] overflow-hidden relative">
      {/* 物理引擎驱动的彩色方块 */}
      <ConfettiPhysics
        particles={globalConfetti}
        onComplete={(id) => {
          setGlobalConfetti(prev => prev.filter(p => p.id !== id));
        }}
      />
      
      <div className="w-full flex flex-col h-full p-6">
        <div className="flex flex-col md:flex-row md:items-start justify-between shrink-0 gap-4 mb-4">
          <div>
            <h1
              className="text-5xl md:text-6xl font-serif text-foreground mb-3 font-normal tracking-tight"
              style={{ fontFamily: 'Georgia, Cambria, "Times New Roman", Times, serif' }}
            >
              {t('title')}
            </h1>
            <p className="text-[17px] text-foreground/70 font-medium">{t('subtitle')}</p>
          </div>
          <div className="flex items-center gap-3 md:mt-2">
            <Button
              variant="outline"
              onClick={handleRefresh}
              className="h-9 text-[13px] font-medium rounded-full px-4 border-black/10 dark:border-white/10 bg-transparent hover:bg-black/5 dark:hover:bg-white/5 shadow-none text-foreground/80 hover:text-foreground transition-colors"
            >
              <RefreshCw className={cn('h-3.5 w-3.5 mr-2', isUsingStableValue && 'animate-spin')} />
              {t('refresh')}
            </Button>
            <Button
              variant="outline"
              onClick={() => setShowTemplateDialog(true)}
              className="h-9 text-[13px] font-medium rounded-full px-4 border-black/10 dark:border-white/10 bg-transparent hover:bg-black/5 dark:hover:bg-white/5 shadow-none text-foreground/80 hover:text-foreground transition-colors"
            >
              <Layout className="h-3.5 w-3.5 mr-2" />
              模板管理
            </Button>
            <Button
              onClick={() => setShowAddDialog(true)}
              className="h-9 text-[13px] font-medium rounded-full px-4 shadow-none"
            >
              <Plus className="h-3.5 w-3.5 mr-2" />
              {t('addAgent')}
            </Button>
          </div>
        </div>

        {/* 视图切换按钮 */}
        <div className={cn(
          "flex items-center gap-2 shrink-0",
          viewMode === 'organization' ? 'mb-4' : 'mb-6'
        )}>
          <Button
            variant={viewMode === 'list' ? 'default' : 'outline'}
            onClick={() => setViewMode('list')}
            className="h-10 text-sm font-medium rounded-full px-6"
          >
            <Bot className="h-4 w-4 mr-2" />
            员工列表
          </Button>
          <Button
            variant={viewMode === 'skills' ? 'default' : 'outline'}
            onClick={() => setViewMode('skills')}
            className="h-10 text-sm font-medium rounded-full px-6"
          >
            <Puzzle className="h-4 w-4 mr-2" />
            技能配置
          </Button>
          <Button
            variant={viewMode === 'organization' ? 'default' : 'outline'}
            onClick={() => setViewMode('organization')}
            className="h-10 text-sm font-medium rounded-full px-6"
          >
            <Building2 className="h-4 w-4 mr-2" />
            组织架构
          </Button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto pr-2 pb-10 -mr-2">
          {viewMode === 'list' ? (
            <>
              {gatewayStatus.state !== 'running' && (
                <div className="mb-8 p-4 rounded-xl border border-yellow-500/50 bg-yellow-500/10 flex items-center gap-3">
                  <AlertCircle className="h-5 w-5 text-yellow-600 dark:text-yellow-400" />
                  <span className="text-yellow-700 dark:text-yellow-400 text-sm font-medium">
                    {t('gatewayWarning')}
                  </span>
                </div>
              )}

              {error && (
                <div className="mb-8 p-4 rounded-xl border border-destructive/50 bg-destructive/10 flex items-center gap-3">
                  <AlertCircle className="h-5 w-5 text-destructive" />
                  <span className="text-destructive text-sm font-medium">
                    {error}
                  </span>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {visibleAgents.map((agent) => (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    channelGroups={visibleChannelGroups}
                    onOpenSettings={() => setActiveAgentId(agent.id)}
                    onDelete={() => setAgentToDelete(agent)}
                    onDigitalEmployeeClick={handleDigitalEmployeeClick}
                  />
                ))}
              </div>
            </>
          ) : viewMode === 'skills' ? (
            <SkillsConfigurationView
              employees={agents}
              onRefresh={handleRefresh}
            />
          ) : (
            <OrganizationView />
          )}
        </div>
      </div>

      {showAddDialog && (
        <AddAgentDialog
          onClose={() => setShowAddDialog(false)}
          onCreate={async (name, options) => {
            await createAgent(name, options);
            setShowAddDialog(false);
            toast.success(t('toast.agentCreated'));
          }}
        />
      )}

      {activeAgent && (
        <AgentSettingsModal
          agent={activeAgent}
          channelGroups={visibleChannelGroups}
          onClose={() => setActiveAgentId(null)}
        />
      )}

      <ConfirmDialog
        open={!!agentToDelete}
        title={t('deleteDialog.title')}
        message={agentToDelete ? t('deleteDialog.message', { name: agentToDelete.name }) : ''}
        confirmLabel={t('common:actions.delete')}
        cancelLabel={t('common:actions.cancel')}
        variant="destructive"
        onConfirm={async () => {
          if (!agentToDelete) return;
          try {
            await deleteAgent(agentToDelete.id);
            const deletedId = agentToDelete.id;
            setAgentToDelete(null);
            if (activeAgentId === deletedId) {
              setActiveAgentId(null);
            }
            toast.success(t('toast.agentDeleted'));
          } catch (error) {
            toast.error(t('toast.agentDeleteFailed', { error: String(error) }));
          }
        }}
        onCancel={() => setAgentToDelete(null)}
      />

      <TemplateManagementDialog
        isOpen={showTemplateDialog}
        onClose={() => setShowTemplateDialog(false)}
      />
    </div>
  );
}

function AgentCard({
  agent,
  channelGroups,
  onOpenSettings,
  onDelete,
  onDigitalEmployeeClick,
}: {
  agent: AgentSummary;
  channelGroups: ChannelGroupItem[];
  onOpenSettings: () => void;
  onDelete: () => void;
  onDigitalEmployeeClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const { t } = useTranslation('agents');
  const [isShaking, setIsShaking] = useState(false);
  
  const boundChannelAccounts = channelGroups.flatMap((group) =>
    group.accounts
      .filter((account) => account.agentId === agent.id)
      .map((account) => {
        const channelName = CHANNEL_NAMES[group.channelType as ChannelType] || group.channelType;
        const accountLabel =
          account.accountId === 'default'
            ? t('settingsDialog.mainAccount')
            : account.name || account.accountId;
        return `${channelName} · ${accountLabel}`;
      }),
  );
  const channelsText = boundChannelAccounts.length > 0
    ? boundChannelAccounts.join(', ')
    : t('none');
  
  const handleDigitalEmployeeClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!agent.isDigitalEmployee) return;
    
    // 如果正在抖动，直接返回，不触发任何操作
    if (isShaking) return;
    
    // 触发全局彩色方块（会检查防抖）
    if (onDigitalEmployeeClick) {
      onDigitalEmployeeClick(event);
    }
    
    // 触发抖动动画
    setIsShaking(true);
    setTimeout(() => setIsShaking(false), 600);
  };

  return (
    <div
      className={cn(
        'group relative flex flex-col p-5 rounded-2xl transition-all border',
        isShaking && 'animate-shake',
        agent.isDigitalEmployee 
          ? 'bg-[#f3f1e9] dark:bg-white/[0.06] border-blue-500/20 dark:border-blue-500/20 shadow-sm cursor-pointer' 
          : agent.isDefault 
            ? 'bg-[#f3f1e9] dark:bg-white/[0.06] border-black/10 dark:border-white/10 shadow-sm cursor-pointer' 
            : 'bg-[#f8f6f0] dark:bg-white/[0.02] border-black/5 dark:border-white/5 hover:border-black/10 dark:hover:border-white/10 hover:shadow-lg cursor-pointer'
      )}
      onClick={agent.isDigitalEmployee ? handleDigitalEmployeeClick : onOpenSettings}
    >
      {/* 状态指示点 */}
      {agent.isDefault && (
        <div className="absolute top-3 right-3 h-2 w-2 rounded-full bg-green-500 shadow-sm"></div>
      )}

      {/* 头像 */}
      <div className="h-16 w-16 mx-auto mb-4 flex items-center justify-center text-primary bg-primary/10 rounded-full shadow-sm">
        <Bot className="h-8 w-8" />
      </div>

      {/* 名称和标签 */}
      <div className="text-center mb-3">
        <h2 className="text-[16px] font-serif font-semibold text-foreground mb-1 truncate" style={{ fontFamily: 'Georgia, Cambria, "Times New Roman", Times, serif' }}>
          {agent.name}
        </h2>
        <div className="flex items-center justify-center gap-2">
          {agent.isDefault && (
            <Badge
              variant="secondary"
              className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-primary/10 border-0 shadow-none text-primary"
            >
              <Check className="h-3 w-3 mr-1 inline" />
              {t('defaultBadge')}
            </Badge>
          )}
          {agent.isDigitalEmployee && (
            <Badge
              variant="secondary"
              className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-blue-500/10 border-0 shadow-none text-blue-600 dark:text-blue-400"
            >
              🤖 数字员工
            </Badge>
          )}
        </div>
      </div>

      {/* 信息 */}
      <div className="space-y-2 mb-4 flex-1">
        <div className="text-[12px] text-muted-foreground flex items-start gap-1.5">
          <span className="opacity-70 shrink-0">🤖</span>
          <span className="line-clamp-2">
            {t('modelLine', {
              model: agent.modelDisplay,
              suffix: agent.inheritedModel ? ` (${t('inherited')})` : '',
            })}
          </span>
        </div>
        <div className="text-[12px] text-muted-foreground flex items-start gap-1.5">
          <span className="opacity-70 shrink-0">💬</span>
          <span className="line-clamp-2">{t('channelsLine', { channels: channelsText })}</span>
        </div>
      </div>

      {/* 操作按钮 */}
      <div className="flex items-center gap-2 pt-3 border-t border-black/5 dark:border-white/5" onClick={(e) => e.stopPropagation()}>
        {agent.isDigitalEmployee ? (
          <div className="flex-1 text-center text-[11px] text-muted-foreground py-1">
            在 IM 平台管理
          </div>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="flex-1 h-8 text-[12px] rounded-full hover:bg-black/5 dark:hover:bg-white/10"
              onClick={onOpenSettings}
            >
              <Settings2 className="h-3.5 w-3.5 mr-1.5" />
              {t('settings')}
            </Button>
            {!agent.isDefault && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-full"
                onClick={onDelete}
                title={t('deleteAgent')}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const inputClasses = 'h-[44px] rounded-xl font-mono text-[13px] bg-[#eeece3] dark:bg-muted border-black/10 dark:border-white/10 focus-visible:ring-2 focus-visible:ring-blue-500/50 focus-visible:border-blue-500 shadow-sm transition-all text-foreground placeholder:text-foreground/40';
const selectClasses = 'h-[44px] w-full rounded-xl font-mono text-[13px] bg-[#eeece3] dark:bg-muted border border-black/10 dark:border-white/10 focus-visible:ring-2 focus-visible:ring-blue-500/50 focus-visible:border-blue-500 shadow-sm transition-all text-foreground px-3';
const labelClasses = 'text-[14px] text-foreground/80 font-bold';

function ChannelLogo({ type }: { type: ChannelType }) {
  switch (type) {
    case 'telegram':
      return <img src={telegramIcon} alt="Telegram" className="w-[20px] h-[20px] dark:invert" />;
    case 'discord':
      return <img src={discordIcon} alt="Discord" className="w-[20px] h-[20px] dark:invert" />;
    case 'whatsapp':
      return <img src={whatsappIcon} alt="WhatsApp" className="w-[20px] h-[20px] dark:invert" />;
    case 'wechat':
      return <img src={wechatIcon} alt="WeChat" className="w-[20px] h-[20px] dark:invert" />;
    case 'dingtalk':
      return <img src={dingtalkIcon} alt="DingTalk" className="w-[20px] h-[20px] dark:invert" />;
    case 'feishu':
      return <img src={feishuIcon} alt="Feishu" className="w-[20px] h-[20px] dark:invert" />;
    case 'wecom':
      return <img src={wecomIcon} alt="WeCom" className="w-[20px] h-[20px] dark:invert" />;
    case 'qqbot':
      return <img src={qqIcon} alt="QQ" className="w-[20px] h-[20px] dark:invert" />;
    default:
      return <span className="text-[20px] leading-none">{CHANNEL_ICONS[type] || '💬'}</span>;
  }
}

function AddAgentDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string, options: { inheritWorkspace: boolean }) => Promise<void>;
}) {
  const { t } = useTranslation('agents');
  const [name, setName] = useState('');
  const [inheritWorkspace, setInheritWorkspace] = useState(false);
  const [isDigitalEmployee, setIsDigitalEmployee] = useState(false);
  const [headImage, setHeadImage] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [saving, setSaving] = useState(false);
  
  const { models, fetchModels, createDigitalEmployee, fetchDigitalEmployees } = useModelsStore();
  const { fetchAgents } = useAgentsStore();
  
  // 加载模型列表
  useEffect(() => {
    if (isDigitalEmployee && models.length === 0) {
      fetchModels();
    }
  }, [isDigitalEmployee, models.length, fetchModels]);
  
  // 设置默认模型
  useEffect(() => {
    if (isDigitalEmployee && models.length > 0 && !selectedModel) {
      const defaultModel = models.find(m => m.id === 'glm-5')?.id || models[0]?.id || '';
      setSelectedModel(defaultModel);
    }
  }, [isDigitalEmployee, models, selectedModel]);

  const handleSubmit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      if (isDigitalEmployee) {
        // 创建数字员工
        await createDigitalEmployee(name.trim(), headImage, selectedModel);
        toast.success('数字员工创建成功');
        // 刷新列表
        await Promise.all([fetchDigitalEmployees(), fetchAgents()]);
        onClose();
      } else {
        // 创建普通 agent
        await onCreate(name.trim(), { inheritWorkspace });
      }
    } catch (error) {
      toast.error(t('toast.agentCreateFailed', { error: String(error) }));
      setSaving(false);
      return;
    }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <Card className="w-full max-w-md rounded-3xl border-0 shadow-2xl bg-[#f3f1e9] dark:bg-card overflow-hidden">
        <CardHeader className="pb-2">
          <CardTitle className="text-2xl font-serif font-normal tracking-tight">
            {t('createDialog.title')}
          </CardTitle>
          <CardDescription className="text-[15px] mt-1 text-foreground/70">
            {t('createDialog.description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6 pt-4 p-6">
          <div className="space-y-2.5">
            <Label htmlFor="agent-name" className={labelClasses}>{t('createDialog.nameLabel')}</Label>
            <Input
              id="agent-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('createDialog.namePlaceholder')}
              className={inputClasses}
            />
          </div>
          
          {/* 数字员工选项 */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="is-digital-employee" className={labelClasses}>创建为数字员工</Label>
              <p className="text-[13px] text-foreground/60">在 IM 平台创建 Bot 账号</p>
            </div>
            <Switch
              id="is-digital-employee"
              checked={isDigitalEmployee}
              onCheckedChange={setIsDigitalEmployee}
            />
          </div>
          
          {isDigitalEmployee ? (
            <>
              {/* 头像 URL */}
              <div className="space-y-2.5">
                <Label htmlFor="head-image" className={labelClasses}>头像 URL（可选）</Label>
                <Input
                  id="head-image"
                  value={headImage}
                  onChange={(event) => setHeadImage(event.target.value)}
                  placeholder="https://example.com/avatar.png"
                  className={inputClasses}
                />
              </div>
              
              {/* 模型选择 */}
              <div className="space-y-2.5">
                <Label htmlFor="model-select" className={labelClasses}>默认模型</Label>
                <select
                  id="model-select"
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  className={`${inputClasses} cursor-pointer`}
                >
                  {models.length === 0 ? (
                    <option value="">加载中...</option>
                  ) : (
                    models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name || model.id}
                      </option>
                    ))
                  )}
                </select>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="inherit-workspace" className={labelClasses}>{t('createDialog.inheritWorkspaceLabel')}</Label>
                <p className="text-[13px] text-foreground/60">{t('createDialog.inheritWorkspaceDescription')}</p>
              </div>
              <Switch
                id="inherit-workspace"
                checked={inheritWorkspace}
                onCheckedChange={setInheritWorkspace}
              />
            </div>
          )}
          
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={onClose}
              className="h-9 text-[13px] font-medium rounded-full px-4 border-black/10 dark:border-white/10 bg-transparent hover:bg-black/5 dark:hover:bg-white/5 shadow-none text-foreground/80 hover:text-foreground"
            >
              {t('common:actions.cancel')}
            </Button>
            <Button
              onClick={() => void handleSubmit()}
              disabled={saving || !name.trim()}
              className="h-9 text-[13px] font-medium rounded-full px-4 shadow-none"
            >
              {saving ? (
                <>
                  <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                  {t('creating')}
                </>
              ) : (
                t('common:actions.save')
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function AgentSettingsModal({
  agent,
  channelGroups,
  onClose,
}: {
  agent: AgentSummary;
  channelGroups: ChannelGroupItem[];
  onClose: () => void;
}) {
  const { t } = useTranslation('agents');
  const { updateAgent, defaultModelRef } = useAgentsStore();
  const [name, setName] = useState(agent.name);
  const [savingName, setSavingName] = useState(false);
  const [showModelModal, setShowModelModal] = useState(false);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);

  useEffect(() => {
    setName(agent.name);
  }, [agent.name]);

  const hasNameChanges = name.trim() !== agent.name;

  const handleRequestClose = () => {
    if (savingName || hasNameChanges) {
      setShowCloseConfirm(true);
      return;
    }
    onClose();
  };

  const handleSaveName = async () => {
    if (!name.trim() || name.trim() === agent.name) return;
    setSavingName(true);
    try {
      await updateAgent(agent.id, name.trim());
      toast.success(t('toast.agentUpdated'));
    } catch (error) {
      toast.error(t('toast.agentUpdateFailed', { error: String(error) }));
    } finally {
      setSavingName(false);
    }
  };

  const assignedChannels = channelGroups.flatMap((group) =>
    group.accounts
      .filter((account) => account.agentId === agent.id)
      .map((account) => ({
        channelType: group.channelType as ChannelType,
        accountId: account.accountId,
        name:
          account.accountId === 'default'
            ? t('settingsDialog.mainAccount')
            : account.name || account.accountId,
        error: account.lastError,
      })),
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <Card className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-3xl border-0 shadow-2xl bg-[#f3f1e9] dark:bg-card overflow-hidden">
        <CardHeader className="flex flex-row items-start justify-between pb-2 shrink-0">
          <div>
            <CardTitle className="text-2xl font-serif font-normal tracking-tight">
              {t('settingsDialog.title', { name: agent.name })}
            </CardTitle>
            <CardDescription className="text-[15px] mt-1 text-foreground/70">
              {t('settingsDialog.description')}
            </CardDescription>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleRequestClose}
            className="rounded-full h-8 w-8 -mr-2 -mt-2 text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5"
          >
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent className="space-y-6 pt-4 overflow-y-auto flex-1 p-6">
          <div className="space-y-4">
            <div className="space-y-2.5">
              <Label htmlFor="agent-settings-name" className={labelClasses}>{t('settingsDialog.nameLabel')}</Label>
              <div className="flex gap-2">
                <Input
                  id="agent-settings-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  readOnly={agent.isDefault}
                  className={inputClasses}
                />
                {!agent.isDefault && (
                  <Button
                    variant="outline"
                    onClick={() => void handleSaveName()}
                    disabled={savingName || !name.trim() || name.trim() === agent.name}
                    className="h-[44px] text-[13px] font-medium rounded-xl px-4 border-black/10 dark:border-white/10 bg-[#eeece3] dark:bg-muted hover:bg-black/5 dark:hover:bg-white/5 shadow-none text-foreground/80 hover:text-foreground"
                  >
                    {savingName ? (
                      <RefreshCw className="h-4 w-4 animate-spin" />
                    ) : (
                      t('common:actions.save')
                    )}
                  </Button>
                )}
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1 rounded-2xl bg-black/5 dark:bg-white/5 border border-transparent p-4">
                <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground/80 font-medium">
                  {t('settingsDialog.agentIdLabel')}
                </p>
                <p className="font-mono text-[13px] text-foreground">{agent.id}</p>
              </div>
              <button
                type="button"
                onClick={() => setShowModelModal(true)}
                className="space-y-1 rounded-2xl bg-black/5 dark:bg-white/5 border border-transparent p-4 text-left hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
              >
                <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground/80 font-medium">
                  {t('settingsDialog.modelLabel')}
                </p>
                <p className="text-[13.5px] text-foreground">
                  {agent.modelDisplay}
                  {agent.inheritedModel ? ` (${t('inherited')})` : ''}
                </p>
                <p className="font-mono text-[12px] text-foreground/70 break-all">
                  {agent.modelRef || defaultModelRef || '-'}
                </p>
              </button>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-xl font-serif text-foreground font-normal tracking-tight">
                  {t('settingsDialog.channelsTitle')}
                </h3>
                <p className="text-[14px] text-foreground/70 mt-1">{t('settingsDialog.channelsDescription')}</p>
              </div>
            </div>

            {assignedChannels.length === 0 && agent.channelTypes.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 p-4 text-[13.5px] text-muted-foreground">
                {t('settingsDialog.noChannels')}
              </div>
            ) : (
              <div className="space-y-3">
                {assignedChannels.map((channel) => (
                  <div key={`${channel.channelType}-${channel.accountId}`} className="flex items-center justify-between rounded-2xl bg-black/5 dark:bg-white/5 border border-transparent p-4">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="h-[40px] w-[40px] shrink-0 flex items-center justify-center text-foreground bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/10 rounded-full shadow-sm">
                        <ChannelLogo type={channel.channelType} />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[15px] font-semibold text-foreground">{channel.name}</p>
                        <p className="text-[13.5px] text-muted-foreground">
                          {CHANNEL_NAMES[channel.channelType]} · {channel.accountId === 'default' ? t('settingsDialog.mainAccount') : channel.accountId}
                        </p>
                        {channel.error && (
                          <p className="text-xs text-destructive mt-1">{channel.error}</p>
                        )}
                      </div>
                    </div>
                    <div className="shrink-0" />
                  </div>
                ))}
                {assignedChannels.length === 0 && agent.channelTypes.length > 0 && (
                  <div className="rounded-2xl border border-dashed border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 p-4 text-[13.5px] text-muted-foreground">
                    {t('settingsDialog.channelsManagedInChannels')}
                  </div>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
      {showModelModal && (
        <AgentModelModal
          agent={agent}
          onClose={() => setShowModelModal(false)}
        />
      )}
      <ConfirmDialog
        open={showCloseConfirm}
        title={t('settingsDialog.unsavedChangesTitle')}
        message={t('settingsDialog.unsavedChangesMessage')}
        confirmLabel={t('settingsDialog.closeWithoutSaving')}
        cancelLabel={t('common:actions.cancel')}
        onConfirm={() => {
          setShowCloseConfirm(false);
          setName(agent.name);
          onClose();
        }}
        onCancel={() => setShowCloseConfirm(false)}
      />
    </div>
  );
}

function AgentModelModal({
  agent,
  onClose,
}: {
  agent: AgentSummary;
  onClose: () => void;
}) {
  const { t } = useTranslation('agents');
  const providerAccounts = useProviderStore((state) => state.accounts);
  const providerStatuses = useProviderStore((state) => state.statuses);
  const providerVendors = useProviderStore((state) => state.vendors);
  const providerDefaultAccountId = useProviderStore((state) => state.defaultAccountId);
  const { updateAgentModel, defaultModelRef } = useAgentsStore();
  const [selectedRuntimeProviderKey, setSelectedRuntimeProviderKey] = useState('');
  const [modelIdInput, setModelIdInput] = useState('');
  const [savingModel, setSavingModel] = useState(false);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);

  const runtimeProviderOptions = useMemo<RuntimeProviderOption[]>(() => {
    const vendorMap = new Map<string, ProviderVendorInfo>(providerVendors.map((vendor) => [vendor.id, vendor]));
    const statusById = new Map<string, ProviderWithKeyInfo>(providerStatuses.map((status) => [status.id, status]));
    const entries = providerAccounts
      .filter((account) => account.enabled && hasConfiguredProviderCredentials(account, statusById))
      .sort((left, right) => {
        if (left.id === providerDefaultAccountId) return -1;
        if (right.id === providerDefaultAccountId) return 1;
        return right.updatedAt.localeCompare(left.updatedAt);
      });

    const deduped = new Map<string, RuntimeProviderOption>();
    for (const account of entries) {
      const runtimeProviderKey = resolveRuntimeProviderKey(account);
      if (!runtimeProviderKey || deduped.has(runtimeProviderKey)) continue;
      const vendor = vendorMap.get(account.vendorId);
      const label = `${account.label} (${vendor?.name || account.vendorId})`;
      const configuredModelId = account.model
        ? (account.model.startsWith(`${runtimeProviderKey}/`)
          ? account.model.slice(runtimeProviderKey.length + 1)
          : account.model)
        : undefined;

      deduped.set(runtimeProviderKey, {
        runtimeProviderKey,
        accountId: account.id,
        label,
        modelIdPlaceholder: vendor?.modelIdPlaceholder,
        configuredModelId,
      });
    }

    return [...deduped.values()];
  }, [providerAccounts, providerDefaultAccountId, providerStatuses, providerVendors]);

  useEffect(() => {
    const override = splitModelRef(agent.overrideModelRef);
    if (override) {
      setSelectedRuntimeProviderKey(override.providerKey);
      setModelIdInput(override.modelId);
      return;
    }

    const effective = splitModelRef(agent.modelRef || defaultModelRef);
    if (effective) {
      setSelectedRuntimeProviderKey(effective.providerKey);
      setModelIdInput(effective.modelId);
      return;
    }

    setSelectedRuntimeProviderKey(runtimeProviderOptions[0]?.runtimeProviderKey || '');
    setModelIdInput('');
  }, [agent.modelRef, agent.overrideModelRef, defaultModelRef, runtimeProviderOptions]);

  const selectedProvider = runtimeProviderOptions.find((option) => option.runtimeProviderKey === selectedRuntimeProviderKey) || null;
  const trimmedModelId = modelIdInput.trim();
  const nextModelRef = selectedRuntimeProviderKey && trimmedModelId
    ? `${selectedRuntimeProviderKey}/${trimmedModelId}`
    : '';
  const normalizedDefaultModelRef = (defaultModelRef || '').trim();
  const isUsingDefaultModelInForm = Boolean(normalizedDefaultModelRef) && nextModelRef === normalizedDefaultModelRef;
  const currentOverrideModelRef = (agent.overrideModelRef || '').trim();
  const desiredOverrideModelRef = nextModelRef && nextModelRef !== normalizedDefaultModelRef
    ? nextModelRef
    : null;
  const modelChanged = (desiredOverrideModelRef || '') !== currentOverrideModelRef;

  const handleRequestClose = () => {
    if (savingModel || modelChanged) {
      setShowCloseConfirm(true);
      return;
    }
    onClose();
  };

  const handleSaveModel = async () => {
    if (!selectedRuntimeProviderKey) {
      toast.error(t('toast.agentModelProviderRequired'));
      return;
    }
    if (!trimmedModelId) {
      toast.error(t('toast.agentModelIdRequired'));
      return;
    }
    if (!modelChanged) return;
    if (!nextModelRef.includes('/')) {
      toast.error(t('toast.agentModelInvalid'));
      return;
    }

    setSavingModel(true);
    try {
      await updateAgentModel(agent.id, desiredOverrideModelRef);
      toast.success(desiredOverrideModelRef ? t('toast.agentModelUpdated') : t('toast.agentModelReset'));
      onClose();
    } catch (error) {
      toast.error(t('toast.agentModelUpdateFailed', { error: String(error) }));
    } finally {
      setSavingModel(false);
    }
  };

  const handleUseDefaultModel = () => {
    const parsedDefault = splitModelRef(normalizedDefaultModelRef);
    if (!parsedDefault) {
      setSelectedRuntimeProviderKey('');
      setModelIdInput('');
      return;
    }
    setSelectedRuntimeProviderKey(parsedDefault.providerKey);
    setModelIdInput(parsedDefault.modelId);
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
      <Card className="w-full max-w-xl rounded-3xl border-0 shadow-2xl bg-[#f3f1e9] dark:bg-card overflow-hidden">
        <CardHeader className="flex flex-row items-start justify-between pb-2">
          <div>
            <CardTitle className="text-2xl font-serif font-normal tracking-tight">
              {t('settingsDialog.modelLabel')}
            </CardTitle>
            <CardDescription className="text-[15px] mt-1 text-foreground/70">
              {t('settingsDialog.modelOverrideDescription', { defaultModel: defaultModelRef || '-' })}
            </CardDescription>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleRequestClose}
            className="rounded-full h-8 w-8 -mr-2 -mt-2 text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5"
          >
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent className="space-y-4 p-6 pt-4">
          <div className="space-y-2">
            <Label htmlFor="agent-model-provider" className="text-[12px] text-foreground/70">{t('settingsDialog.modelProviderLabel')}</Label>
            <select
              id="agent-model-provider"
              value={selectedRuntimeProviderKey}
              onChange={(event) => {
                const nextProvider = event.target.value;
                setSelectedRuntimeProviderKey(nextProvider);
                if (!modelIdInput.trim()) {
                  const option = runtimeProviderOptions.find((candidate) => candidate.runtimeProviderKey === nextProvider);
                  setModelIdInput(option?.configuredModelId || '');
                }
              }}
              className={selectClasses}
            >
              <option value="">{t('settingsDialog.modelProviderPlaceholder')}</option>
              {runtimeProviderOptions.map((option) => (
                <option key={option.runtimeProviderKey} value={option.runtimeProviderKey}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="agent-model-id" className="text-[12px] text-foreground/70">{t('settingsDialog.modelIdLabel')}</Label>
            <Input
              id="agent-model-id"
              value={modelIdInput}
              onChange={(event) => setModelIdInput(event.target.value)}
              placeholder={selectedProvider?.modelIdPlaceholder || selectedProvider?.configuredModelId || t('settingsDialog.modelIdPlaceholder')}
              className={inputClasses}
            />
          </div>
          {!!nextModelRef && (
            <p className="text-[12px] font-mono text-foreground/70 break-all">
              {t('settingsDialog.modelPreview')}: {nextModelRef}
            </p>
          )}
          {runtimeProviderOptions.length === 0 && (
            <p className="text-[12px] text-amber-600 dark:text-amber-400">
              {t('settingsDialog.modelProviderEmpty')}
            </p>
          )}
          <div className="flex items-center justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={handleUseDefaultModel}
              disabled={savingModel || !normalizedDefaultModelRef || isUsingDefaultModelInForm}
              className="h-9 text-[13px] font-medium rounded-full px-4 border-black/10 dark:border-white/10 bg-transparent hover:bg-black/5 dark:hover:bg-white/5 shadow-none text-foreground/80 hover:text-foreground"
            >
              {t('settingsDialog.useDefaultModel')}
            </Button>
            <Button
              variant="outline"
              onClick={handleRequestClose}
              className="h-9 text-[13px] font-medium rounded-full px-4 border-black/10 dark:border-white/10 bg-transparent hover:bg-black/5 dark:hover:bg-white/5 shadow-none text-foreground/80 hover:text-foreground"
            >
              {t('common:actions.cancel')}
            </Button>
            <Button
              onClick={() => void handleSaveModel()}
              disabled={savingModel || !selectedRuntimeProviderKey || !trimmedModelId || !modelChanged}
              className="h-9 text-[13px] font-medium rounded-full px-4 shadow-none"
            >
              {savingModel ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                t('common:actions.save')
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
      <ConfirmDialog
        open={showCloseConfirm}
        title={t('settingsDialog.unsavedChangesTitle')}
        message={t('settingsDialog.unsavedChangesMessage')}
        confirmLabel={t('settingsDialog.closeWithoutSaving')}
        cancelLabel={t('common:actions.cancel')}
        onConfirm={() => {
          setShowCloseConfirm(false);
          onClose();
        }}
        onCancel={() => setShowCloseConfirm(false)}
      />
    </div>
  );
}

export default Agents;
