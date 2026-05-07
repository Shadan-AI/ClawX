import { toOpenClawChannelType, toUiChannelType } from './channel-alias';

type SessionOriginLike = {
  provider?: string;
  accountId?: string;
};

type SessionLike = {
  key: string;
  origin?: SessionOriginLike;
};

function normalizeAgentId(value: string | undefined | null): string {
  return (value ?? '').trim().toLowerCase() || 'main';
}

function normalizeValue(value: string | undefined | null): string {
  return (value ?? '').trim();
}

export function getAgentIdFromSessionKey(sessionKey: string): string {
  if (sessionKey.startsWith('box-im:')) {
    const parts = sessionKey.split(':');
    if (parts.length >= 3) {
      return normalizeAgentId(parts[2]);
    }
  }

  if (!sessionKey.startsWith('agent:')) {
    return 'main';
  }

  const [, agentId] = sessionKey.split(':');
  return normalizeAgentId(agentId);
}

export function buildChannelBindingLookupKeys(
  channelType: string | undefined | null,
  accountId: string | undefined | null,
): string[] {
  const normalizedAccountId = normalizeValue(accountId);
  if (!normalizedAccountId) {
    return [];
  }

  const keys: string[] = [];
  const seen = new Set<string>();
  const pushKey = (value: string | undefined | null) => {
    const normalizedValue = normalizeValue(value);
    if (!normalizedValue || seen.has(normalizedValue)) {
      return;
    }
    seen.add(normalizedValue);
    keys.push(normalizedValue);
  };

  const normalizedChannelType = normalizeValue(channelType);
  if (normalizedChannelType) {
    pushKey(`${normalizedChannelType}:${normalizedAccountId}`);
    pushKey(`${toUiChannelType(normalizedChannelType)}:${normalizedAccountId}`);
    pushKey(`${toOpenClawChannelType(normalizedChannelType)}:${normalizedAccountId}`);
  }

  pushKey(normalizedAccountId);
  return keys;
}

export function resolveBoundAgentId(
  origin: SessionOriginLike | undefined,
  channelBindings: Record<string, string>,
): string | null {
  if (!origin?.accountId) {
    return null;
  }

  for (const key of buildChannelBindingLookupKeys(origin.provider, origin.accountId)) {
    const boundAgentId = normalizeAgentId(channelBindings[key]);
    if (boundAgentId) {
      return boundAgentId;
    }
  }

  return null;
}

export function resolveSessionAgentId(
  session: SessionLike,
  channelBindings: Record<string, string>,
): string {
  return resolveBoundAgentId(session.origin, channelBindings) || getAgentIdFromSessionKey(session.key);
}

export function resolveSessionAgentIdByKey(
  sessionKey: string,
  sessions: SessionLike[],
  channelBindings: Record<string, string>,
): string {
  const session = sessions.find((entry) => entry.key === sessionKey);
  if (!session) {
    return getAgentIdFromSessionKey(sessionKey);
  }
  return resolveSessionAgentId(session, channelBindings);
}
