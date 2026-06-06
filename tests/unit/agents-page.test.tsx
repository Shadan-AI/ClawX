import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Agents } from '../../src/pages/Agents/index';

const hostApiFetchMock = vi.fn();
const subscribeHostEventMock = vi.fn();
const fetchAgentsMock = vi.fn();
const updateAgentMock = vi.fn();
const updateAgentModelMock = vi.fn();
const refreshProviderSnapshotMock = vi.fn();
const fetchDigitalEmployeesMock = vi.fn();
const fetchModelsMock = vi.fn();
const createDigitalEmployeeMock = vi.fn();
const updateEmployeeSkillsMock = vi.fn();
const updateEmployeeTemplateMock = vi.fn();
const getTokenKeyMock = vi.fn();
const newSessionForAgentMock = vi.fn();

const { gatewayState, agentsState, providersState, modelsState } = vi.hoisted(() => ({
  gatewayState: {
    status: { state: 'running', port: 18789 },
  },
  agentsState: {
    agents: [] as Array<Record<string, unknown>>,
    defaultModelRef: null as string | null,
    loading: false,
    error: null as string | null,
  },
  providersState: {
    accounts: [] as Array<Record<string, unknown>>,
    statuses: [] as Array<Record<string, unknown>>,
    vendors: [] as Array<Record<string, unknown>>,
    defaultAccountId: '' as string,
  },
  modelsState: {
    models: [] as Array<Record<string, unknown>>,
    digitalEmployees: [] as Array<Record<string, unknown>>,
    loading: false,
    error: null as string | null,
    isLoggedIn: true as boolean | null,
    currentModelId: null as string | null,
    sessionModels: {} as Record<string, string>,
  },
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: (selector: (state: typeof gatewayState) => unknown) => selector(gatewayState),
}));

vi.mock('@/stores/agents', () => ({
  useAgentsStore: Object.assign(
    (selector?: (state: typeof agentsState & {
      agentSkills: Record<string, unknown>;
      agentTemplates: Record<string, unknown>;
      fetchAgents: typeof fetchAgentsMock;
      updateAgent: typeof updateAgentMock;
      updateAgentModel: typeof updateAgentModelMock;
      createAgent: ReturnType<typeof vi.fn>;
      deleteAgent: ReturnType<typeof vi.fn>;
    }) => unknown) => {
      const state = {
        ...agentsState,
        agentSkills: {},
        agentTemplates: {},
        fetchAgents: fetchAgentsMock,
        updateAgent: updateAgentMock,
        updateAgentModel: updateAgentModelMock,
        createAgent: vi.fn(),
        deleteAgent: vi.fn(),
      };
      return typeof selector === 'function' ? selector(state) : state;
    },
    {
      getState: () => ({
        ...agentsState,
        agentSkills: {},
        agentTemplates: {},
        fetchAgents: fetchAgentsMock,
        updateAgent: updateAgentMock,
        updateAgentModel: updateAgentModelMock,
        createAgent: vi.fn(),
        deleteAgent: vi.fn(),
      }),
    },
  ),
}));

vi.mock('@/stores/providers', () => ({
  useProviderStore: (selector: (state: typeof providersState & {
    refreshProviderSnapshot: typeof refreshProviderSnapshotMock;
  }) => unknown) => {
    const state = {
      ...providersState,
      refreshProviderSnapshot: refreshProviderSnapshotMock,
    };
    return selector(state);
  },
}));

vi.mock('@/stores/models', () => ({
  useModelsStore: Object.assign(
    (selector?: (state: typeof modelsState & {
      fetchModels: typeof fetchModelsMock;
      fetchDigitalEmployees: typeof fetchDigitalEmployeesMock;
      createDigitalEmployee: typeof createDigitalEmployeeMock;
      updateEmployeeSkills: typeof updateEmployeeSkillsMock;
      updateEmployeeTemplate: typeof updateEmployeeTemplateMock;
      getTokenKey: typeof getTokenKeyMock;
    }) => unknown) => {
      const state = {
        ...modelsState,
        fetchModels: fetchModelsMock,
        fetchDigitalEmployees: fetchDigitalEmployeesMock,
        createDigitalEmployee: createDigitalEmployeeMock,
        updateEmployeeSkills: updateEmployeeSkillsMock,
        updateEmployeeTemplate: updateEmployeeTemplateMock,
        getTokenKey: getTokenKeyMock,
      };
      return typeof selector === 'function' ? selector(state) : state;
    },
    {
      getState: () => ({
        ...modelsState,
        fetchModels: fetchModelsMock,
        fetchDigitalEmployees: fetchDigitalEmployeesMock,
        createDigitalEmployee: createDigitalEmployeeMock,
        updateEmployeeSkills: updateEmployeeSkillsMock,
        updateEmployeeTemplate: updateEmployeeTemplateMock,
        getTokenKey: getTokenKeyMock,
      }),
    },
  ),
}));

vi.mock('@/stores/chat', () => ({
  useChatStore: {
    getState: () => ({
      newSessionForAgent: newSessionForAgentMock,
    }),
  },
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

vi.mock('@/lib/host-events', () => ({
  subscribeHostEvent: (...args: unknown[]) => subscribeHostEventMock(...args),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

function renderAgents() {
  return render(<Agents />, { wrapper: MemoryRouter });
}

describe('Agents page status refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gatewayState.status = { state: 'running', port: 18789 };
    agentsState.agents = [];
    agentsState.defaultModelRef = null;
    agentsState.loading = false;
    agentsState.error = null;
    providersState.accounts = [];
    providersState.statuses = [];
    providersState.vendors = [];
    providersState.defaultAccountId = '';
    modelsState.models = [];
    modelsState.digitalEmployees = [];
    modelsState.loading = false;
    modelsState.error = null;
    modelsState.isLoggedIn = true;
    modelsState.currentModelId = null;
    modelsState.sessionModels = {};
    fetchAgentsMock.mockResolvedValue(undefined);
    updateAgentMock.mockResolvedValue(undefined);
    updateAgentModelMock.mockResolvedValue(undefined);
    refreshProviderSnapshotMock.mockResolvedValue(undefined);
    fetchDigitalEmployeesMock.mockResolvedValue(undefined);
    fetchModelsMock.mockResolvedValue(undefined);
    createDigitalEmployeeMock.mockResolvedValue(undefined);
    updateEmployeeSkillsMock.mockResolvedValue(undefined);
    updateEmployeeTemplateMock.mockResolvedValue(undefined);
    getTokenKeyMock.mockResolvedValue('token');
    newSessionForAgentMock.mockReturnValue('agent:main:main');
    hostApiFetchMock.mockResolvedValue({
      success: true,
      channels: [],
    });
  });

  it('refetches channel accounts when gateway channel-status events arrive', async () => {
    let channelStatusHandler: (() => void) | undefined;
    subscribeHostEventMock.mockImplementation((eventName: string, handler: () => void) => {
      if (eventName === 'gateway:channel-status') {
        channelStatusHandler = handler;
      }
      return vi.fn();
    });

    renderAgents();

    await waitFor(() => {
      expect(fetchAgentsMock).toHaveBeenCalledTimes(1);
      expect(hostApiFetchMock).toHaveBeenCalledWith('/api/channels/accounts');
    });
    expect(subscribeHostEventMock).toHaveBeenCalledWith('gateway:channel-status', expect.any(Function));

    await act(async () => {
      channelStatusHandler?.();
    });

    await waitFor(() => {
      const channelFetchCalls = hostApiFetchMock.mock.calls.filter(([path]) => path === '/api/channels/accounts');
      expect(channelFetchCalls).toHaveLength(2);
    });
  });

  it('refetches channel accounts when the gateway transitions to running after mount', async () => {
    gatewayState.status = { state: 'starting', port: 18789 };

    const { rerender } = renderAgents();

    await waitFor(() => {
      expect(fetchAgentsMock).toHaveBeenCalledTimes(1);
      expect(hostApiFetchMock).toHaveBeenCalledWith('/api/channels/accounts');
    });

    gatewayState.status = { state: 'running', port: 18789 };
    await act(async () => {
      rerender(<Agents />);
    });

    await waitFor(() => {
      const channelFetchCalls = hostApiFetchMock.mock.calls.filter(([path]) => path === '/api/channels/accounts');
      expect(channelFetchCalls).toHaveLength(2);
    });
  });

  it('uses "Use default model" as form fill only and disables it when already default', async () => {
    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'claude-opus-4.6',
        modelRef: 'openrouter/anthropic/claude-opus-4.6',
        overrideModelRef: null,
        inheritedModel: true,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:desk',
        channelTypes: [],
      },
    ];
    agentsState.defaultModelRef = 'openrouter/anthropic/claude-opus-4.6';
    providersState.accounts = [
      {
        id: 'openrouter-default',
        label: 'OpenRouter',
        vendorId: 'openrouter',
        authMode: 'api_key',
        model: 'openrouter/anthropic/claude-opus-4.6',
        fallbackModels: ['anthropic/claude-sonnet-4.5'],
        enabled: true,
        createdAt: '2026-03-24T00:00:00.000Z',
        updatedAt: '2026-03-24T00:00:00.000Z',
      },
    ];
    providersState.statuses = [{ id: 'openrouter-default', hasKey: true }];
    providersState.vendors = [
      { id: 'openrouter', name: 'OpenRouter', modelIdPlaceholder: 'anthropic/claude-opus-4.6' },
    ];
    providersState.defaultAccountId = 'openrouter-default';

    renderAgents();

    await waitFor(() => {
      expect(fetchAgentsMock).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole('button', { name: 'settings' }));
    fireEvent.click(screen.getByText('settingsDialog.modelLabel').closest('button') as HTMLButtonElement);

    const useDefaultButton = await screen.findByRole('button', { name: 'settingsDialog.useDefaultModel' });
    const saveButton = screen.getByRole('button', { name: 'common:actions.save' });

    expect(useDefaultButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText('settingsDialog.modelIdLabel'), {
      target: { value: 'anthropic/claude-sonnet-4.5' },
    });
    expect(useDefaultButton).toBeEnabled();
    expect(saveButton).toBeEnabled();

    fireEvent.click(useDefaultButton);

    expect(updateAgentModelMock).not.toHaveBeenCalled();
    expect((screen.getByLabelText('settingsDialog.modelIdLabel') as HTMLSelectElement).value).toBe('anthropic/claude-opus-4.6');
    expect(useDefaultButton).toBeDisabled();
  });

  it('keeps the last agent snapshot visible while a refresh is in flight', async () => {
    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'gpt-5',
        modelRef: 'openai/gpt-5',
        overrideModelRef: null,
        inheritedModel: true,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:main',
        channelTypes: [],
      },
    ];

    const { rerender } = renderAgents();

    expect(await screen.findByText('Main')).toBeInTheDocument();

    agentsState.loading = true;
    await act(async () => {
      rerender(<Agents />);
    });

    expect(screen.getByText('Main')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('keeps the blocking spinner during the initial load before any stable snapshot exists', async () => {
    agentsState.loading = true;
    fetchAgentsMock.mockImplementation(() => new Promise(() => {}));
    refreshProviderSnapshotMock.mockImplementation(() => new Promise(() => {}));
    hostApiFetchMock.mockImplementation(() => new Promise(() => {}));

    const { container } = renderAgents();

    expect(container.querySelector('svg.animate-spin')).toBeTruthy();
    expect(screen.queryByText('title')).not.toBeInTheDocument();
  });

  it('shows the chat action for a regular agent card', async () => {
    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'gpt-5',
        modelRef: 'openai/gpt-5',
        overrideModelRef: null,
        inheritedModel: true,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:main',
        channelTypes: [],
      },
    ];

    renderAgents();

    const chatButton = await screen.findByRole('button', { name: 'newChat' });
    fireEvent.click(chatButton);

    expect(newSessionForAgentMock).toHaveBeenCalledWith('main', { nativeCli: false });
  });

  it('keeps the chat action visible when digital employee metadata is unavailable', async () => {
    agentsState.agents = [
      {
        id: 'bot-network-race',
        name: 'Support Bot',
        isDefault: false,
        modelDisplay: 'glm-5',
        modelRef: 'shadan/glm-5',
        overrideModelRef: null,
        inheritedModel: false,
        workspace: '~/.openclaw/workspace-support',
        agentDir: '~/.openclaw/agents/bot-network-race/agent',
        mainSessionKey: 'agent:bot-network-race:main',
        channelTypes: [],
      },
    ];
    modelsState.digitalEmployees = [];

    renderAgents();

    expect(await screen.findByRole('button', { name: 'newChat' })).toBeInTheDocument();
  });
});
