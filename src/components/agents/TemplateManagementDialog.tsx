/**
 * Template Management Dialog
 * Manage agent templates (view, create, edit, delete)
 */
import { useEffect, useState } from 'react';
import { X, Plus, Edit2, Trash2, Save, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { useAgentTemplatesStore } from '@/stores/agent-templates';
import { useSkillsStore } from '@/stores/skills';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { AgentTemplate, AgentTemplateDTO } from '@/types/agent';

interface TemplateManagementDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

interface TemplateFormData {
  name: string;
  nameZh: string;
  description: string;
  descriptionZh: string;
  icon: string;
  skills: string[];
  recommended: boolean;
  sortOrder: number;
}

export function TemplateManagementDialog({ isOpen, onClose }: TemplateManagementDialogProps) {
  const { templates, loading, fetchTemplates, createTemplate, updateTemplate, deleteTemplate } = useAgentTemplatesStore();
  const { skills } = useSkillsStore();
  const [editingTemplate, setEditingTemplate] = useState<AgentTemplate | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState<TemplateFormData>({
    name: '',
    nameZh: '',
    description: '',
    descriptionZh: '',
    icon: '👨‍💼',
    skills: [],
    recommended: false,
    sortOrder: 0,
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isOpen) {
      fetchTemplates();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const handleEdit = (template: AgentTemplate) => {
    setEditingTemplate(template);
    setFormData({
      name: template.name,
      nameZh: template.nameZh,
      description: template.description || '',
      descriptionZh: template.descriptionZh || '',
      icon: template.icon,
      skills: template.skills,
      recommended: template.recommended,
      sortOrder: template.sortOrder,
    });
    setShowForm(true);
  };

  const handleCreate = () => {
    setEditingTemplate(null);
    setFormData({
      name: '',
      nameZh: '',
      description: '',
      descriptionZh: '',
      icon: '👨‍💼',
      skills: [],
      recommended: false,
      sortOrder: templates.length + 1,
    });
    setShowForm(true);
  };

  const handleSave = async () => {
    // 验证
    if (!formData.name.trim()) {
      toast.error('请输入英文名称');
      return;
    }
    if (!formData.nameZh.trim()) {
      toast.error('请输入中文名称');
      return;
    }
    if (formData.skills.length === 0) {
      toast.error('请至少选择一个技能');
      return;
    }

    setSaving(true);
    try {
      const dto: AgentTemplateDTO = {
        name: formData.name.trim(),
        nameZh: formData.nameZh.trim(),
        description: formData.description.trim(),
        descriptionZh: formData.descriptionZh.trim(),
        icon: formData.icon,
        skills: formData.skills,
        recommended: formData.recommended,
        sortOrder: formData.sortOrder,
      };

      if (editingTemplate) {
        await updateTemplate(editingTemplate.id, dto);
        toast.success('模板更新成功');
      } else {
        await createTemplate(dto);
        toast.success('模板创建成功');
      }

      setShowForm(false);
      setEditingTemplate(null);
      await fetchTemplates();
    } catch (error) {
      toast.error('保存失败: ' + String(error));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (template: AgentTemplate) => {
    if (!confirm(`确定要删除模板"${template.nameZh}"吗？`)) {
      return;
    }

    try {
      await deleteTemplate(template.id);
      toast.success('模板删除成功');
      await fetchTemplates();
    } catch (error) {
      toast.error('删除失败: ' + String(error));
    }
  };

  const toggleSkill = (skillId: string) => {
    setFormData(prev => ({
      ...prev,
      skills: prev.skills.includes(skillId)
        ? prev.skills.filter(id => id !== skillId)
        : [...prev.skills, skillId],
    }));
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-[#f3f1e9] dark:bg-card w-full max-w-4xl max-h-[90vh] rounded-2xl shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-black/10 dark:border-white/10">
          <div>
            <h2 className="text-2xl font-serif text-foreground font-normal tracking-tight">
              模板管理
            </h2>
            <p className="text-sm text-foreground/70 mt-1">
              管理数字员工预设模板
            </p>
          </div>
          <div className="flex items-center gap-2">
            {!showForm && (
              <Button
                onClick={handleCreate}
                className="h-9 text-[13px] font-medium rounded-full px-4"
              >
                <Plus className="h-3.5 w-3.5 mr-2" />
                创建模板
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="h-9 w-9 rounded-full"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading && !templates.length ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : showForm ? (
            /* Form View */
            <div className="space-y-6 max-w-2xl mx-auto">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-sm font-bold text-foreground/80">英文名称 *</Label>
                  <Input
                    value={formData.name}
                    onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                    placeholder="Customer Service"
                    className="h-11 rounded-xl"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-sm font-bold text-foreground/80">中文名称 *</Label>
                  <Input
                    value={formData.nameZh}
                    onChange={(e) => setFormData(prev => ({ ...prev, nameZh: e.target.value }))}
                    placeholder="客服助手"
                    className="h-11 rounded-xl"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-bold text-foreground/80">图标 Emoji</Label>
                <Input
                  value={formData.icon}
                  onChange={(e) => setFormData(prev => ({ ...prev, icon: e.target.value }))}
                  placeholder="👨‍💼"
                  className="h-11 rounded-xl text-2xl"
                  maxLength={4}
                />
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-bold text-foreground/80">英文描述</Label>
                <Input
                  value={formData.description}
                  onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                  placeholder="Handle customer inquiries and support"
                  className="h-11 rounded-xl"
                />
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-bold text-foreground/80">中文描述</Label>
                <Input
                  value={formData.descriptionZh}
                  onChange={(e) => setFormData(prev => ({ ...prev, descriptionZh: e.target.value }))}
                  placeholder="处理客户咨询和支持工作"
                  className="h-11 rounded-xl"
                />
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-bold text-foreground/80">技能列表 * (已选 {formData.skills.length})</Label>
                <div className="border border-black/10 dark:border-white/10 rounded-xl p-4 bg-[#eeece3] dark:bg-muted max-h-48 overflow-y-auto">
                  <div className="flex flex-wrap gap-2">
                    {skills.filter(s => s.enabled).map(skill => (
                      <Badge
                        key={skill.id}
                        variant={formData.skills.includes(skill.id) ? 'default' : 'outline'}
                        className={cn(
                          'cursor-pointer transition-colors',
                          formData.skills.includes(skill.id)
                            ? 'bg-blue-500 text-white hover:bg-blue-600'
                            : 'hover:bg-black/5 dark:hover:bg-white/5'
                        )}
                        onClick={() => toggleSkill(skill.id)}
                      >
                        {skill.icon} {skill.name}
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between p-4 rounded-xl bg-[#eeece3] dark:bg-muted">
                <div>
                  <Label className="text-sm font-bold text-foreground/80">推荐模板</Label>
                  <p className="text-xs text-foreground/60 mt-1">推荐的模板会优先显示</p>
                </div>
                <Switch
                  checked={formData.recommended}
                  onCheckedChange={(checked) => setFormData(prev => ({ ...prev, recommended: checked }))}
                />
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-bold text-foreground/80">排序顺序</Label>
                <Input
                  type="number"
                  value={formData.sortOrder}
                  onChange={(e) => setFormData(prev => ({ ...prev, sortOrder: parseInt(e.target.value) || 0 }))}
                  className="h-11 rounded-xl"
                />
              </div>

              <div className="flex items-center gap-3 pt-4">
                <Button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex-1 h-11 rounded-full"
                >
                  {saving ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      保存中...
                    </>
                  ) : (
                    <>
                      <Save className="h-4 w-4 mr-2" />
                      保存模板
                    </>
                  )}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowForm(false);
                    setEditingTemplate(null);
                  }}
                  disabled={saving}
                  className="flex-1 h-11 rounded-full"
                >
                  取消
                </Button>
              </div>
            </div>
          ) : (
            /* List View */
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {templates.map(template => (
                <div
                  key={template.id}
                  className="p-4 rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-muted hover:shadow-md transition-shadow"
                >
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

                  <p className="text-sm text-foreground/70 mb-3 line-clamp-2">
                    {template.descriptionZh || template.description}
                  </p>

                  <div className="flex flex-wrap gap-1.5 mb-3">
                    {template.skills.slice(0, 3).map(skillId => (
                      <Badge
                        key={skillId}
                        variant="outline"
                        className="text-xs"
                      >
                        {skillId}
                      </Badge>
                    ))}
                    {template.skills.length > 3 && (
                      <Badge variant="outline" className="text-xs">
                        +{template.skills.length - 3}
                      </Badge>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleEdit(template)}
                      className="flex-1 h-8 text-xs rounded-full"
                    >
                      <Edit2 className="h-3 w-3 mr-1" />
                      编辑
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleDelete(template)}
                      className="flex-1 h-8 text-xs rounded-full text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="h-3 w-3 mr-1" />
                      删除
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
