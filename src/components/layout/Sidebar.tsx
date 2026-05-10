/**
 * Sidebar Component
 * Navigation sidebar with menu items.
 * No longer fixed - sits inside the flex layout below the title bar.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  Network,
  Bot,
  Puzzle,
  Clock,
  Settings as SettingsIcon,
  PanelLeftClose,
  PanelLeft,
  Plus,
  Terminal,
  ExternalLink,
  Trash2,
  Cpu,
  Search,
  X,
  Edit2,
  Check,
  Loader2,
} from 'lucide-react';
import { resolveSessionAgentId } from '@/lib/session-agent';
import { sanitizeSessionLabelText } from '@/lib/chat-display';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';
import { useChatStore, type ChatSession } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useAgentsStore } from '@/stores/agents';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { hostApiFetch } from '@/lib/host-api';
import { useTranslation } from 'react-i18next';
import logoSvg from '@/assets/logo.svg';

type SessionBucketKey =
  | 'today'
  | 'yesterday'
  | 'withinWeek'
  | 'withinTwoWeeks'
  | 'withinMonth'
  | 'older';

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  badge?: string;
  collapsed?: boolean;
  onClick?: () => void;
  testId?: string;
}

function NavItem({ to, icon, label, badge, collapsed, onClick, testId }: NavItemProps) {
  return (
    <NavLink
      to={to}
      onClick={onClick}
      data-testid={testId}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14px] font-medium transition-colors',
          'hover:bg-black/5 dark:hover:bg-white/5 text-foreground/80',
          isActive
            ? 'bg-black/5 dark:bg-white/10 text-foreground'
            : '',
          collapsed && 'justify-center px-0'
        )
      }
    >
      {({ isActive }) => (
        <>
          <div className={cn("flex shrink-0 items-center justify-center", isActive ? "text-foreground" : "text-muted-foreground")}>
            {icon}
          </div>
          {!collapsed && (
            <>
              <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
              {badge && (
                <Badge variant="secondary" className="ml-auto shrink-0">
                  {badge}
                </Badge>
              )}
            </>
          )}
        </>
      )}
    </NavLink>
  );
}

function getSessionBucket(activityMs: number, nowMs: number): SessionBucketKey {
  if (!activityMs || activityMs <= 0) return 'older';

  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;

  if (activityMs >= startOfToday) return 'today';
  if (activityMs >= startOfYesterday) return 'yesterday';

  const daysAgo = (startOfToday - activityMs) / (24 * 60 * 60 * 1000);
  if (daysAgo <= 7) return 'withinWeek';
  if (daysAgo <= 14) return 'withinTwoWeeks';
  if (daysAgo <= 30) return 'withinMonth';
  return 'older';
}

function getSessionActivityMs(session: ChatSession, sessionLastActivity: Record<string, number>): number {
  const activity = sessionLastActivity[session.key];
  if (typeof activity === 'number' && Number.isFinite(activity) && activity > 0) {
    return activity;
  }

  if (typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt) && session.updatedAt > 0) {
    return session.updatedAt;
  }

  return 0;
}

function isUnusedDraftSession(
  sessionKey: string,
  messagesLength: number,
  sessionLastActivity: Record<string, number>,
  sessionLabels: Record<string, string>,
): boolean {
  return !sessionKey.endsWith(':main')
    && messagesLength === 0
    && !sessionLastActivity[sessionKey]
    && !sessionLabels[sessionKey];
}

function getSessionKeyTail(sessionKey: string): string {
  const parts = sessionKey.split(':');
  return parts[parts.length - 1] || sessionKey;
}

function isGeneratedSessionIdentifier(value: string | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  return /^session-\d{8,}$/i.test(trimmed)
    || /^[a-f0-9]{8}$/i.test(trimmed)
    || /^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(trimmed);
}

function isMeaningfulSessionTitle(title: string | undefined, sessionKey: string): boolean {
  const trimmed = title?.trim();
  if (!trimmed || trimmed === sessionKey) {
    return false;
  }

  const sessionTail = getSessionKeyTail(sessionKey);
  if (trimmed === sessionTail) {
    return false;
  }

  return !isGeneratedSessionIdentifier(trimmed);
}

const INITIAL_NOW_MS = Date.now();

function getSafeDisplaySessionLabel(
  sessionKey: string,
  rawTitle: string | undefined,
): string {
  const sanitized = rawTitle ? sanitizeSessionLabelText(rawTitle) : '';
  if (isMeaningfulSessionTitle(sanitized, sessionKey)) {
    return sanitized;
  }
  return sessionKey.endsWith(':main') ? '\u65b0\u5bf9\u8bdd' : '\u672a\u547d\u540d\u5bf9\u8bdd';
}

function getPreferredDisplaySessionLabel(
  sessionKey: string,
  ...candidates: Array<string | undefined>
): string {
  for (const candidate of candidates) {
    const sanitized = candidate ? sanitizeSessionLabelText(candidate) : '';
    if (isMeaningfulSessionTitle(sanitized, sessionKey)) {
      return sanitized;
    }
  }
  return getSafeDisplaySessionLabel(sessionKey, undefined);
}

function isRawBotSessionLabel(value: string | undefined): boolean {
  const trimmed = value?.trim();
  return Boolean(trimmed && /^bot-[a-z0-9]+$/i.test(trimmed));
}

export function Sidebar() {
  const sidebarCollapsed = useSettingsStore((state) => state.sidebarCollapsed);
  const setSidebarCollapsed = useSettingsStore((state) => state.setSidebarCollapsed);

  const sessions = useChatStore((s) => s.sessions);
  const currentSessionKey = useChatStore((s) => s.currentSessionKey);
  const sessionLabels = useChatStore((s) => s.sessionLabels);
  const sessionLastActivity = useChatStore((s) => s.sessionLastActivity);
  const switchSession = useChatStore((s) => s.switchSession);
  const newSession = useChatStore((s) => s.newSession);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const loadHistory = useChatStore((s) => s.loadHistory);
  const channelBindings = useChatStore((s) => s.channelBindings);
  const loadChannelBindings = useChatStore((s) => s.loadChannelBindings);

  const gatewayStatus = useGatewayStore((s) => s.status);
  const isGatewayRunning = gatewayStatus.state === 'running';

  useEffect(() => {
    if (!isGatewayRunning) return;
    let cancelled = false;
    const hasExistingMessages = useChatStore.getState().messages.length > 0;
    (async () => {
      await loadSessions();
      await loadChannelBindings();
      if (cancelled) return;
      await loadHistory(hasExistingMessages);
    })();
    return () => {
      cancelled = true;
    };
  }, [isGatewayRunning, loadHistory, loadSessions, loadChannelBindings]);
  const agents = useAgentsStore((s) => s.agents);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);

  const navigate = useNavigate();
  const isOnChat = useLocation().pathname === '/';

  const getSessionLabel = useCallback(
    (session: ChatSession, agentName?: string) => {
      const resolvedLabel = getPreferredDisplaySessionLabel(
        session.key,
        sessionLabels[session.key],
        session.label,
        session.displayName,
      );
      if (isRawBotSessionLabel(resolvedLabel) && agentName) {
        return agentName;
      }
      return resolvedLabel;
    },
    [sessionLabels],
  );

  const getAgentIdFromSession = useCallback(
    (session: ChatSession): string => resolveSessionAgentId(session, channelBindings),
    [channelBindings],
  );

  const openDevConsole = async () => {
    try {
      const result = await hostApiFetch<{
        success: boolean;
        url?: string;
        error?: string;
      }>('/api/gateway/control-ui');
      if (result.success && result.url) {
        window.electron.openExternal(result.url);
      } else {
        console.error('Failed to get Dev Console URL:', result.error);
      }
    } catch (err) {
      console.error('Error opening Dev Console:', err);
    }
  };

  const { t } = useTranslation(['common', 'chat']);
  const [sessionToDelete, setSessionToDelete] = useState<{ key: string; label: string } | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [sessionToRename, setSessionToRename] = useState<{ key: string; label: string } | null>(null);
  const [renameInput, setRenameInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [nowMs, setNowMs] = useState(INITIAL_NOW_MS);
  const [isManageMode, setIsManageMode] = useState(false);
  const [selectedSessionKeys, setSelectedSessionKeys] = useState<string[]>([]);
  const [isPruningEmpty, setIsPruningEmpty] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    void fetchAgents();
  }, [fetchAgents]);

  const agentNameById = useMemo(
    () => Object.fromEntries((agents ?? []).map((agent) => [agent.id, agent.name])),
    [agents],
  );

  // Filter sessions based on search query
  const filteredSessions = useMemo(() => {
    if (!searchQuery.trim()) return sessions;
    const query = searchQuery.toLowerCase();
    return sessions.filter((s) => {
      const label = getSessionLabel(s.key, s.displayName, s.label).toLowerCase();
      const agentId = getAgentIdFromSession(s);
      const agentName = (agentNameById[agentId] || agentId).toLowerCase();
      return label.includes(query) || agentName.includes(query);
    });
  }, [sessions, searchQuery, agentNameById, getAgentIdFromSession, getSessionLabel]);

  useEffect(() => {
    setSelectedSessionKeys((current) => current.filter((key) => sessions.some((session) => session.key === key)));
  }, [sessions]);

  const selectedSessionKeySet = useMemo(
    () => new Set(selectedSessionKeys),
    [selectedSessionKeys],
  );
  const selectableSessions = useMemo(
    () => filteredSessions,
    [filteredSessions],
  );
  const allSelectableChecked = selectableSessions.length > 0
    && selectableSessions.every((session) => selectedSessionKeySet.has(session.key));
  const hasSelectedSessions = selectedSessionKeys.length > 0;

  const sortedFilteredSessions = filteredSessions;

  const sessionBuckets: Array<{ key: SessionBucketKey; label: string; sessions: typeof sessions }> = [
    { key: 'today', label: t('chat:historyBuckets.today'), sessions: [] },
    { key: 'yesterday', label: t('chat:historyBuckets.yesterday'), sessions: [] },
    { key: 'withinWeek', label: t('chat:historyBuckets.withinWeek'), sessions: [] },
    { key: 'withinTwoWeeks', label: t('chat:historyBuckets.withinTwoWeeks'), sessions: [] },
    { key: 'withinMonth', label: t('chat:historyBuckets.withinMonth'), sessions: [] },
    { key: 'older', label: t('chat:historyBuckets.older'), sessions: [] },
  ];
  const sessionBucketMap = Object.fromEntries(sessionBuckets.map((bucket) => [bucket.key, bucket])) as Record<
    SessionBucketKey,
    (typeof sessionBuckets)[number]
  >;

  for (const session of sortedFilteredSessions) {
    const bucketKey = getSessionBucket(getSessionActivityMs(session, sessionLastActivity), nowMs);
    sessionBucketMap[bucketKey].sessions.push(session);
  }

  const handleRenameSession = async (sessionKey: string, newLabel: string) => {
    if (!newLabel.trim()) return;
    try {
      // Update session label via API
      await hostApiFetch('/api/sessions/rename', {
        method: 'POST',
        body: JSON.stringify({ sessionKey, label: newLabel }),
      });
      // Update local state
      useChatStore.getState().sessionLabels[sessionKey] = newLabel;
      setSessionToRename(null);
      setRenameInput('');
    } catch (err) {
      console.error('Failed to rename session:', err);
    }
  };

  const toggleSessionSelection = useCallback((sessionKey: string, checked: boolean) => {
    setSelectedSessionKeys((current) => {
      if (checked) {
        return current.includes(sessionKey) ? current : [...current, sessionKey];
      }
      return current.filter((key) => key !== sessionKey);
    });
  }, []);

  const toggleSelectAllVisible = useCallback((checked: boolean) => {
    if (!checked) {
      setSelectedSessionKeys([]);
      return;
    }
    setSelectedSessionKeys(selectableSessions.map((session) => session.key));
  }, [selectableSessions]);

  const handleBulkDelete = useCallback(async () => {
    const deleteTargets = sessions.filter((session) => selectedSessionKeys.includes(session.key));
    for (const session of deleteTargets) {
      await deleteSession(session.key);
    }
    if (selectedSessionKeys.includes(currentSessionKey)) {
      navigate('/');
    }
    setSelectedSessionKeys([]);
    setIsManageMode(false);
    setBulkDeleteOpen(false);
  }, [currentSessionKey, deleteSession, navigate, selectedSessionKeys, sessions]);

  const handlePruneEmptySessions = useCallback(async () => {
    setIsPruningEmpty(true);
    try {
      await hostApiFetch('/api/sessions/prune-empty', { method: 'POST' });
      await loadSessions();
      await loadChannelBindings();
      await loadHistory(useChatStore.getState().messages.length > 0);
      setSelectedSessionKeys([]);
    } catch (error) {
      console.error('Failed to prune empty sessions:', error);
    } finally {
      setIsPruningEmpty(false);
    }
  }, [loadChannelBindings, loadHistory, loadSessions]);

  const navItems = [
    { to: '/models', icon: <Cpu className="h-[18px] w-[18px]" strokeWidth={2} />, label: t('sidebar.models'), testId: 'sidebar-nav-models' },
    { to: '/agents', icon: <Bot className="h-[18px] w-[18px]" strokeWidth={2} />, label: t('sidebar.agents'), testId: 'sidebar-nav-agents' },
    { to: '/channels', icon: <Network className="h-[18px] w-[18px]" strokeWidth={2} />, label: t('sidebar.channels'), testId: 'sidebar-nav-channels' },
    { to: '/skills', icon: <Puzzle className="h-[18px] w-[18px]" strokeWidth={2} />, label: t('sidebar.skills'), testId: 'sidebar-nav-skills' },
    { to: '/cron', icon: <Clock className="h-[18px] w-[18px]" strokeWidth={2} />, label: t('sidebar.cronTasks'), testId: 'sidebar-nav-cron' },
  ];

  return (
    <aside
      data-testid="sidebar"
      className={cn(
        'flex min-h-0 shrink-0 flex-col overflow-hidden border-r bg-[#eae8e1]/60 dark:bg-background transition-all duration-300',
        sidebarCollapsed ? 'w-16' : 'w-64'
      )}
    >
      {/* Top Header Toggle */}
      <div className={cn("flex items-center p-2 h-12", sidebarCollapsed ? "justify-center" : "justify-between")}>
        {!sidebarCollapsed && (
          <div className="flex items-center gap-2 px-2 overflow-hidden">
            <img src={logoSvg} alt="OpenMe" className="h-5 w-auto shrink-0" />
            <span className="text-sm font-semibold truncate whitespace-nowrap text-foreground/90">
              OpenMe
            </span>
          </div>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10"
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
        >
          {sidebarCollapsed ? (
            <PanelLeft className="h-[18px] w-[18px]" />
          ) : (
            <PanelLeftClose className="h-[18px] w-[18px]" />
          )}
        </Button>
      </div>

      {/* Navigation */}
      <nav className="flex flex-col px-2 gap-0.5">
        <button
          data-testid="sidebar-new-chat"
          onClick={() => {
            const { currentSessionKey, messages, sessionLastActivity, sessionLabels } = useChatStore.getState();
            const keepCurrentDraft = isUnusedDraftSession(
              currentSessionKey,
              messages.length,
              sessionLastActivity,
              sessionLabels,
            );
            if (!keepCurrentDraft) {
              newSession();
            }
            navigate('/');
          }}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14px] font-medium transition-colors mb-2',
            'bg-black/5 dark:bg-accent shadow-none border border-transparent text-foreground',
            sidebarCollapsed && 'justify-center px-0',
          )}
        >
          <div className="flex shrink-0 items-center justify-center text-foreground/80">
            <Plus className="h-[18px] w-[18px]" strokeWidth={2} />
          </div>
          {!sidebarCollapsed && <span className="flex-1 text-left overflow-hidden text-ellipsis whitespace-nowrap">{t('sidebar.newChat')}</span>}
        </button>

        {navItems.map((item) => (
          <NavItem
            key={item.to}
            {...item}
            collapsed={sidebarCollapsed}
          />
        ))}
      </nav>

      {/* Session list — below Settings, only when expanded */}
      {!sidebarCollapsed && sessions.length > 0 && (
        <div className="mt-4 flex-1 flex flex-col overflow-hidden px-2 pb-2">
          {/* Search box */}
          <div className="relative mb-2">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="text"
              placeholder={t('chat:searchSessions')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className={cn(
                'w-full rounded-lg border border-border bg-background/50 pl-8 pr-8 py-1.5 text-[13px]',
                'placeholder:text-muted-foreground/60',
                'focus:outline-none focus:ring-1 focus:ring-ring',
              )}
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <div className="mb-2 rounded-xl border border-black/5 bg-white/55 p-1.5 shadow-[0_1px_0_rgba(0,0,0,0.03)] dark:border-white/8 dark:bg-white/5">
            <div className="mb-1 px-1.5 text-[11px] font-medium tracking-tight text-foreground/55">
              {'\u4f1a\u8bdd\u5de5\u5177'}
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <Button
                variant={isManageMode ? 'secondary' : 'outline'}
                size="sm"
                className={cn(
                  'h-9 justify-start rounded-lg border-0 px-2.5 text-[12px] shadow-none',
                  isManageMode
                    ? 'bg-foreground text-background hover:bg-foreground/90'
                    : 'bg-black/[0.035] text-foreground/85 hover:bg-black/[0.06] dark:bg-white/[0.06] dark:hover:bg-white/[0.1]',
                )}
                onClick={() => {
                  setIsManageMode((current) => {
                    const next = !current;
                    if (!next) {
                      setSelectedSessionKeys([]);
                    }
                    return next;
                  });
                }}
              >
                <Edit2 className="mr-1.5 h-3.5 w-3.5 shrink-0" />
                {isManageMode ? '\u5b8c\u6210\u7ba1\u7406' : '\u6279\u91cf\u7ba1\u7406'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  'h-9 justify-start rounded-lg border-0 px-2.5 text-[12px] shadow-none',
                  isPruningEmpty
                    ? 'bg-amber-50 text-amber-700 hover:bg-amber-50 dark:bg-amber-500/10 dark:text-amber-300'
                    : 'bg-[#efe8da] text-foreground/85 hover:bg-[#e8dfce] dark:bg-[#3a3427] dark:text-foreground dark:hover:bg-[#453d2d]',
                )}
                disabled={isPruningEmpty}
                onClick={() => void handlePruneEmptySessions()}
              >
                {isPruningEmpty ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 shrink-0 animate-spin" />
                ) : (
                  <Trash2 className="mr-1.5 h-3.5 w-3.5 shrink-0" />
                )}
                {isPruningEmpty ? '\u6e05\u7406\u4e2d' : '\u6e05\u7406\u7a7a\u4f1a\u8bdd'}
              </Button>
            </div>
          </div>

          {isManageMode && (
            <div className="mb-2 rounded-lg border border-border/70 bg-background/50 px-2 py-2">
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-[12px] text-foreground/80">
                  <Checkbox
                    checked={allSelectableChecked}
                    onCheckedChange={toggleSelectAllVisible}
                    disabled={selectableSessions.length === 0}
                  />
                  <span>{'\u5168\u9009\u5f53\u524d\u5217\u8868'}</span>
                </label>
                <span className="text-[12px] text-muted-foreground">{'\u5df2\u9009'} {selectedSessionKeys.length}</span>
              </div>
              <div className="mt-2 flex items-center gap-1.5">
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-7 px-2 text-[12px]"
                  disabled={!hasSelectedSessions}
                  onClick={() => setBulkDeleteOpen(true)}
                >
                  {'\u6279\u91cf\u5220\u9664'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[12px]"
                  disabled={!hasSelectedSessions}
                  onClick={() => setSelectedSessionKeys([])}
                >
                  {'\u6e05\u7a7a\u9009\u62e9'}
                </Button>
              </div>
            </div>
          )}

          {/* Sessions list */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden space-y-0.5">
            {filteredSessions.length === 0 ? (
              <div className="px-2.5 py-4 text-center text-[13px] text-muted-foreground">
                {t('chat:noSessionsFound')}
              </div>
            ) : (
              sessionBuckets.map((bucket) => (
                bucket.sessions.length > 0 ? (
                  <div key={bucket.key} className="pt-2">
                    <div className="px-2.5 pb-1 text-[11px] font-medium text-muted-foreground/60 tracking-tight">
                      {bucket.label}
                    </div>
                    {bucket.sessions.map((s) => {
                      const agentId = getAgentIdFromSession(s);
                      const agentName = agentNameById[agentId] || agentId;
                      const isRenaming = sessionToRename?.key === s.key;
                      const isSelected = selectedSessionKeySet.has(s.key);
                      const canSelect = true;
                      
                      return (
                        <div key={s.key} className="group relative flex items-center">
                          {isRenaming ? (
                            <div className="w-full flex items-center gap-1 px-2.5 py-1.5">
                              <input
                                type="text"
                                value={renameInput}
                                onChange={(e) => setRenameInput(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    void handleRenameSession(s.key, renameInput);
                                  } else if (e.key === 'Escape') {
                                    setSessionToRename(null);
                                    setRenameInput('');
                                  }
                                }}
                                autoFocus
                                className="flex-1 rounded border border-border bg-background px-2 py-0.5 text-[13px] focus:outline-none focus:ring-1 focus:ring-ring"
                              />
                              <button
                                onClick={() => void handleRenameSession(s.key, renameInput)}
                                className="p-0.5 text-green-600 hover:text-green-700"
                              >
                                <Check className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => {
                                  setSessionToRename(null);
                                  setRenameInput('');
                                }}
                                className="p-0.5 text-muted-foreground hover:text-foreground"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          ) : (
                            <>
                              {isManageMode && (
                                <div className="absolute left-2 z-10">
                                  <Checkbox
                                    checked={isSelected}
                                    onCheckedChange={(checked) => toggleSessionSelection(s.key, checked)}
                                  />
                                </div>
                              )}
                              <button
                                onClick={() => {
                                  if (isManageMode) {
                                    if (canSelect) {
                                      toggleSessionSelection(s.key, !isSelected);
                                    }
                                    return;
                                  }
                                  switchSession(s.key);
                                  if (!isOnChat) {
                                    navigate('/');
                                  }
                                }}
                                className={cn(
                                  'w-full text-left rounded-lg px-2.5 py-1.5 text-[13px] transition-colors pr-14',
                                  'hover:bg-black/5 dark:hover:bg-white/5',
                                  isOnChat && currentSessionKey === s.key
                                    ? 'bg-black/5 dark:bg-white/10 text-foreground font-medium'
                                    : 'text-foreground/75',
                                  isManageMode && 'pl-8',
                                )}
                              >
                                <div className="flex min-w-0 items-center gap-2">
                                  <span className="shrink-0 rounded-full bg-black/[0.04] px-2 py-0.5 text-[10px] font-medium text-foreground/70 dark:bg-white/[0.08]">
                                    {agentName}
                                  </span>
                                  <span className="truncate">{getSessionLabel(s, agentName)}</span>
                                </div>
                              </button>
                              {!isManageMode && (
                                <div className="absolute right-1 flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
                                <button
                                  aria-label="Rename session"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSessionToRename({
                                      key: s.key,
                                      label: getSessionLabel(s, agentName),
                                    });
                                    setRenameInput(getSessionLabel(s, agentName));
                                  }}
                                  className={cn(
                                    'flex items-center justify-center rounded p-0.5 transition-colors',
                                    'text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/10',
                                  )}
                                >
                                  <Edit2 className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  aria-label="Delete session"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSessionToDelete({
                                      key: s.key,
                                      label: getSessionLabel(s, agentName),
                                    });
                                  }}
                                  className={cn(
                                    'flex items-center justify-center rounded p-0.5 transition-colors',
                                    'text-muted-foreground hover:text-destructive hover:bg-destructive/10',
                                  )}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : null
              ))
            )}
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="p-2 mt-auto">
        {/* Gateway Status */}
        <div className={cn(
          'flex items-center gap-2.5 rounded-lg px-2.5 py-2 mb-1 text-[13px]',
          sidebarCollapsed ? 'justify-center px-0' : '',
        )}>
          {gatewayStatus.state === 'running' && (
            <>
              <div className="relative flex shrink-0 items-center justify-center">
                <span className="h-2 w-2 rounded-full bg-green-500" />
                <span className="absolute h-2 w-2 rounded-full bg-green-500 animate-ping opacity-60" />
              </div>
              {!sidebarCollapsed && <span className="text-green-600 dark:text-green-500 font-medium">{t('sidebar.gatewayRunning')}</span>}
            </>
          )}
          {(gatewayStatus.state === 'starting' || gatewayStatus.state === 'reconnecting') && (
            <>
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-yellow-500" />
              {!sidebarCollapsed && <span className="text-yellow-600 dark:text-yellow-400 font-medium">{t('sidebar.gatewayStarting')}</span>}
            </>
          )}
          {gatewayStatus.state === 'error' && (
            <>
              <span className="h-2 w-2 rounded-full bg-red-500 shrink-0" />
              {!sidebarCollapsed && <span className="text-red-600 dark:text-red-400 font-medium">{t('sidebar.gatewayError')}</span>}
            </>
          )}
          {(gatewayStatus.state === 'stopped' || gatewayStatus.state === 'idle' || (!gatewayStatus.state)) && (
            <>
              <span className="h-2 w-2 rounded-full bg-muted-foreground/40 shrink-0" />
              {!sidebarCollapsed && <span className="text-muted-foreground font-medium">{t('sidebar.gatewayStopped')}</span>}
            </>
          )}
        </div>

        <NavLink
            to="/settings"
            data-testid="sidebar-nav-settings"
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14px] font-medium transition-colors',
                'hover:bg-black/5 dark:hover:bg-white/5 text-foreground/80',
                isActive && 'bg-black/5 dark:bg-white/10 text-foreground',
                sidebarCollapsed ? 'justify-center px-0' : ''
              )
            }
          >
          {({ isActive }) => (
            <>
              <div className={cn("flex shrink-0 items-center justify-center", isActive ? "text-foreground" : "text-muted-foreground")}>
                <SettingsIcon className="h-[18px] w-[18px]" strokeWidth={2} />
              </div>
              {!sidebarCollapsed && <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{t('sidebar.settings')}</span>}
            </>
          )}
        </NavLink>

        <Button
          data-testid="sidebar-open-dev-console"
          variant="ghost"
          className={cn(
            'flex items-center gap-2.5 rounded-lg px-2.5 py-2 h-auto text-[14px] font-medium transition-colors w-full mt-1',
            'hover:bg-black/5 dark:hover:bg-white/5 text-foreground/80',
            sidebarCollapsed ? 'justify-center px-0' : 'justify-start'
          )}
          onClick={openDevConsole}
        >
          <div className="flex shrink-0 items-center justify-center text-muted-foreground">
            <Terminal className="h-[18px] w-[18px]" strokeWidth={2} />
          </div>
          {!sidebarCollapsed && (
            <>
              <span className="flex-1 text-left overflow-hidden text-ellipsis whitespace-nowrap">{t('common:sidebar.openClawPage')}</span>
              <ExternalLink className="h-3 w-3 shrink-0 ml-auto opacity-50 text-muted-foreground" />
            </>
          )}
        </Button>
      </div>

      <ConfirmDialog
        open={!!sessionToDelete}
        title={t('common:actions.confirm')}
        message={t('common:sidebar.deleteSessionConfirm', { label: sessionToDelete?.label })}
        confirmLabel={t('common:actions.delete')}
        cancelLabel={t('common:actions.cancel')}
        variant="destructive"
        onConfirm={async () => {
          if (!sessionToDelete) return;
          await deleteSession(sessionToDelete.key);
          if (currentSessionKey === sessionToDelete.key) navigate('/');
          setSessionToDelete(null);
        }}
        onCancel={() => setSessionToDelete(null)}
      />
      <ConfirmDialog
        open={bulkDeleteOpen}
        title="批量删除会话"
        message={`确定删除已选中的 ${selectedSessionKeys.length} 个会话吗？`}
        confirmLabel={t('common:actions.delete')}
        cancelLabel={t('common:actions.cancel')}
        variant="destructive"
        onConfirm={handleBulkDelete}
        onCancel={() => setBulkDeleteOpen(false)}
      />
    </aside>
  );
}
