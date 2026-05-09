import { toOpenClawChannelType, toUiChannelType } from './channel-alias';

type SessionOriginLike = {
  provider?: string;
  surface?: string;
  accountId?: string;
  to?: string;
};

type SessionLike = {
  key: string;
  origin?: SessionOriginLike;
  lastChannel?: string;
  lastAccountId?: string;
  deliveryContext?: {
    channel?: string;
    accountId?: string;
  };
};

function normalizeAgentId(value: string | undefined | null): string {
  return (value ?? '').trim().toLowerCase() || 'main';
}

function normalizeValue(value: string | undefined | null): string {
  return (value ?? '').trim();
}

function resolveBoundAgentIdFromSessionKey(
  sessionKey: string,
  channelBindings: Record<string, string>,
): string | null {
  if (sessionKey.startsWith('box-im:')) {
    const parts = sessionKey.split(':');
    if (parts.length >= 2) {
      const accountId = normalizeValue(parts[1]);
      if (accountId) {
        for (const key of buildChannelBindingLookupKeys('box-im', accountId)) {
          const boundAgentId = normalizeAgentId(channelBindings[key]);
          if (boundAgentId) {
            return boundAgentId;
          }
        }
      }
    }
  }

  return null;
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

function resolveSessionChannelCandidates(session: SessionLike): string[] {
  const values = [
    session.origin?.provider,
    session.origin?.surface,
    session.deliveryContext?.channel,
    session.lastChannel,
  ];

  const results: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeValue(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    results.push(normalized);
  }
  return results;
}

function resolveSessionAccountCandidates(session: SessionLike): string[] {
  const values = [
    session.origin?.accountId,
    session.deliveryContext?.accountId,
    session.lastAccountId,
    session.origin?.to,
  ];

  const results: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeValue(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    results.push(normalized);
  }
  return results;
}

export function resolveBoundAgentId(
  session: SessionLike,
  channelBindings: Record<string, string>,
): string | null {
  const channelCandidates = resolveSessionChannelCandidates(session);
  const accountCandidates = resolveSessionAccountCandidates(session);

  if (accountCandidates.length === 0) {
    return null;
  }

  for (const accountId of accountCandidates) {
    for (const channelType of channelCandidates) {
      for (const key of buildChannelBindingLookupKeys(channelType, accountId)) {
        const boundAgentId = normalizeAgentId(channelBindings[key]);
        if (boundAgentId) {
          return boundAgentId;
        }
      }
    }
  }

  return null;
}

export function resolveSessionAgentId(
  session: SessionLike,
  channelBindings: Record<string, string>,
): string {
  return resolveBoundAgentId(session, channelBindings) || getAgentIdFromSessionKey(session.key);
}

export function resolveSessionAgentIdByKey(
  sessionKey: string,
  sessions: SessionLike[],
  channelBindings: Record<string, string>,
): string {
  const session = sessions.find((entry) => entry.key === sessionKey);
  if (!session) {
    const boundAgentId = resolveBoundAgentIdFromSessionKey(sessionKey, channelBindings);
    if (boundAgentId) {
      return boundAgentId;
    }
    return getAgentIdFromSessionKey(sessionKey);
  }
  return resolveSessionAgentId(session, channelBindings);
}
