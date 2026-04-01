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
  syncing: boolean;
  error: string | null;
  fetchAgents: () => Promise<void>;
  syncFromRemote: () => Promise<void>;
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
    if (e.openclawAgentId) agentMap.set(e.openclawAgentId, e);
    agentMap.set(e.nickName, e);
    agentMap.set(e.userName, e);
  }

  return {
    agents: (snapshot.agents ?? []).map(agent => ({
      ...agent,
      digitalEmployee: agentMap.get(agent.id) ?? agentMap.get(agent.name),
    })),
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
  syncing: false,
  error: null,

  /**
   * Load agents from local config only (fast, no remote API call).
   * Digital employees come from whatever is already persisted locally.
   */
  fetchAgents: async () => {
    set({ loading: true, error: null });
    try {
      const [snapshot, botsRes] = await Promise.all([
        hostApiFetch<AgentsSnapshot & { success?: boolean }>('/api/agents'),
        hostApiFetch<{ bots?: DigitalEmployee[] }>('/plugins/box-im/bots').catch(() => ({ bots: [] })),
      ]);
      set({ ...applySnapshot(snapshot, botsRes.bots || []), loading: false });
    } catch (error) {
      set({ loading: false, error: String(error) });
    }
  },

  /**
   * Sync from remote ai-im API: pull bots, create missing agents, bind channels.
   * Only triggered by explicit user action (sync button).
   */
  syncFromRemote: async () => {
    set({ syncing: true, error: null });
    try {
      // 1. Trigger remote sync (box-im-sync.ts pulls from API and writes config)
      const botsRes = await hostApiFetch<{ bots?: DigitalEmployee[] }>('/plugins/box-im/bots');
      const bots = botsRes.bots || [];

      // 2. Reload agents after config was updated by sync
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>('/api/agents');
      const existingIds = new Set((snapshot.agents ?? []).map(a => a.id));

      // 3. Create agents for bots that don't have one yet
      const missing = bots.filter(b => b.openclawAgentId && !existingIds.has(b.openclawAgentId));
      for (const bot of missing) {
        try {
          await hostApiFetch('/api/agents', {
            method: 'POST',
            body: JSON.stringify({ name: bot.nickName || bot.openclawAgentId }),
          });
        } catch (err) {
          console.warn('[agents] Failed to create agent for bot:', bot.openclawAgentId, err);
        }
      }

      // 4. Bind box-im channel for new agents
      if (missing.length > 0) {
        const updated = await hostApiFetch<AgentsSnapshot & { success?: boolean }>('/api/agents');
        for (const bot of missing) {
          const agent = (updated.agents ?? []).find(a => a.id === bot.openclawAgentId || a.name === bot.nickName);
          if (agent && !agent.channelTypes?.includes('box-im')) {
            try {
              await hostApiFetch(`/api/agents/${encodeURIComponent(agent.id)}/channels/box-im`, { method: 'PUT' });
            } catch (err) {
              console.warn('[agents] Failed to bind box-im for:', agent.id, err);
            }
          }
        }
      }

      // 5. Final reload
      await get().fetchAgents();
    } catch (error) {
      set({ error: String(error) });
    } finally {
      set({ syncing: false });
    }
  },

  createAgent: async (name: string, options?: { headImage?: string; model?: string }) => {
    set({ error: null });
    try {
      // Register bot on ai-im platform (with nodeId via ownerAuth)
      const result = await hostApiFetch<{ error?: string; data?: { userName?: string } }>('/plugins/box-im/bots', {
        method: 'POST',
        body: JSON.stringify({ nickName: name, headImage: options?.headImage || '', model: options?.model || '' }),
      });
      if (result.error) throw new Error(result.error);

      // Sync to pick up the new bot, create agent, bind channel
      await get().syncFromRemote();

      // Set model if specified
      if (options?.model) {
        const newAgent = get().agents.find(a => a.name === name);
        if (newAgent) {
          await get().updateAgentModel(newAgent.id, `shadan/${options.model}`);
        }
      }
    } catch (error) {
      console.error('[agents] createAgent failed:', error);
      set({ error: String(error) });
      throw error;
    }
  },

  updateAgent: async (agentId: string, name: string) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<AgentsSnapshot>(
        `/api/agents/${encodeURIComponent(agentId)}`,
        { method: 'PUT', body: JSON.stringify({ name }) },
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
      const snapshot = await hostApiFetch<AgentsSnapshot>(
        `/api/agents/${encodeURIComponent(agentId)}/model`,
        { method: 'PUT', body: JSON.stringify({ modelRef }) },
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
      const snapshot = await hostApiFetch<AgentsSnapshot>(
        `/api/agents/${encodeURIComponent(agentId)}`,
        { method: 'DELETE' },
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
      const snapshot = await hostApiFetch<AgentsSnapshot>(
        `/api/agents/${encodeURIComponent(agentId)}/channels/${encodeURIComponent(channelType)}`,
        { method: 'PUT' },
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
      const snapshot = await hostApiFetch<AgentsSnapshot>(
        `/api/agents/${encodeURIComponent(agentId)}/channels/${encodeURIComponent(channelType)}`,
        { method: 'DELETE' },
      );
      set(applySnapshot(snapshot, get().digitalEmployees));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  clearError: () => set({ error: null }),
}));
