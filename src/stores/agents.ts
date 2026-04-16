import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import type { ChannelType } from '@/types/channel';
import type { AgentSummary, AgentsSnapshot } from '@/types/agent';

interface AgentsState {
  agents: AgentSummary[];
  defaultAgentId: string;
  defaultModelRef: string | null;
  configuredChannelTypes: string[];
  channelOwners: Record<string, string>;
  channelAccountOwners: Record<string, string>;
  agentSkills: Record<string, string[]>; // agentId -> skillIds
  agentTemplates: Record<string, number | null>; // agentId -> templateId (null = 自定义)
  loading: boolean;
  error: string | null;
  fetchAgents: () => Promise<void>;
  createAgent: (name: string, options?: { inheritWorkspace?: boolean }) => Promise<void>;
  updateAgent: (agentId: string, name: string) => Promise<void>;
  updateAgentModel: (agentId: string, modelRef: string | null) => Promise<void>;
  deleteAgent: (agentId: string) => Promise<void>;
  assignChannel: (agentId: string, channelType: ChannelType) => Promise<void>;
  removeChannel: (agentId: string, channelType: ChannelType) => Promise<void>;
  updateAgentSkills: (agentId: string, skillIds: string[]) => Promise<void>;
  updateAgentTemplate: (agentId: string, templateId: number | null) => Promise<void>;
  clearError: () => void;
}

const SESSION_MODELS_KEY = 'clawx-session-models';
const AGENT_TEMPLATES_KEY = 'clawx-agent-templates';

function loadAgentTemplates(): Record<string, number | null> {
  try {
    const raw = localStorage.getItem(AGENT_TEMPLATES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveAgentTemplates(templates: Record<string, number | null>) {
  try {
    localStorage.setItem(AGENT_TEMPLATES_KEY, JSON.stringify(templates));
  } catch { /* ignore */ }
}

function applySnapshot(snapshot: AgentsSnapshot | undefined) {
  return snapshot ? {
    agents: snapshot.agents ?? [],
    defaultAgentId: snapshot.defaultAgentId ?? 'main',
    defaultModelRef: snapshot.defaultModelRef ?? null,
    configuredChannelTypes: snapshot.configuredChannelTypes ?? [],
    channelOwners: snapshot.channelOwners ?? {},
    channelAccountOwners: snapshot.channelAccountOwners ?? {},
  } : {};
}

export const useAgentsStore = create<AgentsState>((set, get) => ({
  agents: [],
  defaultAgentId: 'main',
  defaultModelRef: null,
  configuredChannelTypes: [],
  channelOwners: {},
  channelAccountOwners: {},
  agentSkills: {},
  agentTemplates: loadAgentTemplates(), // 从 localStorage 加载
  loading: false,
  error: null,

  fetchAgents: async () => {
    set({ loading: true, error: null });
    try {
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>('/api/agents');
      
      // 从 agents 中提取 skills 到 agentSkills
      const agentSkills: Record<string, string[]> = {};
      snapshot.agents?.forEach(agent => {
        if (agent.skills && Array.isArray(agent.skills)) {
          agentSkills[agent.id] = agent.skills;
        }
      });
      
      set({
        ...applySnapshot(snapshot),
        agentSkills,
        loading: false,
      });
    } catch (error) {
      set({ loading: false, error: String(error) });
    }
  },

  createAgent: async (name: string, options?: { inheritWorkspace?: boolean }) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>('/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name, inheritWorkspace: options?.inheritWorkspace }),
      });
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  updateAgent: async (agentId: string, name: string) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>(
        `/api/agents/${encodeURIComponent(agentId)}`,
        {
          method: 'PUT',
          body: JSON.stringify({ name }),
        }
      );
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  updateAgentModel: async (agentId: string, modelRef: string | null) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>(
        `/api/agents/${encodeURIComponent(agentId)}/model`,
        {
          method: 'PUT',
          body: JSON.stringify({ modelRef }),
        }
      );
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  deleteAgent: async (agentId: string) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>(
        `/api/agents/${encodeURIComponent(agentId)}`,
        { method: 'DELETE' }
      );
      
      // 清理 agentSkills 和 agentTemplates
      set((state) => {
        const newAgentSkills = { ...state.agentSkills };
        const newAgentTemplates = { ...state.agentTemplates };
        delete newAgentSkills[agentId];
        delete newAgentTemplates[agentId];
        
        // 同步到 localStorage
        saveAgentTemplates(newAgentTemplates);
        
        return {
          ...applySnapshot(snapshot),
          agentSkills: newAgentSkills,
          agentTemplates: newAgentTemplates,
        };
      });
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  assignChannel: async (agentId: string, channelType: ChannelType) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>(
        `/api/agents/${encodeURIComponent(agentId)}/channels/${encodeURIComponent(channelType)}`,
        { method: 'PUT' }
      );
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  removeChannel: async (agentId: string, channelType: ChannelType) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>(
        `/api/agents/${encodeURIComponent(agentId)}/channels/${encodeURIComponent(channelType)}`,
        { method: 'DELETE' }
      );
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  updateAgentSkills: async (agentId: string, skillIds: string[]) => {
    set({ error: null });
    try {
      console.log('[agents] updateAgentSkills called:', { agentId, skillIds });
      
      // 1. 保存到本地配置文件
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>(
        `/api/agents/${encodeURIComponent(agentId)}/skills`,
        {
          method: 'PUT',
          body: JSON.stringify({ skills: skillIds }),
        }
      );
      
      console.log('[agents] Skills saved to config file');
      
      // 2. 同步到数据库（如果有对应的 Box-IM 数字员工）
      try {
        const { useModelsStore } = await import('./models');
        const digitalEmployees = useModelsStore.getState().digitalEmployees;
        
        // 如果 digitalEmployees 为空，先获取一次
        if (digitalEmployees.length === 0) {
          console.log('[agents] digitalEmployees is empty, fetching...');
          await useModelsStore.getState().fetchDigitalEmployees();
        }
        
        const employee = useModelsStore.getState().digitalEmployees.find(e => e.openclawAgentId === agentId);
        
        if (employee) {
          console.log('[agents] Found matching Box-IM employee:', employee.id, employee.nickName);
          console.log('[agents] Saving skills to database...');
          await useModelsStore.getState().updateEmployeeSkills(employee.id, skillIds);
          console.log('[agents] Skills saved to database');
        } else {
          console.log('[agents] No matching Box-IM employee found for agentId:', agentId);
        }
      } catch (dbError) {
        // 数据库同步失败不影响配置文件保存
        console.warn('[agents] Failed to sync skills to database:', dbError);
      }
      
      // 3. 更新本地状态
      set((state) => ({
        ...applySnapshot(snapshot),
        agentSkills: {
          ...state.agentSkills,
          [agentId]: skillIds,
        },
      }));
      
      console.log('[agents] Local state updated');
    } catch (error) {
      console.error('[agents] updateAgentSkills error:', error);
      set({ error: String(error) });
      throw error;
    }
  },

  updateAgentTemplate: async (agentId: string, templateId: number | null) => {
    console.log('[agents] updateAgentTemplate called:', { agentId, templateId });
    
    // 更新本地状态
    set((state) => {
      const newTemplates = {
        ...state.agentTemplates,
        [agentId]: templateId,
      };
      saveAgentTemplates(newTemplates);
      return { agentTemplates: newTemplates };
    });
    
    // 尝试同步到数据库（如果有对应的 Box-IM 数字员工）
    try {
      const { useModelsStore } = await import('./models');
      const digitalEmployees = useModelsStore.getState().digitalEmployees;
      
      if (digitalEmployees.length === 0) {
        await useModelsStore.getState().fetchDigitalEmployees();
      }
      
      const employee = useModelsStore.getState().digitalEmployees.find(e => e.openclawAgentId === agentId);
      
      if (employee) {
        console.log('[agents] Syncing template to database...');
        await useModelsStore.getState().updateEmployeeTemplate(employee.id, templateId);
        console.log('[agents] Template synced to database');
      }
    } catch (dbError) {
      console.warn('[agents] Failed to sync template to database:', dbError);
    }
  },

  clearError: () => set({ error: null }),
}));
