import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ChatInput } from '@/pages/Chat/ChatInput';

const { agentsState, chatState, gatewayState } = vi.hoisted(() => ({
  agentsState: {
    agents: [] as Array<Record<string, unknown>>,
    agentSkills: {} as Record<string, string[]>,
  },
  chatState: {
    currentSessionKey: 'agent:main:main',
    currentAgentId: 'main',
    sessions: [{ key: 'agent:main:main' }] as Array<Record<string, unknown>>,
    channelBindings: {} as Record<string, string>,
    sessionModels: {} as Record<string, string>,
    refresh: vi.fn(),
    loading: false,
    showThinking: false,
    toggleThinking: vi.fn(),
  },
  gatewayState: {
    status: { state: 'running', port: 18789 },
  },
}));

vi.mock('@/stores/agents', () => ({
  useAgentsStore: Object.assign(
    (selector: (state: typeof agentsState) => unknown) => selector(agentsState),
    { getState: () => agentsState },
  ),
}));

vi.mock('@/stores/chat', () => ({
  useChatStore: (selector: (state: typeof chatState) => unknown) => selector(chatState),
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: (selector: (state: typeof gatewayState) => unknown) => selector(gatewayState),
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({
  invokeIpc: vi.fn(),
}));

function translate(key: string, vars?: Record<string, unknown>): string {
  switch (key) {
    case 'composer.attachFiles':
      return 'Attach files';
    case 'composer.pickAgent':
      return 'Choose agent';
    case 'composer.clearTarget':
      return 'Clear target agent';
    case 'composer.targetChip':
      return `@${String(vars?.agent ?? '')}`;
    case 'composer.agentPickerTitle':
      return 'Route the next message to another agent';
    case 'composer.gatewayDisconnectedPlaceholder':
      return 'Gateway not connected...';
    case 'composer.send':
      return 'Send';
    case 'composer.stop':
      return 'Stop';
    case 'composer.gatewayConnected':
      return 'connected';
    case 'composer.gatewayStatus':
      return `gateway ${String(vars?.state ?? '')} | port: ${String(vars?.port ?? '')} ${String(vars?.pid ?? '')}`.trim();
    case 'composer.retryFailedAttachments':
      return 'Retry failed attachments';
    default:
      return key;
  }
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: translate,
  }),
}));

function renderChatInput(props: ComponentProps<typeof ChatInput>) {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <ChatInput {...props} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe('ChatInput agent targeting', () => {
  beforeEach(() => {
    agentsState.agents = [];
    agentsState.agentSkills = {};
    chatState.currentSessionKey = 'agent:main:main';
    chatState.currentAgentId = 'main';
    chatState.sessions = [{ key: 'agent:main:main' }];
    chatState.channelBindings = {};
    chatState.sessionModels = {};
    chatState.refresh = vi.fn();
    chatState.loading = false;
    chatState.showThinking = false;
    chatState.toggleThinking = vi.fn();
    gatewayState.status = { state: 'running', port: 18789 };
  });

  it('hides the @agent picker when only one agent is configured', () => {
    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'MiniMax',
        inheritedModel: true,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:main',
        channelTypes: [],
      },
    ];

    renderChatInput({ onSend: vi.fn() });

    expect(screen.queryByTitle('Choose agent')).not.toBeInTheDocument();
  });

  it('lets the user select an agent target and sends it with the message', () => {
    const onSend = vi.fn();
    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'MiniMax',
        inheritedModel: true,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:main',
        channelTypes: [],
      },
      {
        id: 'research',
        name: 'Research',
        isDefault: false,
        modelDisplay: 'Claude',
        inheritedModel: false,
        workspace: '~/.openclaw/workspace-research',
        agentDir: '~/.openclaw/agents/research/agent',
        mainSessionKey: 'agent:research:desk',
        channelTypes: [],
      },
    ];

    renderChatInput({ onSend });

    fireEvent.click(screen.getByTitle('Choose agent'));
    fireEvent.click(screen.getByText('Research'));

    expect(screen.getByText('@Research')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hello direct agent' } });
    const sendButton = screen.getAllByTitle('Send').find((button) => !button.hasAttribute('disabled'));
    expect(sendButton).toBeTruthy();
    fireEvent.click(sendButton as HTMLElement);

    expect(onSend).toHaveBeenCalledWith('Hello direct agent', undefined, 'research');
  });

  it('calls onStop from the sending button state', () => {
    const onStop = vi.fn();

    renderChatInput({ onSend: vi.fn(), onStop, sending: true, stopIcon: 'pause' });

    const stopButton = screen.getAllByTitle('Stop').find((button) => !button.hasAttribute('disabled'));
    expect(stopButton).toBeTruthy();
    fireEvent.click(stopButton as HTMLElement);

    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
