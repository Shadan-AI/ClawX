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
    agentMap.set(e.nickName, e);
    agentMap.set(e.userName, e);
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
      const [snapshot, botsRes] = await Promise.all([
        hostApiFetch<AgentsSnapshot & { success?: boolean }>('/api/agents'),
        hostApiFetch<{ bots?: DigitalEmployee[]; success?: boolean }>('/plugins/box-im/bots').catch((err) => {
          console.warn('[agents] Failed to fetch bots:', err);
          return { bots: [] };
        }),
      ]);
      
      console.log('[agents] API responses:', {
        agentsCount: snapshot.agents?.length,
        botsResKeys: Object.keys(botsRes),
        botsCount: botsRes.bots?.length,
        botsRaw: botsRes,
      });
      
      let digitalEmployees = botsRes.bots || [];
      const existingAgents = snapshot.agents ?? [];
      const agentIds = new Set(existingAgents.map(a => a.id));
      const agentNames = new Set(existingAgents.map(a => a.name));
      
      console.log('[agents] fetchAgents initial:', {
        agents: existingAgents.map(a => ({ id: a.id, name: a.name })),
        bots: digitalEmployees.map(b => ({ id: b.id, openclawAgentId: b.openclawAgentId, nickName: b.nickName })),
      });
      
      const botsNeedingAgent: DigitalEmployee[] = [];
      
      for (const bot of digitalEmployees) {
        const hasMatchingId = bot.openclawAgentId && agentIds.has(bot.openclawAgentId);
        const hasMatchingName = agentNames.has(bot.nickName);
        
        if (!hasMatchingId && !hasMatchingName) {
          botsNeedingAgent.push(bot);
        }
      }
      
      for (const bot of botsNeedingAgent) {
        try {
          console.log('[agents] Creating agent for bot:', bot.openclawAgentId || bot.nickName);
          await hostApiFetch('/api/agents', {
            method: 'POST',
            body: JSON.stringify({ name: bot.nickName || bot.openclawAgentId || `bot-${bot.id}` }),
          });
        } catch (createErr) {
          console.warn('[agents] Failed to create agent for bot:', bot.openclawAgentId || bot.nickName, createErr);
        }
      }
      
      if (botsNeedingAgent.length > 0) {
        const newSnapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>('/api/agents');
        const newAgents = newSnapshot.agents ?? [];
        const newAgentIds = new Set(newAgents.map(a => a.id));
        
        for (const bot of digitalEmployees) {
          const agentId = bot.openclawAgentId || bot.nickName;
          if (agentId && newAgentIds.has(agentId)) {
            const agent = newAgents.find(a => a.id === agentId || a.name === bot.nickName);
            if (agent && !agent.channelTypes?.includes('box-im')) {
              try {
                console.log('[agents] Binding box-im channel for agent:', agent.id);
                await hostApiFetch(`/api/agents/${encodeURIComponent(agent.id)}/channels/box-im`, {
                  method: 'PUT',
                });
              } catch (bindErr) {
                console.warn('[agents] Failed to bind box-im channel for agent:', agent.id, bindErr);
              }
            }
          }
        }
        
        const finalSnapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>('/api/agents');
        const finalBotsRes = await hostApiFetch<{ bots?: DigitalEmployee[]; success?: boolean }>('/plugins/box-im/bots').catch(() => ({ bots: [] }));
        digitalEmployees = finalBotsRes.bots || [];
        set({
          ...applySnapshot(finalSnapshot, digitalEmployees),
          loading: false,
        });
      } else {
        set({
          ...applySnapshot(snapshot, digitalEmployees),
          loading: false,
        });
      }
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
