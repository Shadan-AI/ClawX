import type { IncomingMessage, ServerResponse } from 'http';
import type { Dirent } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { getOpenClawConfigDir, expandPath } from '../../utils/paths';
import { readOpenClawConfig } from '../../utils/channel-config';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

const SAFE_SESSION_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const DANGLING_SESSION_PRUNE_AGE_MS = 10 * 60 * 1000;

type LocalSessionIndexEntry = {
  key: string;
  label?: string;
  displayName?: string;
  thinkingLevel?: string;
  model?: string;
  updatedAt?: number;
  sessionId?: string;
  sessionFile?: string;
  cliSessionIds?: Record<string, string>;
  cliSessionId?: string;
  claudeCliSessionId?: string;
};

type TranscriptSidebarMeta = {
  messageCount: number;
  visibleMessageCount: number;
  firstUserText?: string;
  firstVisibleUserText?: string;
  lastTimestamp?: number;
};

type PruneEmptySessionsResult = {
  scanned: number;
  removed: number;
  failed: string[];
};

type NativeCliResolveResult = {
  sessionId: string;
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

  let agentEntries: Array<{ name: string; isDirectory(): boolean }>;
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
      let parsedJson: Record<string, unknown> | null = null;
      let normalizedRaw = stripUtf8Bom(raw);
      try {
        parsedJson = JSON.parse(normalizedRaw) as Record<string, unknown>;
      } catch {
        const repairedRaw = repairLikelyCorruptedJson(raw);
        normalizedRaw = repairedRaw;
        parsedJson = JSON.parse(repairedRaw) as Record<string, unknown>;
      }

      if (!parsedJson) {
        continue;
      }

      const sessionsDir = join(agentsDir, entry.name, 'sessions');
      const { nextJson, removed } = await pruneDanglingSessionsJson(fsP, entry.name, sessionsDir, parsedJson);
      const nextRaw = JSON.stringify(nextJson, null, 2);
      if (nextRaw !== normalizedRaw || normalizedRaw !== raw || removed > 0) {
        await fsP.writeFile(sessionsJsonPath, nextRaw, 'utf8');
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

function normalizeNativeCliProvider(provider: unknown, command?: unknown): string {
  const configured = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
  if (configured) return configured.replace(/[^a-z0-9_-]/g, '') || 'claude';
  const commandName = typeof command === 'string'
    ? command.trim().toLowerCase().split(/[\\/]/).pop() ?? ''
    : '';
  if (commandName.includes('codex')) return 'codex';
  return 'claude';
}

function parseAgentIdFromSessionKey(sessionKey: string): string | null {
  if (!sessionKey || !sessionKey.startsWith('agent:')) return null;
  const parts = sessionKey.split(':');
  if (parts.length < 3 || !SAFE_SESSION_SEGMENT.test(parts[1])) return null;
  return parts[1];
}

async function persistNativeCliSessionIndex(params: {
  sessionKey: string;
  cliSessionId?: string;
  provider?: string;
  label?: string;
}): Promise<void> {
  const agentId = parseAgentIdFromSessionKey(params.sessionKey);
  if (!agentId) throw new Error(`Invalid sessionKey: ${params.sessionKey}`);

  const provider = params.provider?.trim()
    ? normalizeNativeCliProvider(params.provider)
    : (await resolveNativeCliRuntimeContext(agentId))?.provider ?? 'claude';
  const cliSessionId = params.cliSessionId?.trim() || '';
  const label = params.label?.trim() || '';
  const sessionsDir = join(getOpenClawConfigDir(), 'agents', agentId, 'sessions');
  const sessionsJsonPath = join(sessionsDir, 'sessions.json');
  const fsP = await import('node:fs/promises');
  await fsP.mkdir(sessionsDir, { recursive: true });

  let sessionsJson: Record<string, unknown>;
  try {
    sessionsJson = JSON.parse(await fsP.readFile(sessionsJsonPath, 'utf8')) as Record<string, unknown>;
  } catch {
    sessionsJson = {};
  }

  const now = Date.now();
  const existingRaw = sessionsJson[params.sessionKey];
  const existing = existingRaw && typeof existingRaw === 'object' && !Array.isArray(existingRaw)
    ? existingRaw as Record<string, unknown>
    : {};
  const existingCliSessionIds = existing.cliSessionIds && typeof existing.cliSessionIds === 'object' && !Array.isArray(existing.cliSessionIds)
    ? existing.cliSessionIds as Record<string, unknown>
    : {};
  const nextEntry: Record<string, unknown> = {
    ...existing,
    updatedAt: Math.max(typeof existing.updatedAt === 'number' ? existing.updatedAt : 0, now),
  };
  if (label) {
    nextEntry.label = label;
    nextEntry.displayName = label;
  }
  if (cliSessionId) {
    nextEntry.sessionId = typeof existing.sessionId === 'string' && existing.sessionId.trim() ? existing.sessionId : cliSessionId;
    nextEntry.cliSessionIds = {
      ...existingCliSessionIds,
      [provider]: cliSessionId,
    };
    nextEntry.cliSessionId = cliSessionId;
    if (provider === 'claude') nextEntry.claudeCliSessionId = cliSessionId;
  }
  sessionsJson[params.sessionKey] = nextEntry;
  await fsP.writeFile(sessionsJsonPath, JSON.stringify(sessionsJson, null, 2), 'utf8');
}

function claudeProjectDirNames(cwd: string): string[] {
  const normalized = cwd.trim();
  return [...new Set([
    normalized.replace(/\//g, '-'),
    normalized.replace(/[^A-Za-z0-9_-]/g, '-'),
  ].filter(Boolean))];
}

function codexSessionDirsForStartedAt(startedAt: number): string[] {
  const root = join(homedir(), '.codex', 'sessions');
  const dayMs = 24 * 60 * 60 * 1000;
  const dirs = [];
  for (const offset of [-dayMs, 0, dayMs]) {
    const date = new Date(startedAt + offset);
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    dirs.push(join(root, year, month, day));
  }
  return [...new Set(dirs)];
}

function normalizePromptText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function promptMatches(candidate: string | undefined, userText: string): boolean {
  const candidateText = normalizePromptText(candidate ?? '');
  const expected = normalizePromptText(userText);
  if (!candidateText || !expected) return false;
  return candidateText === expected || candidateText.includes(expected) || expected.includes(candidateText);
}

async function readTextTail(filePath: string, maxBytes = 256 * 1024): Promise<string> {
  const fsP = await import('node:fs/promises');
  const stat = await fsP.stat(filePath);
  const handle = await fsP.open(filePath, 'r');
  try {
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

function extractSessionIdFromJsonlTail(raw: string, fallbackSessionId: string, userText: string): string | null {
  const lines = raw.split(/\r?\n/).filter(Boolean).reverse();
  let latestSessionId = fallbackSessionId;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const entrySessionId = coerceNonEmptyString(entry.sessionId);
      if (entrySessionId) latestSessionId = entrySessionId;
      if (entry.type === 'last-prompt' && promptMatches(coerceNonEmptyString(entry.lastPrompt), userText)) {
        return coerceNonEmptyString(entry.sessionId) ?? latestSessionId;
      }
      const message = entry.message && typeof entry.message === 'object' ? entry.message as Record<string, unknown> : null;
      if (entry.type === 'user' || message?.role === 'user') {
        const text = extractTranscriptText(message?.content ?? entry.message);
        if (promptMatches(text, userText)) return latestSessionId;
      }
    } catch {
      // Ignore malformed/incomplete tail lines while the CLI is still writing.
    }
  }
  return null;
}

async function listJsonlFiles(dir: string, recursive = false, depth = 0): Promise<Array<{ path: string; sessionId: string; mtimeMs: number }>> {
  const fsP = await import('node:fs/promises');
  let entries: Dirent[];
  try {
    entries = await fsP.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: Array<{ path: string; sessionId: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && recursive && depth < 5) {
      files.push(...await listJsonlFiles(path, true, depth + 1));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    try {
      const stat = await fsP.stat(path);
      files.push({ path, sessionId: basename(entry.name, '.jsonl'), mtimeMs: stat.mtimeMs });
    } catch {
      // File may have moved while scanning.
    }
  }
  return files;
}

async function resolveNativeCliRuntimeContext(agentId: string): Promise<{
  provider: string;
  cwd: string;
} | null> {
  const config = await readOpenClawConfig() as Record<string, unknown>;
  const agents = config.agents && typeof config.agents === 'object' ? config.agents as Record<string, unknown> : {};
  const list = Array.isArray(agents.list) ? agents.list as Array<Record<string, unknown>> : [];
  const entry = list.find((item) => coerceNonEmptyString(item.id) === agentId);
  if (!entry) return null;
  const runtime = entry.runtime && typeof entry.runtime === 'object' ? entry.runtime as Record<string, unknown> : null;
  if (runtime?.type !== 'native-cli') return null;
  const nativeCli = runtime.nativeCli && typeof runtime.nativeCli === 'object'
    ? runtime.nativeCli as Record<string, unknown>
    : {};
  const command = coerceNonEmptyString(nativeCli.command);
  const provider = normalizeNativeCliProvider(nativeCli.provider, command);
  const cwd = coerceNonEmptyString(nativeCli.cwd)
    ?? coerceNonEmptyString(entry.workspace)
    ?? join(getOpenClawConfigDir(), `workspace-${agentId}`);
  return { provider, cwd: expandPath(cwd) };
}

async function resolveNativeCliSessionFromFiles(params: {
  agentId: string;
  provider?: string;
  userText: string;
  startedAt?: number;
}): Promise<NativeCliResolveResult | null> {
  const context = await resolveNativeCliRuntimeContext(params.agentId);
  if (!context) return null;
  const provider = params.provider?.trim()
    ? normalizeNativeCliProvider(params.provider)
    : context.provider;
  const startedAt = Number.isFinite(params.startedAt) && params.startedAt ? Number(params.startedAt) : Date.now() - 60_000;
  const minMtime = startedAt - 120_000;

  const files = provider === 'codex'
    ? (await Promise.all(codexSessionDirsForStartedAt(startedAt).map((dir) => listJsonlFiles(dir)))).flat()
    : (await Promise.all(
      claudeProjectDirNames(context.cwd).map((dirName) => listJsonlFiles(join(homedir(), '.claude', 'projects', dirName))),
    )).flat();

  const recentFiles = files
    .filter((file) => file.mtimeMs >= minMtime)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 80);

  for (const file of recentFiles) {
    try {
      const tail = await readTextTail(file.path);
      const sessionId = extractSessionIdFromJsonlTail(tail, file.sessionId, params.userText);
      if (sessionId) return { sessionId, sessionFile: file.path };
    } catch {
      // Keep scanning other recent files.
    }
  }

  // No file matched the user text — return null instead of a wrong session.
  return null;
}

function getSessionKeyTail(sessionKey: string): string {
  const parts = sessionKey.split(':');
  return parts[parts.length - 1] || sessionKey;
}

function isGeneratedSessionIdentifier(value: string | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  return /^session-\d{8,}$/i.test(trimmed)
    || /^[a-f0-9]{8}$/i.test(trimmed)
    || /^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(trimmed);
}

function isMeaningfulSessionTitle(title: string | undefined, sessionKey: string): boolean {
  const trimmed = title?.trim();
  if (!trimmed || trimmed === sessionKey) {
    return false;
  }
  const sessionTail = getSessionKeyTail(sessionKey);
  if (trimmed === sessionTail) {
    return false;
  }
  return !isGeneratedSessionIdentifier(trimmed);
}

function isNativeCliSessionKey(sessionKey: string): boolean {
  return /^agent:[^:]+:cli:/i.test(sessionKey);
}

function hasNativeCliSessionId(session: LocalSessionIndexEntry): boolean {
  return Boolean(
    session.cliSessionId
      || session.claudeCliSessionId
      || (session.cliSessionIds && Object.keys(session.cliSessionIds).length > 0),
  );
}

function shouldPreserveNativeCliSession(session: LocalSessionIndexEntry): boolean {
  if (!isNativeCliSessionKey(session.key)) {
    return false;
  }
  return hasNativeCliSessionId(session)
    || isMeaningfulSessionTitle(session.label, session.key)
    || isMeaningfulSessionTitle(session.displayName, session.key);
}

function extractTranscriptText(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part === 'object' && 'text' in part && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        return '';
      })
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (content && typeof content === 'object' && 'text' in content && typeof (content as { text?: unknown }).text === 'string') {
    return (content as { text: string }).text.trim();
  }
  return '';
}

function isInternalTranscriptText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/^(HEARTBEAT_OK|NO_REPLY)\s*$/i.test(trimmed)) return true;
  if (trimmed.startsWith('Read HEARTBEAT.md if it exists (workspace context).')) return true;
  if (/^(?:Follow|Follow it strictly\.?|Do not infer(?: or repeat old tasks from prior chats\.)?|If nothing needs attention,\s*reply HEARTBEAT_OK\.?)$/i.test(trimmed)) return true;
  if (/^System:\s*\[[^\]]+\]\s*Exec (?:completed|failed|started)\b/i.test(trimmed)) return true;
  return false;
}

async function readTranscriptSidebarMeta(
  fsP: typeof import('node:fs/promises'),
  sessionFile: string | undefined,
): Promise<TranscriptSidebarMeta | null> {
  if (!sessionFile) {
    return null;
  }
  try {
    const raw = await fsP.readFile(sessionFile, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    let messageCount = 0;
    let visibleMessageCount = 0;
    let firstUserText: string | undefined;
    let firstVisibleUserText: string | undefined;
    let lastTimestamp: number | undefined;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as { type?: string; message?: Record<string, unknown> };
        if (entry.type !== 'message' || !entry.message || typeof entry.message !== 'object') {
          continue;
        }
        messageCount += 1;
        const timestamp = coerceUpdatedAt(entry.message.timestamp);
        if (typeof timestamp === 'number') {
          lastTimestamp = Math.max(lastTimestamp ?? 0, timestamp);
        }
        const text = extractTranscriptText(entry.message.content);
        const isInternal = isInternalTranscriptText(text) || entry.message.role === 'system';
        if (!isInternal) {
          visibleMessageCount += 1;
        }
        if (entry.message.role === 'user') {
          if (text) {
            firstUserText ??= text;
            if (!isInternal) {
              firstVisibleUserText ??= text;
            }
          }
        }
      } catch {
        // Ignore malformed transcript lines.
      }
    }

    return { messageCount, visibleMessageCount, firstUserText, firstVisibleUserText, lastTimestamp };
  } catch {
    return null;
  }
}

async function shouldPruneEmptyTranscriptSessionEntry(
  fsP: typeof import('node:fs/promises'),
  session: LocalSessionIndexEntry,
): Promise<boolean> {
  if (session.key.endsWith(':main')) {
    return false;
  }

  if (shouldPreserveNativeCliSession(session)) {
    return false;
  }

  const updatedAt = session.updatedAt ?? 0;
  if (!updatedAt || Date.now() - updatedAt < DANGLING_SESSION_PRUNE_AGE_MS) {
    return false;
  }

  if (!session.sessionFile) {
    return true;
  }

  const transcriptMeta = await readTranscriptSidebarMeta(fsP, session.sessionFile);
  return (transcriptMeta?.visibleMessageCount ?? 0) <= 0;
}

function resolveLocalSessionEntry(
  _agentId: string,
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
    cliSessionIds: coerceCliSessionIds(entry?.cliSessionIds),
    cliSessionId: coerceNonEmptyString(entry?.cliSessionId),
    claudeCliSessionId: coerceNonEmptyString(entry?.claudeCliSessionId),
  };
}

function coerceCliSessionIds(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([provider, sessionId]) => [provider.trim().toLowerCase(), coerceNonEmptyString(sessionId)] as const)
    .filter((entry): entry is readonly [string, string] => Boolean(entry[0] && entry[1]));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

async function shouldPruneDanglingSessionEntry(
  fsP: typeof import('node:fs/promises'),
  session: LocalSessionIndexEntry,
): Promise<boolean> {
  if (await shouldPruneEmptyTranscriptSessionEntry(fsP, session)) {
    return true;
  }

  if (session.key.endsWith(':main')) {
    return false;
  }

  if (shouldPreserveNativeCliSession(session)) {
    return false;
  }

  const hasMeaningfulTitle = [
    session.label,
    session.displayName,
  ].some((candidate) => isMeaningfulSessionTitle(candidate, session.key));
  if (hasMeaningfulTitle) {
    return false;
  }

  const sessionTail = getSessionKeyTail(session.key);
  if (!isGeneratedSessionIdentifier(sessionTail)) {
    return false;
  }

  const updatedAt = session.updatedAt ?? 0;
  if (!updatedAt || Date.now() - updatedAt < DANGLING_SESSION_PRUNE_AGE_MS) {
    return false;
  }

  if (!session.sessionFile) {
    return true;
  }

  try {
    await fsP.access(session.sessionFile);
    const transcriptMeta = await readTranscriptSidebarMeta(fsP, session.sessionFile);
    return (transcriptMeta?.visibleMessageCount ?? 0) <= 0;
  } catch {
    return true;
  }
}

async function pruneDanglingSessionsJson(
  fsP: typeof import('node:fs/promises'),
  agentId: string,
  sessionsDir: string,
  json: Record<string, unknown>,
): Promise<{ nextJson: Record<string, unknown>; removed: number }> {
  if (Array.isArray(json.sessions)) {
    const kept: Array<Record<string, unknown>> = [];
    let removed = 0;
    for (const item of json.sessions as Array<Record<string, unknown>>) {
      const sessionKey = coerceNonEmptyString(item.key) ?? coerceNonEmptyString(item.sessionKey);
      if (!sessionKey) {
        kept.push(item);
        continue;
      }
      const normalized = resolveLocalSessionEntry(agentId, sessionKey, item, sessionsDir);
      if (normalized && await shouldPruneDanglingSessionEntry(fsP, normalized)) {
        removed += 1;
        continue;
      }
      kept.push(item);
    }
    return {
      nextJson: { ...json, sessions: kept },
      removed,
    };
  }

  const nextJson: Record<string, unknown> = {};
  let removed = 0;
  for (const [sessionKey, value] of Object.entries(json)) {
    const normalized = resolveLocalSessionEntry(agentId, sessionKey, value, sessionsDir);
    if (normalized && await shouldPruneDanglingSessionEntry(fsP, normalized)) {
      removed += 1;
      continue;
    }
    nextJson[sessionKey] = value;
  }

  return { nextJson, removed };
}

async function pruneEmptySessionEntries(): Promise<PruneEmptySessionsResult> {
  const fsP = await import('node:fs/promises');
  const agentsDir = join(getOpenClawConfigDir(), 'agents');
  const failed: string[] = [];
  let scanned = 0;
  let removed = 0;

  let agentEntries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    agentEntries = (await fsP.readdir(agentsDir, { withFileTypes: true })) as Array<{ name: string; isDirectory(): boolean }>;
  } catch {
    return { scanned, removed, failed };
  }

  for (const entry of agentEntries) {
    if (!entry.isDirectory()) continue;

    const sessionsDir = join(agentsDir, entry.name, 'sessions');
    const sessionsJsonPath = join(sessionsDir, 'sessions.json');
    scanned += 1;

    try {
      const raw = stripUtf8Bom(await fsP.readFile(sessionsJsonPath, 'utf8'));
      const json = JSON.parse(raw) as Record<string, unknown>;
      const nextJson: Record<string, unknown> = Array.isArray(json.sessions) ? { ...json, sessions: [] } : {};
      let localRemoved = 0;

      if (Array.isArray(json.sessions)) {
        const kept: Array<Record<string, unknown>> = [];
        for (const item of json.sessions as Array<Record<string, unknown>>) {
          const sessionKey = coerceNonEmptyString(item.key) ?? coerceNonEmptyString(item.sessionKey);
          if (!sessionKey) {
            kept.push(item);
            continue;
          }
          const normalized = resolveLocalSessionEntry(entry.name, sessionKey, item, sessionsDir);
          if (normalized && await shouldPruneEmptyTranscriptSessionEntry(fsP, normalized)) {
            localRemoved += 1;
            continue;
          }
          kept.push(item);
        }
        nextJson.sessions = kept;
      } else {
        for (const [sessionKey, value] of Object.entries(json)) {
          const normalized = resolveLocalSessionEntry(entry.name, sessionKey, value, sessionsDir);
          if (normalized && await shouldPruneEmptyTranscriptSessionEntry(fsP, normalized)) {
            localRemoved += 1;
            continue;
          }
          nextJson[sessionKey] = value;
        }
      }

      if (localRemoved > 0) {
        await fsP.writeFile(sessionsJsonPath, JSON.stringify(nextJson, null, 2), 'utf8');
        removed += localRemoved;
      }
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        continue;
      }
      failed.push(sessionsJsonPath);
    }
  }

  return { scanned, removed, failed };
}

async function listLocalSessionIndexes(): Promise<LocalSessionIndexEntry[]> {
  const fsP = await import('node:fs/promises');
  const agentsDir = join(getOpenClawConfigDir(), 'agents');
  const sessions: LocalSessionIndexEntry[] = [];

  let agentEntries: Array<{ name: string; isDirectory(): boolean }>;
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

  for (const session of sessions) {
    if (!session.sessionFile) continue;

    const shouldPreferTranscriptTitle = !session.key.endsWith(':main');
    const needsTitle = shouldPreferTranscriptTitle
      || !isMeaningfulSessionTitle(session.displayName ?? session.label, session.key);
    const needsTimestamp = !session.updatedAt;
    if (!needsTitle && !needsTimestamp) continue;

    const transcriptMeta = await readTranscriptSidebarMeta(fsP, session.sessionFile);
    if (!transcriptMeta) continue;

    const titleText = transcriptMeta.firstVisibleUserText;
    if (titleText && shouldPreferTranscriptTitle) {
      const compactTitle = titleText.replace(/\s+/g, ' ').trim();
      session.displayName = compactTitle.length > 50 ? `${compactTitle.slice(0, 50)}...` : compactTitle;
    } else if (needsTitle && titleText) {
      const compactTitle = titleText.replace(/\s+/g, ' ').trim();
      session.displayName = compactTitle.length > 50 ? `${compactTitle.slice(0, 50)}...` : compactTitle;
    }
    if (needsTimestamp && transcriptMeta.lastTimestamp) {
      session.updatedAt = transcriptMeta.lastTimestamp;
    }
  }

  const visibleSessions: LocalSessionIndexEntry[] = [];
  for (const session of sessions) {
    if (session.sessionFile && session.sessionFile.endsWith('.deleted.jsonl')) {
      continue;
    }
    if (await shouldPruneDanglingSessionEntry(fsP, session)) {
      continue;
    }
    visibleSessions.push(session);
  }

  return visibleSessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
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

  if (url.pathname === '/api/sessions/native-cli-session' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        sessionKey?: string;
        cliSessionId?: string;
        provider?: string;
        label?: string;
      }>(req);
      const sessionKey = body.sessionKey?.trim() || '';
      const cliSessionId = body.cliSessionId?.trim() || '';
      const label = body.label?.trim() || '';
      if (!parseAgentIdFromSessionKey(sessionKey)) {
        sendJson(res, 400, { success: false, error: 'sessionKey is required' });
        return true;
      }

      await persistNativeCliSessionIndex({ sessionKey, cliSessionId, provider: body.provider, label });
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/sessions/native-cli-resolve' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        sessionKey?: string;
        provider?: string;
        userText?: string;
        startedAt?: number;
      }>(req);
      const sessionKey = body.sessionKey?.trim() || '';
      const agentId = parseAgentIdFromSessionKey(sessionKey);
      const userText = body.userText?.trim() || '';
      if (!agentId || !userText) {
        sendJson(res, 400, { success: false, error: 'sessionKey and userText are required' });
        return true;
      }
      const resolved = await resolveNativeCliSessionFromFiles({
        agentId,
        provider: body.provider,
        userText,
        startedAt: body.startedAt,
      });
      if (!resolved?.sessionId) {
        sendJson(res, 200, { success: true, resolved: false });
        return true;
      }
      await persistNativeCliSessionIndex({
        sessionKey,
        provider: body.provider,
        cliSessionId: resolved.sessionId,
      });
      sendJson(res, 200, {
        success: true,
        resolved: true,
        sessionId: resolved.sessionId,
        sessionFile: resolved.sessionFile,
      });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
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

  if (url.pathname === '/api/sessions/prune-empty' && req.method === 'POST') {
    try {
      const result = await pruneEmptySessionEntries();
      sendJson(res, 200, { success: true, ...result });
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
      let raw: string;
      try {
        raw = await fsP.readFile(sessionsJsonPath, 'utf8');
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
          sendJson(res, 200, { success: true, deleted: false, alreadyDeleted: true });
          return true;
        }
        throw error;
      }
      const sessionsJson = JSON.parse(raw) as Record<string, unknown>;

      let uuidFileName: string | undefined;
      let resolvedSrcPath: string | undefined;
      let hasIndexEntry = false;
      if (Array.isArray(sessionsJson.sessions)) {
        const entry = (sessionsJson.sessions as Array<Record<string, unknown>>)
          .find((s) => s.key === sessionKey || s.sessionKey === sessionKey);
        if (entry) {
          hasIndexEntry = true;
          uuidFileName = (entry.file ?? entry.fileName ?? entry.path) as string | undefined;
          if (!uuidFileName && typeof entry.id === 'string') {
            uuidFileName = `${entry.id}.jsonl`;
          }
        }
      }
      if (!uuidFileName && sessionsJson[sessionKey] != null) {
        hasIndexEntry = true;
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
        if (!hasIndexEntry) {
          sendJson(res, 200, { success: true, deleted: false, alreadyDeleted: true });
          return true;
        }
      } else if (!resolvedSrcPath) {
        if (!uuidFileName!.endsWith('.jsonl')) uuidFileName = `${uuidFileName}.jsonl`;
        resolvedSrcPath = join(sessionsDir, uuidFileName!);
      }
      let transcriptDeleted = false;
      if (resolvedSrcPath) {
        const dstPath = resolvedSrcPath.replace(/\.jsonl$/, '.deleted.jsonl');
        try {
          await fsP.access(resolvedSrcPath);
          await fsP.rename(resolvedSrcPath, dstPath);
          transcriptDeleted = true;
        } catch {
          // Non-fatal; still try to update sessions.json.
        }
      }
      const raw2 = await fsP.readFile(sessionsJsonPath, 'utf8');
      const json2 = JSON.parse(raw2) as Record<string, unknown>;
      let indexDeleted = false;
      if (Array.isArray(json2.sessions)) {
        const before = json2.sessions.length;
        const nextSessions = (json2.sessions as Array<Record<string, unknown>>)
          .filter((s) => s.key !== sessionKey && s.sessionKey !== sessionKey);
        json2.sessions = nextSessions;
        indexDeleted = nextSessions.length !== before;
      } else if (json2[sessionKey]) {
        delete json2[sessionKey];
        indexDeleted = true;
      }
      if (indexDeleted) {
        await fsP.writeFile(sessionsJsonPath, JSON.stringify(json2, null, 2), 'utf8');
      }
      sendJson(res, 200, {
        success: true,
        deleted: transcriptDeleted || indexDeleted,
        transcriptDeleted,
        indexDeleted,
      });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
