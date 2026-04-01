import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import type { ChannelType } from '@/types/channel';
import type { AgentSummary, AgentsSnapshot, DigitalEmployee } from '@/types/agent';

interface AgentsState {
  agents: AgentSummary[];
  digitalEmployees: DigitalEmployee[];
  defaultAgentId: string;
  defaultModelRef: string | null;
  configuredChannelTypes: string[];
  channelOwners: Record<string, string>;
  channelAccountOwners: Record<string, string>;
  loading: boolean;
  error: string | null;
  fetchAgents: () => Promise<void>;
  createAgent: (name: string, options?: { inheritWorkspace?: boolean }) => Promise<void>;
  updateAgent: (agentId: string, name: string) => Promise<void>;
  updateAgentModel: (agentId: string, modelRef: string | null) => Promise<void>;
  deleteAgent: (agentId: string) => Promise<void>;
  assignChannel: (agentId: string, channelType: ChannelType) => Promise<void>;
  removeChannel: (agentId: string, channelType: ChannelType) => Promise<void>;
  clearError: () => void;
}

function applySnapshot(snapshot: AgentsSnapshot | undefined, digitalEmployees: DigitalEmployee[] = []) {
  if (!snapshot) return {};
  
  const agentMap = new Map<string, DigitalEmployee>();
  for (const e of digitalEmployees) {
    if (e.openclawAgentId) {
      agentMap.set(e.openclawAgentId, e);
    }
    if (e.nickName) {
      agentMap.set(e.nickName, e);
    }
    if (e.userName) {
      agentMap.set(e.userName, e);
    }
  }
  
  console.log('[agents] applySnapshot:', {
    agents: snapshot.agents?.map(a => ({ id: a.id, name: a.name })),
    digitalEmployees: digitalEmployees.map(e => ({ id: e.id, openclawAgentId: e.openclawAgentId, nickName: e.nickName })),
    agentMapKeys: [...agentMap.keys()],
  });
  
  return {
    agents: (snapshot.agents ?? []).map(agent => {
      let digitalEmployee = agentMap.get(agent.id);
      if (!digitalEmployee) {
        digitalEmployee = agentMap.get(agent.name);
      }
      return {
        ...agent,
        digitalEmployee,
      };
    }),
    digitalEmployees,
    defaultAgentId: snapshot.defaultAgentId ?? 'main',
    defaultModelRef: snapshot.defaultModelRef ?? null,
    configuredChannelTypes: snapshot.configuredChannelTypes ?? [],
    channelOwners: snapshot.channelOwners ?? {},
    channelAccountOwners: snapshot.channelAccountOwners ?? {},
  };
}

export const useAgentsStore = create<AgentsState>((set, get) => ({
  agents: [],
  digitalEmployees: [],
  defaultAgentId: 'main',
  defaultModelRef: null,
  configuredChannelTypes: [],
  channelOwners: {},
  channelAccountOwners: {},
  loading: false,
  error: null,

  fetchAgents: async () => {
    set({ loading: true, error: null });
    try {
      console.log('[agents] fetchAgents: starting...');
      // /plugins/box-im/bots 内部已经通过 saveBoxImAccountsAndSyncAgents 完成了 agent 创建和绑定
      // 只需要拉取一次，无需前端再次创建 agent，避免重复触发 Gateway 重载
      let botsRes: { bots?: DigitalEmployee[]; success?: boolean } = { bots: [] };
      try {
        botsRes = await hostApiFetch<{ bots?: DigitalEmployee[]; success?: boolean }>('/plugins/box-im/bots');
      } catch (err) {
        console.warn('[agents] Failed to fetch bots:', err);
      }
      
      // 等待一小段时间确保 saveBoxImAccountsAndSyncAgents 完成写入
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>('/api/agents');
      
      console.log('[agents] API responses:', {
        agentsCount: snapshot.agents?.length,
        botsCount: botsRes.bots?.length,
      });
      
      const digitalEmployees = botsRes.bots || [];
      
      set({
        ...applySnapshot(snapshot, digitalEmployees),
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
      
      const newAgent = (snapshot.agents ?? []).find(a => a.name === name && !get().agents.some((ga: AgentSummary) => ga.id === a.id));
      if (newAgent) {
        try {
          await hostApiFetch('/plugins/box-im/bots', {
            method: 'POST',
            body: JSON.stringify({
              agentId: newAgent.id,
              nickName: name,
            }),
          });
          
          try {
            await hostApiFetch(`/api/agents/${encodeURIComponent(newAgent.id)}/channels/box-im`, {
              method: 'PUT',
            });
          } catch (bindErr) {
            console.warn('[agents] Failed to bind box-im channel:', bindErr);
          }
        } catch (botErr) {
          console.warn('[agents] Failed to create digital employee:', botErr);
        }
      }
      
      await get().fetchAgents();
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
      set(applySnapshot(snapshot, get().digitalEmployees));
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
      set(applySnapshot(snapshot, get().digitalEmployees));
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
      set(applySnapshot(snapshot, get().digitalEmployees));
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
      set(applySnapshot(snapshot, get().digitalEmployees));
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
      set(applySnapshot(snapshot, get().digitalEmployees));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  clearError: () => set({ error: null }),
}));
