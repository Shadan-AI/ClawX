import { describe, expect, it } from 'vitest';
import {
  buildNativeCliSessionKey,
  findNativeCliSessionForAgent,
  isNativeCliSessionKey,
  resolveRuntimeSession,
} from '@/lib/runtime-session';
import type { AgentSummary } from '@/types/agent';

function agent(id: string, runtimeType: 'embedded' | 'native-cli' = 'embedded'): AgentSummary {
  return {
    id,
    name: id,
    isDefault: id === 'main',
    modelDisplay: 'test-model',
    inheritedModel: true,
    workspace: '/tmp/workspace',
    agentDir: `/tmp/agents/${id}`,
    mainSessionKey: `agent:${id}:main`,
    channelTypes: [],
    runtime: runtimeType === 'native-cli'
      ? {
          type: 'native-cli',
          nativeCli: {
            provider: 'Claude',
            command: 'claude',
          },
        }
      : { type: 'embedded' },
  };
}

describe('runtime session resolution', () => {
  it('treats native-cli agent runtime as the source of truth even when session key is main', () => {
    const result = resolveRuntimeSession({
      currentSessionKey: 'agent:research:main',
      currentAgentId: 'main',
      sessions: [
        { key: 'agent:research:main' },
        { key: 'agent:research:cli:abc' },
      ],
      agents: [agent('main'), agent('research', 'native-cli')],
    });

    expect(result.agentId).toBe('research');
    expect(result.runtimeType).toBe('native-cli');
    expect(result.provider).toBe('claude');
    expect(result.needsNativeCliSessionSwitch).toBe(true);
    expect(result.recommendedSessionKey).toBe('agent:research:cli:abc');
  });

  it('keeps native-cli classification before agents finish loading', () => {
    const result = resolveRuntimeSession({
      currentSessionKey: 'agent:research:cli:abc',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:research:cli:abc' }],
      agents: [],
    });

    expect(result.agentId).toBe('research');
    expect(result.runtimeType).toBe('native-cli');
    expect(result.needsNativeCliSessionSwitch).toBe(false);
    expect(result.recommendedSessionKey).toBe('agent:research:cli:abc');
  });

  it('does not let stale currentAgentId override an agent session key', () => {
    const result = resolveRuntimeSession({
      currentSessionKey: 'agent:research:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:research:main' }],
      agents: [agent('main'), agent('research', 'embedded')],
    });

    expect(result.agentId).toBe('research');
    expect(result.runtimeType).toBe('openclaw');
  });

  it('finds and builds canonical native-cli session keys', () => {
    expect(isNativeCliSessionKey('agent:research:cli:abc')).toBe(true);
    expect(isNativeCliSessionKey('agent:research:main')).toBe(false);
    expect(findNativeCliSessionForAgent([
      { key: 'agent:main:main' },
      { key: 'agent:research:cli:abc' },
    ], 'Research')?.key).toBe('agent:research:cli:abc');
    expect(buildNativeCliSessionKey('Research', 1770000000000, 0.123456789)).toMatch(
      /^agent:research:cli:[a-z0-9]+-4fzzzxj/,
    );
  });
});
