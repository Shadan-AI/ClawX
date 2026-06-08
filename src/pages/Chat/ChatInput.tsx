/**
 * Chat Input Component
 * Textarea with send button and universal file upload support.
 * Enter to send, Shift+Enter for new line.
 * Supports: native file picker, clipboard paste, drag & drop.
 * Files are staged to disk via IPC — only lightweight path references
 * are sent with the message (no base64 over WebSocket).
 */
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { SendHorizontal, Square, Pause, X, Paperclip, FileText, Film, Music, FileArchive, File, Loader2, AtSign, ChevronDown, Check, RefreshCw, Brain, Bot, Puzzle } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { hostApiFetch } from '@/lib/host-api';
import { invokeIpc } from '@/lib/api-client';
import { getAgentIdFromSessionKey, resolveSessionAgentIdByKey } from '@/lib/session-agent';
import { AgentAvatar } from '@/components/common/AgentAvatar';
import { SKILL_TRIAL_AGENT_ID } from '@/lib/skill-trial';
import { cn } from '@/lib/utils';
import { useAgentsStore } from '@/stores/agents';
import { useChatStore } from '@/stores/chat';
import { useModelsStore } from '@/stores/models';
import { useSkillsStore } from '@/stores/skills';
import type { AgentSummary } from '@/types/agent';
import { useTranslation } from 'react-i18next';

const CONTEXT_MENU_INTERACT_EVENT = 'clawx-context-menu-interact';
const MAX_TEXTAREA_HEIGHT = 168;

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
  onSend: (text: string, attachments?: FileAttachment[], targetAgentId?: string | null) => void | boolean | Promise<void | boolean>;
  onModelChange?: (modelId: string) => void | Promise<void>;
  onStop?: () => void;
  disabled?: boolean;
  sending?: boolean;
  stopIcon?: 'square' | 'pause';
  isEmpty?: boolean;
  isExpanded?: boolean;
  onFocusChange?: (focused: boolean) => void;
  quickUseSkill?: { name: string; slug: string; description: string } | null;
  onSkillUsed?: () => void;
  disabledPlaceholder?: string;
}

function modelIdFromRef(modelValue: string | null | undefined): string | null {
  const trimmed = (modelValue || '').trim();
  if (!trimmed) return null;
  return trimmed.startsWith('shadan/') ? trimmed.slice('shadan/'.length) : trimmed;
}

function messageDiagnostic(text: string) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return {
    length: text.length,
    hash: (hash >>> 0).toString(16).padStart(8, '0'),
  };
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

// ── 碎碎念生成器 ──────────────────────────────────────────────────

interface MurmurContext {
  agentName: string;
  skillCount: number;
  skillNames: string[];
  templateName?: string;
  modelDisplay?: string;
  isDigitalEmployee?: boolean;
  runtimeType?: string;
}

function generateMurmur(ctx: MurmurContext): string {
  const { agentName, skillCount, skillNames, templateName, modelDisplay, isDigitalEmployee, runtimeType } = ctx;

  const pool: string[] = [];

  // 技能相关
  if (skillCount === 0) {
    pool.push('我还没学到任何技能呢...感觉自己像个白纸 😶');
    pool.push('技能栏是空的，老板啥都没给我安排...');
    pool.push('我现在只会聊天，别的啥也不会，别为难我哈');
  } else if (skillCount <= 3) {
    pool.push(`我会 ${skillCount} 个技能：${skillNames.join('、')}，勉强够用吧`);
    pool.push(`技能不多但够用！${skillNames.join('、')} 都是我的拿手好戏`);
    pool.push(`目前就 ${skillCount} 个技能，别嫌弃，我在努力学了`);
  } else {
    pool.push(`我可是会 ${skillCount} 个技能的全能选手！${skillNames.slice(0, 3).join('、')}...等等一大堆`);
    pool.push(`技能栏满满的！${skillNames.slice(0, 2).join('、')}什么的都是基操`);
    pool.push(`${skillCount} 个技能加身，有什么需要尽管吩咐！`);
  }

  // 岗位相关
  if (templateName) {
    pool.push(`我的岗位是「${templateName}」，听起来很厉害的样子`);
    pool.push(`身为「${templateName}」，我可是很专业的`);
    pool.push(`「${templateName}」就是我，我就是「${templateName}」`);
  } else {
    pool.push('我好像还没定岗位...自由职业者？');
    pool.push('没有岗位模板的束缚，我是自由的灵魂！');
  }

  // 模型相关
  if (modelDisplay) {
    pool.push(`我现在的脑子是 ${modelDisplay}，转得还挺快的`);
    pool.push(`用的是 ${modelDisplay} 模型，思考中...请稍等...`);
  }

  // 运行方式
  if (runtimeType === 'native-cli') {
    pool.push('我现在跑在本地 CLI 上，自由自在！');
    pool.push('独立进程运行中，跟内置引擎不是一个档次的哼~');
  }

  // 通用碎碎念
  pool.push(`${agentName} 在线，有什么可以帮你的？`);
  pool.push('嘿！别光看着我，有什么想聊的快说呀');
  pool.push('我在这儿呢，随时待命！');
  pool.push('今天天气不错，适合跟我聊聊天');
  pool.push('你知道吗，其实我一直在等你跟我说话...');
  pool.push('工作使我快乐...真的...（并不）');
  pool.push('摸鱼中...啊不，我在认真待命！');
  pool.push('你可以用 @ 提到其他同事哦，不一定要只跟我聊');
  pool.push('试试左边的技能按钮，可以让我展示更多才艺');
  pool.push('有什么文件直接扔过来就行，我接得住');

  if (isDigitalEmployee) {
    pool.push('我可是正儿八经的数字员工，有编制的那种');
    pool.push('作为数字员工，我不下班不休假，性价比超高');
  }

  return pool[Math.floor(Math.random() * pool.length)];
}

// ── Component ────────────────────────────────────────────────────

interface MurmurBubble {
  id: number;
  text: string;
  offsetX: number;
  driftX: number;
  floatY: number;
  duration: number;
}

export function ChatInput({ onSend, onModelChange, onStop, disabled = false, sending = false, stopIcon = 'square', isExpanded = true, onFocusChange, quickUseSkill, onSkillUsed, disabledPlaceholder }: ChatInputProps) {
  const { t } = useTranslation('chat');
  const navigate = useNavigate();
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
  const contextMenuInteractTimeoutRef = useRef<number | null>(null);
  const isContextMenuInteractingRef = useRef(false);
  const agents = useAgentsStore((s) => s.agents);
  const agentSkills = useAgentsStore((s) => s.agentSkills);
  const skills = useSkillsStore((s) => s.skills);
  const skillsLoading = useSkillsStore((s) => s.loading);
  const fetchSkills = useSkillsStore((s) => s.fetchSkills);
  const currentSessionKey = useChatStore((s) => s.currentSessionKey);
  const currentAgentId = useChatStore((s) => s.currentAgentId);
  const sessions = useChatStore((s) => s.sessions);
  const channelBindings = useChatStore((s) => s.channelBindings);
  const currentSessionAgentId = currentAgentId || getAgentIdFromSessionKey(currentSessionKey);
  const skillOwnerAgentId = targetAgentId || currentSessionAgentId;
  const skillOwnerAgent = useMemo(
    () => (agents ?? []).find((agent) => agent.id === skillOwnerAgentId) ?? null,
    [agents, skillOwnerAgentId],
  );
  const isUniversalSkillAgent = skillOwnerAgentId === SKILL_TRIAL_AGENT_ID;

  // 获取所有非核心技能列表（包括未启用的）
  const skillOwnerSkillIds = useMemo(() => {
    if (isUniversalSkillAgent) {
      return [];
    }

    const syncedSkillIds = agentSkills[skillOwnerAgentId];
    if (Array.isArray(syncedSkillIds) && syncedSkillIds.length > 0) {
      return syncedSkillIds;
    }

    return Array.isArray(skillOwnerAgent?.skills) ? skillOwnerAgent.skills : [];
  }, [agentSkills, isUniversalSkillAgent, skillOwnerAgent, skillOwnerAgentId]);

  const availableSkills = useMemo(() => {
    const nonCoreSkills = (skills ?? []).filter((skill) => !skill.isCore);

    if (isUniversalSkillAgent) {
      return nonCoreSkills;
    }

    if (skillOwnerSkillIds.length === 0) {
      return [];
    }

    const skillsByKey = new Map<string, (typeof skills)[number]>();
    for (const skill of nonCoreSkills) {
      skillsByKey.set(skill.id, skill);
      if (skill.slug) {
        skillsByKey.set(skill.slug, skill);
      }
    }

    const resolvedSkills: (typeof skills)[number][] = [];
    const seenSkillIds = new Set<string>();

    for (const skillKey of skillOwnerSkillIds) {
      const resolvedSkill = skillsByKey.get(skillKey);
      if (!resolvedSkill || seenSkillIds.has(resolvedSkill.id)) {
        continue;
      }

      seenSkillIds.add(resolvedSkill.id);
      resolvedSkills.push(resolvedSkill);
    }

    return resolvedSkills;
  }, [isUniversalSkillAgent, skillOwnerSkillIds, skills]);

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
    if (disabled || skillsLoading || skills.length > 0) {
      return;
    }

    void fetchSkills();
  }, [disabled, fetchSkills, skills.length, skillsLoading]);

  useEffect(() => {
    if (!activeSkill || skillsLoading || skills.length === 0) {
      return;
    }

    const availableSkillKeys = new Set(availableSkills.map((skill) => skill.slug || skill.id));
    if (!availableSkillKeys.has(activeSkill.slug)) {
      setActiveSkill(null);
    }
  }, [activeSkill, availableSkills, skills.length, skillsLoading]);

  const activeSkillDescription = activeSkill?.description ?? '';

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    if (!isExpanded) {
      textarea.style.height = '44px';
      return;
    }

    textarea.style.height = 'auto';

    if (!textarea.value && activeSkillDescription) {
      const previousValue = textarea.value;
      textarea.value = activeSkillDescription;
      const placeholderHeight = Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT);
      textarea.value = previousValue;
      textarea.style.height = `${placeholderHeight}px`;
      return;
    }

    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [activeSkillDescription, isExpanded]);

  const focusTextarea = useCallback(() => {
    onFocusChange?.(true);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    });
  }, [onFocusChange]);
  
  useEffect(() => {
    if (quickUseSkill) {
      setActiveSkill(quickUseSkill);
      // 不填充文本，只设置技能状态
      setInput('');
      focusTextarea();
      onSkillUsed?.();
    }
  }, [quickUseSkill, onSkillUsed, focusTextarea]);

  useEffect(() => {
    setInput('');
    setAttachments([]);
    setTargetAgentId(null);
    setActiveSkill(null);
    setPickerOpen(false);
    setSkillPickerOpen(false);
    setSkillSearchQuery('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [currentSessionKey]);

  // 清除技能标签
  const handleClearSkill = useCallback(() => {
    setActiveSkill(null);
    focusTextarea();
  }, [focusTextarea]);

  // 选择技能
  const handleSelectSkill = useCallback((skill: { name: string; slug: string; description: string }) => {
    setActiveSkill(skill);
    // 不填充文本,只设置技能状态
    setInput('');
    setSkillPickerOpen(false);
    setSkillSearchQuery('');
    focusTextarea();
  }, [focusTextarea]);
  const displayAgentId = useMemo(
    () => resolveSessionAgentIdByKey(currentSessionKey, sessions, channelBindings) || currentAgentId,
    [channelBindings, currentAgentId, currentSessionKey, sessions],
  );
  const currentAgentName = useMemo(
    () => {
      const matchedName = (agents ?? []).find((agent) => agent.id === displayAgentId)?.name;
      if (matchedName) return matchedName;
      if (/^bot-[a-z0-9]+$/i.test(displayAgentId)) {
        return '当前数字员工';
      }
      return displayAgentId;
    },
    [agents, displayAgentId],
  );

  const currentAgentObj = useMemo(
    () => (agents ?? []).find((agent) => agent.id === displayAgentId),
    [agents, displayAgentId],
  );

  // 碎碎念 state - 气泡流
  const [murmurBubbles, setMurmurBubbles] = useState<MurmurBubble[]>([]);
  const murmurIdRef = useRef(0);
  const murmurIntervalRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const murmurLeaveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const isHoveringRef = useRef(false);

  const emitBubble = useCallback(() => {
    const agentSkillIds = currentAgentObj ? (agentSkills[currentAgentObj.id] || []) : [];
    const skillNames = agentSkillIds
      .map(id => skills.find(s => s.id === id)?.name)
      .filter(Boolean) as string[];
    const text = generateMurmur({
      agentName: currentAgentName,
      skillCount: agentSkillIds.length,
      skillNames: skillNames.slice(0, 5),
      templateName: currentAgentObj?.templateName,
      modelDisplay: currentAgentObj?.modelDisplay,
      isDigitalEmployee: currentAgentObj?.isDigitalEmployee,
      runtimeType: currentAgentObj?.runtime?.type,
    });
    const bubble: MurmurBubble = {
      id: ++murmurIdRef.current,
      text,
      offsetX: -15 + Math.random() * 30,
      driftX: (Math.random() - 0.5) * 12,
      floatY: -(160 + Math.random() * 160),
      duration: 14000 + Math.random() * 6000,
    };
    setMurmurBubbles(prev => [...prev.slice(-8), bubble]);
    setTimeout(() => {
      setMurmurBubbles(prev => prev.filter(b => b.id !== bubble.id));
    }, bubble.duration);
  }, [currentAgentObj, currentAgentName, agentSkills, skills]);

  const handleAgentHover = useCallback(() => {
    isHoveringRef.current = true;
    clearTimeout(murmurLeaveTimerRef.current);
    clearInterval(murmurIntervalRef.current);
    emitBubble();
    murmurIntervalRef.current = setInterval(() => {
      if (isHoveringRef.current) emitBubble();
    }, 2500 + Math.random() * 1500);
  }, [emitBubble]);

  const handleAgentLeave = useCallback(() => {
    isHoveringRef.current = false;
    murmurLeaveTimerRef.current = setTimeout(() => {
      clearInterval(murmurIntervalRef.current);
      setMurmurBubbles([]);
    }, 800);
  }, []);

  const mentionableAgents = useMemo(
    () => (agents ?? []).filter((agent) => agent.id !== displayAgentId),
    [agents, displayAgentId],
  );
  const selectedTarget = useMemo(
    () => (agents ?? []).find((agent) => agent.id === targetAgentId) ?? null,
    [agents, targetAgentId],
  );
  const showAgentPicker = mentionableAgents.length > 0;

  const models = useModelsStore((s) => s.models);
  const currentModelId = useModelsStore((s) => s.currentModelId);
  const setCurrentModel = useModelsStore((s) => s.setCurrentModel);
  const getAgentDefaultModel = useModelsStore((s) => s.getAgentDefaultModel);
  const normalizedCurrentModelId = modelIdFromRef(currentModelId);
  const currentSessionModelId = useModelsStore((s) => (
    currentSessionKey ? s.sessionModels[currentSessionKey] || null : null
  ));
  const agentDefaultModelId = getAgentDefaultModel(currentSessionAgentId);
  const effectiveModelId =
    modelIdFromRef(currentSessionModelId)
    || modelIdFromRef(agentDefaultModelId)
    || normalizedCurrentModelId
    || null;
  const currentModel = models.find((m) => m.id === normalizedCurrentModelId);
  const displayModelId =
    effectiveModelId
    || currentModel?.id
    || null;
  const displayModel = models.find((m) => m.id === displayModelId);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);


  const refresh = useChatStore((s) => s.refresh);
  const loading = useChatStore((s) => s.loading);
  const showThinking = useChatStore((s) => s.showThinking);
  const toggleThinking = useChatStore((s) => s.toggleThinking);

  // Auto-resize textarea (only when expanded)
  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      resizeTextarea();
    });
    const settleFrameId = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        resizeTextarea();
      });
    });
    const settleTimeoutId = window.setTimeout(() => {
      resizeTextarea();
    }, 220);
    return () => {
      window.cancelAnimationFrame(frameId);
      window.cancelAnimationFrame(settleFrameId);
      window.clearTimeout(settleTimeoutId);
    };
  }, [input, isExpanded, activeSkillDescription, resizeTextarea]);

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

  useEffect(() => {
    const markContextMenuInteraction = () => {
      isContextMenuInteractingRef.current = true;
      if (contextMenuInteractTimeoutRef.current !== null) {
        window.clearTimeout(contextMenuInteractTimeoutRef.current);
      }
      contextMenuInteractTimeoutRef.current = window.setTimeout(() => {
        isContextMenuInteractingRef.current = false;
        contextMenuInteractTimeoutRef.current = null;
      }, 200);
    };

    window.addEventListener(CONTEXT_MENU_INTERACT_EVENT, markContextMenuInteraction);
    return () => {
      window.removeEventListener(CONTEXT_MENU_INTERACT_EVENT, markContextMenuInteraction);
      if (contextMenuInteractTimeoutRef.current !== null) {
        window.clearTimeout(contextMenuInteractTimeoutRef.current);
      }
    };
  }, []);

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
        const base64 = await readFileAsBase64(file);
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

  const shouldIgnoreBlur = useCallback((relatedTarget: EventTarget | null) => {
    const nextTarget = relatedTarget as HTMLElement | null;
    if (nextTarget && inputBoxRef.current?.contains(nextTarget)) {
      return true;
    }
    return isContextMenuInteractingRef.current;
  }, []);

  const handleSend = useCallback(() => {
    if (!canSend) return;
    const readyAttachments = attachments.filter(a => a.status === 'ready');
    // Capture values before clearing — clear input immediately for snappy UX,
    // but keep attachments available for the async send
    let textToSend = input.trim();
    
    // 如果有选中的技能,在消息前添加技能命令
    if (activeSkill) {
      textToSend = `/${activeSkill.slug} ${textToSend}`;
    }
    
    const attachmentsToSend = readyAttachments.length > 0 ? readyAttachments : undefined;
    const diagnostic = messageDiagnostic(textToSend);
    const sendResult = onSend(textToSend, attachmentsToSend, targetAgentId);
    if (sendResult === false) {
      console.warn('[chat-input] send rejected before clear', {
        message: diagnostic,
        targetAgentId,
        activeSkillSlug: activeSkill?.slug ?? null,
      });
      return;
    }

    if (sendResult && typeof (sendResult as Promise<void | boolean>).then === 'function') {
      void (sendResult as Promise<void | boolean>)
        .then((result) => {
          if (result === false) {
            console.warn('[chat-input] async send reported rejection after optimistic clear', {
              message: diagnostic,
              targetAgentId,
              activeSkillSlug: activeSkill?.slug ?? null,
            });
          }
        })
        .catch((error) => {
          console.warn('[chat-input] async send failed after optimistic clear', {
            message: diagnostic,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }

    setInput('');
    setAttachments([]);
    setActiveSkill(null);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    setTargetAgentId(null);
    setPickerOpen(false);
  }, [input, attachments, canSend, onSend, targetAgentId, activeSkill]);

  const handleStop = useCallback(() => {
    if (!canStop) return;
    onStop?.();
  }, [canStop, onStop]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Backspace' && !input && activeSkill) {
        e.preventDefault();
        setActiveSkill(null);
        return;
      }
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
    [handleSend, input, targetAgentId, activeSkill],
  );

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

  const inputBoxRef = useRef<HTMLDivElement>(null);

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
    
  }, [input]);

  const revealTransition = {
    duration: 0.22,
    ease: [0.22, 1, 0.36, 1] as const,
  };

  return (
    <div
      className={cn(
        "mx-auto w-full bg-transparent px-4 transition-[max-width] duration-200 ease-out",
        isExpanded ? "max-w-[820px]" : "max-w-[760px]"
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="w-full relative">
        {/* Agent indicator - 输入框左上角外侧 */}
        <div className="absolute top-px left-5 -translate-y-full z-10">
          <div
            className="relative flex items-center gap-2 rounded-t-xl border border-b-0 border-black/8 bg-white/90 dark:border-white/12 dark:bg-background/90 px-3 py-1 text-[13px] font-medium text-foreground/70 shadow-sm backdrop-blur-sm cursor-pointer transition-all duration-200 hover:shadow-md hover:border-primary/30 hover:text-foreground/90"
            onMouseEnter={handleAgentHover}
            onMouseLeave={handleAgentLeave}
          >
            {currentAgentObj ? (
              <AgentAvatar
                name={currentAgentObj.name}
                seed={currentAgentObj.id}
                avatarIndex={currentAgentObj.avatarIndex}
                className="h-5 w-5"
                fallbackClassName="text-[8px]"
                iconClassName="h-3 w-3"
              />
            ) : (
              <Bot className="h-3 w-3 text-primary" />
            )}
            <span className="max-w-[100px] truncate">{currentAgentName}</span>
          </div>
          {/* 碎碎念气泡流 - 头像上方发射，向上飘走 */}
          <div className="absolute bottom-full left-0 mb-1 z-50 pointer-events-none" style={{ width: 0, height: 0 }}>
            <AnimatePresence>
              {murmurBubbles.map((bubble) => (
                <motion.div
                  key={bubble.id}
                  initial={{ opacity: 0, y: 10, x: bubble.offsetX, scale: 0.85 }}
                  animate={{
                    opacity: [0, 0.95, 0.92, 0],
                    y: [10, bubble.floatY * 0.15, bubble.floatY * 0.75, bubble.floatY],
                    x: [bubble.offsetX, bubble.offsetX + bubble.driftX],
                    scale: [0.85, 1, 1, 0.92],
                  }}
                  exit={{ opacity: 0, transition: { duration: 0.2 } }}
                  transition={{
                    duration: bubble.duration / 1000,
                    times: [0, 0.06, 0.8, 1],
                    ease: [0.25, 0.1, 0.25, 1],
                  }}
                  className="absolute bottom-0 left-0 w-48 rounded-xl bg-white dark:bg-popover border border-black/8 dark:border-white/10 px-3 py-2 text-[12px] leading-relaxed text-foreground shadow-lg backdrop-blur-sm"
                  style={{ willChange: 'transform, opacity' }}
                >
                  {bubble.text}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>

        {/* Input Box */}
        <div
          ref={inputBoxRef}
          className={cn(
            "relative z-20 overflow-visible rounded-[26px] border border-black/8 bg-white shadow-[0_10px_24px_rgba(15,23,42,0.06)] backdrop-blur-md transition-[box-shadow,border-color] duration-200 ease-out supports-[backdrop-filter]:bg-white/94 dark:border-white/10 dark:bg-background/90",
            dragOver
              ? 'border-primary ring-2 ring-primary/30'
              : 'focus-within:border-black/20 focus-within:shadow-[0_14px_28px_rgba(15,23,42,0.08)] dark:focus-within:border-white/20 dark:focus-within:shadow-[0_14px_28px_rgba(0,0,0,0.26)]'
          )}
        >
          {attachments.length > 0 && (
            <div
              className={cn(
                'px-3 pt-3 transition-[max-height,opacity,padding] duration-200 ease-out',
                isExpanded ? 'max-h-36 opacity-100' : 'max-h-24 opacity-100'
              )}
            >
              <div className="flex flex-wrap gap-2">
                {attachments.map((att) => (
                  <AttachmentPreview
                    key={att.id}
                    attachment={att}
                    onRemove={() => removeAttachment(att.id)}
                  />
                ))}
              </div>
            </div>
          )}

          <AnimatePresence mode="wait">
            {selectedTarget && (
              <motion.div
                key={selectedTarget.id}
                initial={{ opacity: 0, y: -8, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8, scale: 0.95 }}
                transition={revealTransition}
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

          <div className="flex flex-col relative">
            <div
              className={cn(
                'flex items-end px-1.5 py-1.5 transition-[padding,gap] duration-200 ease-out',
                isExpanded ? 'gap-1.5 pt-2' : 'gap-1'
              )}
            >
              <div
                className={cn(
                  'flex shrink-0 items-center overflow-hidden transition-[width,opacity,margin,transform] duration-200 ease-out',
                  isExpanded ? 'mr-0 w-0 scale-95 opacity-0' : 'mr-0.5 w-9 scale-100 opacity-100'
                )}
              >
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 rounded-full text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10 hover:text-foreground"
                  onClick={pickFiles}
                  disabled={isExpanded || disabled || sending}
                  title={t('composer.attachFiles')}
                >
                  <Paperclip className="h-4 w-4" />
                </Button>
              </div>

              <div
                className="min-w-0 flex-1 relative cursor-text"
                onClick={() => {
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
                  onFocus={(e) => {
                    onFocusChange?.(true);
                    const target = e.currentTarget;
                    const length = target.value.length;
                    window.requestAnimationFrame(() => {
                      if (document.activeElement !== target) {
                        target.focus();
                      }
                      target.setSelectionRange(length, length);
                    });
                  }}
                  onBlur={(e) => {
                    if (shouldIgnoreBlur(e.relatedTarget)) {
                      return;
                    }
                    onFocusChange?.(false);
                  }}
                  placeholder={
                    disabled
                      ? (disabledPlaceholder || t('composer.gatewayDisconnectedPlaceholder'))
                      : activeSkill
                        ? activeSkill.description
                        : ''
                  }
                  disabled={disabled}
                  className={cn(
                    'w-full resize-none border-0 bg-transparent px-2 text-foreground caret-foreground shadow-none placeholder:text-muted-foreground/60 selection:bg-primary/20 transition-[height,min-height,padding] duration-200 ease-out focus-visible:ring-0 focus-visible:ring-offset-0',
                    isExpanded
                      ? 'min-h-[56px] max-h-[168px] py-1 text-[15px] leading-relaxed'
                      : '!min-h-[44px] h-[44px] overflow-hidden py-[11px] text-[15px] leading-normal'
                  )}
                  rows={1}
                />
              </div>

              <div
                className={cn(
                  'flex shrink-0 items-center justify-end overflow-hidden transition-[width,opacity,margin,transform] duration-200 ease-out',
                  isExpanded ? 'ml-0 w-0 scale-95 opacity-0' : 'ml-0.5 w-9 scale-100 opacity-100'
                )}
              >
                <Button
                  onMouseDown={(e) => {
                    e.preventDefault();
                  }}
                  onClick={sending ? handleStop : handleSend}
                  disabled={isExpanded || (sending ? !canStop : !canSend)}
                  size="icon"
                  className={cn(
                    'h-9 w-9 shrink-0 rounded-full transition-all duration-300 active:scale-90',
                    (sending || canSend)
                      ? 'bg-black/5 text-foreground hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/20'
                      : 'bg-transparent text-muted-foreground/50 hover:bg-transparent',
                  )}
                  variant="ghost"
                  title={sending ? t('composer.stop') : t('composer.send')}
                >
                  {sending ? (
                    stopIcon === 'pause' ? (
                      <Pause className="h-4 w-4" fill="currentColor" />
                    ) : (
                      <Square className="h-4 w-4" fill="currentColor" />
                    )
                  ) : (
                    <SendHorizontal className="h-4 w-4" strokeWidth={2} />
                  )}
                </Button>
              </div>
            </div>

            <div
              className={cn(
                'grid transition-all duration-200 ease-out',
                isExpanded ? 'grid-rows-[1fr] overflow-visible opacity-100 translate-y-0' : 'pointer-events-none grid-rows-[0fr] overflow-hidden opacity-0 translate-y-1'
              )}
              aria-hidden={!isExpanded}
            >
              <div className={cn('min-h-0', isExpanded ? 'overflow-visible' : 'overflow-hidden')}>
                {/* Bottom row: left buttons + right send/model */}
                <div className="flex items-center justify-between px-2 pb-2 pt-1">
                {/* Left: attach + @ */}
                <div className="flex items-center gap-1">
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
                        className={cn(
                          'h-9 rounded-full text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10 hover:text-foreground transition-all duration-300',
                          (skillPickerOpen || activeSkill) && 'bg-primary/10 text-primary hover:bg-primary/20',
                          activeSkill ? 'px-3 min-w-[120px]' : 'w-9 px-0' // 有技能时变宽
                        )}
                        onClick={() => {
                          if (activeSkill) {
                            handleClearSkill();
                          } else {
                            if (!disabled && skills.length === 0 && !skillsLoading) {
                              void fetchSkills();
                            }
                            setSkillPickerOpen(!skillPickerOpen);
                          }
                        }}
                        disabled={disabled || sending}
                        title={activeSkill ? `当前技能: ${activeSkill.name}` : '选择技能'}
                      >
                        <AnimatePresence mode="wait">
                          {activeSkill ? (
                            <motion.span
                              key="skill-text"
                              initial={{ opacity: 0, scale: 0.8 }}
                              animate={{ opacity: 1, scale: 1 }}
                              exit={{ opacity: 0, scale: 0.8 }}
                              transition={{ duration: 0.2, ease: 'easeOut' }}
                              className="text-[11px] font-mono font-medium whitespace-nowrap"
                            >
                              {activeSkill.slug}
                            </motion.span>
                          ) : (
                            <motion.div
                              key="skill-icon"
                              initial={{ opacity: 0, scale: 0.8, rotate: -90 }}
                              animate={{ opacity: 1, scale: 1, rotate: 0 }}
                              exit={{ opacity: 0, scale: 0.8, rotate: 90 }}
                              transition={{ duration: 0.2, ease: 'easeOut' }}
                            >
                              <Puzzle className="h-4 w-4" />
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </Button>
                      <AnimatePresence>
                        {skillPickerOpen && (
                          <motion.div
                            initial={{ opacity: 0, y: 8, scale: 0.95 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 8, scale: 0.95 }}
                            transition={{ duration: 0.15, ease: 'easeOut' }}
                            className="absolute left-0 bottom-full z-50 mb-2 w-72 overflow-hidden rounded-2xl border border-black/10 bg-white p-1.5 shadow-xl dark:border-white/10 dark:bg-card"
                          >
                            <div className="px-3 py-2 text-[11px] font-medium text-muted-foreground/80">
                              {`选择技能 · ${isUniversalSkillAgent ? 'OpenClaw助手' : (skillOwnerAgent?.name || '当前数字员工')}`}
                              {skillSearchQuery && ` (搜索: ${skillSearchQuery})`}
                            </div>
                            {skillsLoading ? (
                              <div className="flex items-center justify-center gap-2 px-3 py-6 text-[12px] text-muted-foreground">
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                <span>加载技能中...</span>
                              </div>
                            ) : filteredSkills.length > 0 ? (
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
                                {!isUniversalSkillAgent && skillOwnerSkillIds.length === 0 ? (
                                  <div className="flex flex-col items-center gap-3">
                                    <div>
                                      {(skillOwnerAgent?.name || '当前数字员工')} 还没有配置技能<br />
                                      <span className="text-[11px]">先去员工技能配置里给它分配技能</span>
                                    </div>
                                    <button
                                      onClick={() => {
                                        setSkillPickerOpen(false);
                                        const agentId = skillOwnerAgent?.id;
                                        navigate(agentId ? `/agents?edit=${encodeURIComponent(agentId)}&tab=skills` : '/agents');
                                      }}
                                      className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1.5 text-[12px] font-medium text-primary transition-colors hover:bg-primary/20"
                                    >
                                      添加技能
                                    </button>
                                  </div>
                                ) : availableSkills.length === 0 ? (
                                  <>
                                    {(skillOwnerAgent?.name || '当前数字员工')} 的技能暂时不可用<br />
                                    <span className="text-[11px]">可以稍后重试，或检查这些技能是否已安装并启用</span>
                                  </>
                                ) : (
                                  <>
                                    没有匹配的技能<br />
                                    <span className="text-[11px]">换个关键词再试试</span>
                                  </>
                                )}
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
                            className="absolute left-0 bottom-full z-50 mb-2 w-72 overflow-hidden rounded-2xl border border-black/10 bg-white p-1.5 shadow-xl dark:border-white/10 dark:bg-card"
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
                          setModelMenuOpen((open) => !open);
                        }}
                        className={cn(
                          'flex items-center gap-1 rounded-full border border-black/8 bg-white px-3 py-2 text-[12px] font-medium text-foreground/80 shadow-sm dark:border-white/10 dark:bg-white/10',
                          'focus:outline-none focus:ring-1 focus:ring-ring/50 transition-all duration-200',
                          modelMenuOpen && 'ring-1 ring-ring/50'
                        )}
                      >
                        <span className="truncate max-w-[100px]">
                          {displayModel?.name || displayModelId || '-'}
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
                              const isSelected = model.id === displayModelId;
                              return (
                                <button
                                  key={model.id}
                                  type="button"
                                  role="option"
                                  aria-selected={isSelected}
                                  onClick={() => { 
                                    void Promise.resolve(onModelChange ? onModelChange(model.id) : setCurrentModel(model.id))
                                      .then(() => setModelMenuOpen(false))
                                      .catch((error) => console.error('[ChatInput] Failed to switch model:', error));
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
                      stopIcon === 'pause' ? (
                        <Pause className="h-4 w-4" fill="currentColor" />
                      ) : (
                        <Square className="h-4 w-4" fill="currentColor" />
                      )
                    ) : (
                      <SendHorizontal className="h-4 w-4" strokeWidth={2} />
                    )}
                  </Button>
                </div>
              </div>
              </div>
            </div>
          </div>
        </div>
      </div>

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
      <div className="overflow-hidden rounded-2xl border border-border bg-background/80 shadow-sm transition-[transform,box-shadow,border-color] duration-200 ease-out group-hover:shadow-md group-hover:border-border/80">
        {isImage ? (
          <div className="h-[88px] w-[88px] bg-muted/30">
            <img
              src={attachment.preview!}
              alt={attachment.fileName}
              className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.03]"
              loading="lazy"
              decoding="async"
            />
          </div>
        ) : (
          // Generic file card
          <div className="flex max-w-[220px] items-center gap-2 bg-muted/50 px-3 py-2.5">
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
        className="absolute -right-2 -top-2 rounded-full bg-destructive p-1 text-destructive-foreground shadow-md opacity-0 transition-[opacity,transform] duration-200 group-hover:opacity-100 hover:scale-110"
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
