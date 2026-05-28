import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { gatewayRpcMock, hostApiFetchMock, agentsState } = vi.hoisted(() => ({
  gatewayRpcMock: vi.fn(),
  hostApiFetchMock: vi.fn(),
  agentsState: {
    agents: [] as Array<Record<string, unknown>>,
  },
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({
      status: { state: 'running' },
      rpc: gatewayRpcMock,
    }),
  },
}));

vi.mock('@/stores/agents', () => ({
  useAgentsStore: {
    getState: () => agentsState,
  },
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

describe('native-cli runtime store invariants', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-28T01:00:00Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
    window.localStorage.clear();

    agentsState.agents = [
      {
        id: 'cli-agent',
        name: 'CLI Agent',
        isDefault: false,
        modelDisplay: 'Claude',
        inheritedModel: false,
        workspace: '~/.openclaw/workspace-cli',
        agentDir: '~/.openclaw/agents/cli-agent/agent',
        mainSessionKey: 'agent:cli-agent:main',
        channelTypes: [],
        runtime: {
          type: 'native-cli',
          nativeCli: {
            provider: 'claude',
            command: 'claude',
          },
        },
      },
    ];

    gatewayRpcMock.mockReset();
    gatewayRpcMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.list') return { sessions: [] };
      if (method === 'chat.history') return { messages: [] };
      throw new Error(`Unexpected gateway RPC: ${method}`);
    });

    hostApiFetchMock.mockReset();
    hostApiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/sessions/repair-indexes') return { success: true };
      if (url === '/api/runtime/sessions/native-cli') return { success: true };
      if (url.startsWith('/api/sessions/transcript')) return { success: true, messages: [] };
      return { success: true, sessions: [] };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('loadSessions corrects a native-cli agent main session to an existing cli session', async () => {
    hostApiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/sessions/indexes') {
        return {
          success: true,
          sessions: [
            { key: 'agent:cli-agent:main', displayName: 'Main' },
            { key: 'agent:cli-agent:cli:previous', displayName: 'CLI' },
          ],
        };
      }
      if (url === '/api/sessions/repair-indexes') return { success: true };
      if (url.startsWith('/api/sessions/transcript')) return { success: true, messages: [] };
      return { success: true, sessions: [] };
    });

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      currentSessionKey: 'agent:cli-agent:main',
      currentAgentId: 'cli-agent',
      sessions: [{ key: 'agent:cli-agent:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      channelBindings: {},
      loading: false,
      error: null,
    });

    await useChatStore.getState().loadSessions();

    expect(useChatStore.getState().currentSessionKey).toBe('agent:cli-agent:cli:previous');
    expect(useChatStore.getState().currentAgentId).toBe('cli-agent');
  });

  it('loadSessions creates a native-cli session when only a main session exists', async () => {
    hostApiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/sessions/indexes') {
        return {
          success: true,
          sessions: [{ key: 'agent:cli-agent:main', displayName: 'Main' }],
        };
      }
      if (url === '/api/sessions/repair-indexes') return { success: true };
      if (url === '/api/runtime/sessions/native-cli') return { success: true };
      if (url.startsWith('/api/sessions/transcript')) return { success: true, messages: [] };
      return { success: true, sessions: [] };
    });

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      currentSessionKey: 'agent:cli-agent:main',
      currentAgentId: 'cli-agent',
      sessions: [{ key: 'agent:cli-agent:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      channelBindings: {},
      loading: false,
      error: null,
    });

    await useChatStore.getState().loadSessions();

    const currentSessionKey = useChatStore.getState().currentSessionKey;
    expect(currentSessionKey).toMatch(/^agent:cli-agent:cli:/);
    expect(useChatStore.getState().sessions.some((session) => session.key === currentSessionKey)).toBe(true);
    expect(hostApiFetchMock).toHaveBeenCalledWith(
      '/api/runtime/sessions/native-cli',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining(currentSessionKey),
      }),
    );
  });
});
