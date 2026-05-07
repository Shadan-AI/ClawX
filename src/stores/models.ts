import { create } from 'zustand';
import { invokeIpc } from '@/lib/api-client';
import { getAgentIdFromSessionKey, resolveSessionAgentIdByKey } from '@/lib/session-agent';
import { useAgentsStore } from './agents';

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
  skills?: string | string[]; // 可以是 JSON 字符串或数组
  templateId?: number | null; // 模板ID
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
  createDigitalEmployee: (nickName: string, headImage?: string, model?: string) => Promise<DigitalEmployee>;
  updateEmployeeSkills: (employeeId: number, skills: string[]) => Promise<void>;
  updateEmployeeTemplate: (employeeId: number, templateId: number | null) => Promise<void>;
  getAgentDefaultModel: (agentId: string) => string | null;
  getSessionModel: (sessionKey: string) => string | null;
  setSessionModel: (sessionKey: string, modelId: string) => void;
  getTokenKey: () => Promise<string | null>;
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

function normalizeModelRef(modelRef: string | null | undefined): string | null {
  const trimmed = (modelRef || '').trim();
  return trimmed || null;
}

function modelIdFromRef(modelRef: string): string {
  const separatorIndex = modelRef.indexOf('/');
  return separatorIndex >= 0 ? modelRef.slice(separatorIndex + 1) : modelRef;
}

function toSessionModelRef(modelValue: string): string {
  return modelValue.includes('/') ? modelValue : `shadan/${modelValue}`;
}

function toCurrentModelId(modelRef: string, models: OneApiModel[]): string {
  const modelId = modelIdFromRef(modelRef);
  return models.some((model) => model.id === modelId) ? modelId : modelRef;
}

async function resolveAgentModelRef(agentId: string): Promise<string | null> {
  let agentsState = useAgentsStore.getState();
  if (agentsState.agents.length === 0 && !agentsState.loading) {
    try {
      await agentsState.fetchAgents();
    } catch (err) {
      console.warn('[models] Failed to fetch agents while resolving model:', err);
    }
    agentsState = useAgentsStore.getState();
  }

  const agent = agentsState.agents.find((entry) => entry.id === agentId);
  return normalizeModelRef(agent?.modelRef) || normalizeModelRef(agentsState.defaultModelRef);
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
      // 不再设置默认模型,让每个智能体使用自己配置的模型
      set({ models, loading: false, currentModelId: currentModelId || null, isLoggedIn: true, error: null });
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
        
        // Update gateway session (只更新当前 session,不更新 main session)
        await invokeIpc('gateway:rpc', 'sessions.patch', {
          key: sessionKey,
          model: `shadan/${modelId}`,
        });
        
        console.log(`[setCurrentModel] Updated model to ${modelId} for session ${sessionKey}`);
      }
    } catch (err) {
      console.error('Failed to update session model:', err);
    }
  },

  ensureSessionModel: async (sessionKey: string) => {
    let { models, digitalEmployees, sessionModels } = get();
    if (models.length === 0) return;

    let agentId = getAgentIdFromSessionKey(sessionKey);
    try {
      const { useChatStore } = await import('./chat');
      const chatState = useChatStore.getState();
      agentId = resolveSessionAgentIdByKey(sessionKey, chatState.sessions, chatState.channelBindings);
    } catch (err) {
      console.warn('[ensureSessionModel] Failed to resolve binding-aware agent:', err);
    }
    const sessionOverride = sessionModels[sessionKey];
    let modelRef = sessionOverride ? toSessionModelRef(sessionOverride) : null;

    if (!modelRef) {
      modelRef = await resolveAgentModelRef(agentId);
      if (modelRef) {
        console.log(`[ensureSessionModel] Using agent default model: ${modelRef} for agent ${agentId}`);
      }
    }

    if (!modelRef) {
      if (digitalEmployees.length === 0) {
        console.log('[ensureSessionModel] digitalEmployees is empty, fetching...');
        await get().fetchDigitalEmployees();
        digitalEmployees = get().digitalEmployees;
      }

      const employee = digitalEmployees.find((entry) => entry.openclawAgentId === agentId);
      if (employee?.model) {
        modelRef = toSessionModelRef(employee.model);
        console.log(`[ensureSessionModel] Falling back to synced employee model: ${modelRef} for agent ${agentId}`);
      }
    }

    if (!modelRef) {
      modelRef = `shadan/${models[0].id}`;
      console.log(`[ensureSessionModel] No agent model configured, using first available model: ${modelRef}`);
    }

    set({ currentModelId: toCurrentModelId(modelRef, models) });
    try {
      await invokeIpc('gateway:rpc', 'sessions.patch', {
        key: sessionKey,
        model: modelRef,
      });
      console.log(`[ensureSessionModel] Set session model to ${modelRef} for ${sessionKey}`);
    } catch (err) {
      console.error('Failed to ensure session model:', err);
    }
    return;
    /*

    // 如果 digitalEmployees 为空,先加载
    if (digitalEmployees.length === 0) {
      console.log('[ensureSessionModel] digitalEmployees is empty, fetching...');
      await get().fetchDigitalEmployees();
      // 重新获取最新的 digitalEmployees
      digitalEmployees = get().digitalEmployees;
    }

    const agentId = getAgentIdFromSessionKey(sessionKey);
    let modelId = sessionModels[sessionKey];

    // 如果会话没有配置模型
    if (!modelId) {
      // 尝试使用 agent 的默认模型
      const employee = digitalEmployees.find(e => e.openclawAgentId === agentId);
      if (employee?.model) {
        modelId = employee.model;
        console.log(`[ensureSessionModel] Using agent default model: ${modelId} for agent ${agentId}`);
      } else {
        // 如果 agent 没有配置模型,使用第一个可用模型作为默认值
        if (models.length > 0) {
          modelId = models[0].id;
          console.log(`[ensureSessionModel] No agent model configured, using first available model: ${modelId}`);
        } else {
          console.log(`[ensureSessionModel] No models available`);
          return;
        }
      }
    }

    if (modelId && models.some(m => m.id === modelId)) {
      set({ currentModelId: modelId });
      try {
        await invokeIpc('gateway:rpc', 'sessions.patch', {
          key: sessionKey,
          model: `shadan/${modelId}`,
        });
        console.log(`[ensureSessionModel] Set session model to ${modelId} for ${sessionKey}`);
      } catch (err) {
        console.error('Failed to ensure session model:', err);
      }
    }
    */
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
      console.log('[models] Fetching digital employees...');
      
      // 直接调用 im-platform API，绕过 Gateway
      const tokenKey = await getTokenKey();
      if (!tokenKey) {
        console.log('[models] No tokenKey, skipping fetch');
        set({ digitalEmployees: [] });
        return;
      }
      
      const apiUrl = 'https://im.shadanai.com/api';
      const response = await fetch(`${apiUrl}/bot/list`, {
        method: 'GET',
        headers: {
          'Token-Key': tokenKey,
          'Content-Type': 'application/json',
        },
      });
      
      if (!response.ok) {
        throw new Error(`API request failed: ${response.status}`);
      }
      
      const result = await response.json();
      console.log('[models] Digital employees response:', result);
      
      if (result.code !== 200) {
        throw new Error(`API error: ${result.message}`);
      }
      
      const employees = (result.data || []).map((emp: any) => {
        // 解析 skills 字段（可能是 JSON 字符串或数组）
        let skillsArray: string[] = [];
        if (emp.skills) {
          if (typeof emp.skills === 'string') {
            try {
              skillsArray = JSON.parse(emp.skills);
            } catch {
              skillsArray = [];
            }
          } else if (Array.isArray(emp.skills)) {
            skillsArray = emp.skills;
          }
        }
        
        return {
          id: emp.id,
          userName: emp.userName || '',
          nickName: emp.nickName || '',
          headImage: emp.headImage || '',
          openclawAgentId: emp.openclawAgentId || emp.agentId || emp.userName || '',
          model: emp.model || '',
          nodeId: emp.nodeId || '',
          skills: skillsArray,
          templateId: emp.templateId, // 添加 templateId
        };
      }) as DigitalEmployee[];
      
      console.log('[models] Parsed employees:', employees);
      console.log('[models] Employee count:', employees.length);
      set({ digitalEmployees: employees });
      
      // 同步技能和模板到 agents store
      const { useAgentsStore } = await import('./agents');
      const agentSkills: Record<string, string[]> = {};
      const agentTemplates: Record<string, number | null> = {};
      
      employees.forEach(emp => {
        console.log('[models] Processing employee:', { 
          id: emp.id, 
          openclawAgentId: emp.openclawAgentId, 
          skills: emp.skills,
          templateId: (emp as any).templateId 
        });
        
        if (emp.openclawAgentId) {
          // 同步技能
          if (emp.skills && Array.isArray(emp.skills)) {
            agentSkills[emp.openclawAgentId] = emp.skills;
          }
          
          // 同步模板ID
          const templateId = (emp as any).templateId;
          if (templateId !== undefined) {
            agentTemplates[emp.openclawAgentId] = templateId;
          }
        }
      });
      
      console.log('[models] Agent skills to sync:', agentSkills);
      console.log('[models] Agent templates to sync:', agentTemplates);
      
      // 批量更新 agents store 的技能和模板
      useAgentsStore.setState((state) => ({
        agentSkills: {
          ...state.agentSkills,
          ...agentSkills,
        },
        agentTemplates: {
          ...state.agentTemplates,
          ...agentTemplates,
        },
      }));
      
      // 同步到 localStorage
      const currentTemplates = useAgentsStore.getState().agentTemplates;
      localStorage.setItem('clawx-agent-templates', JSON.stringify(currentTemplates));
    } catch (error) {
      console.error('[models] Failed to fetch digital employees:', error);
      set({ digitalEmployees: [] });
    }
  },

  createDigitalEmployee: async (nickName: string, headImage?: string, model?: string) => {
    try {
      console.log('[models] Creating digital employee:', { nickName, headImage, model });
      
      // 1. 生成稳定的 agentId
      const agentId = 'bot-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      
      // 2. 获取 tokenKey
      const tokenKey = await getTokenKey();
      if (!tokenKey) {
        throw new Error('未绑定用户');
      }
      
      // 3. 调用 im-platform API 创建 Bot 账号（使用 /bot/register 接口）
      const apiUrl = 'https://im.shadanai.com/api';
      const response = await fetch(`${apiUrl}/bot/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Token-Key': tokenKey,
        },
        body: JSON.stringify({
          agentId,
          nickName,
          headImage: headImage || '',
          model: model || '',
        }),
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`创建 IM 账号失败: ${response.status} ${errorText}`);
      }
      
      const result = await response.json();
      console.log('[models] Create bot response:', result);
      
      if (result.code !== 200) {
        throw new Error(result.message || '创建失败');
      }
      
      const newEmployee: DigitalEmployee = {
        id: result.data?.id || 0,
        userName: result.data?.userName || agentId,
        nickName,
        headImage: headImage || '',
        openclawAgentId: agentId,
        model: model || '',
        nodeId: result.data?.nodeId || '',
        skills: [],
      };
      
      // 4. 尝试在 Gateway 中创建 agent（best-effort）
      try {
        const { useGatewayStore } = await import('./gateway');
        const gatewayState = useGatewayStore.getState();
        
        if (gatewayState.status.state === 'running') {
          await gatewayState.rpc('agents.create', {
            name: agentId,
            workspace: `~/.openclaw/workspace-${agentId}`,
          });
          console.log('[models] Gateway agent created successfully');
        } else {
          console.warn('[models] Gateway not running, skipping agent creation');
        }
      } catch (gwErr) {
        console.warn('[models] Gateway agent creation failed:', gwErr);
        // 不抛出错误，因为 IM 账号已经创建成功
      }
      
      // 5. 更新本地状态
      set((state) => ({
        digitalEmployees: [...state.digitalEmployees, newEmployee],
      }));
      
      console.log('[models] Digital employee created:', newEmployee);
      return newEmployee;
    } catch (error) {
      console.error('[models] Failed to create digital employee:', error);
      throw error;
    }
  },

  updateEmployeeSkills: async (employeeId: number, skills: string[]) => {
    try {
      console.log('[models] updateEmployeeSkills called:', { employeeId, skills });
      
      // 直接调用 im-platform API，而不是通过 Gateway
      const { invokeIpc } = await import('@/lib/api-client');
      const tokenKey = await invokeIpc<string | null>('box-im:getTokenKey');
      
      if (!tokenKey) {
        throw new Error('未绑定用户');
      }
      
      const apiUrl = 'https://im.shadanai.com/api';
      const response = await fetch(`${apiUrl}/bot/skills/${employeeId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Token-Key': tokenKey,
        },
        body: JSON.stringify({ skills }),
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API 请求失败: ${response.status} ${errorText}`);
      }
      
      const result = await response.json();
      console.log('[models] API response:', result);
      
      // Update local state
      set((state) => ({
        digitalEmployees: state.digitalEmployees.map(emp =>
          emp.id === employeeId ? { ...emp, skills } : emp
        ),
      }));
      
      console.log('[models] Local state updated');
    } catch (err) {
      console.error('[models] Failed to update employee skills:', err);
      throw err;
    }
  },

  updateEmployeeTemplate: async (employeeId: number, templateId: number | null) => {
    try {
      console.log('[models] updateEmployeeTemplate called:', { employeeId, templateId });
      
      const { invokeIpc } = await import('@/lib/api-client');
      const tokenKey = await invokeIpc<string | null>('box-im:getTokenKey');
      
      if (!tokenKey) {
        throw new Error('未绑定用户');
      }
      
      const apiUrl = 'https://im.shadanai.com/api';
      const response = await fetch(`${apiUrl}/bot/template/${employeeId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Token-Key': tokenKey,
        },
        body: JSON.stringify({ templateId }),
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API 请求失败: ${response.status} ${errorText}`);
      }
      
      const result = await response.json();
      console.log('[models] Template update response:', result);
      
      if (result.code !== 200) {
        throw new Error(result.message || '更新模板失败');
      }
    } catch (err) {
      console.error('[models] Failed to update employee template:', err);
      throw err;
    }
  },

  getAgentDefaultModel: (agentId: string): string | null => {
    const agentsState = useAgentsStore.getState();
    const agent = agentsState.agents.find((entry) => entry.id === agentId);
    const modelRef = normalizeModelRef(agent?.modelRef) || normalizeModelRef(agentsState.defaultModelRef);
    if (modelRef) {
      return modelIdFromRef(modelRef);
    }

    const employee = get().digitalEmployees.find((entry) => entry.openclawAgentId === agentId);
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

  getTokenKey: async () => {
    return await getTokenKey();
  },
}));
