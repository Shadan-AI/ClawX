import { getAgentIdFromSessionKey, resolveSessionAgentIdByKey } from './session-agent';
import type { AgentSummary } from '@/types/agent';

export type RuntimeType = 'openclaw' | 'native-cli';

export type RuntimeSessionLike = {
  key: string;
};

export type RuntimeSessionResolution = {
  agentId: string;
  runtimeType: RuntimeType;
  provider?: string;
  currentSessionKey: string;
  currentSessionIsNativeCli: boolean;
  recommendedSessionKey: string;
  needsNativeCliSessionSwitch: boolean;
  agent?: AgentSummary;
};

export function normalizeRuntimeAgentId(value: string | undefined | null): string {
  return (value ?? '').trim().toLowerCase() || 'main';
}

export function normalizeNativeCliProvider(provider: string | undefined | null): string {
  return provider?.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'claude';
}

export function isAgentSessionKey(sessionKey: string): boolean {
  return sessionKey.startsWith('agent:');
}

export function isNativeCliSessionKey(sessionKey: string): boolean {
  return /^agent:[^:]+:cli:/i.test(sessionKey);
}

export function getAgentIdFromNativeCliSessionKey(sessionKey: string): string | null {
  if (!isNativeCliSessionKey(sessionKey)) return null;
  return normalizeRuntimeAgentId(getAgentIdFromSessionKey(sessionKey));
}

export function buildNativeCliSessionKey(agentId: string, now = Date.now(), random = Math.random()): string {
  const shortId = random.toString(36).slice(2, 10);
  return `agent:${normalizeRuntimeAgentId(agentId)}:cli:${now.toString(36)}-${shortId}`;
}

export function getRuntimeAgent(
  agents: readonly AgentSummary[] | undefined,
  agentId: string | undefined | null,
): AgentSummary | undefined {
  const normalizedAgentId = normalizeRuntimeAgentId(agentId);
  return (agents ?? []).find((agent) => normalizeRuntimeAgentId(agent.id) === normalizedAgentId);
}

export function getNativeCliAgent(
  agents: readonly AgentSummary[] | undefined,
  agentId: string | undefined | null,
): AgentSummary | undefined {
  const agent = getRuntimeAgent(agents, agentId);
  return agent?.runtime?.type === 'native-cli' ? agent : undefined;
}

export function findNativeCliSessionForAgent(
  sessions: readonly RuntimeSessionLike[],
  agentId: string | undefined | null,
): RuntimeSessionLike | undefined {
  const normalizedAgentId = normalizeRuntimeAgentId(agentId);
  return sessions.find(
    (session) => getAgentIdFromNativeCliSessionKey(session.key) === normalizedAgentId,
  );
}

export function resolveRequestedAgentId(
  sessionKey: string,
  sessions: readonly RuntimeSessionLike[],
  channelBindings: Record<string, string>,
  currentAgentId: string | undefined | null,
): string {
  if (isAgentSessionKey(sessionKey)) {
    return normalizeRuntimeAgentId(getAgentIdFromSessionKey(sessionKey));
  }

  const resolvedFromSession = resolveSessionAgentIdByKey(sessionKey, sessions, channelBindings);
  return normalizeRuntimeAgentId(resolvedFromSession || currentAgentId);
}

export function resolveRuntimeSession(params: {
  currentSessionKey: string;
  currentAgentId?: string | null;
  sessions: readonly RuntimeSessionLike[];
  agents: readonly AgentSummary[] | undefined;
  channelBindings?: Record<string, string>;
}): RuntimeSessionResolution {
  const {
    currentSessionKey,
    currentAgentId,
    sessions,
    agents,
    channelBindings = {},
  } = params;
  const currentSessionIsNativeCli = isNativeCliSessionKey(currentSessionKey);
  const agentId = resolveRequestedAgentId(currentSessionKey, sessions, channelBindings, currentAgentId);
  const agent = getRuntimeAgent(agents, agentId);
  const runtimeType: RuntimeType = agent?.runtime?.type === 'native-cli' || currentSessionIsNativeCli
    ? 'native-cli'
    : 'openclaw';
  const provider = runtimeType === 'native-cli'
    ? normalizeNativeCliProvider(agent?.runtime?.nativeCli?.provider)
    : undefined;
  const nativeCliSession = runtimeType === 'native-cli'
    ? findNativeCliSessionForAgent(sessions, agentId)
    : undefined;
  const recommendedSessionKey = currentSessionIsNativeCli
    ? currentSessionKey
    : nativeCliSession?.key ?? currentSessionKey;

  return {
    agentId,
    runtimeType,
    provider,
    currentSessionKey,
    currentSessionIsNativeCli,
    recommendedSessionKey,
    needsNativeCliSessionSwitch: runtimeType === 'native-cli' && !currentSessionIsNativeCli,
    agent,
  };
}
