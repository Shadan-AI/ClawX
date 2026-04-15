import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, Check, Puzzle, RefreshCw, Search, X, Sparkles } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useAgentsStore } from '@/stores/agents';
import { useSkillsStore } from '@/stores/skills';
import { TemplateSelectionDialog } from '@/components/agents/TemplateSelectionDialog';
import type { AgentSummary } from '@/types/agent';
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
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null);
  const [localSkills, setLocalSkills] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [isDropZoneActive, setIsDropZoneActive] = useState(false);
  const [draggedSkillId, setDraggedSkillId] = useState<string | null>(null);
  const [showTemplateDialog, setShowTemplateDialog] = useState(false);

  // 获取本地已安装的技能
  useEffect(() => {
    void fetchSkills();
  }, [fetchSkills]);

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
  
  const currentSkills = useMemo(
    () => selectedEmployeeId ? (localSkills[selectedEmployeeId] || []) : [],
    [selectedEmployeeId, localSkills]
  );
  
  const hasChanges = useMemo(
    () => selectedEmployeeId && JSON.stringify(currentSkills) !== JSON.stringify(agentSkills[selectedEmployeeId] || []),
    [selectedEmployeeId, currentSkills, agentSkills]
  );

  // 只显示已启用的技能供配置
  const enabledSkills = useMemo(
    () => allSkills.filter((skill) => skill.enabled),
    [allSkills]
  );

  // 获取所有分类（缓存计数）
  const categoriesWithCount = useMemo(() => {
    const cats = new Map<string, number>();
    cats.set('all', enabledSkills.length);
    
    enabledSkills.forEach((skill) => {
      if (skill.category) {
        cats.set(skill.category, (cats.get(skill.category) || 0) + 1);
      }
    });
    
    return Array.from(cats.entries())
      .sort((a, b) => a[0] === 'all' ? -1 : b[0] === 'all' ? 1 : a[0].localeCompare(b[0]));
  }, [enabledSkills]);

  // 过滤技能（使用防抖后的搜索词）
  const filteredSkills = useMemo(() => {
    return enabledSkills.filter((skill) => {
      const matchesSearch = !debouncedSearchQuery || 
        skill.name.toLowerCase().includes(debouncedSearchQuery.toLowerCase()) ||
        (skill.description && skill.description.toLowerCase().includes(debouncedSearchQuery.toLowerCase()));
      const matchesCategory = selectedCategory === 'all' || skill.category === selectedCategory;
      return matchesSearch && matchesCategory;
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
      await updateAgentSkills(selectedEmployeeId, localSkills[selectedEmployeeId] || []);
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

  const handleApplyTemplate = (skills: string[]) => {
    if (!selectedEmployeeId) return;
    setLocalSkills((prev) => ({
      ...prev,
      [selectedEmployeeId]: skills,
    }));
    toast.success('模板已应用，请点击"保存配置"以保存更改');
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
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* 员工选择器 + 已选技能 - 合并卡片 */}
      <div
        className={cn(
          'p-6 rounded-2xl border transition-all duration-150',
          isDropZoneActive
            ? 'border-primary/50 bg-primary/5 shadow-md'
            : 'border-black/10 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.02] shadow-sm'
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* 顶部：员工选择器 */}
        <div className="flex items-center gap-4 mb-6">
          <div className="flex items-center gap-3 flex-1">
            <div className="h-12 w-12 shrink-0 flex items-center justify-center text-primary bg-primary/10 rounded-full transition-transform hover:rotate-12 duration-200 shadow-sm">
              <Bot className="h-6 w-6" />
            </div>
            <div className="flex-1">
              <p className="text-xs text-muted-foreground mb-1.5 font-medium">当前配置员工</p>
              <select
                value={selectedEmployeeId || ''}
                onChange={(e) => setSelectedEmployeeId(e.target.value)}
                className="text-lg font-bold bg-transparent border-none outline-none cursor-pointer text-foreground w-full hover:text-primary transition-colors duration-150"
              >
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="outline"
              onClick={() => setShowTemplateDialog(true)}
              className="h-9 text-xs rounded-full px-4 border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5 transition-colors duration-150"
            >
              <Sparkles className="h-3.5 w-3.5 mr-1.5" />
              快速选择模板
            </Button>
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
                    className="h-9 text-xs rounded-full px-4 border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5 transition-colors duration-150"
                  >
                    重置
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>
            <Button
              onClick={handleSave}
              disabled={saving || !hasChanges}
              className="h-9 text-xs rounded-full px-5 shadow-sm hover:shadow-md transition-all duration-150"
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

        {/* 已选技能区域 */}
        <motion.div 
          layout
          transition={{ type: 'spring', stiffness: 400, damping: 30 }}
          className="p-4 rounded-xl bg-black/[0.02] dark:bg-white/[0.02] border border-black/10 dark:border-white/10"
        >
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">
              <Puzzle className="h-3.5 w-3.5" />
              已选技能
            </p>
            <AnimatePresence mode="wait">
              <motion.span
                key={currentSkills.length}
                initial={{ scale: 1.2, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 500, damping: 25 }}
                className="text-xs font-medium text-foreground/70 bg-black/5 dark:bg-white/5 px-2.5 py-1 rounded-full"
              >
                {currentSkills.length} 个
              </motion.span>
            </AnimatePresence>
          </div>
          
          {currentSkills.length === 0 ? (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center justify-center py-6 text-muted-foreground"
            >
              <p className="text-xs">
                {isDropZoneActive ? '松开鼠标添加技能' : '拖拽技能到这里或点击下方技能卡片'}
              </p>
            </motion.div>
          ) : (
            <motion.div 
              layout
              className="flex flex-wrap gap-2"
            >
              <AnimatePresence mode="popLayout">
                {currentSkills.map((skillId) => {
                  const skill = enabledSkills.find((s) => s.id === skillId);
                  if (!skill) return null;
                  return (
                    <motion.button
                      key={skillId}
                      layout
                      initial={{ opacity: 0, scale: 0.8, y: -10 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.8, x: -20 }}
                      transition={{ 
                        type: 'spring',
                        stiffness: 500,
                        damping: 30,
                        mass: 0.8
                      }}
                      onClick={() => handleRemoveSkill(skillId)}
                      className="group inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-black/[0.06] dark:bg-white/[0.08] hover:bg-black/[0.1] dark:hover:bg-white/[0.12] border border-black/10 dark:border-white/10 transition-all duration-200 text-xs font-medium shadow-sm hover:shadow-md"
                    >
                      <span className="text-base">{skill.icon || '🔧'}</span>
                      <span className="text-foreground">{skill.name}</span>
                      <X className="h-3 w-3 text-foreground/40 group-hover:text-foreground/70 transition-colors duration-200" />
                    </motion.button>
                  );
                })}
              </AnimatePresence>
            </motion.div>
          )}
        </motion.div>
      </div>

      {/* 搜索和筛选 */}
      <div className="space-y-3">
        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="搜索技能..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10 h-11 rounded-xl border-black/10 dark:border-white/10 bg-muted/50 focus:bg-background transition-colors duration-150"
          />
          <AnimatePresence>
            {searchQuery && (
              <motion.button
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ duration: 0.1 }}
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors duration-150"
              >
                <X className="h-4 w-4" />
              </motion.button>
            )}
          </AnimatePresence>
        </div>

        {/* 分类筛选 */}
        <div className="flex items-center gap-2 flex-wrap">
          {categoriesWithCount.map(([cat, count]) => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              className={cn(
                'px-3.5 py-1.5 rounded-full text-xs font-medium transition-all duration-150',
                selectedCategory === cat
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground'
              )}
            >
              {cat === 'all' ? '全部' : cat} ({count})
            </button>
          ))}
        </div>
      </div>

      {/* 可用技能网格 */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm font-semibold text-foreground">
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
              <p className="text-muted-foreground">没有找到匹配的技能</p>
            </motion.div>
          ) : (
            <motion.div
              key="grid"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.15 }}
              className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4 p-2"
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
                      'group relative flex flex-col items-center gap-2.5 p-4 rounded-xl border text-center select-none',
                      'transition-all duration-200 ease-out',
                      isSelected
                        ? 'border-primary bg-primary/5 shadow-sm'
                        : isDragging
                        ? 'border-primary/30 bg-black/[0.02] dark:bg-white/[0.02] cursor-grabbing opacity-50'
                        : 'border-black/10 dark:border-white/10 hover:border-primary/30 hover:bg-black/5 dark:hover:bg-white/5 cursor-grab hover:shadow-md'
                    )}
                  >
                    <div className="text-3xl pointer-events-none">
                      {skill.icon || '🔧'}
                    </div>
                    <div className="w-full pointer-events-none">
                      <div className="font-medium text-xs truncate">{skill.name}</div>
                      {skill.category && (
                        <div className="text-[10px] text-muted-foreground truncate mt-0.5">
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
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Template Selection Dialog */}
      <TemplateSelectionDialog
        isOpen={showTemplateDialog}
        onClose={() => setShowTemplateDialog(false)}
        onApply={handleApplyTemplate}
        currentSkills={currentSkills}
      />
    </div>
  );
}
