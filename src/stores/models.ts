import { create } from 'zustand';
import { invokeIpc } from '@/lib/api-client';
import { hostApiFetch } from '@/lib/host-api';

export interface OneApiModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
}

export interface DigitalEmployee {
  id: number;
  userName: string;
  nickName: string;
  headImage: string;
  openclawAgentId: string;
  model: string;
  nodeId: string;
}

export interface ModelState {
  models: OneApiModel[];
  currentModelId: string | null;
  loading: boolean;
  error: string | null;
  isLoggedIn: boolean | null;
  digitalEmployees: DigitalEmployee[];
  sessionModels: Record<string, string>;

  fetchModels: () => Promise<void>;
  setCurrentModel: (modelId: string) => Promise<void>;
  ensureSessionModel: (sessionKey: string) => Promise<void>;
  clearError: () => void;
  checkLoginStatus: () => Promise<boolean>;
  logout: () => Promise<void>;
  fetchDigitalEmployees: () => Promise<void>;
  getAgentDefaultModel: (agentId: string) => string | null;
  getSessionModel: (sessionKey: string) => string | null;
  setSessionModel: (sessionKey: string, modelId: string) => void;
}

const SESSION_MODELS_KEY = 'clawx-session-models';

function loadSessionModels(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SESSION_MODELS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveSessionModels(models: Record<string, string>) {
  try {
    localStorage.setItem(SESSION_MODELS_KEY, JSON.stringify(models));
  } catch { /* ignore */ }
}

const ONEAPI_BASE_URL = 'https://one-api.shadanai.com';

const MODEL_META: Record<string, { name?: string }> = {
  'glm-5': { name: 'GLM-5' },
  'glm-5-turbo': { name: 'GLM-5 Turbo' },
  'glm-4': { name: 'GLM-4' },
  'qwen-max': { name: 'Qwen Max' },
  'claude-sonnet-4-5-20250929': { name: 'Claude Sonnet 4.5' },
};

export async function getTokenKey(): Promise<string | null> {
  try {
    return await invokeIpc<string | null>('box-im:getTokenKey');
  } catch (err) {
    console.warn('[models] Failed to get tokenKey:', err);
    return null;
  }
}

async function fetchModelsFromOneApi(tokenKey: string): Promise<OneApiModel[]> {
  const response = await fetch(`${ONEAPI_BASE_URL}/v1/models`, {
    headers: { Authorization: `Bearer ${tokenKey}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`OneAPI 请求失败: ${response.status}`);
  const data = await response.json();
  return (data.data || []).map((m: { id: string }) => ({
    id: m.id,
    name: MODEL_META[m.id]?.name || m.id,
  }));
}

function getAgentIdFromSessionKey(sessionKey: string): string {
  if (!sessionKey.startsWith('agent:')) return 'main';
  const [, agentId] = sessionKey.split(':');
  return agentId || 'main';
}

export const useModelsStore = create<ModelState>((set, get) => ({
  models: [],
  currentModelId: null,
  loading: false,
  error: null,
  isLoggedIn: null,
  digitalEmployees: [],
  sessionModels: loadSessionModels(),

  checkLoginStatus: async () => {
    const tokenKey = await getTokenKey();
    const loggedIn = tokenKey !== null;
    const prevLoggedIn = get().isLoggedIn;

    if (prevLoggedIn === true && loggedIn === false) {
      set({ models: [], currentModelId: null, isLoggedIn: false, error: '请先登录', digitalEmployees: [], sessionModels: {} });
    } else if (loggedIn === true) {
      set({ isLoggedIn: true, error: null });
      get().fetchModels();
      get().fetchDigitalEmployees();
    } else {
      set({ isLoggedIn: loggedIn });
    }
    return loggedIn;
  },

  fetchModels: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });

    const tokenKey = await getTokenKey();
    if (!tokenKey) {
      set({ models: [], loading: false, error: '请先登录', isLoggedIn: false });
      return;
    }

    try {
      const models = await fetchModelsFromOneApi(tokenKey);
      const currentModelId = get().currentModelId;
      const defaultModelId = models.find(m => m.id === 'glm-5')?.id || models[0]?.id || null;
      set({ models, loading: false, currentModelId: currentModelId || defaultModelId, isLoggedIn: true, error: null });
    } catch (err) {
      set({ models: [], loading: false, error: err instanceof Error ? err.message : '获取模型列表失败' });
    }
  },

  setCurrentModel: async (modelId: string) => {
    const { models } = get();
    if (!models.find(m => m.id === modelId)) {
      set({ error: `模型 ${modelId} 不存在` });
      return;
    }
    set({ currentModelId: modelId });

    try {
      const { useChatStore } = await import('./chat');
      const sessionKey = useChatStore.getState().currentSessionKey;
      if (sessionKey) {
        // Save to localStorage immediately
        get().setSessionModel(sessionKey, modelId);
        
        // Update gateway session
        await invokeIpc('gateway:rpc', 'sessions.patch', {
          key: sessionKey,
          model: `shadan/${modelId}`,
        });
      }
    } catch (err) {
      console.error('Failed to update session model:', err);
    }
  },

  ensureSessionModel: async (sessionKey: string) => {
    const { models, digitalEmployees, sessionModels } = get();
    if (models.length === 0) return;

    const agentId = getAgentIdFromSessionKey(sessionKey);
    let modelId = sessionModels[sessionKey];

    if (!modelId) {
      const employee = digitalEmployees.find(e => e.openclawAgentId === agentId);
      if (employee?.model) modelId = employee.model;
    }
    if (!modelId) {
      modelId = models.find(m => m.id === 'glm-5')?.id || models[0]?.id;
    }

    if (modelId && models.some(m => m.id === modelId)) {
      set({ currentModelId: modelId });
      try {
        await invokeIpc('gateway:rpc', 'sessions.patch', {
          key: sessionKey,
          model: `shadan/${modelId}`,
        });
      } catch (err) {
        console.error('Failed to ensure session model:', err);
      }
    }
  },

  clearError: () => set({ error: null }),

  logout: async () => {
    try {
      await invokeIpc<{ success: boolean; error?: string }>('box-im:logout');
      set({ models: [], currentModelId: null, isLoggedIn: false, error: null, digitalEmployees: [], sessionModels: {} });
      localStorage.removeItem('clawx-settings');
      localStorage.removeItem(SESSION_MODELS_KEY);

      const { useSettingsStore } = await import('./settings');
      useSettingsStore.getState().resetBoxImGateComplete();

      const { useGatewayStore } = await import('./gateway');
      try { await useGatewayStore.getState().restart(); } catch { /* best-effort */ }

      window.location.reload();
    } catch (err) {
      console.error('[models] Logout failed:', err);
    }
  },

  fetchDigitalEmployees: async () => {
    try {
      const data = await hostApiFetch<{ bots?: DigitalEmployee[] }>('/plugins/box-im/bots');
      set({ digitalEmployees: (data.bots || []) as DigitalEmployee[] });
    } catch {
      set({ digitalEmployees: [] });
    }
  },

  getAgentDefaultModel: (agentId: string): string | null => {
    const employee = get().digitalEmployees.find(e => e.openclawAgentId === agentId);
    return employee?.model || null;
  },

  getSessionModel: (sessionKey: string): string | null => {
    return get().sessionModels[sessionKey] || null;
  },

  setSessionModel: (sessionKey: string, modelId: string) => {
    set((state) => {
      const next = { ...state.sessionModels, [sessionKey]: modelId };
      saveSessionModels(next);
      return { sessionModels: next };
    });
  },
}));
