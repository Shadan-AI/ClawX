/**
 * Template Selection Dialog
 * 模板选择对话框 - 快速应用模板到员工
 */
import { useEffect, useState, useMemo } from 'react';
import { X, Check, Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useAgentTemplatesStore } from '@/stores/agent-templates';
import { useSkillsStore } from '@/stores/skills';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { AgentTemplate } from '@/types/agent';

interface TemplateSelectionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onApply: (skills: string[]) => void;
  currentSkills: string[];
}

export function TemplateSelectionDialog({
  isOpen,
  onClose,
  onApply,
  currentSkills,
}: TemplateSelectionDialogProps) {
  const { templates, loading, fetchTemplates } = useAgentTemplatesStore();
  const { skills: allSkills } = useSkillsStore();
  const [selectedTemplate, setSelectedTemplate] = useState<AgentTemplate | null>(null);
  const [applying, setApplying] = useState(false);
  const [installingSkill, setInstallingSkill] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      fetchTemplates();
    }
  }, [isOpen, fetchTemplates]);

  const handleApply = async () => {
    if (!selectedTemplate) return;

    setApplying(true);
    try {
      const { installSkill, enableSkill, fetchSkills } = useSkillsStore.getState();
      
      // 1. 检查哪些技能未安装
      const installedSkillSlugs = allSkills.map(s => s.slug || s.id);
      const missingSkills = selectedTemplate.skills.filter(
        skillId => !installedSkillSlugs.includes(skillId)
      );
      
      // 2. 检查哪些技能已安装但未启用
      const disabledSkills = selectedTemplate.skills.filter(skillId => {
        const skill = allSkills.find(s => (s.slug || s.id) === skillId);
        return skill && !skill.enabled;
      });

      // 3. 自动安装缺失的技能
      if (missingSkills.length > 0) {
        toast.info(`正在安装 ${missingSkills.length} 个缺失的技能...`, { duration: 3000 });
        
        let successCount = 0;
        const failedSkills: string[] = [];
        
        for (const skillSlug of missingSkills) {
          setInstallingSkill(skillSlug);
          
          // 使用 setTimeout 让 UI 有机会更新
          await new Promise(resolve => setTimeout(resolve, 100));
          
          try {
            await installSkill(skillSlug);
            successCount++;
            toast.success(`✓ ${skillSlug}`, { duration: 2000 });
          } catch (err) {
            console.error(`Failed to install skill ${skillSlug}:`, err);
            failedSkills.push(skillSlug);
            toast.error(`✗ ${skillSlug}`, { duration: 2000 });
          }
        }
        
        setInstallingSkill(null);
        
        // 刷新技能列表
        await fetchSkills();
        
        if (failedSkills.length > 0) {
          toast.warning(
            `部分技能安装失败 (${successCount}/${missingSkills.length})`,
            { duration: 3000 }
          );
        } else {
          toast.success(`✓ 所有技能安装完成`, { duration: 2000 });
        }
      }

      // 4. 启用已安装但未启用的技能
      if (disabledSkills.length > 0) {
        toast.info(`正在启用 ${disabledSkills.length} 个技能...`, { duration: 2000 });
        
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
        await fetchSkills();
      }

      // 5. 获取最新的技能列表并应用模板
      const updatedSkills = useSkillsStore.getState().skills;
      const enabledSkillIds = updatedSkills.filter(s => s.enabled).map(s => s.id);
      const skillsToApply = selectedTemplate.skills
        .map(skillSlug => {
          const skill = updatedSkills.find(s => (s.slug || s.id) === skillSlug);
          return skill?.id;
        })
        .filter((id): id is string => id !== undefined && enabledSkillIds.includes(id));

      onApply(skillsToApply);
      toast.success(
        `✓ 已应用"${selectedTemplate.nameZh}"，共 ${skillsToApply.length} 个技能`,
        { duration: 3000 }
      );
      onClose();
    } catch (error) {
      console.error('Apply template error:', error);
      toast.error('应用模板失败: ' + String(error));
    } finally {
      setApplying(false);
      setInstallingSkill(null);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-[#f3f1e9] dark:bg-card w-full max-w-3xl max-h-[85vh] rounded-2xl shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-black/10 dark:border-white/10">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
              <Sparkles className="h-5 w-5 text-white" />
            </div>
            <div>
              <h2 className="text-2xl font-serif text-foreground font-normal tracking-tight">
                快速选择模板
              </h2>
              <p className="text-sm text-foreground/70 mt-0.5">
                选择一个模板快速配置技能
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-9 w-9 rounded-full"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : templates.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Sparkles className="h-12 w-12 text-muted-foreground opacity-50 mb-4" />
              <p className="text-foreground/70">暂无可用模板</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {templates.map((template) => {
                const isSelected = selectedTemplate?.id === template.id;
                const enabledSkillIds = allSkills.filter(s => s.enabled).map(s => s.id);
                const availableSkills = template.skills.filter(skillId =>
                  enabledSkillIds.includes(skillId)
                );
                const missingSkills = template.skills.filter(skillId =>
                  !enabledSkillIds.includes(skillId)
                );

                return (
                  <div
                    key={template.id}
                    onClick={() => setSelectedTemplate(template)}
                    className={cn(
                      'relative p-5 rounded-xl border-2 cursor-pointer transition-all duration-200',
                      isSelected
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/20 shadow-lg scale-[1.02]'
                        : 'border-black/10 dark:border-white/10 bg-white dark:bg-muted hover:border-blue-300 hover:shadow-md'
                    )}
                  >
                    {/* 选中标记 */}
                    {isSelected && (
                      <div className="absolute top-3 right-3 h-6 w-6 rounded-full bg-blue-500 flex items-center justify-center">
                        <Check className="h-4 w-4 text-white" />
                      </div>
                    )}

                    {/* 图标和标题 */}
                    <div className="flex items-start gap-3 mb-3">
                      <div className="text-3xl">{template.icon}</div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="font-semibold text-foreground truncate">
                            {template.nameZh}
                          </h3>
                          {template.recommended && (
                            <Badge variant="secondary" className="text-xs">
                              推荐
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">{template.name}</p>
                      </div>
                    </div>

                    {/* 描述 */}
                    <p className="text-sm text-foreground/70 mb-3 line-clamp-2">
                      {template.descriptionZh || template.description}
                    </p>

                    {/* 技能统计 */}
                    <div className="flex items-center gap-2 text-xs">
                      <Badge variant="outline" className="bg-green-50 dark:bg-green-950/20 text-green-700 dark:text-green-400 border-green-200 dark:border-green-800">
                        {availableSkills.length} 个可用
                      </Badge>
                      {missingSkills.length > 0 && (
                        <Badge variant="outline" className="bg-orange-50 dark:bg-orange-950/20 text-orange-700 dark:text-orange-400 border-orange-200 dark:border-orange-800">
                          {missingSkills.length} 个缺失
                        </Badge>
                      )}
                    </div>

                    {/* 技能列表预览 */}
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {template.skills.slice(0, 4).map((skillId) => {
                        const isAvailable = enabledSkillIds.includes(skillId);
                        return (
                          <Badge
                            key={skillId}
                            variant="outline"
                            className={cn(
                              'text-xs',
                              isAvailable
                                ? 'bg-white dark:bg-muted'
                                : 'bg-gray-100 dark:bg-gray-800 opacity-50'
                            )}
                          >
                            {skillId}
                          </Badge>
                        );
                      })}
                      {template.skills.length > 4 && (
                        <Badge variant="outline" className="text-xs">
                          +{template.skills.length - 4}
                        </Badge>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-6 border-t border-black/10 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.02]">
          <div className="text-sm text-foreground/70">
            {selectedTemplate ? (
              <>
                已选择: <span className="font-semibold text-foreground">{selectedTemplate.nameZh}</span>
              </>
            ) : (
              '请选择一个模板'
            )}
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              onClick={onClose}
              disabled={applying}
              className="h-10 rounded-full px-5"
            >
              取消
            </Button>
            <Button
              onClick={handleApply}
              disabled={!selectedTemplate || applying}
              className="h-10 rounded-full px-5"
            >
              {applying ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {installingSkill ? `安装 ${installingSkill}...` : '应用中...'}
                </>
              ) : (
                <>
                  <Check className="h-4 w-4 mr-2" />
                  应用模板
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
