/**
 * Employee Templates Store
 * 数字员工模板状态管理
 */

import { create } from 'zustand';
import type { EmployeeTemplate } from '@/types/template';
import { OFFICIAL_TEMPLATES } from '@/data/employee-templates';
import { useModelsStore } from './models';

interface TemplatesState {
  templates: EmployeeTemplate[];
  loading: boolean;
  error: string | null;

  fetchTemplates: () => Promise<void>;
  applyTemplate: (employeeId: number, templateId: string, applyModel?: boolean) => Promise<void>;
  clearError: () => void;
}

export const useTemplatesStore = create<TemplatesState>((set, get) => ({
  templates: [],
  loading: false,
  error: null,

  /**
   * 获取模板列表
   * 目前使用本地定义的官方模板，未来可以从服务器获取
   */
  fetchTemplates: async () => {
    set({ loading: true, error: null });
    try {
      // 模拟异步加载
      await new Promise(resolve => setTimeout(resolve, 100));
      set({ templates: OFFICIAL_TEMPLATES, loading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '获取模板失败', loading: false });
    }
  },

  /**
   * 应用模板到数字员工
   * @param employeeId 员工ID
   * @param templateId 模板ID
   * @param applyModel 是否同时应用模板推荐的模型
   */
  applyTemplate: async (employeeId: number, templateId: string, applyModel = false) => {
    const template = get().templates.find(t => t.id === templateId);
    if (!template) {
      throw new Error(`模板 ${templateId} 不存在`);
    }

    try {
      // 更新技能
      await useModelsStore.getState().updateEmployeeSkills(employeeId, template.skills);

      // 如果需要，同时更新模型
      if (applyModel && template.model) {
        const modelsStore = useModelsStore.getState();
        const employee = modelsStore.digitalEmployees.find(e => e.id === employeeId);
        if (employee) {
          // 更新员工的默认模型
          // 注意：这里需要后端支持更新员工的 model 字段
          // 暂时只更新技能，模型更新可以后续添加
          console.log(`[Templates] Would update model to ${template.model} for employee ${employeeId}`);
        }
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '应用模板失败' });
      throw err;
    }
  },

  clearError: () => set({ error: null }),
}));
