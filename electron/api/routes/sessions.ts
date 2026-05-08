import type { IncomingMessage, ServerResponse } from 'http';
import { join } from 'node:path';
import { getOpenClawConfigDir } from '../../utils/paths';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

const SAFE_SESSION_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

type LocalSessionIndexEntry = {
  key: string;
  label?: string;
  displayName?: string;
  thinkingLevel?: string;
  model?: string;
  updatedAt?: number;
  sessionId?: string;
  sessionFile?: string;
};

function stripUtf8Bom(raw: string): string {
  return raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
}

function repairLikelyCorruptedJson(raw: string): string {
  const input = stripUtf8Bom(raw);
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (!inString) {
      result += ch;
      if (ch === '"') {
        inString = true;
        escaped = false;
      }
      continue;
    }

    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      result += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) {
        j += 1;
      }
      const next = input[j];
      const isClosingQuote = next === ',' || next === '}' || next === ']' || next === ':';
      if (isClosingQuote) {
        result += ch;
        inString = false;
      } else {
        result += '\\"';
      }
      continue;
    }

    result += ch;
  }

  return result;
}

async function repairSessionIndexFiles(): Promise<{ scanned: number; repaired: number; failed: string[] }> {
  const fsP = await import('node:fs/promises');
  const agentsDir = join(getOpenClawConfigDir(), 'agents');
  const failed: string[] = [];
  let scanned = 0;
  let repaired = 0;

  let agentEntries: Array<{ name: string; isDirectory(): boolean }> = [];
  try {
    agentEntries = (await fsP.readdir(agentsDir, { withFileTypes: true })) as Array<{ name: string; isDirectory(): boolean }>;
  } catch {
    return { scanned, repaired, failed };
  }

  for (const entry of agentEntries) {
    if (!entry.isDirectory()) continue;
    const sessionsJsonPath = join(agentsDir, entry.name, 'sessions', 'sessions.json');

    try {
      const raw = await fsP.readFile(sessionsJsonPath, 'utf8');
      scanned += 1;
      try {
        const normalizedRaw = stripUtf8Bom(raw);
        JSON.parse(normalizedRaw);
        if (normalizedRaw !== raw) {
          await fsP.writeFile(sessionsJsonPath, normalizedRaw, 'utf8');
          repaired += 1;
        }
        continue;
      } catch {
        const repairedRaw = repairLikelyCorruptedJson(raw);
        JSON.parse(repairedRaw);
        await fsP.writeFile(sessionsJsonPath, repairedRaw, 'utf8');
        repaired += 1;
      }
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        continue;
      }
      failed.push(sessionsJsonPath);
    }
  }

  return { scanned, repaired, failed };
}

function coerceNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function coerceUpdatedAt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function resolveLocalSessionEntry(
  agentId: string,
  sessionKey: string,
  value: unknown,
  sessionsDir: string,
): LocalSessionIndexEntry | null {
  if (!sessionKey) return null;

  const entry = (value && typeof value === 'object') ? value as Record<string, unknown> : null;
  const sessionId = coerceNonEmptyString(entry?.sessionId)
    ?? coerceNonEmptyString(entry?.id);

  let sessionFile = coerceNonEmptyString(entry?.sessionFile)
    ?? coerceNonEmptyString(entry?.file)
    ?? coerceNonEmptyString(entry?.fileName)
    ?? coerceNonEmptyString(entry?.path);

  if (sessionFile && !sessionFile.match(/^[A-Za-z]:\\/u) && !sessionFile.startsWith('/')) {
    sessionFile = join(sessionsDir, sessionFile);
  }

  if (!sessionFile && sessionId) {
    sessionFile = join(sessionsDir, `${sessionId}.jsonl`);
  }

  return {
    key: sessionKey,
    label: coerceNonEmptyString(entry?.label),
    displayName: coerceNonEmptyString(entry?.displayName) ?? coerceNonEmptyString(entry?.derivedTitle),
    thinkingLevel: coerceNonEmptyString(entry?.thinkingLevel),
    model: coerceNonEmptyString(entry?.model),
    updatedAt: coerceUpdatedAt(entry?.updatedAt),
    sessionId,
    sessionFile,
  };
}

async function listLocalSessionIndexes(): Promise<LocalSessionIndexEntry[]> {
  const fsP = await import('node:fs/promises');
  const agentsDir = join(getOpenClawConfigDir(), 'agents');
  const sessions: LocalSessionIndexEntry[] = [];

  let agentEntries: Array<{ name: string; isDirectory(): boolean }> = [];
  try {
    agentEntries = (await fsP.readdir(agentsDir, { withFileTypes: true })) as Array<{ name: string; isDirectory(): boolean }>;
  } catch {
    return sessions;
  }

  for (const agentEntry of agentEntries) {
    if (!agentEntry.isDirectory()) continue;
    const agentId = agentEntry.name;
    const sessionsDir = join(agentsDir, agentId, 'sessions');
    const sessionsJsonPath = join(sessionsDir, 'sessions.json');

    try {
      const raw = stripUtf8Bom(await fsP.readFile(sessionsJsonPath, 'utf8'));
      const json = JSON.parse(raw) as Record<string, unknown>;

      if (Array.isArray(json.sessions)) {
        for (const item of json.sessions as Array<Record<string, unknown>>) {
          const sessionKey = coerceNonEmptyString(item.key) ?? coerceNonEmptyString(item.sessionKey);
          if (!sessionKey) continue;
          const normalized = resolveLocalSessionEntry(agentId, sessionKey, item, sessionsDir);
          if (normalized) sessions.push(normalized);
        }
        continue;
      }

      for (const [sessionKey, value] of Object.entries(json)) {
        const normalized = resolveLocalSessionEntry(agentId, sessionKey, value, sessionsDir);
        if (normalized) sessions.push(normalized);
      }
    } catch {
      // Ignore broken per-agent indexes here; repair endpoint already handles them.
    }
  }

  for (const session of sessions) {
    if (session.updatedAt || !session.sessionFile) continue;
    try {
      const stat = await fsP.stat(session.sessionFile);
      session.updatedAt = stat.mtimeMs;
    } catch {
      // ignore stat failures
    }
  }

  return sessions
    .filter((session) => !session.sessionFile || !session.sessionFile.endsWith('.deleted.jsonl'))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export async function handleSessionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/sessions/repair-indexes' && req.method === 'POST') {
    try {
      const result = await repairSessionIndexFiles();
      sendJson(res, 200, { success: true, ...result });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/sessions/transcript' && req.method === 'GET') {
    try {
      const agentId = url.searchParams.get('agentId')?.trim() || '';
      const sessionId = url.searchParams.get('sessionId')?.trim() || '';
      if (!agentId || !sessionId) {
        sendJson(res, 400, { success: false, error: 'agentId and sessionId are required' });
        return true;
      }
      if (!SAFE_SESSION_SEGMENT.test(agentId) || !SAFE_SESSION_SEGMENT.test(sessionId)) {
        sendJson(res, 400, { success: false, error: 'Invalid transcript identifier' });
        return true;
      }

      const transcriptPath = join(getOpenClawConfigDir(), 'agents', agentId, 'sessions', `${sessionId}.jsonl`);
      const fsP = await import('node:fs/promises');
      const raw = await fsP.readFile(transcriptPath, 'utf8');
      const lines = raw.split(/\r?\n/).filter(Boolean);
      const messages = lines.flatMap((line) => {
        try {
          const entry = JSON.parse(line) as { type?: string; message?: unknown };
          return entry.type === 'message' && entry.message ? [entry.message] : [];
        } catch {
          return [];
        }
      });

      sendJson(res, 200, { success: true, messages });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        sendJson(res, 404, { success: false, error: 'Transcript not found' });
      } else {
        sendJson(res, 500, { success: false, error: 'Failed to load transcript' });
      }
    }
    return true;
  }

  if (url.pathname === '/api/sessions/indexes' && req.method === 'GET') {
    try {
      const sessions = await listLocalSessionIndexes();
      sendJson(res, 200, { success: true, sessions });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/sessions/delete' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ sessionKey: string }>(req);
      const sessionKey = body.sessionKey;
      if (!sessionKey || !sessionKey.startsWith('agent:')) {
        sendJson(res, 400, { success: false, error: `Invalid sessionKey: ${sessionKey}` });
        return true;
      }
      const parts = sessionKey.split(':');
      if (parts.length < 3) {
        sendJson(res, 400, { success: false, error: `sessionKey has too few parts: ${sessionKey}` });
        return true;
      }
      const agentId = parts[1];
      const sessionsDir = join(getOpenClawConfigDir(), 'agents', agentId, 'sessions');
      const sessionsJsonPath = join(sessionsDir, 'sessions.json');
      const fsP = await import('node:fs/promises');
      const raw = await fsP.readFile(sessionsJsonPath, 'utf8');
      const sessionsJson = JSON.parse(raw) as Record<string, unknown>;

      let uuidFileName: string | undefined;
      let resolvedSrcPath: string | undefined;
      if (Array.isArray(sessionsJson.sessions)) {
        const entry = (sessionsJson.sessions as Array<Record<string, unknown>>)
          .find((s) => s.key === sessionKey || s.sessionKey === sessionKey);
        if (entry) {
          uuidFileName = (entry.file ?? entry.fileName ?? entry.path) as string | undefined;
          if (!uuidFileName && typeof entry.id === 'string') {
            uuidFileName = `${entry.id}.jsonl`;
          }
        }
      }
      if (!uuidFileName && sessionsJson[sessionKey] != null) {
        const val = sessionsJson[sessionKey];
        if (typeof val === 'string') {
          uuidFileName = val;
        } else if (typeof val === 'object' && val !== null) {
          const entry = val as Record<string, unknown>;
          const absFile = (entry.sessionFile ?? entry.file ?? entry.fileName ?? entry.path) as string | undefined;
          if (absFile) {
            if (absFile.startsWith('/') || absFile.match(/^[A-Za-z]:\\/)) {
              resolvedSrcPath = absFile;
            } else {
              uuidFileName = absFile;
            }
          } else {
            const uuidVal = (entry.id ?? entry.sessionId) as string | undefined;
            if (uuidVal) uuidFileName = uuidVal.endsWith('.jsonl') ? uuidVal : `${uuidVal}.jsonl`;
          }
        }
      }
      if (!uuidFileName && !resolvedSrcPath) {
        sendJson(res, 404, { success: false, error: `Cannot resolve file for session: ${sessionKey}` });
        return true;
      }
      if (!resolvedSrcPath) {
        if (!uuidFileName!.endsWith('.jsonl')) uuidFileName = `${uuidFileName}.jsonl`;
        resolvedSrcPath = join(sessionsDir, uuidFileName!);
      }
      const dstPath = resolvedSrcPath.replace(/\.jsonl$/, '.deleted.jsonl');
      try {
        await fsP.access(resolvedSrcPath);
        await fsP.rename(resolvedSrcPath, dstPath);
      } catch {
        // Non-fatal; still try to update sessions.json.
      }
      const raw2 = await fsP.readFile(sessionsJsonPath, 'utf8');
      const json2 = JSON.parse(raw2) as Record<string, unknown>;
      if (Array.isArray(json2.sessions)) {
        json2.sessions = (json2.sessions as Array<Record<string, unknown>>)
          .filter((s) => s.key !== sessionKey && s.sessionKey !== sessionKey);
      } else if (json2[sessionKey]) {
        delete json2[sessionKey];
      }
      await fsP.writeFile(sessionsJsonPath, JSON.stringify(json2, null, 2), 'utf8');
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
