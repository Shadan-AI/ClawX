/**
 * Template Selection Dialog
 * 员工模板选择对话框
 */

import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useTemplatesStore } from '@/stores/templates';
import { useModelsStore } from '@/stores/models';
import { SkillBadges } from './SkillBadges';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Check } from 'lucide-react';

interface TemplateDialogProps {
  employeeId: number;
  isOpen: boolean;
  onClose: () => void;
  onApplied: () => void;
}

export function TemplateDialog({ employeeId, isOpen, onClose, onApplied }: TemplateDialogProps) {
  const { templates, loading, fetchTemplates, applyTemplate } = useTemplatesStore();
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [applyModel, setApplyModel] = useState(false);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (isOpen && templates.length === 0) {
      fetchTemplates();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, templates.length]);

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId);

  const handleApply = async () => {
    if (!selectedTemplateId) return;

    setApplying(true);
    try {
      await applyTemplate(employeeId, selectedTemplateId, applyModel);
      toast.success('模板应用成功');
      onApplied();
      onClose();
    } catch (err) {
      toast.error('应用模板失败: ' + String(err));
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-2xl font-serif">选择员工模板</DialogTitle>
          <DialogDescription>
            选择一个预设模板快速配置员工的技能和模型
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto pr-2 -mr-2">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <LoadingSpinner size="lg" />
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 py-4">
              {templates.map((template) => {
                const isSelected = template.id === selectedTemplateId;
                return (
                  <button
                    key={template.id}
                    onClick={() => setSelectedTemplateId(template.id)}
                    className={cn(
                      'relative p-4 rounded-xl border-2 text-left transition-all',
                      'hover:shadow-md hover:scale-[1.02]',
                      isSelected
                        ? 'border-primary bg-primary/5 shadow-md'
                        : 'border-border hover:border-primary/50'
                    )}
                  >
                    {isSelected && (
                      <div className="absolute top-3 right-3 w-6 h-6 rounded-full bg-primary flex items-center justify-center">
                        <Check className="h-4 w-4 text-primary-foreground" />
                      </div>
                    )}

                    <div className="flex items-start gap-3 mb-3">
                      <div className="text-4xl">{template.icon}</div>
                      <div className="flex-1">
                        <h3 className="text-lg font-semibold text-foreground mb-1">
                          {template.name}
                        </h3>
                        <p className="text-sm text-muted-foreground leading-relaxed">
                          {template.description}
                        </p>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div>
                        <p className="text-xs font-medium text-muted-foreground mb-1.5">
                          包含技能:
                        </p>
                        <SkillBadges skills={template.skills} maxDisplay={5} size="sm" />
                      </div>

                      {template.model && (
                        <div>
                          <p className="text-xs font-medium text-muted-foreground mb-1">
                            推荐模型:
                          </p>
                          <span className="text-xs font-mono px-2 py-1 rounded bg-black/5 dark:bg-white/10">
                            {template.model}
                          </span>
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {selectedTemplate && selectedTemplate.model && (
          <div className="flex items-center gap-2 py-3 border-t">
            <Checkbox
              id="apply-model"
              checked={applyModel}
              onCheckedChange={(checked) => setApplyModel(checked as boolean)}
            />
            <label
              htmlFor="apply-model"
              className="text-sm font-medium cursor-pointer"
            >
              同时应用推荐模型 ({selectedTemplate.model})
            </label>
          </div>
        )}

        <div className="flex items-center justify-end gap-3 pt-4 border-t">
          <Button variant="outline" onClick={onClose} disabled={applying}>
            取消
          </Button>
          <Button
            onClick={handleApply}
            disabled={!selectedTemplateId || applying}
          >
            {applying ? (
              <>
                <LoadingSpinner size="sm" className="mr-2" />
                应用中...
              </>
            ) : (
              '应用模板'
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
