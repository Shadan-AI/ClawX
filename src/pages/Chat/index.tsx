/**
 * Chat Page
 * Native React implementation communicating with OpenClaw Gateway
 * via gateway:rpc IPC. Session selector, thinking toggle, and refresh
 * are in the toolbar; messages render with markdown + streaming.
 */
import { useEffect, useState, useCallback, useLayoutEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { AlertCircle, Loader2, Sparkles } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { useChatStore, type RawMessage } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useAgentsStore } from '@/stores/agents';
import { useModelsStore } from '@/stores/models';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';
import { extractImages, extractText, extractThinking, extractToolUse } from './message-utils';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useStickToBottomInstant } from '@/hooks/use-stick-to-bottom-instant';
import { useMinLoading } from '@/hooks/use-min-loading';

export function Chat() {
  const { t } = useTranslation('chat');
  const location = useLocation();
  const gatewayStatus = useGatewayStore((s) => s.status);
  const isGatewayRunning = gatewayStatus.state === 'running';

  const messages = useChatStore((s) => s.messages);
  const currentSessionKey = useChatStore((s) => s.currentSessionKey);
  const loading = useChatStore((s) => s.loading);
  
  // 技能快速使用状态
  const [quickUseSkill, setQuickUseSkill] = useState<{ name: string; slug: string; description: string } | null>(null);
  
  // 处理从员工列表跳转过来创建新会话的情况
  useEffect(() => {
    const state = location.state as { createNewSessionFor?: string; quickUseSkill?: { name: string; slug: string; description: string } } | null;
    
    // 处理技能快速使用
    if (state?.quickUseSkill) {
      console.log('[Chat] Quick use skill:', state.quickUseSkill);
      setQuickUseSkill(state.quickUseSkill);
      // 清除 location state，避免重复触发
      window.history.replaceState({}, document.title);
    }
    // 处理创建新会话
    else if (state?.createNewSessionFor) {
      const agentId = state.createNewSessionFor;
      // 创建新会话，sessionKey 格式必须是 agent:agentId:session-timestamp
      const newSessionKey = `agent:${agentId}:session-${Date.now()}`;
      
      console.log('[Chat] Creating new session for agent:', { agentId, newSessionKey });
      
      // 切换到新会话（switchSession 会自动更新 currentAgentId）
      useChatStore.getState().switchSession(newSessionKey);
      
      // 清除 location state，避免重复触发
      window.history.replaceState({}, document.title);
    }
  }, [location]);
  const sending = useChatStore((s) => s.sending);
  const error = useChatStore((s) => s.error);
  const showThinking = useChatStore((s) => s.showThinking);
  const streamingMessage = useChatStore((s) => s.streamingMessage);
  const streamingTools = useChatStore((s) => s.streamingTools);
  const pendingFinal = useChatStore((s) => s.pendingFinal);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const abortRun = useChatStore((s) => s.abortRun);
  const clearError = useChatStore((s) => s.clearError);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);

  const cleanupEmptySession = useChatStore((s) => s.cleanupEmptySession);

  const [streamingTimestamp, setStreamingTimestamp] = useState<number>(0);
  const minLoading = useMinLoading(loading && messages.length > 0);
  const { contentRef, scrollRef } = useStickToBottomInstant(currentSessionKey);

  const [isAtBottom, setIsAtBottom] = useState(true);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const isInputExpanded = isAtBottom || isInputFocused;

  // Debug: 监控状态变化
  useEffect(() => {
    console.log('[Chat] State:', { isAtBottom, isInputFocused, isInputExpanded });
  }, [isAtBottom, isInputFocused, isInputExpanded]);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      // 使用平滑滚动
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth'
      });
    }
  }, [scrollRef]);

  // 包装 sendMessage，在发送后自动滚动到底部
  const handleSendMessage = useCallback((text: string, attachments?: any[], targetAgentId?: string | null) => {
    sendMessage(text, attachments, targetAgentId);
  }, [sendMessage]);

  // 监听消息变化，当有新消息时自动滚动到底部
  useEffect(() => {
    if (messages.length > 0) {
      // 延迟滚动，确保消息已完全渲染到 DOM
      const timer = setTimeout(() => {
        scrollToBottom();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [messages.length, scrollToBottom]);

  // 检查是否在底部
  const checkIsAtBottom = useCallback(() => {
    if (scrollRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
      // 如果内容高度小于等于容器高度，说明没有滚动条，视为在底部
      if (scrollHeight <= clientHeight) {
        console.log('[Chat] No scroll needed, setting isAtBottom=true');
        setIsAtBottom(true);
        return true;
      }
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      const isBottom = distanceFromBottom < 50;
      console.log('[Chat] Scroll check:', { scrollTop, scrollHeight, clientHeight, distanceFromBottom, isBottom });
      setIsAtBottom(isBottom);
      return isBottom;
    }
    return true;
  }, [scrollRef]);

  // 当输入框获得焦点时，不自动滚动，只更新展开状态
  // 用户可能正在查看历史消息，不应该强制滚动到底部

  // 监听滚动事件
  const handleScroll = useCallback(() => {
    checkIsAtBottom();
  }, [checkIsAtBottom]);

  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (scrollElement) {
      scrollElement.addEventListener('scroll', handleScroll);
      // 初始化时检查一次
      checkIsAtBottom();
      return () => scrollElement.removeEventListener('scroll', handleScroll);
    }
  }, [handleScroll, scrollRef, checkIsAtBottom]);

  // 会话切换或消息变化时，重新检查滚动位置
  useLayoutEffect(() => {
    checkIsAtBottom();
  }, [currentSessionKey, messages.length, checkIsAtBottom]);

  // 监听内容区域的高度变化（例如展开/收起 thinking 卡片）
  useEffect(() => {
    const contentElement = contentRef.current;
    if (!contentElement) return;

    const resizeObserver = new ResizeObserver(() => {
      // 内容高度变化时，重新检查是否在底部
      checkIsAtBottom();
    });

    resizeObserver.observe(contentElement);
    return () => resizeObserver.disconnect();
  }, [contentRef, checkIsAtBottom]);

  // Load data when gateway is running.
  // When the store already holds messages for this session (i.e. the user
  // is navigating *back* to Chat), use quiet mode so the existing messages
  // stay visible while fresh data loads in the background.  This avoids
  // an unnecessary messages 鈫?spinner 鈫?messages flicker.
  useEffect(() => {
    return () => {
      // If the user navigates away without sending any messages, remove the
      // empty session so it doesn't linger as a ghost entry in the sidebar.
      cleanupEmptySession();
    };
  }, [cleanupEmptySession]);

  useEffect(() => {
    void fetchAgents();
  }, [fetchAgents]);

  // Fetch models on mount
  useEffect(() => {
    void useModelsStore.getState().fetchModels();
  }, []);

  // Sync model display when session changes (agent switch / session switch)
  useEffect(() => {
    if (currentSessionKey) {
      void useModelsStore.getState().ensureSessionModel(currentSessionKey);
    }
  }, [currentSessionKey]);
  // Update timestamp when sending starts
  useEffect(() => {
    if (sending && streamingTimestamp === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStreamingTimestamp(Date.now() / 1000);
    } else if (!sending && streamingTimestamp !== 0) {
      setStreamingTimestamp(0);
    }
  }, [sending, streamingTimestamp]);

  // Gateway not running block has been completely removed so the UI always renders.

  const streamMsg = streamingMessage && typeof streamingMessage === 'object'
    ? streamingMessage as unknown as { role?: string; content?: unknown; timestamp?: number }
    : null;
  const streamText = streamMsg ? extractText(streamMsg) : (typeof streamingMessage === 'string' ? streamingMessage : '');
  const hasStreamText = streamText.trim().length > 0;
  const streamThinking = streamMsg ? extractThinking(streamMsg) : null;
  const hasStreamThinking = showThinking && !!streamThinking && streamThinking.trim().length > 0;
  const streamTools = streamMsg ? extractToolUse(streamMsg) : [];
  const hasStreamTools = streamTools.length > 0;
  const streamImages = streamMsg ? extractImages(streamMsg) : [];
  const hasStreamImages = streamImages.length > 0;
  const hasStreamToolStatus = streamingTools.length > 0;
  const shouldRenderStreaming = sending && (hasStreamText || hasStreamThinking || hasStreamTools || hasStreamImages || hasStreamToolStatus);
  const hasAnyStreamContent = hasStreamText || hasStreamThinking || hasStreamTools || hasStreamImages || hasStreamToolStatus;

  const isEmpty = messages.length === 0 && !sending && !loading;
  const isLoading = loading && messages.length === 0 && !sending;

  // 点击消息区域时，让输入框失去焦点（收起输入框）
  const handleMessagesAreaClick = useCallback(() => {
    if (isInputFocused) {
      setIsInputFocused(false);
    }
  }, [isInputFocused]);

  return (
    <div className={cn("relative flex flex-col -m-6 transition-colors duration-500 dark:bg-background")} style={{ height: 'calc(100vh - 2.5rem)' }}>
      {/* Messages Area */}
      <div 
        ref={scrollRef} 
        className="flex-1 overflow-y-auto px-4 py-4 pb-40"
        onClick={handleMessagesAreaClick}
      >
        <div ref={contentRef} className="max-w-4xl mx-auto space-y-5 relative">
          <AnimatePresence mode="wait">
            {isLoading ? (
              <motion.div
                key="loading"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.2 }}
                className="flex items-center justify-center min-h-[60vh]"
              >
                <div className="flex flex-col items-center gap-4">
                  <div className="relative">
                    <div className="w-12 h-12 rounded-full border-4 border-primary/20"></div>
                    <div className="absolute inset-0 w-12 h-12 rounded-full border-4 border-primary border-t-transparent animate-spin"></div>
                  </div>
                  <p className="text-sm text-muted-foreground animate-pulse">加载消息中...</p>
                </div>
              </motion.div>
            ) : isEmpty ? (
              <motion.div
                key="welcome"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
              >
                <WelcomeScreen />
              </motion.div>
            ) : (
              <motion.div
                key={currentSessionKey}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                className="space-y-5"
              >
                {messages.map((msg, idx) => (
                  <ChatMessage
                    key={msg.id || `msg-${idx}`}
                    message={msg}
                    showThinking={showThinking}
                  />
                ))}

                {/* Streaming message */}
                {shouldRenderStreaming && (
                  <ChatMessage
                    message={(streamMsg
                      ? {
                          ...(streamMsg as Record<string, unknown>),
                          role: (typeof streamMsg.role === 'string' ? streamMsg.role : 'assistant') as RawMessage['role'],
                          content: streamMsg.content ?? streamText,
                          timestamp: streamMsg.timestamp ?? streamingTimestamp,
                        }
                      : {
                          role: 'assistant',
                          content: streamText,
                          timestamp: streamingTimestamp,
                        }) as RawMessage}
                    showThinking={showThinking}
                    isStreaming
                    streamingTools={streamingTools}
                  />
                )}

                {/* Activity indicator: waiting for next AI turn after tool execution */}
                {sending && pendingFinal && !shouldRenderStreaming && (
                  <ActivityIndicator phase="tool_processing" />
                )}

                {/* Typing indicator when sending but no stream content yet */}
                {sending && !pendingFinal && !hasAnyStreamContent && (
                  <TypingIndicator />
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Input Area - Floating */}
      <div className="absolute bottom-0 left-0 right-0 z-10 pointer-events-none">
        {/* Error bar — hide "Gateway stopped" since it's a normal shutdown event */}
        {error && !error.includes('Gateway stopped') && (
          <div className="pointer-events-auto px-4 py-2 bg-destructive/10 border-y border-destructive/20">
            <div className="max-w-4xl mx-auto flex items-center justify-between">
              <p className="text-sm text-destructive flex items-center gap-2">
                <AlertCircle className="h-4 w-4" />
                {error}
              </p>
              <button
                onClick={clearError}
                className="text-xs text-destructive/60 hover:text-destructive underline"
              >
                {t('common:actions.dismiss')}
              </button>
            </div>
          </div>
        )}
        <div className="pointer-events-auto">
          <ChatInput
            onSend={sendMessage}
            onStop={abortRun}
            disabled={!isGatewayRunning}
            sending={sending}
            isExpanded={isInputExpanded}
            onFocusChange={setIsInputFocused}
            quickUseSkill={quickUseSkill}
            onSkillUsed={() => setQuickUseSkill(null)}
          />
        </div>
      </div>

      {/* Transparent loading overlay */}
      {minLoading && !sending && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/20 backdrop-blur-[1px] rounded-xl pointer-events-auto">
          <div className="bg-background shadow-lg rounded-full p-2.5 border border-border">
            <LoadingSpinner size="md" />
          </div>
        </div>
      )}
    </div>
  );
}

// 鈹€鈹€ Welcome Screen 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

function WelcomeScreen() {
  const { t } = useTranslation('chat');
  const quickActions = [
    { key: 'askQuestions', label: t('welcome.askQuestions') },
    { key: 'creativeTasks', label: t('welcome.creativeTasks') },
    { key: 'brainstorming', label: t('welcome.brainstorming') },
  ];

  return (
    <div className="flex flex-col items-center justify-center text-center h-[60vh]">
      <div className="mb-6 animate-in fade-in-0 zoom-in-90 duration-700 ease-out">
        <div className="h-16 w-16 mx-auto rounded-full bg-gradient-to-br from-violet-500/20 to-blue-500/20 flex items-center justify-center">
          <Sparkles className="h-8 w-8 text-foreground/40" />
        </div>
      </div>
      <h1 className="text-4xl md:text-5xl font-serif text-foreground/80 mb-8 font-normal tracking-tight animate-in fade-in-0 duration-700 ease-out delay-200" style={{ fontFamily: 'Georgia, Cambria, "Times New Roman", Times, serif' }}>
        {t('welcome.subtitle')}
      </h1>

      <div className="flex flex-wrap items-center justify-center gap-2.5 max-w-lg w-full animate-in fade-in-0 duration-700 ease-out delay-400">
        {quickActions.map(({ key, label }) => (
          <button 
            key={key}
            className="px-4 py-1.5 rounded-full border border-black/10 dark:border-white/10 text-[13px] font-medium text-foreground/70 hover:bg-black/5 dark:hover:bg-white/5 hover:scale-105 active:scale-95 transition-all duration-200 bg-black/[0.02]"
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

// 鈹€鈹€ Typing Indicator 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

function TypingIndicator() {
  return (
    <div className="flex gap-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full mt-1 bg-black/5 dark:bg-white/5 text-foreground">
        <Sparkles className="h-4 w-4" />
      </div>
      <div className="bg-black/5 dark:bg-white/5 text-foreground rounded-2xl px-4 py-3">
        <div className="flex gap-1">
          <span className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
          <span className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
          <span className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
        </div>
      </div>
    </div>
  );
}

// 鈹€鈹€ Activity Indicator (shown between tool cycles) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

function ActivityIndicator({ phase }: { phase: 'tool_processing' }) {
  void phase;
  return (
    <div className="flex gap-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full mt-1 bg-black/5 dark:bg-white/5 text-foreground">
        <Sparkles className="h-4 w-4" />
      </div>
      <div className="bg-black/5 dark:bg-white/5 text-foreground rounded-2xl px-4 py-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          <span>Processing tool results…</span>
        </div>
      </div>
    </div>
  );
}

export default Chat;
