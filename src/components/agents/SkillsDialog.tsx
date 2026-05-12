/**
 * Skills Management Dialog
 * 技能管理对话框
 */

import { useState, useEffect, useMemo } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSkillsStore } from '@/stores/skills';
import { useModelsStore } from '@/stores/models';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { AgentAvatar } from '@/components/common/AgentAvatar';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Search, X, Plus, Sparkles } from 'lucide-react';
import { TemplateDialog } from './TemplateDialog';
import type { DigitalEmployee } from '@/stores/models';

interface SkillsDialogProps {
  employee: DigitalEmployee | null;
  isOpen: boolean;
  onClose: () => void;
  onUpdated: () => void;
}

export function SkillsDialog({ employee, isOpen, onClose, onUpdated }: SkillsDialogProps) {
  const allSkills = useSkillsStore((s) => s.skills);
  const { updateEmployeeSkills } = useModelsStore();
  
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);

  // 初始化选中的技能
  useEffect(() => {
    if (employee?.skills) {
      setSelectedSkills([...employee.skills]);
    } else {
      setSelectedSkills([]);
    }
  }, [employee]);

  // 过滤技能列表
  const filteredSkills = useMemo(() => {
    if (!searchQuery.trim()) return allSkills;
    const query = searchQuery.toLowerCase();
    return allSkills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(query) ||
        skill.id.toLowerCase().includes(query)
    );
  }, [allSkills, searchQuery]);

  const handleToggleSkill = (skillId: string) => {
    setSelectedSkills((prev) =>
      prev.includes(skillId)
        ? prev.filter((id) => id !== skillId)
        : [...prev, skillId]
    );
  };

  const handleSave = async () => {
    if (!employee) return;

    setSaving(true);
    try {
      await updateEmployeeSkills(employee.id, selectedSkills);
      toast.success('技能更新成功');
      onUpdated();
      onClose();
    } catch (err) {
      toast.error('更新技能失败: ' + String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleTemplateApplied = () => {
    onUpdated();
    // 刷新当前对话框的数据
    if (employee) {
      const updatedEmployee = useModelsStore.getState().digitalEmployees.find(
        (e) => e.id === employee.id
      );
      if (updatedEmployee?.skills) {
        setSelectedSkills([...updatedEmployee.skills]);
      }
    }
  };

  if (!employee) return null;

  return (
    <>
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-2xl font-serif flex items-center gap-3">
              <AgentAvatar
                name={employee.nickName}
                imageUrl={employee.headImage}
                seed={employee.openclawAgentId || employee.id.toString()}
                className="h-10 w-10"
                fallbackClassName="text-[12px]"
              />
              <div>
                <div>{employee.nickName}</div>
                <div className="text-sm font-normal text-muted-foreground">
                  管理技能
                </div>
              </div>
            </DialogTitle>
            <DialogDescription>
              为该员工添加或删除技能，或使用预设模板快速配置
            </DialogDescription>
          </DialogHeader>

          {/* 操作栏 */}
          <div className="flex items-center gap-2 py-3 border-b">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="搜索技能..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <Button
              variant="outline"
              onClick={() => setTemplateDialogOpen(true)}
              className="shrink-0"
            >
              <Sparkles className="h-4 w-4 mr-2" />
              应用模板
            </Button>
          </div>

          {/* 已选技能 */}
          {selectedSkills.length > 0 && (
            <div className="py-3 border-b">
              <p className="text-sm font-medium mb-2">
                已选技能 ({selectedSkills.length})
              </p>
              <div className="flex flex-wrap gap-2">
                {selectedSkills.map((skillId) => {
                  const skill = allSkills.find((s) => s.id === skillId);
                  if (!skill) return null;
                  return (
                    <button
                      key={skillId}
                      onClick={() => handleToggleSkill(skillId)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary/10 text-primary hover:bg-primary/20 transition-colors text-sm"
                    >
                      <span>{skill.icon}</span>
                      <span>{skill.name}</span>
                      <X className="h-3 w-3" />
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* 技能列表 */}
          <div className="flex-1 overflow-y-auto pr-2 -mr-2">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 py-4">
              {filteredSkills.map((skill) => {
                const isSelected = selectedSkills.includes(skill.id);
                return (
                  <button
                    key={skill.id}
                    onClick={() => handleToggleSkill(skill.id)}
                    className={cn(
                      'flex items-center gap-3 p-3 rounded-lg border-2 text-left transition-all',
                      'hover:shadow-sm',
                      isSelected
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:border-primary/30'
                    )}
                  >
                    <div className="text-2xl">{skill.icon || '🔧'}</div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm truncate">
                        {skill.name}
                      </div>
                      {skill.description && (
                        <div className="text-xs text-muted-foreground line-clamp-1">
                          {skill.description}
                        </div>
                      )}
                    </div>
                    {isSelected && (
                      <div className="shrink-0 w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                        <Plus className="h-3 w-3 text-primary-foreground rotate-45" />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>

            {filteredSkills.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                <Search className="h-12 w-12 mb-4 opacity-50" />
                <p>未找到匹配的技能</p>
              </div>
            )}
          </div>

          {/* 底部按钮 */}
          <div className="flex items-center justify-between pt-4 border-t">
            <div className="text-sm text-muted-foreground">
              已选择 {selectedSkills.length} 个技能
            </div>
            <div className="flex items-center gap-3">
              <Button variant="outline" onClick={onClose} disabled={saving}>
                取消
              </Button>
              <Button onClick={handleSave} disabled={saving}>
                {saving ? (
                  <>
                    <LoadingSpinner size="sm" className="mr-2" />
                    保存中...
                  </>
                ) : (
                  '保存'
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 模板选择对话框 */}
      <TemplateDialog
        employeeId={employee.id}
        isOpen={templateDialogOpen}
        onClose={() => setTemplateDialogOpen(false)}
        onApplied={handleTemplateApplied}
      />
    </>
  );
}
