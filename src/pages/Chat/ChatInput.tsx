/**
 * Chat Input Component
 * Textarea with send button and universal file upload support.
 * Enter to send, Shift+Enter for new line.
 * Supports: native file picker, clipboard paste, drag & drop.
 * Files are staged to disk via IPC — only lightweight path references
 * are sent with the message (no base64 over WebSocket).
 */
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { SendHorizontal, Square, X, Paperclip, FileText, Film, Music, FileArchive, File, Loader2, AtSign, ChevronDown, Check, RefreshCw, Brain, Bot, Puzzle } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { hostApiFetch } from '@/lib/host-api';
import { invokeIpc } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { useAgentsStore } from '@/stores/agents';
import { useChatStore } from '@/stores/chat';
import { useModelsStore } from '@/stores/models';
import { useSkillsStore } from '@/stores/skills';
import type { AgentSummary } from '@/types/agent';
import { useTranslation } from 'react-i18next';

// ── Types ────────────────────────────────────────────────────────

export interface FileAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  stagedPath: string;        // disk path for gateway
  preview: string | null;    // data URL for images, null for others
  status: 'staging' | 'ready' | 'error';
  error?: string;
}

interface ChatInputProps {
  onSend: (text: string, attachments?: FileAttachment[], targetAgentId?: string | null) => void;
  onStop?: () => void;
  disabled?: boolean;
  sending?: boolean;
  isEmpty?: boolean;
  isExpanded?: boolean;
  onFocusChange?: (focused: boolean) => void;
  quickUseSkill?: { name: string; slug: string; description: string } | null;
  onSkillUsed?: () => void;
}

// ── Helpers ──────────────────────────────────────────────────────

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function FileIcon({ mimeType, className }: { mimeType: string; className?: string }) {
  if (mimeType.startsWith('video/')) return <Film className={className} />;
  if (mimeType.startsWith('audio/')) return <Music className={className} />;
  if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml') return <FileText className={className} />;
  if (mimeType.includes('zip') || mimeType.includes('compressed') || mimeType.includes('archive') || mimeType.includes('tar') || mimeType.includes('rar') || mimeType.includes('7z')) return <FileArchive className={className} />;
  if (mimeType === 'application/pdf') return <FileText className={className} />;
  return <File className={className} />;
}

/**
 * Read a browser File object as base64 string (without the data URL prefix).
 */
function readFileAsBase64(file: globalThis.File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      if (!dataUrl || !dataUrl.includes(',')) {
        reject(new Error(`Invalid data URL from FileReader for ${file.name}`));
        return;
      }
      const base64 = dataUrl.split(',')[1];
      if (!base64) {
        reject(new Error(`Empty base64 data for ${file.name}`));
        return;
      }
      resolve(base64);
    };
    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

// ── Component ────────────────────────────────────────────────────

export function ChatInput({ onSend, onStop, disabled = false, sending = false, isExpanded = true, onFocusChange, quickUseSkill, onSkillUsed }: ChatInputProps) {
  const { t } = useTranslation('chat');
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [targetAgentId, setTargetAgentId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [skillSearchQuery, setSkillSearchQuery] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const skillPickerRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);
  const agents = useAgentsStore((s) => s.agents);
  const skills = useSkillsStore((s) => s.skills);

  // 获取所有非核心技能列表（包括未启用的）
  const availableSkills = useMemo(() => {
    return (skills || []).filter(skill => !skill.isCore);
  }, [skills]);

  // 过滤技能列表
  const filteredSkills = useMemo(() => {
    if (!skillSearchQuery) return availableSkills;
    const query = skillSearchQuery.toLowerCase();
    return availableSkills.filter(skill => 
      skill.name.toLowerCase().includes(query) ||
      skill.description.toLowerCase().includes(query) ||
      (skill.slug || '').toLowerCase().includes(query)
    );
  }, [availableSkills, skillSearchQuery]);

  // 处理技能快速使用
  const [activeSkill, setActiveSkill] = useState<{ name: string; slug: string; description: string } | null>(null);
  
  useEffect(() => {
    if (quickUseSkill) {
      setActiveSkill(quickUseSkill);
      // 不填充文本,只设置技能标签
      setInput('');
      // 聚焦输入框
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
      // 通知父组件技能已使用
      onSkillUsed?.();
    }
  }, [quickUseSkill, onSkillUsed]);

  // 清除技能标签
  const handleClearSkill = useCallback(() => {
    setActiveSkill(null);
    setInput('');
    textareaRef.current?.focus();
  }, []);

  // 选择技能
  const handleSelectSkill = useCallback((skill: { name: string; slug: string; description: string }) => {
    setActiveSkill(skill);
    setInput(''); // 清空输入框,只显示技能标签
    setSkillPickerOpen(false);
    setSkillSearchQuery('');
    textareaRef.current?.focus();
  }, []);
  const currentAgentId = useChatStore((s) => s.currentAgentId);
  const currentAgentName = useMemo(
    () => (agents ?? []).find((agent) => agent.id === currentAgentId)?.name ?? currentAgentId,
    [agents, currentAgentId],
  );
  const mentionableAgents = useMemo(
    () => (agents ?? []).filter((agent) => agent.id !== currentAgentId),
    [agents, currentAgentId],
  );
  const selectedTarget = useMemo(
    () => (agents ?? []).find((agent) => agent.id === targetAgentId) ?? null,
    [agents, targetAgentId],
  );
  const showAgentPicker = mentionableAgents.length > 0;

  const models = useModelsStore((s) => s.models);
  const currentModelId = useModelsStore((s) => s.currentModelId);
  const setCurrentModel = useModelsStore((s) => s.setCurrentModel);
  const currentModel = models.find((m) => m.id === currentModelId);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);

  // Debug: 监控模型数据
  useEffect(() => {
    console.log('[ChatInput] Models:', models.length, 'Current:', currentModelId, 'Model:', currentModel?.name);
  }, [models, currentModelId, currentModel]);

  const refresh = useChatStore((s) => s.refresh);
  const loading = useChatStore((s) => s.loading);
  const showThinking = useChatStore((s) => s.showThinking);
  const toggleThinking = useChatStore((s) => s.toggleThinking);

  // Auto-resize textarea (only when expanded)
  useEffect(() => {
    if (textareaRef.current) {
      if (isExpanded) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
      } else {
        textareaRef.current.style.height = '44px';
      }
    }
  }, [input, isExpanded]);

  // Focus textarea on mount (avoids Windows focus loss after session delete + native dialog)
  useEffect(() => {
    if (!disabled && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [disabled]);

  useEffect(() => {
    if (!targetAgentId) return;
    if (targetAgentId === currentAgentId) {
      setTargetAgentId(null);
      setPickerOpen(false);
      return;
    }
    if (!(agents ?? []).some((agent) => agent.id === targetAgentId)) {
      setTargetAgentId(null);
      setPickerOpen(false);
    }
  }, [agents, currentAgentId, targetAgentId]);

  useEffect(() => {
    if (!pickerOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [pickerOpen]);

  // 点击外部关闭技能选择器
  useEffect(() => {
    if (!skillPickerOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!skillPickerRef.current?.contains(event.target as Node)) {
        setSkillPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [skillPickerOpen]);

  useEffect(() => {
    if (!modelMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!modelMenuRef.current?.contains(event.target as Node)) {
        setModelMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [modelMenuOpen]);

  // ── File staging via native dialog ─────────────────────────────

  const pickFiles = useCallback(async () => {
    try {
      const result = await invokeIpc('dialog:open', {
        properties: ['openFile', 'multiSelections'],
      }) as { canceled: boolean; filePaths?: string[] };
      if (result.canceled || !result.filePaths?.length) return;

      // Add placeholder entries immediately
      const tempIds: string[] = [];
      for (const filePath of result.filePaths) {
        const tempId = crypto.randomUUID();
        tempIds.push(tempId);
        // Handle both Unix (/) and Windows (\) path separators
        const fileName = filePath.split(/[\\/]/).pop() || 'file';
        setAttachments(prev => [...prev, {
          id: tempId,
          fileName,
          mimeType: '',
          fileSize: 0,
          stagedPath: '',
          preview: null,
          status: 'staging' as const,
        }]);
      }

      // Stage all files via IPC
      console.log('[pickFiles] Staging files:', result.filePaths);
      const staged = await hostApiFetch<Array<{
        id: string;
        fileName: string;
        mimeType: string;
        fileSize: number;
        stagedPath: string;
        preview: string | null;
      }>>('/api/files/stage-paths', {
        method: 'POST',
        body: JSON.stringify({ filePaths: result.filePaths }),
      });
      console.log('[pickFiles] Stage result:', staged?.map(s => ({ id: s?.id, fileName: s?.fileName, mimeType: s?.mimeType, fileSize: s?.fileSize, stagedPath: s?.stagedPath, hasPreview: !!s?.preview })));

      // Update each placeholder with real data
      setAttachments(prev => {
        let updated = [...prev];
        for (let i = 0; i < tempIds.length; i++) {
          const tempId = tempIds[i];
          const data = staged[i];
          if (data) {
            updated = updated.map(a =>
              a.id === tempId
                ? { ...data, status: 'ready' as const }
                : a,
            );
          } else {
            console.warn(`[pickFiles] No staged data for tempId=${tempId} at index ${i}`);
            updated = updated.map(a =>
              a.id === tempId
                ? { ...a, status: 'error' as const, error: 'Staging failed' }
                : a,
            );
          }
        }
        return updated;
      });
    } catch (err) {
      console.error('[pickFiles] Failed to stage files:', err);
      // Mark any stuck 'staging' attachments as 'error' so the user can remove them
      // and the send button isn't permanently blocked
      setAttachments(prev => prev.map(a =>
        a.status === 'staging'
          ? { ...a, status: 'error' as const, error: String(err) }
          : a,
      ));
    }
  }, []);

  // ── Stage browser File objects (paste / drag-drop) ─────────────

  const stageBufferFiles = useCallback(async (files: globalThis.File[]) => {
    for (const file of files) {
      const tempId = crypto.randomUUID();
      setAttachments(prev => [...prev, {
        id: tempId,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        fileSize: file.size,
        stagedPath: '',
        preview: null,
        status: 'staging' as const,
      }]);

      try {
        console.log(`[stageBuffer] Reading file: ${file.name} (${file.type}, ${file.size} bytes)`);
        const base64 = await readFileAsBase64(file);
        console.log(`[stageBuffer] Base64 length: ${base64?.length ?? 'null'}`);
        const staged = await hostApiFetch<{
          id: string;
          fileName: string;
          mimeType: string;
          fileSize: number;
          stagedPath: string;
          preview: string | null;
        }>('/api/files/stage-buffer', {
          method: 'POST',
          body: JSON.stringify({
            base64,
            fileName: file.name,
            mimeType: file.type || 'application/octet-stream',
          }),
        });
        console.log(`[stageBuffer] Staged: id=${staged?.id}, path=${staged?.stagedPath}, size=${staged?.fileSize}`);
        setAttachments(prev => prev.map(a =>
          a.id === tempId ? { ...staged, status: 'ready' as const } : a,
        ));
      } catch (err) {
        console.error(`[stageBuffer] Error staging ${file.name}:`, err);
        setAttachments(prev => prev.map(a =>
          a.id === tempId
            ? { ...a, status: 'error' as const, error: String(err) }
            : a,
        ));
      }
    }
  }, []);

  // ── Attachment management ──────────────────────────────────────

  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  }, []);

  const allReady = attachments.length === 0 || attachments.every(a => a.status === 'ready');
  const canSend = (input.trim() || attachments.length > 0) && allReady && !disabled && !sending;
  const canStop = sending && !disabled && !!onStop;

  const handleSend = useCallback(() => {
    if (!canSend) return;
    const readyAttachments = attachments.filter(a => a.status === 'ready');
    // Capture values before clearing — clear input immediately for snappy UX,
    // but keep attachments available for the async send
    let textToSend = input.trim();
    
    // 如果有选中的技能,在消息前添加技能提示
    if (activeSkill && textToSend) {
      textToSend = `使用 ${activeSkill.name} 技能: ${textToSend}`;
    }
    
    const attachmentsToSend = readyAttachments.length > 0 ? readyAttachments : undefined;
    console.log(`[handleSend] text="${textToSend.substring(0, 50)}", attachments=${attachments.length}, ready=${readyAttachments.length}, sending=${!!attachmentsToSend}`);
    if (attachmentsToSend) {
      console.log('[handleSend] Attachment details:', attachmentsToSend.map(a => ({
        id: a.id, fileName: a.fileName, mimeType: a.mimeType, fileSize: a.fileSize,
        stagedPath: a.stagedPath, status: a.status, hasPreview: !!a.preview,
      })));
    }
    setInput('');
    setAttachments([]);
    setActiveSkill(null); // 发送后清除技能选择
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    onSend(textToSend, attachmentsToSend, targetAgentId);
    setTargetAgentId(null);
    setPickerOpen(false);
  }, [input, attachments, canSend, onSend, targetAgentId, activeSkill]);

  const handleStop = useCallback(() => {
    if (!canStop) return;
    onStop?.();
  }, [canStop, onStop]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Backspace' && !input && targetAgentId) {
        setTargetAgentId(null);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        const nativeEvent = e.nativeEvent as KeyboardEvent;
        if (isComposingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229) {
          return;
        }
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend, input, targetAgentId],
  );

  // Handle paste (Ctrl/Cmd+V with files)
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      const pastedFiles: globalThis.File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) pastedFiles.push(file);
        }
      }
      if (pastedFiles.length > 0) {
        e.preventDefault();
        stageBufferFiles(pastedFiles);
      }
    },
    [stageBufferFiles],
  );

  // Handle drag & drop
  const [dragOver, setDragOver] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      if (e.dataTransfer?.files?.length) {
        stageBufferFiles(Array.from(e.dataTransfer.files));
      }
    },
    [stageBufferFiles],
  );

  // ── Typing particles (removed shake animation) ────────────────
  const inputBoxRef = useRef<HTMLDivElement>(null);
  const [particles, setParticles] = useState<Array<{ id: number; x: number; y: number; color: string; size: number }>>([]);
  const particleIdRef = useRef(0);

  const spawnParticles = useCallback(() => {
    if (!inputBoxRef.current) return;
    const rect = inputBoxRef.current.getBoundingClientRect();
    const colors = ['#f43f5e', '#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#06b6d4'];
    const newParticles = Array.from({ length: 3 }, () => ({
      id: particleIdRef.current++,
      x: rect.left + Math.random() * rect.width,
      y: rect.top + Math.random() * 20,
      color: colors[Math.floor(Math.random() * colors.length)],
      size: 4 + Math.random() * 6,
    }));
    setParticles(prev => [...prev.slice(-15), ...newParticles]);
    setTimeout(() => {
      setParticles(prev => prev.filter(p => !newParticles.some(np => np.id === p.id)));
    }, 700);
  }, []);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const prev = input;
    const newValue = e.target.value;
    setInput(newValue);
    
    // 检测斜杠命令
    if (newValue.startsWith('/') && !prev.startsWith('/')) {
      // 刚输入 /
      setSkillPickerOpen(true);
      setSkillSearchQuery('');
    } else if (newValue.startsWith('/')) {
      // 继续输入搜索
      const query = newValue.slice(1);
      setSkillSearchQuery(query);
      setSkillPickerOpen(true);
    } else {
      // 不是斜杠命令
      setSkillPickerOpen(false);
      setSkillSearchQuery('');
    }
    
    // Spawn particles on any content change
    if (newValue.length !== prev.length) {
      spawnParticles();
    }
  }, [input, spawnParticles]);

  return (
    <div
      className={cn(
        "w-full mx-auto transition-all duration-300 ease-out bg-transparent",
        isExpanded ? "max-w-3xl p-4 pb-4" : "max-w-2xl px-4 py-2"
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="w-full">
        {/* Attachment Previews */}
        {attachments.length > 0 && (
          <div className={cn(
            "flex gap-2 mb-3 flex-wrap transition-all duration-300",
            !isExpanded && "opacity-0 h-0 mb-0 overflow-hidden"
          )}>
            {attachments.map((att) => (
              <AttachmentPreview
                key={att.id}
                attachment={att}
                onRemove={() => removeAttachment(att.id)}
              />
            ))}
          </div>
        )}

        {/* Input Box */}
        <div 
          ref={inputBoxRef}
          className={cn(
            "relative bg-white dark:bg-card rounded-[28px] shadow-sm border transition-all duration-300 ease-out",
            dragOver ? 'border-primary ring-2 ring-primary/30' : 'border-black/8 dark:border-white/10 focus-within:border-black/20 dark:focus-within:border-white/20 focus-within:shadow-lg focus-within:shadow-black/5 dark:focus-within:shadow-white/5',
            isExpanded ? "shadow-md p-2" : "p-1"
          )}
          style={{
            transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.2s ease-out',
          } as React.CSSProperties}
        >
          <AnimatePresence mode="wait">
            {selectedTarget && (
              <motion.div
                key={selectedTarget.id}
                initial={{ opacity: 0, y: -8, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8, scale: 0.95 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                className={cn(
                  "px-2.5 pt-2 pb-1",
                  !isExpanded && "opacity-0 h-0 py-0 overflow-hidden"
                )}
              >
                <button
                  type="button"
                  onClick={() => setTargetAgentId(null)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-[13px] font-medium text-foreground transition-all duration-200 hover:bg-primary/10 hover:scale-105 active:scale-95"
                  title={t('composer.clearTarget')}
                >
                  <span>{t('composer.targetChip', { agent: selectedTarget.name })}</span>
                  <X className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Collapsed layout: single row with buttons + textarea + send */}
          {!isExpanded && (
            <div 
              className="flex items-center gap-1"
            >
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0 h-9 w-9 rounded-full text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10 hover:text-foreground"
                onClick={pickFiles}
                disabled={disabled || sending}
                title={t('composer.attachFiles')}
              >
                <Paperclip className="h-4 w-4" />
              </Button>

              <div 
                className="flex-1 relative cursor-text"
                onClick={() => {
                  // 点击时立即聚焦，这样会触发 onFocus -> onFocusChange(true) -> 展开
                  // 展开后 textarea 会保持聚焦状态
                  textareaRef.current?.focus();
                }}
              >
                <Textarea
                  ref={textareaRef}
                  value={input}
                  onChange={handleInputChange}
                  onKeyDown={handleKeyDown}
                  onCompositionStart={() => { isComposingRef.current = true; }}
                  onCompositionEnd={() => { isComposingRef.current = false; }}
                  onPaste={handlePaste}
                  onFocus={() => {
                    onFocusChange?.(true);
                    // 确保在展开后仍然保持聚焦
                    setTimeout(() => {
                      if (textareaRef.current && document.activeElement !== textareaRef.current) {
                        textareaRef.current.focus();
                      }
                    }, 50);
                  }}
                  onBlur={() => onFocusChange?.(false)}
                  placeholder={disabled ? t('composer.gatewayDisconnectedPlaceholder') : ''}
                  disabled={disabled}
                  className="resize-none border-0 focus-visible:ring-0 focus-visible:ring-offset-0 shadow-none bg-transparent px-1 placeholder:text-muted-foreground/60 !min-h-[44px] h-[44px] overflow-hidden !py-[11px] text-base leading-normal"
                  rows={1}
                />
              </div>

              <Button
                onMouseDown={(e) => {
                  // 阻止按钮点击时触发 textarea 的 blur 事件
                  e.preventDefault();
                }}
                onClick={sending ? handleStop : handleSend}
                disabled={sending ? !canStop : !canSend}
                size="icon"
                className={cn(
                  "shrink-0 h-9 w-9 rounded-full transition-all duration-300 active:scale-90",
                  (sending || canSend)
                    ? 'bg-black/5 dark:bg-white/10 text-foreground hover:bg-black/10 dark:hover:bg-white/20'
                    : 'text-muted-foreground/50 hover:bg-transparent bg-transparent',
                )}
                variant="ghost"
                title={sending ? t('composer.stop') : t('composer.send')}
              >
                {sending ? (
                  <Square className="h-4 w-4" fill="currentColor" />
                ) : (
                  <SendHorizontal className="h-4 w-4" strokeWidth={2} />
                )}
              </Button>
            </div>
          )}

          {/* Expanded layout: textarea on top, buttons on bottom row */}
          {isExpanded && (
            <div className="flex flex-col relative">
              {/* Textarea - full width, taller */}
              <div className="relative px-2 pt-2">
                <Textarea
                  ref={textareaRef}
                  value={input}
                  onChange={handleInputChange}
                  onKeyDown={handleKeyDown}
                  onCompositionStart={() => { isComposingRef.current = true; }}
                  onCompositionEnd={() => { isComposingRef.current = false; }}
                  onPaste={handlePaste}
                  onFocus={(e) => {
                    onFocusChange?.(true);
                    // 将光标移到文本末尾
                    const target = e.target;
                    const length = target.value.length;
                    setTimeout(() => {
                      target.setSelectionRange(length, length);
                    }, 0);
                  }}
                  onBlur={(e) => {
                    // 检查焦点是否移到了输入框容器内的其他元素
                    // 如果是，不触发 blur（保持展开状态）
                    const relatedTarget = e.relatedTarget as HTMLElement;
                    if (relatedTarget && inputBoxRef.current?.contains(relatedTarget)) {
                      return;
                    }
                    onFocusChange?.(false);
                  }}
                  placeholder={disabled ? t('composer.gatewayDisconnectedPlaceholder') : ''}
                  disabled={disabled}
                  className="resize-none border-0 focus-visible:ring-0 focus-visible:ring-offset-0 shadow-none bg-transparent px-1 placeholder:text-muted-foreground/60 min-h-[36px] max-h-[200px] py-1.5 text-base leading-relaxed w-full"
                  rows={1}
                />
              </div>

              {/* Bottom row: left buttons + right send/model */}
              <div className="flex items-center justify-between px-1 pb-1">
                {/* Left: current agent + skill tag + attach + @ */}
                <div className="flex items-center gap-1">
                  {/* 当前对话对象 */}
                  <div className="flex items-center gap-1.5 rounded-full border border-black/5 bg-white/70 dark:bg-white/5 px-2.5 py-1 text-[11px] font-medium text-foreground/70 dark:border-white/10">
                    <Bot className="h-3 w-3 text-primary" />
                    <span>{currentAgentName}</span>
                  </div>
                  
                  {/* Skill Tag */}
                  {activeSkill && (
                    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary text-[11px] font-medium">
                      <span>🎯 {activeSkill.name}</span>
                      <button
                        onClick={handleClearSkill}
                        className="hover:bg-primary/20 rounded-full p-0.5 transition-colors"
                        title="取消使用技能"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </div>
                  )}
                  
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 rounded-full text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10 hover:text-foreground"
                    onClick={pickFiles}
                    disabled={disabled || sending}
                    title={t('composer.attachFiles')}
                  >
                    <Paperclip className="h-5 w-5" />
                  </Button>

                  {/* Skill Picker - 始终显示 */}
                  <div ref={skillPickerRef} className="relative">
                      <Button
                        variant="ghost"
                        size="icon"
                        className={cn(
                          'h-9 w-9 rounded-full text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10 hover:text-foreground transition-colors',
                          (skillPickerOpen || activeSkill) && 'bg-primary/10 text-primary hover:bg-primary/20'
                        )}
                        onClick={() => {
                          if (activeSkill) {
                            handleClearSkill();
                          } else {
                            setSkillPickerOpen(!skillPickerOpen);
                          }
                        }}
                        disabled={disabled || sending}
                        title={activeSkill ? `当前技能: ${activeSkill.name}` : '选择技能'}
                      >
                        <Puzzle className="h-4 w-4" />
                      </Button>
                      <AnimatePresence>
                        {skillPickerOpen && (
                          <motion.div
                            initial={{ opacity: 0, y: 8, scale: 0.95 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 8, scale: 0.95 }}
                            transition={{ duration: 0.15, ease: 'easeOut' }}
                            className="absolute left-0 bottom-full z-20 mb-2 w-72 overflow-hidden rounded-2xl border border-black/10 bg-white p-1.5 shadow-xl dark:border-white/10 dark:bg-card"
                          >
                            <div className="px-3 py-2 text-[11px] font-medium text-muted-foreground/80">
                              选择技能 {skillSearchQuery && `(搜索: ${skillSearchQuery})`}
                            </div>
                            {filteredSkills.length > 0 ? (
                              <div className="max-h-64 overflow-y-auto">
                              {filteredSkills.map((skill) => (
                                <button
                                  key={skill.id}
                                  onClick={() => {
                                    if (!skill.enabled) {
                                      // 未启用的技能，提示用户
                                      return;
                                    }
                                    handleSelectSkill({ name: skill.name, slug: skill.slug || skill.id, description: skill.description });
                                  }}
                                  disabled={!skill.enabled}
                                  className={cn(
                                    "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
                                    skill.enabled 
                                      ? "hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer" 
                                      : "opacity-50 cursor-not-allowed"
                                  )}
                                >
                                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-lg">
                                    {skill.icon || '🔧'}
                                  </div>
                                  <div className="flex-1 overflow-hidden">
                                    <div className="flex items-center gap-2">
                                      <div className="truncate text-[13px] font-medium text-foreground">
                                        {skill.name}
                                      </div>
                                      {!skill.enabled && (
                                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                                          未启用
                                        </span>
                                      )}
                                    </div>
                                    <div className="truncate text-[11px] text-muted-foreground">
                                      {skill.description}
                                    </div>
                                  </div>
                                  {activeSkill?.slug === (skill.slug || skill.id) && (
                                    <Check className="h-4 w-4 shrink-0 text-primary" />
                                  )}
                                </button>
                              ))}
                            </div>
                            ) : (
                              <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">
                                暂无可用技能<br/>
                                <span className="text-[11px]">请前往技能市场安装</span>
                              </div>
                            )}
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>

                  {showAgentPicker && (
                    <div ref={pickerRef} className="relative">
                      <Button
                        variant="ghost"
                        size="icon"
                        className={cn(
                          'h-9 w-9 rounded-full text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10 hover:text-foreground transition-colors',
                          (pickerOpen || selectedTarget) && 'bg-primary/10 text-primary hover:bg-primary/20'
                        )}
                        onClick={() => setPickerOpen((open) => !open)}
                        disabled={disabled || sending}
                        title={t('composer.pickAgent')}
                      >
                        <AtSign className="h-4 w-4" />
                      </Button>
                      <AnimatePresence>
                        {pickerOpen && (
                          <motion.div
                            initial={{ opacity: 0, y: 8, scale: 0.95 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 8, scale: 0.95 }}
                            transition={{ duration: 0.15, ease: 'easeOut' }}
                            className="absolute left-0 bottom-full z-20 mb-2 w-72 overflow-hidden rounded-2xl border border-black/10 bg-white p-1.5 shadow-xl dark:border-white/10 dark:bg-card"
                          >
                            <div className="px-3 py-2 text-[11px] font-medium text-muted-foreground/80">
                              {t('composer.agentPickerTitle', { currentAgent: currentAgentName })}
                            </div>
                            <div className="max-h-64 overflow-y-auto">
                              {mentionableAgents.map((agent) => (
                                <AgentPickerItem
                                  key={agent.id}
                                  agent={agent}
                                  selected={agent.id === targetAgentId}
                                  onSelect={() => {
                                    setTargetAgentId(agent.id);
                                    setPickerOpen(false);
                                    textareaRef.current?.focus();
                                  }}
                                />
                              ))}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )}
                </div>

                {/* Right: refresh + thinking + model picker + send */}
                <div className="flex items-center gap-1">
                  {/* Refresh button */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 rounded-full text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10 hover:text-foreground"
                        onClick={() => refresh()}
                        disabled={loading}
                      >
                        <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t('toolbar.refresh')}</p>
                    </TooltipContent>
                  </Tooltip>

                  {/* Thinking toggle */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className={cn(
                          'h-9 w-9 rounded-full text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10 hover:text-foreground',
                          showThinking && 'bg-primary/10 text-primary hover:bg-primary/20'
                        )}
                        onClick={toggleThinking}
                      >
                        <Brain className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{showThinking ? t('toolbar.hideThinking') : t('toolbar.showThinking')}</p>
                    </TooltipContent>
                  </Tooltip>
                  
                  {models.length > 0 && (
                    <div ref={modelMenuRef} className="relative">
                      <button
                        type="button"
                        aria-haspopup="listbox"
                        aria-expanded={modelMenuOpen}
                        onClick={() => {
                          console.log('[ChatInput] Model menu clicked, current state:', modelMenuOpen);
                          setModelMenuOpen((open) => !open);
                        }}
                        className={cn(
                          'flex items-center gap-1 rounded-full border border-black/10 bg-black/5 dark:bg-white/10 px-3 py-2 text-[12px] font-medium text-foreground/80 dark:border-white/10',
                          'focus:outline-none focus:ring-1 focus:ring-ring/50 transition-all duration-200',
                          modelMenuOpen && 'ring-1 ring-ring/50'
                        )}
                      >
                        <span className="truncate max-w-[100px]">
                          {currentModel?.name || currentModelId || t('selectModel')}
                        </span>
                        <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform duration-200', modelMenuOpen && 'rotate-180')} />
                      </button>
                      <AnimatePresence>
                        {modelMenuOpen && (
                          <motion.div
                            initial={{ opacity: 0, y: 8, scale: 0.95 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 8, scale: 0.95 }}
                            transition={{ duration: 0.15, ease: 'easeOut' }}
                            role="listbox"
                            className="absolute z-50 right-0 bottom-full mb-2 min-w-[160px] rounded-lg border border-border bg-popover shadow-lg max-h-48 overflow-auto py-1"
                          >
                            {models.map((model) => {
                              const isSelected = model.id === currentModelId;
                              return (
                                <button
                                  key={model.id}
                                  type="button"
                                  role="option"
                                  aria-selected={isSelected}
                                  onClick={() => { 
                                    console.log('[ChatInput] Switching to model:', model.id, model.name);
                                    setCurrentModel(model.id); 
                                    setModelMenuOpen(false); 
                                  }}
                                  className={cn(
                                    'w-full px-3 py-2 text-left text-[12px] flex items-center justify-between gap-2',
                                    'hover:bg-accent transition-colors duration-150',
                                    isSelected && 'bg-accent/60'
                                  )}
                                >
                                  <span className="truncate">{model.name || model.id}</span>
                                  {isSelected && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
                                </button>
                              );
                            })}
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )}

                  <Button
                    onMouseDown={(e) => {
                      // 阻止按钮点击时触发 textarea 的 blur 事件
                      e.preventDefault();
                    }}
                    onClick={sending ? handleStop : handleSend}
                    disabled={sending ? !canStop : !canSend}
                    size="icon"
                    className={cn(
                      "h-9 w-9 shrink-0 rounded-full transition-all duration-300 active:scale-90",
                      (sending || canSend)
                        ? 'bg-black/5 dark:bg-white/10 text-foreground hover:bg-black/10 dark:hover:bg-white/20'
                        : 'text-muted-foreground/50 hover:bg-transparent bg-transparent',
                    )}
                    variant="ghost"
                    title={sending ? t('composer.stop') : t('composer.send')}
                  >
                    {sending ? (
                      <Square className="h-4 w-4" fill="currentColor" />
                    ) : (
                      <SendHorizontal className="h-4 w-4" strokeWidth={2} />
                    )}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Typing particles */}
      {particles.length > 0 && (
        <div className="fixed inset-0 pointer-events-none z-[9999]">
          {particles.map(p => (
            <div
              key={p.id}
              className="absolute rounded-full animate-[particle_0.7s_ease-out_forwards]"
              style={{
                left: p.x,
                top: p.y,
                width: p.size,
                height: p.size,
                backgroundColor: p.color,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Attachment Preview ───────────────────────────────────────────

function AttachmentPreview({
  attachment,
  onRemove,
}: {
  attachment: FileAttachment;
  onRemove: () => void;
}) {
  const isImage = attachment.mimeType.startsWith('image/') && attachment.preview;

  return (
    <div className="relative group">
      <div className="rounded-lg overflow-hidden border border-border">
        {isImage ? (
          // Image thumbnail
          <div className="w-16 h-16">
            <img
              src={attachment.preview!}
              alt={attachment.fileName}
              className="w-full h-full object-cover"
            />
          </div>
        ) : (
          // Generic file card
          <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 max-w-[200px]">
            <FileIcon mimeType={attachment.mimeType} className="h-5 w-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 overflow-hidden">
              <p className="text-xs font-medium truncate">{attachment.fileName}</p>
              <p className="text-[10px] text-muted-foreground">
                {attachment.fileSize > 0 ? formatFileSize(attachment.fileSize) : '...'}
              </p>
            </div>
          </div>
        )}

        {/* Staging overlay */}
        {attachment.status === 'staging' && (
          <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
            <Loader2 className="h-4 w-4 text-white animate-spin" />
          </div>
        )}

        {/* Error overlay */}
        {attachment.status === 'error' && (
          <div className="absolute inset-0 bg-destructive/20 flex items-center justify-center">
            <span className="text-[10px] text-destructive font-medium px-1">Error</span>
          </div>
        )}
      </div>

      {/* Remove button - outside the overflow-hidden container */}
      <button
        onClick={onRemove}
        className="absolute -top-2 -right-2 bg-destructive text-destructive-foreground rounded-full p-1 shadow-md opacity-0 group-hover:opacity-100 transition-opacity hover:scale-110"
        aria-label="Remove attachment"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function AgentPickerItem({
  agent,
  selected,
  onSelect,
}: {
  agent: AgentSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full flex-col items-start rounded-xl px-3 py-2 text-left transition-colors',
        selected ? 'bg-primary/10 text-foreground' : 'hover:bg-black/5 dark:hover:bg-white/5'
      )}
    >
      <span className="text-[14px] font-medium text-foreground">{agent.name}</span>
      <span className="text-[11px] text-muted-foreground">
        {agent.modelDisplay}
      </span>
    </button>
  );
}
