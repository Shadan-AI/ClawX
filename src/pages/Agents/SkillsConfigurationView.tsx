import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { Bot, Check, Puzzle, RefreshCw, Search, X, Sparkles, ChevronDown, Loader2, FileText, Eye, Edit3, Save, RotateCcw, FolderOpen, FileCode } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useAgentsStore } from '@/stores/agents';
import { useSkillsStore } from '@/stores/skills';
import { useAgentTemplatesStore } from '@/stores/agent-templates';
import type { AgentSummary } from '@/types/agent';
import type { AgentTemplate } from '@/types/agent';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

/**
 * Skills Configuration View
 * 技能配置视图 - 为数字员工批量管理技能
 * 支持拖拽技能卡片到员工区域，带惯性效果
 */
export function SkillsConfigurationView({
  employees,
  onRefresh,
}: {
  employees: AgentSummary[];
  onRefresh: () => void;
}) {
  const { skills: allSkills, loading: skillsLoading, fetchSkills } = useSkillsStore();
  const { agentSkills, updateAgentSkills } = useAgentsStore();
  const { templates, loading: templatesLoading, fetchTemplates } = useAgentTemplatesStore();
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null);
  const [localSkills, setLocalSkills] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [isDropZoneActive, setIsDropZoneActive] = useState(false);
  const [draggedSkillId, setDraggedSkillId] = useState<string | null>(null);
  const [showEmployeeDropdown, setShowEmployeeDropdown] = useState(false);
  const [applyingTemplate, setApplyingTemplate] = useState(false);
  const [viewMode, setViewMode] = useState<'skills' | 'profile'>('skills');
  
  // Profile editor states
  const [selectedMdFile, setSelectedMdFile] = useState('AGENTS.md');
  const [mdContent, setMdContent] = useState('');
  const [originalMdContent, setOriginalMdContent] = useState('');
  const [isMdPreview, setIsMdPreview] = useState(false);
  const [mdLoading, setMdLoading] = useState(false);
  const [mdSaving, setMdSaving] = useState(false);
  const [mdSyncing, setMdSyncing] = useState(false);
  const [mdSource, setMdSource] = useState<'LOCAL' | 'TEMPLATE' | 'USER' | 'DEFAULT'>('LOCAL');
  const [previewHtml, setPreviewHtml] = useState({ __html: '' });

  // 获取本地已安装的技能和模板
  useEffect(() => {
    // 只在数据为空时才加载
    if (allSkills.length === 0 && !skillsLoading) {
      void fetchSkills();
    }
    if (templates.length === 0 && !templatesLoading) {
      void fetchTemplates();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allSkills.length, skillsLoading, templates.length, templatesLoading]);

  // 搜索防抖
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // 初始化本地技能状态
  useEffect(() => {
    setLocalSkills(agentSkills);
    if (employees.length > 0 && !selectedEmployeeId) {
      setSelectedEmployeeId(employees[0].id);
    }
  }, [agentSkills, employees.length, selectedEmployeeId]); // 优化依赖项

  const selectedEmployee = useMemo(
    () => employees.find((e) => e.id === selectedEmployeeId),
    [employees, selectedEmployeeId]
  );
  
  const currentSkills = useMemo(() => {
    const skills = selectedEmployeeId ? (localSkills[selectedEmployeeId] || []) : [];
    console.log('[SkillsConfigurationView] currentSkills:', {
      selectedEmployeeId,
      skills,
      localSkills,
      agentSkills,
    });
    return skills;
  }, [selectedEmployeeId, localSkills, agentSkills]);
  
  const hasChanges = useMemo(
    () => selectedEmployeeId && JSON.stringify(currentSkills) !== JSON.stringify(agentSkills[selectedEmployeeId] || []),
    [selectedEmployeeId, currentSkills, agentSkills]
  );

  const MD_FILES = ['AGENTS.md', 'SOUL.md', 'TOOLS.md', 'IDENTITY.md', 'USER.md', 'HEARTBEAT.md'];

  const DEFAULT_TEMPLATES: Record<string, string> = {
    'AGENTS.md': `# AGENTS

This file defines the agent's role and responsibilities.

## Role
Describe the agent's primary role and purpose.

## Responsibilities
- List key responsibilities
- Define scope of work
- Specify limitations
`,
    'SOUL.md': `# SOUL

This file defines the agent's personality and communication style.

## Personality
Describe the agent's personality traits.

## Communication Style
- Tone and manner of speaking
- Level of formality
- Preferred language patterns
`,
    'TOOLS.md': `# TOOLS

This file lists the tools and capabilities available to the agent.

## Available Tools
- List tools the agent can use
- Describe when to use each tool
- Specify any tool-specific guidelines
`,
    'IDENTITY.md': `# IDENTITY

This file defines the agent's identity and metadata.

## Basic Information
- Name: [Agent Name]
- Emoji: [Emoji]
- Avatar: [Avatar URL or path]

## Description
Brief description of the agent.
`,
    'USER.md': `# USER

This file contains information about the user and their preferences.

## User Preferences
- Communication preferences
- Working style
- Specific requirements

## Context
Additional context about the user's needs and expectations.
`,
    'HEARTBEAT.md': `# HEARTBEAT

This file contains periodic tasks and reminders for the agent.

## Periodic Tasks
- List recurring tasks
- Specify check intervals
- Define success criteria

## Reminders
- Important reminders
- Scheduled checks
`,
  };

  const loadMdFile = useCallback(async (filename: string) => {
    if (!selectedEmployeeId) return;
    setMdLoading(true);
    try {
      const result = await window.electron.ipcRenderer.invoke('agent-profile:read', {
        agentId: selectedEmployeeId,
        filename,
      }) as { success: boolean; content?: string; source?: string; error?: string };
      
      if (result.success) {
        setMdContent(result.content || '');
        setOriginalMdContent(result.content || '');
        setMdSource((result.source as any) || 'LOCAL');
      } else {
        toast.error(`加载失败: ${result.error}`);
      }
    } catch (error) {
      toast.error(`加载失败: ${String(error)}`);
    } finally {
      setMdLoading(false);
    }
  }, [selectedEmployeeId]);

  // Load MD file when switching files or agents
  useEffect(() => {
    if (viewMode === 'profile' && selectedEmployeeId) {
      loadMdFile(selectedMdFile);
    }
  }, [selectedEmployeeId, selectedMdFile, viewMode, loadMdFile]);

  // Update preview when content changes
  useEffect(() => {
    if (isMdPreview && mdContent) {
      marked(mdContent).then((html) => {
        const sanitized = DOMPurify.sanitize(html);
        setPreviewHtml({ __html: sanitized });
      });
    }
  }, [isMdPreview, mdContent]);

  const handleMdSave = async () => {
    if (!selectedEmployeeId) return;
    setMdSaving(true);
    
    // 显示保存中的提示
    const savingToast = toast.loading('💾 正在保存到本地...');
    
    try {
      const result = await window.electron.ipcRenderer.invoke('agent-profile:save', {
        agentId: selectedEmployeeId,
        filename: selectedMdFile,
        content: mdContent,
      }) as { success: boolean; isCustomized?: boolean; error?: string };
      
      if (result.success) {
        setOriginalMdContent(mdContent);
        setMdSource('USER'); // 保存后变为自定义
        
        // 更新提示信息
        toast.success(
          `✅ 保存成功！\n💾 已保存到本地\n☁️ 已上传到云端${result.isCustomized ? '\n✏️ 文件已标记为自定义' : ''}`,
          { id: savingToast, duration: 3000 }
        );
      } else {
        toast.error(`❌ 保存失败\n${result.error || '未知错误'}`, { id: savingToast, duration: 4000 });
      }
    } catch (error) {
      toast.error(`❌ 保存失败\n${String(error)}`, { id: savingToast, duration: 4000 });
    } finally {
      setMdSaving(false);
    }
  };

  const handleMdReset = () => {
    setMdContent(originalMdContent);
    toast.info('已重置');
  };

  const handleOpenMdFolder = async () => {
    if (!selectedEmployeeId) return;
    try {
      const workspaceDir = await window.electron.ipcRenderer.invoke('agent-profile:getDir', {
        agentId: selectedEmployeeId,
      }) as { success: boolean; path?: string; error?: string };
      
      if (workspaceDir.success && workspaceDir.path) {
        await window.electron.openExternal(`file://${workspaceDir.path}`);
        toast.success('已打开文件夹');
      } else {
        toast.error(`打开失败: ${workspaceDir.error}`);
      }
    } catch (error) {
      toast.error(`打开失败: ${String(error)}`);
    }
  };

  const handleLoadDefaultTemplate = () => {
    const defaultContent = DEFAULT_TEMPLATES[selectedMdFile] || '';
    setMdContent(defaultContent);
    toast.info('已加载默认模板');
  };

  const handleSyncProfile = async () => {
    if (!selectedEmployeeId) return;
    setMdSyncing(true);
    try {
      toast.info('正在同步岗位定义文件...', { duration: 1000 });
      
      const result = await window.electron.ipcRenderer.invoke('agent-profile:sync', {
        agentId: selectedEmployeeId,
      }) as { success: boolean; synced?: number; errors?: number; error?: string };
      
      if (result.success) {
        const synced = result.synced || 0;
        const errors = result.errors || 0;
        
        if (synced > 0) {
          toast.success(
            `✅ 同步完成！\n📥 已同步 ${synced} 个文件${errors > 0 ? `\n⚠️ ${errors} 个文件失败` : ''}`,
            { duration: 3000 }
          );
        } else {
          toast.info('所有文件已是最新，无需同步', { duration: 2000 });
        }
        
        // Reload current file to show updated content
        await loadMdFile(selectedMdFile);
      } else {
        toast.error(`❌ 同步失败\n${result.error || '未知错误'}`, { duration: 4000 });
      }
    } catch (error) {
      toast.error(`❌ 同步失败\n${String(error)}`, { duration: 4000 });
    } finally {
      setMdSyncing(false);
    }
  };

  const hasMdChanges = mdContent !== originalMdContent;

  // 只显示已启用的技能供配置
  const enabledSkills = useMemo(
    () => allSkills.filter((skill) => skill.enabled),
    [allSkills]
  );

  // 获取所有分类（缓存计数）
  const categoriesWithCount = useMemo(() => {
    const cats = new Map<string, number>();
    cats.set('all', enabledSkills.length);
    
    // 智能分类：根据技能名称自动归类
    enabledSkills.forEach((skill) => {
      let category = skill.category;
      
      // 如果没有 category，根据技能名称智能分类
      if (!category) {
        const name = skill.name.toLowerCase();
        const slug = (skill.slug || skill.id).toLowerCase();
        
        if (name.includes('note') || slug.includes('note') || slug.includes('obsidian') || slug.includes('notion') || slug.includes('bear')) {
          category = '笔记';
        } else if (name.includes('github') || name.includes('git') || slug.includes('github') || slug.includes('coding')) {
          category = '开发';
        } else if (name.includes('slack') || name.includes('discord') || slug.includes('slack') || slug.includes('discord') || slug.includes('imsg') || slug.includes('wechat')) {
          category = '通讯';
        } else if (name.includes('image') || name.includes('video') || name.includes('media') || slug.includes('image') || slug.includes('video') || slug.includes('gif')) {
          category = '媒体';
        } else if (name.includes('web') || name.includes('search') || name.includes('crawler') || slug.includes('web') || slug.includes('xurl')) {
          category = '网络';
        } else if (name.includes('weather') || slug.includes('weather')) {
          category = '生活';
        } else if (name.includes('smart') || name.includes('home') || slug.includes('hue') || slug.includes('sonos') || slug.includes('wacli')) {
          category = '智能家居';
        } else if (name.includes('music') || name.includes('spotify') || slug.includes('spotify') || slug.includes('song')) {
          category = '音乐';
        } else if (name.includes('task') || name.includes('todo') || slug.includes('things') || slug.includes('trello')) {
          category = '任务管理';
        } else if (name.includes('ai') || slug.includes('ai-') || slug.includes('gemini') || slug.includes('openai')) {
          category = 'AI';
        } else {
          category = '其他';
        }
      }
      
      cats.set(category, (cats.get(category) || 0) + 1);
    });
    
    return Array.from(cats.entries())
      .sort((a, b) => {
        if (a[0] === 'all') return -1;
        if (b[0] === 'all') return 1;
        return b[1] - a[1]; // 按数量降序排列
      });
  }, [enabledSkills]);

  // 过滤技能（使用防抖后的搜索词）
  const filteredSkills = useMemo(() => {
    return enabledSkills.filter((skill) => {
      const matchesSearch = !debouncedSearchQuery || 
        skill.name.toLowerCase().includes(debouncedSearchQuery.toLowerCase()) ||
        (skill.description && skill.description.toLowerCase().includes(debouncedSearchQuery.toLowerCase()));
      
      if (selectedCategory === 'all') {
        return matchesSearch;
      }
      
      // 获取技能的分类（使用相同的智能分类逻辑）
      let category = skill.category;
      if (!category) {
        const name = skill.name.toLowerCase();
        const slug = (skill.slug || skill.id).toLowerCase();
        
        if (name.includes('note') || slug.includes('note') || slug.includes('obsidian') || slug.includes('notion') || slug.includes('bear')) {
          category = '笔记';
        } else if (name.includes('github') || name.includes('git') || slug.includes('github') || slug.includes('coding')) {
          category = '开发';
        } else if (name.includes('slack') || name.includes('discord') || slug.includes('slack') || slug.includes('discord') || slug.includes('imsg') || slug.includes('wechat')) {
          category = '通讯';
        } else if (name.includes('image') || name.includes('video') || name.includes('media') || slug.includes('image') || slug.includes('video') || slug.includes('gif')) {
          category = '媒体';
        } else if (name.includes('web') || name.includes('search') || name.includes('crawler') || slug.includes('web') || slug.includes('xurl')) {
          category = '网络';
        } else if (name.includes('weather') || slug.includes('weather')) {
          category = '生活';
        } else if (name.includes('smart') || name.includes('home') || slug.includes('hue') || slug.includes('sonos') || slug.includes('wacali')) {
          category = '智能家居';
        } else if (name.includes('music') || name.includes('spotify') || slug.includes('spotify') || slug.includes('song')) {
          category = '音乐';
        } else if (name.includes('task') || name.includes('todo') || slug.includes('things') || slug.includes('trello')) {
          category = '任务管理';
        } else if (name.includes('ai') || slug.includes('ai-') || slug.includes('gemini') || slug.includes('openai')) {
          category = 'AI';
        } else {
          category = '其他';
        }
      }
      
      return matchesSearch && category === selectedCategory;
    });
  }, [enabledSkills, debouncedSearchQuery, selectedCategory]);

  const handleToggleSkill = useCallback((skillId: string) => {
    if (!selectedEmployeeId) return;
    setLocalSkills((prev) => {
      const current = prev[selectedEmployeeId] || [];
      const updated = current.includes(skillId)
        ? current.filter((id) => id !== skillId)
        : [...current, skillId];
      return { ...prev, [selectedEmployeeId]: updated };
    });
  }, [selectedEmployeeId]);

  const handleAddSkill = useCallback((skillId: string) => {
    if (!selectedEmployeeId) return;
    setLocalSkills((prev) => {
      const current = prev[selectedEmployeeId] || [];
      if (current.includes(skillId)) return prev;
      return { ...prev, [selectedEmployeeId]: [...current, skillId] };
    });
  }, [selectedEmployeeId]);

  const handleRemoveSkill = useCallback((skillId: string) => {
    if (!selectedEmployeeId) return;
    setLocalSkills((prev) => {
      const current = prev[selectedEmployeeId] || [];
      return { ...prev, [selectedEmployeeId]: current.filter((id) => id !== skillId) };
    });
  }, [selectedEmployeeId]);

  const handleSave = async () => {
    if (!selectedEmployeeId) return;
    setSaving(true);
    try {
      const skillsToSave = localSkills[selectedEmployeeId] || [];
      
      // 先保存技能
      await updateAgentSkills(selectedEmployeeId, skillsToSave);
      
      // 保存后检查是否需要更新模板状态
      const { agentTemplates, updateAgentTemplate } = useAgentsStore.getState();
      const currentTemplateId = agentTemplates[selectedEmployeeId];
      
      if (currentTemplateId) {
        // 如果当前使用了模板，检查技能是否与模板一致
        const template = templates.find(t => t.id === currentTemplateId);
        if (template) {
          // 模板中存储的是 skillSlug，需要转换为 skillId 进行比较
          const templateSkillIds = template.skills
            .map(skillSlug => {
              const skill = allSkills.find(s => (s.slug || s.id) === skillSlug);
              return skill?.id;
            })
            .filter((id): id is string => id !== undefined);
          
          // 比较技能列表是否一致（不考虑顺序）
          const skillsMatch = 
            skillsToSave.length === templateSkillIds.length &&
            skillsToSave.every(skill => templateSkillIds.includes(skill)) &&
            templateSkillIds.every(skill => skillsToSave.includes(skill));
          
          if (!skillsMatch) {
            // 技能被修改，将模板改为 null（表示"自定义"）
            console.log('[SkillsConfigurationView] Skills modified, setting template to custom');
            await updateAgentTemplate(selectedEmployeeId, null);
          } else {
            console.log('[SkillsConfigurationView] Skills match template, keeping templateId');
          }
        }
      }
      
      toast.success('技能配置已保存');
      onRefresh();
    } catch (err) {
      toast.error('保存失败: ' + String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (!selectedEmployeeId) return;
    setLocalSkills((prev) => ({
      ...prev,
      [selectedEmployeeId]: agentSkills[selectedEmployeeId] || [],
    }));
  };

  const handleApplyTemplate = async (template: AgentTemplate) => {
    if (!selectedEmployeeId) {
      toast.error('请先选择一个员工');
      return;
    }

    setApplyingTemplate(true);
    
    // 使用固定的 toast ID，这样新的会替换旧的
    const toastId = 'apply-template';
    
    try {
      const { installSkill, enableSkill, fetchSkills: refreshSkills } = useSkillsStore.getState();
      
      // 1. 检查哪些技能未安装
      const installedSkillSlugs = allSkills.map(s => s.slug || s.id);
      const missingSkills = template.skills.filter(
        skillId => !installedSkillSlugs.includes(skillId)
      );
      
      // 2. 检查哪些技能已安装但未启用
      const disabledSkills = template.skills.filter(skillId => {
        const skill = allSkills.find(s => (s.slug || s.id) === skillId);
        return skill && !skill.enabled;
      });

      // 3. 自动安装缺失的技能
      const failedSkills: string[] = [];
      if (missingSkills.length > 0) {
        toast.loading(`正在安装 ${missingSkills.length} 个缺失的技能...`, { id: toastId, duration: Infinity });
        
        for (const skillSlug of missingSkills) {
          try {
            await installSkill(skillSlug);
            toast.loading(`✓ ${skillSlug} | 继续安装...`, { id: toastId, duration: Infinity });
          } catch (err) {
            console.error(`Failed to install skill ${skillSlug}:`, err);
            failedSkills.push(skillSlug);
            toast.loading(`✗ ${skillSlug} | 继续安装...`, { id: toastId, duration: Infinity });
          }
        }
        
        // 刷新技能列表
        await refreshSkills();
        
        if (failedSkills.length > 0) {
          toast.warning(
            `部分技能安装失败 (${missingSkills.length - failedSkills.length}/${missingSkills.length} 成功)`,
            { id: toastId, duration: 3000 }
          );
        } else {
          toast.success(`✓ 所有技能安装完成`, { id: toastId, duration: 2000 });
        }
      }

      // 4. 启用已安装但未启用的技能
      if (disabledSkills.length > 0) {
        toast.loading(`正在启用 ${disabledSkills.length} 个技能...`, { id: toastId, duration: Infinity });
        
        for (const skillSlug of disabledSkills) {
          try {
            const skill = allSkills.find(s => (s.slug || s.id) === skillSlug);
            if (skill) {
              await enableSkill(skill.id);
            }
          } catch (err) {
            console.error(`Failed to enable skill ${skillSlug}:`, err);
          }
        }
        
        // 再次刷新技能列表
        await refreshSkills();
      }

      // 5. 获取最新的技能列表并应用模板
      const updatedSkills = useSkillsStore.getState().skills;
      const enabledSkillIds = updatedSkills.filter(s => s.enabled).map(s => s.id);
      
      // 只应用成功安装且启用的技能
      const skillsToApply = template.skills
        .filter(skillSlug => !failedSkills.includes(skillSlug)) // 排除安装失败的
        .map(skillSlug => {
          const skill = updatedSkills.find(s => (s.slug || s.id) === skillSlug);
          return skill?.id;
        })
        .filter((id): id is string => id !== undefined && enabledSkillIds.includes(id));

      // 更新本地技能状态
      setLocalSkills((prev) => ({
        ...prev,
        [selectedEmployeeId]: skillsToApply,
      }));
      
      // 更新模板关联状态（重要：这样保存时才不会被判定为"自定义"）
      const { updateAgentTemplate } = useAgentsStore.getState();
      await updateAgentTemplate(selectedEmployeeId, template.id);
      
      // 加载并应用模板的profile文件
      try {
        toast.loading('正在加载模板配置文件...', { id: toastId, duration: Infinity });
        const { fetchTemplateProfiles } = useAgentTemplatesStore.getState();
        const profileFiles = await fetchTemplateProfiles(template.id);
        
        if (profileFiles && Object.keys(profileFiles).length > 0) {
          // 写入每个profile文件
          for (const [filename, content] of Object.entries(profileFiles)) {
            await window.electron.ipcRenderer.invoke('agent-profile:save', {
              agentId: selectedEmployeeId,
              filename,
              content,
            });
          }
          
          // 如果当前正在查看profile，刷新显示
          if (viewMode === 'profile') {
            await loadMdFile(selectedMdFile);
          }
          
          console.log('[SkillsConfigurationView] Profile files applied:', Object.keys(profileFiles));
        }
      } catch (profileErr) {
        console.error('[SkillsConfigurationView] Failed to apply profile files:', profileErr);
        // 不影响技能应用，只是警告
      }
      
      if (failedSkills.length > 0) {
        toast.warning(
          `已应用"${template.nameZh}"，但有 ${failedSkills.length} 个技能安装失败。已应用 ${skillsToApply.length} 个可用技能。请点击"保存配置"以保存更改`,
          { id: toastId, duration: 5000 }
        );
      } else {
        toast.success(
          `✓ 已应用"${template.nameZh}"，共 ${skillsToApply.length} 个技能。请点击"保存配置"以保存更改`,
          { id: toastId, duration: 3000 }
        );
      }
    } catch (error) {
      console.error('Apply template error:', error);
      toast.error('应用模板失败: ' + String(error), { id: toastId });
    } finally {
      setApplyingTemplate(false);
    }
  };

  // 拖拽处理
  const handleDragStart = useCallback((e: React.DragEvent, skillId: string) => {
    setDraggedSkillId(skillId);
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', skillId);
    
    // 创建自定义拖拽图像
    const dragImage = e.currentTarget.cloneNode(true) as HTMLElement;
    dragImage.style.position = 'absolute';
    dragImage.style.top = '-1000px';
    dragImage.style.opacity = '0.8';
    dragImage.style.transform = 'rotate(-5deg) scale(1.1)';
    document.body.appendChild(dragImage);
    e.dataTransfer.setDragImage(dragImage, 50, 50);
    setTimeout(() => document.body.removeChild(dragImage), 0);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggedSkillId(null);
    setIsDropZoneActive(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setIsDropZoneActive(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // 只有当离开整个拖放区域时才取消高亮
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;
    if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) {
      setIsDropZoneActive(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDropZoneActive(false);
    const skillId = e.dataTransfer.getData('text/plain');
    if (skillId && !currentSkills.includes(skillId)) {
      handleAddSkill(skillId);
      const skill = enabledSkills.find(s => s.id === skillId);
      toast.success(`已添加 ${skill?.name || '技能'}`);
    }
    setDraggedSkillId(null);
  }, [currentSkills, handleAddSkill, enabledSkills]);

  // 关闭下拉菜单
  const dropdownRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowEmployeeDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  if (skillsLoading) {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.3 }}
        className="flex flex-col items-center justify-center py-20"
      >
        <LoadingSpinner size="lg" />
        <p className="text-sm text-muted-foreground mt-4">加载技能中...</p>
      </motion.div>
    );
  }

  if (employees.length === 0) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="flex flex-col items-center justify-center py-20"
      >
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ delay: 0.2, type: 'spring', stiffness: 200 }}
        >
          <Bot className="h-16 w-16 mb-4 text-muted-foreground opacity-50" />
        </motion.div>
        <p className="text-lg font-medium text-foreground mb-2">暂无数字员工</p>
        <p className="text-sm text-muted-foreground">请先创建数字员工</p>
      </motion.div>
    );
  }

  if (enabledSkills.length === 0) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="flex flex-col items-center justify-center py-20"
      >
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ delay: 0.2, type: 'spring', stiffness: 200 }}
        >
          <Puzzle className="h-16 w-16 mb-4 text-muted-foreground opacity-50" />
        </motion.div>
        <p className="text-lg font-medium text-foreground mb-2">暂无可用技能</p>
        <p className="text-sm text-muted-foreground">请先在技能页面安装并启用技能</p>
      </motion.div>
    );
  }

  return (
    <div className="flex flex-col gap-5 h-full">
      {/* 顶部：当前配置员工选择器 */}
      <div className="shrink-0 p-5 rounded-xl border border-black/10 dark:border-white/10 bg-[#f3f1e9] dark:bg-white/[0.06] overflow-visible relative z-50">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3 flex-1 overflow-visible">
            <div className="h-11 w-11 shrink-0 flex items-center justify-center text-primary bg-primary/10 rounded-lg">
              <Bot className="h-5 w-5" />
            </div>
            <div className="flex-1 relative overflow-visible" ref={dropdownRef}>
              <p className="text-[11px] text-muted-foreground mb-1 font-medium uppercase tracking-wide">当前配置员工</p>
              <button
                onClick={() => setShowEmployeeDropdown(!showEmployeeDropdown)}
                className="w-full text-left text-[16px] font-semibold bg-transparent border-none outline-none cursor-pointer text-foreground hover:text-primary transition-colors duration-150 flex items-center justify-between gap-2"
              >
                <span className="truncate">{selectedEmployee?.name || '选择员工'}</span>
                <ChevronDown className={cn(
                  "h-4 w-4 shrink-0 transition-transform duration-200 text-muted-foreground",
                  showEmployeeDropdown && "rotate-180"
                )} />
              </button>
              
              {/* 下拉菜单 */}
              <AnimatePresence>
                {showEmployeeDropdown && (
                  <motion.div
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.15, ease: 'easeOut' }}
                    className="absolute top-full left-0 right-0 mt-2 bg-background border border-border rounded-lg shadow-lg overflow-hidden z-[100] max-h-64 overflow-y-auto"
                  >
                    {employees.map((emp, index) => {
                      const empSkillsCount = (localSkills[emp.id] || []).length;
                      return (
                        <button
                          key={emp.id}
                          onClick={() => {
                            setSelectedEmployeeId(emp.id);
                            setShowEmployeeDropdown(false);
                          }}
                          className={cn(
                            "w-full text-left px-3 py-2.5 text-[14px] transition-colors duration-100 flex items-center justify-between gap-2",
                            selectedEmployeeId === emp.id
                              ? "bg-primary/10 text-primary font-medium"
                              : "text-foreground hover:bg-muted/50",
                            index !== 0 && "border-t border-border/40"
                          )}
                        >
                          <span className="truncate flex-1">{emp.name}</span>
                          <span className="text-[11px] text-muted-foreground font-normal shrink-0">
                            {empSkillsCount}
                          </span>
                          {selectedEmployeeId === emp.id && (
                            <Check className="h-3.5 w-3.5 shrink-0" />
                          )}
                        </button>
                      );
                    })}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
          
          <div className="flex items-center gap-2 shrink-0">
            <AnimatePresence mode="wait">
              {hasChanges && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ duration: 0.15 }}
                >
                  <Button
                    variant="outline"
                    onClick={handleReset}
                    disabled={saving}
                    className="h-9 text-[13px] font-medium rounded-lg px-4"
                  >
                    重置
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>
            <Button
              onClick={handleSave}
              disabled={saving || !hasChanges}
              className="h-9 text-[13px] font-medium rounded-lg px-5"
            >
              {saving ? (
                <>
                  <RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  保存中...
                </>
              ) : (
                '保存配置'
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* 底部：左右分栏 */}
      <div className="flex gap-5 flex-1 min-h-0 relative z-10">
        {/* 左侧：模板选择面板 */}
      <div className="w-80 shrink-0 flex flex-col overflow-y-auto pr-2 -mr-2">
        {/* 整个模板区域的大框 */}
        <div className="p-4 rounded-xl border border-black/10 dark:border-white/10 bg-[#f3f1e9] dark:bg-white/[0.06]">
          {/* 标题 */}
          <div className="mb-4 pb-3 border-b border-black/10 dark:border-white/10">
            <div className="flex items-center gap-2 mb-1.5">
              <Sparkles className="h-4 w-4 text-primary" />
              <h3 className="text-[16px] font-bold text-foreground">
                岗位模板
              </h3>
            </div>
            <p className="text-[12px] text-muted-foreground leading-relaxed">
              选择模板快速配置技能
            </p>
          </div>
          
        {/* 模板列表 */}
        {templatesLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : templates.length === 0 ? (
          <div className="text-center py-12">
            <Sparkles className="h-10 w-10 mx-auto mb-3 text-muted-foreground opacity-50" />
            <p className="text-[13px] text-muted-foreground">暂无可用模板</p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {templates.map((template) => {
              // 检查当前员工是否使用了这个模板
              const { agentTemplates } = useAgentsStore.getState();
              const currentTemplateId = selectedEmployeeId ? agentTemplates[selectedEmployeeId] : undefined;
              const isCurrentTemplate = currentTemplateId === template.id;
              
              const enabledSkillIds = allSkills.filter(s => s.enabled).map(s => s.id);
              const installedSkillSlugs = allSkills.map(s => s.slug || s.id);
              
              // 解析 skills 字段（可能是字符串或数组）
              let templateSkills: string[] = [];
              if (template.skills) {
                if (typeof template.skills === 'string') {
                  try {
                    templateSkills = JSON.parse(template.skills);
                  } catch (e) {
                    console.error('[SkillsConfigurationView] Failed to parse skills:', template.skills);
                    templateSkills = [];
                  }
                } else if (Array.isArray(template.skills)) {
                  templateSkills = template.skills;
                }
              }
              
              // 检查技能是否存在（已安装或已启用）
              const existingSkills = templateSkills.filter(skillId =>
                installedSkillSlugs.includes(skillId) || enabledSkillIds.includes(skillId)
              );
              const availableSkills = templateSkills.filter(skillId =>
                enabledSkillIds.includes(skillId)
              );
              const missingSkills = templateSkills.filter(skillId =>
                !installedSkillSlugs.includes(skillId) && !enabledSkillIds.includes(skillId)
              );
              
              // 如果模板中所有技能都不存在，显示警告
              const allSkillsMissing = existingSkills.length === 0;

              return (
                <button
                  key={template.id}
                  onClick={() => handleApplyTemplate(template)}
                  disabled={applyingTemplate || !selectedEmployeeId || allSkillsMissing}
                  className={cn(
                    'w-full text-left p-3.5 rounded-lg border transition-all duration-200',
                    isCurrentTemplate
                      ? 'border-primary bg-primary/5 shadow-sm'
                      : allSkillsMissing
                      ? 'border-black/5 dark:border-white/5 bg-black/5 dark:bg-white/[0.02] opacity-60 cursor-not-allowed'
                      : 'border-black/5 dark:border-white/5 bg-[#f8f6f0] dark:bg-white/[0.02] hover:border-primary/50 hover:bg-[#f3f1e9] dark:hover:bg-white/[0.06]',
                    !selectedEmployeeId && 'opacity-50 cursor-not-allowed'
                  )}
                >
                  <div className="flex items-start gap-2.5">
                    {/* 图标 */}
                    <div className="text-2xl shrink-0">{template.icon}</div>

                    {/* 内容 */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h4 className="font-semibold text-[14px] text-foreground">
                          {template.nameZh}
                        </h4>
                        {isCurrentTemplate && (
                          <Badge variant="default" className="text-[10px] px-1.5 py-0">
                            使用中
                          </Badge>
                        )}
                        {template.recommended && !allSkillsMissing && !isCurrentTemplate && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                            推荐
                          </Badge>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground mb-2 line-clamp-2 leading-relaxed">
                        {template.descriptionZh || template.description}
                      </p>
                      
                      {/* 技能统计 */}
                      {allSkillsMissing ? (
                        <div className="flex items-center gap-1.5 text-[11px] font-medium text-destructive bg-destructive/10 px-2 py-1 rounded-md w-fit">
                          <span>⚠️</span>
                          <span>所有技能不可用</span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 text-[11px] font-medium">
                          <span className="flex items-center gap-1 text-green-600 dark:text-green-400 bg-green-500/10 px-2 py-1 rounded-md">
                            <span>✓</span>
                            <span>{availableSkills.length} 可用</span>
                          </span>
                          {missingSkills.length > 0 && (
                            <span className="flex items-center gap-1 text-orange-600 dark:text-orange-400 bg-orange-500/10 px-2 py-1 rounded-md">
                              <span>•</span>
                              <span>{missingSkills.length} 需安装</span>
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  
                  {applyingTemplate && isCurrentTemplate && (
                    <div className="mt-3 pt-3 border-t border-border/50 flex items-center gap-2 text-[12px] text-primary font-medium">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>应用中...</span>
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
        </div>
      </div>

      {/* 右侧：已选技能 / 岗位定义 */}
      <div className="flex-1 min-w-0 space-y-6 overflow-y-auto pr-2 -mr-2">
        {/* 已选技能区域 - 第二层容器 */}
        <div
          className={cn(
            'p-6 rounded-2xl border transition-all duration-200',
            isDropZoneActive
              ? 'border-primary bg-primary/5 shadow-lg shadow-primary/10'
              : 'border-black/10 dark:border-white/10 bg-[#f3f1e9] dark:bg-white/[0.06]'
          )}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Button
                variant={viewMode === 'skills' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setViewMode('skills')}
                className="h-8 text-[12px] font-medium rounded-lg px-3"
              >
                <Puzzle className="h-3.5 w-3.5 mr-1.5" />
                已选技能
              </Button>
              <Button
                variant={viewMode === 'profile' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setViewMode('profile')}
                disabled={!selectedEmployeeId}
                className="h-8 text-[12px] font-medium rounded-lg px-3"
              >
                <FileText className="h-3.5 w-3.5 mr-1.5" />
                岗位定义
              </Button>
            </div>
            {viewMode === 'skills' && (
              <AnimatePresence mode="wait">
                <motion.span
                  key={currentSkills.length}
                  initial={{ scale: 1.2, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: 'spring', stiffness: 500, damping: 25 }}
                  className="text-[12px] font-medium text-foreground/70 bg-black/5 dark:bg-white/5 px-3 py-1 rounded-full"
                >
                  {currentSkills.length} 个
                </motion.span>
              </AnimatePresence>
            )}
          </div>
          
          <AnimatePresence mode="wait">
            {viewMode === 'profile' ? (
              <motion.div
                key="profile-view"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.3 }}
                className="flex flex-col h-[600px]"
              >
                {selectedEmployeeId ? (
                  <>
                    {/* 说明区域 */}
                    <div className="mb-3 p-3 rounded-lg bg-blue-500/5 border border-blue-500/20">
                      <div className="flex items-start gap-2">
                        <div className="text-blue-500 mt-0.5">ℹ️</div>
                        <div className="flex-1 text-xs text-foreground/70 space-y-1">
                          <p className="font-medium text-foreground/90">岗位定义文件说明：</p>
                          <ul className="space-y-0.5 ml-3 list-disc">
                            <li><strong>📦 使用模板</strong>：从模板继承，未自定义</li>
                            <li><strong>✏️ 已自定义</strong>：已修改并保存到云端</li>
                            <li><strong>💾 本地文件</strong>：仅保存在本地，未同步</li>
                            <li><strong>☁️ 云端同步</strong>：保存时自动上传，点击"同步"可下载最新版本</li>
                          </ul>
                        </div>
                      </div>
                    </div>
                    
                    {/* MD File tabs */}
                    <div className="flex items-center gap-1 mb-3 border-b border-border pb-2">
                      {MD_FILES.map((file) => (
                        <button
                          key={file}
                          onClick={() => setSelectedMdFile(file)}
                          className={cn(
                            'px-3 py-1.5 text-xs font-medium rounded transition-colors',
                            selectedMdFile === file
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-muted hover:bg-muted/80 text-muted-foreground'
                          )}
                        >
                          {file.replace('.md', '')}
                        </button>
                      ))}
                    </div>

                    {/* Toolbar */}
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        {/* 文件来源标识 */}
                        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-muted/50 border border-border/50">
                          <span className="text-[10px] font-medium text-muted-foreground">来源:</span>
                          {mdSource === 'TEMPLATE' && (
                            <Badge variant="outline" className="h-5 text-[10px] px-1.5 bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30">
                              📦 使用模板
                            </Badge>
                          )}
                          {mdSource === 'USER' && (
                            <Badge variant="outline" className="h-5 text-[10px] px-1.5 bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30">
                              ✏️ 已自定义
                            </Badge>
                          )}
                          {mdSource === 'LOCAL' && (
                            <Badge variant="outline" className="h-5 text-[10px] px-1.5 bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/30">
                              💾 本地文件
                            </Badge>
                          )}
                          {mdSource === 'DEFAULT' && (
                            <Badge variant="outline" className="h-5 text-[10px] px-1.5 bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/30">
                              📄 默认内容
                            </Badge>
                          )}
                        </div>
                        
                        <div className="h-4 w-px bg-border" />
                        
                        <Button
                          variant={isMdPreview ? 'outline' : 'default'}
                          size="sm"
                          onClick={() => setIsMdPreview(false)}
                          className="h-8 text-xs"
                        >
                          <Edit3 className="h-3 w-3 mr-1" />
                          编辑
                        </Button>
                        <Button
                          variant={isMdPreview ? 'default' : 'outline'}
                          size="sm"
                          onClick={() => setIsMdPreview(true)}
                          className="h-8 text-xs"
                        >
                          <Eye className="h-3 w-3 mr-1" />
                          预览
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleSyncProfile}
                          disabled={mdSyncing}
                          className="h-8 text-xs"
                          title="同步所有岗位定义文件"
                        >
                          <RefreshCw className={cn("h-3 w-3 mr-1", mdSyncing && "animate-spin")} />
                          {mdSyncing ? '同步中...' : '同步'}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleLoadDefaultTemplate}
                          className="h-8 text-xs"
                          title="加载默认模板"
                        >
                          <FileCode className="h-3 w-3 mr-1" />
                          默认模板
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleOpenMdFolder}
                          className="h-8 text-xs"
                          title="在文件管理器中打开"
                        >
                          <FolderOpen className="h-3 w-3 mr-1" />
                          打开文件夹
                        </Button>
                      </div>
                      <div className="flex items-center gap-2">
                        {hasMdChanges && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleMdReset}
                            disabled={mdSaving}
                            className="h-8 text-xs"
                          >
                            <RotateCcw className="h-3 w-3 mr-1" />
                            重置
                          </Button>
                        )}
                        <Button
                          variant="default"
                          size="sm"
                          onClick={handleMdSave}
                          disabled={!hasMdChanges || mdSaving}
                          className="h-8 text-xs"
                        >
                          <Save className="h-3 w-3 mr-1" />
                          {mdSaving ? '保存中...' : '保存'}
                        </Button>
                      </div>
                    </div>

                    {/* Content area */}
                    <div className="flex-1 border border-border rounded-lg overflow-hidden">
                      {mdLoading ? (
                        <div className="flex items-center justify-center h-full">
                          <div className="text-sm text-muted-foreground">加载中...</div>
                        </div>
                      ) : isMdPreview ? (
                        <div
                          className="prose prose-sm max-w-none p-4 overflow-auto h-full bg-background"
                          dangerouslySetInnerHTML={previewHtml}
                        />
                      ) : (
                        <textarea
                          value={mdContent}
                          onChange={(e) => setMdContent(e.target.value)}
                          className="w-full h-full p-4 bg-background text-foreground font-mono text-sm resize-none focus:outline-none"
                          placeholder="在此编辑 Markdown 内容..."
                        />
                      )}
                    </div>
                  </>
                ) : (
                  <div className="flex items-center justify-center h-full text-muted-foreground">
                    <p className="text-[13px]">请先选择一个员工</p>
                  </div>
                )}
              </motion.div>
            ) : currentSkills.length === 0 ? (
              <motion.div 
                key="skills-empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex items-center justify-center py-8 text-muted-foreground"
              >
                <p className="text-[13px]">
                  {isDropZoneActive ? '松开鼠标添加技能' : '拖拽技能到这里或点击下方技能卡片'}
                </p>
              </motion.div>
            ) : (
              <motion.div 
                key="skills-list"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                transition={{ duration: 0.3 }}
                layout
                className="flex flex-wrap gap-2"
              >
                <AnimatePresence mode="popLayout">
                  {currentSkills.map((skillId) => {
                    // 尝试通过 ID 或 slug 查找技能（在所有技能中查找，不仅限于已启用的）
                    const skill = allSkills.find((s) => s.id === skillId || (s.slug || s.id) === skillId);
                    
                    if (!skill) {
                      console.warn('[SkillsConfigurationView] Skill not found:', {
                        skillId,
                        skillIdType: typeof skillId,
                        allSkillsCount: allSkills.length,
                        enabledSkillsCount: enabledSkills.length,
                        firstSkill: allSkills[0],
                        sampleSkillIds: allSkills.slice(0, 3).map(s => ({ id: s.id, slug: s.slug })),
                      });
                      return null;
                    }
                    
                    return (
                      <motion.button
                        key={skillId}
                        layout
                        initial={{ scale: 0.8, y: -10 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.8, x: -20 }}
                        transition={{ 
                          type: 'spring',
                          stiffness: 500,
                          damping: 30,
                          mass: 0.8
                        }}
                        onClick={() => handleRemoveSkill(skillId)}
                        className="group inline-flex items-center gap-2 px-3.5 py-2.5 rounded-lg bg-primary/5 hover:bg-primary/8 border border-primary/20 hover:border-primary/30 transition-all duration-200 text-[13px] font-medium"
                      >
                        <span className="text-[16px]">{skill.icon || '🔧'}</span>
                        <span className="text-foreground/90 font-bold">{skill.name}</span>
                        {!skill.enabled && (
                          <span className="text-[10px] text-orange-600 dark:text-orange-400 font-semibold">未启用</span>
                        )}
                        <X className="h-3.5 w-3.5 text-foreground/70 group-hover:text-foreground transition-colors duration-200" />
                      </motion.button>
                    );
                  })}
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

      {/* 搜索和筛选 - 只在技能视图显示 */}
      {viewMode === 'skills' && (
      <div className="space-y-3 px-0.5">
        <div className="relative">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none z-10" />
          <Input
            placeholder="搜索技能..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-11 pr-10 h-11 rounded-xl border-border bg-muted/50 focus:bg-background focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-0 focus-visible:border-primary transition-colors duration-150 text-[13px]"
          />
          <AnimatePresence>
            {searchQuery && (
              <motion.button
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ duration: 0.1 }}
                onClick={() => setSearchQuery('')}
                className="absolute right-3 text-muted-foreground hover:text-foreground transition-colors duration-150 z-10 h-4 w-4 flex items-center justify-center"
                aria-label="清除搜索"
                style={{ top: '14px' }}
              >
                <X className="h-4 w-4" />
              </motion.button>
            )}
          </AnimatePresence>
        </div>

        {/* 分类筛选 */}
        <div className="flex items-center gap-2 flex-wrap">
          {categoriesWithCount.map(([cat, count]) => {
            // 为每个分类添加图标
            const categoryIcon = cat === 'all' ? '📦' :
              cat === '笔记' ? '📝' :
              cat === '开发' ? '💻' :
              cat === '通讯' ? '💬' :
              cat === '媒体' ? '🎨' :
              cat === '网络' ? '🌐' :
              cat === '生活' ? '🌤️' :
              cat === '智能家居' ? '🏠' :
              cat === '音乐' ? '🎵' :
              cat === '任务管理' ? '✅' :
              cat === 'AI' ? '🤖' :
              '🔧';
            
            return (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={cn(
                  'px-3.5 py-1.5 rounded-full text-[12px] font-medium transition-all duration-150 flex items-center gap-1.5 whitespace-nowrap',
                  selectedCategory === cat
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'bg-muted/50 hover:bg-accent text-muted-foreground hover:text-foreground border border-border'
                )}
              >
                <span>{categoryIcon}</span>
                <span>{cat === 'all' ? '全部' : cat}</span>
                <span className="opacity-70 text-[11px]">({count})</span>
              </button>
            );
          })}
        </div>
      </div>
      )}

      {/* 可用技能网格 - 只在技能视图显示 */}
      {viewMode === 'skills' && (
      <div>
        <div className="flex items-center justify-between mb-4">
          <p className="text-[15px] font-serif font-semibold text-foreground" style={{ fontFamily: 'Georgia, Cambria, "Times New Roman", Times, serif' }}>
            {filteredSkills.length === enabledSkills.length 
              ? `可用技能 (${enabledSkills.length} 个已启用)`
              : `筛选结果 (${filteredSkills.length} / ${enabledSkills.length})`
            }
          </p>
        </div>
        
        <AnimatePresence mode="wait">
          {filteredSkills.length === 0 ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="text-center py-16"
            >
              <Puzzle className="h-12 w-12 mx-auto mb-3 text-muted-foreground opacity-50" />
              <p className="text-[14px] text-muted-foreground">没有找到匹配的技能</p>
            </motion.div>
          ) : (
            <div
              key={`grid-${selectedCategory}`}
              className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3"
            >
              {filteredSkills.map((skill) => {
                const isSelected = currentSkills.includes(skill.id);
                const isDragging = draggedSkillId === skill.id;
                return (
                  <div
                    key={skill.id}
                    draggable={!isSelected}
                    onDragStart={(e) => handleDragStart(e, skill.id)}
                    onDragEnd={handleDragEnd}
                    onClick={() => handleToggleSkill(skill.id)}
                    className={cn(
                      'group relative flex flex-col items-center gap-3 p-4 rounded-xl border text-center select-none',
                      'transition-all duration-200 ease-out',
                      isSelected
                        ? 'border-primary bg-primary/5'
                        : isDragging
                        ? 'border-primary/30 bg-black/5 dark:bg-white/[0.02] cursor-grabbing opacity-50'
                        : 'border-black/5 dark:border-white/5 bg-[#f8f6f0] dark:bg-white/[0.02] hover:border-primary/40 hover:bg-[#f3f1e9] dark:hover:bg-white/[0.06] cursor-grab'
                    )}
                  >
                    <div className="text-[32px] pointer-events-none">
                      {skill.icon || '🔧'}
                    </div>
                    <div className="w-full pointer-events-none">
                      <div className="font-medium text-[13px] truncate text-foreground">{skill.name}</div>
                      {skill.category && (
                        <div className="text-[11px] text-muted-foreground truncate mt-1">
                          {skill.category}
                        </div>
                      )}
                    </div>
                    <AnimatePresence>
                      {isSelected && (
                        <motion.div
                          initial={{ scale: 0 }}
                          animate={{ scale: 1 }}
                          exit={{ scale: 0 }}
                          transition={{ duration: 0.15 }}
                          className="absolute top-2 right-2 w-5 h-5 rounded-full bg-primary flex items-center justify-center shadow-sm pointer-events-none"
                        >
                          <Check className="h-3 w-3 text-primary-foreground" />
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
              })}
            </div>
          )}
        </AnimatePresence>
      </div>
      )}

      {/* Template Selection Dialog */}
      </div>
      </div>
    </div>
  );
}
