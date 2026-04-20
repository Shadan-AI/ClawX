/**
 * Agent Templates State Store
 * 管理数字员工模板状态
 */
import { create } from 'zustand';
import type { AgentTemplate, AgentTemplateDTO } from '@/types/agent';
import { toast } from 'sonner';
import { invokeIpc } from '@/lib/api-client';

// 获取 Token-Key
async function getTokenKey(): Promise<string | null> {
  try {
    return await invokeIpc<string | null>('box-im:getTokenKey');
  } catch (err) {
    console.warn('[agent-templates] Failed to get tokenKey:', err);
    return null;
  }
}

interface AgentTemplatesState {
  templates: AgentTemplate[];
  loading: boolean;
  error: string | null;
  
  // Actions
  fetchTemplates: () => Promise<void>;
  createTemplate: (template: AgentTemplateDTO) => Promise<void>;
  updateTemplate: (id: number, template: AgentTemplateDTO) => Promise<void>;
  deleteTemplate: (id: number) => Promise<void>;
  applyTemplate: (templateId: number, botId: number) => Promise<void>;
}

const API_BASE_URL = 'https://im.shadanai.com/api';

export const useAgentTemplatesStore = create<AgentTemplatesState>((set, get) => ({
  templates: [],
  loading: false,
  error: null,

  /**
   * 获取所有模板列表（需要认证）
   */
  fetchTemplates: async () => {
    set({ loading: true, error: null });
    try {
      console.log('[agent-templates] Fetching templates...');
      
      const tokenKey = await getTokenKey();
      if (!tokenKey) {
        console.warn('[agent-templates] No tokenKey, cannot fetch templates');
        set({ templates: [], loading: false });
        return;
      }
      
      const response = await fetch(`${API_BASE_URL}/agent/template/list`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Token-Key': tokenKey,
        },
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const result = await response.json();
      
      if (result.code === 200 || result.code === 0) {
        console.log('[agent-templates] Fetched templates:', result.data?.length || 0);
        set({ templates: result.data || [], loading: false });
      } else {
        console.warn('[agent-templates] API returned error:', result.message);
        set({ templates: [], loading: false });
      }
    } catch (error) {
      console.error('[agent-templates] Failed to fetch templates:', error);
      set({ templates: [], loading: false });
    }
  },

  /**
   * 创建新模板（需要认证）
   */
  createTemplate: async (template) => {
    try {
      console.log('[agent-templates] Creating template:', template.nameZh);
      
      const tokenKey = await getTokenKey();
      if (!tokenKey) {
        throw new Error('未登录，请先登录 Box-IM');
      }
      
      const response = await fetch(`${API_BASE_URL}/agent/template/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Token-Key': tokenKey,
        },
        body: JSON.stringify(template),
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const result = await response.json();
      
      if (result.code === 200 || result.code === 0) {
        console.log('[agent-templates] Template created:', result.data?.id);
        await get().fetchTemplates();
        toast.success('模板创建成功');
      } else {
        throw new Error(result.message || '创建模板失败');
      }
    } catch (error) {
      console.error('[agent-templates] Failed to create template:', error);
      toast.error('创建模板失败: ' + String(error));
      throw error;
    }
  },

  /**
   * 更新模板（需要认证）
   */
  updateTemplate: async (id, template) => {
    try {
      console.log('[agent-templates] Updating template:', id);
      
      const tokenKey = await getTokenKey();
      if (!tokenKey) {
        throw new Error('未登录，请先登录 Box-IM');
      }
      
      const response = await fetch(`${API_BASE_URL}/agent/template/${id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Token-Key': tokenKey,
        },
        body: JSON.stringify(template),
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const result = await response.json();
      
      if (result.code === 200 || result.code === 0) {
        console.log('[agent-templates] Template updated:', id);
        await get().fetchTemplates();
        toast.success('模板更新成功');
      } else {
        throw new Error(result.message || '更新模板失败');
      }
    } catch (error) {
      console.error('[agent-templates] Failed to update template:', error);
      toast.error('更新模板失败: ' + String(error));
      throw error;
    }
  },

  /**
   * 删除模板（需要认证）
   */
  deleteTemplate: async (id) => {
    try {
      console.log('[agent-templates] Deleting template:', id);
      
      const tokenKey = await getTokenKey();
      if (!tokenKey) {
        throw new Error('未登录，请先登录 Box-IM');
      }
      
      const response = await fetch(`${API_BASE_URL}/agent/template/${id}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Token-Key': tokenKey,
        },
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const result = await response.json();
      
      if (result.code === 200 || result.code === 0) {
        console.log('[agent-templates] Template deleted:', id);
        await get().fetchTemplates();
        toast.success('模板删除成功');
      } else {
        throw new Error(result.message || '删除模板失败');
      }
    } catch (error) {
      console.error('[agent-templates] Failed to delete template:', error);
      toast.error('删除模板失败: ' + String(error));
      throw error;
    }
  },

  /**
   * 应用模板到Bot（需要认证）
   */
  applyTemplate: async (templateId, botId) => {
    try {
      console.log('[agent-templates] Applying template:', { templateId, botId });
      
      const tokenKey = await getTokenKey();
      if (!tokenKey) {
        throw new Error('未登录，请先登录 Box-IM');
      }
      
      const response = await fetch(`${API_BASE_URL}/agent/template/apply/${templateId}/to/${botId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Token-Key': tokenKey,
        },
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const result = await response.json();
      
      if (result.code === 200 || result.code === 0) {
        console.log('[agent-templates] Template applied successfully');
        toast.success('模板应用成功');
      } else {
        throw new Error(result.message || '应用模板失败');
      }
    } catch (error) {
      console.error('[agent-templates] Failed to apply template:', error);
      toast.error('应用模板失败: ' + String(error));
      throw error;
    }
  },
}));
