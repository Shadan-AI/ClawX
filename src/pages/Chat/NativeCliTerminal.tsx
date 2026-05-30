import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import {
  Loader2,
} from 'lucide-react';
import { invokeIpc } from '@/lib/api-client';
import { hostApiFetch } from '@/lib/host-api';
import { useAgentsStore } from '@/stores/agents';
import { useChatStore } from '@/stores/chat';
import {
  enrichWithCachedImages,
  enrichWithToolResultFiles,
  getMessageText,
  isToolResultRole,
  loadMissingPreviews,
} from '@/stores/chat/helpers';
import { useModelsStore } from '@/stores/models';
import {
  initialNativeCliTerminalState,
  nativeCliTerminalCanSend,
  nativeCliTerminalLoadingLabel,
  nativeCliTerminalReducer,
} from '@/lib/native-cli-terminal-state';
import { addNativeCliAgentSkillsChangedListener } from '@/lib/native-cli-events';
import { ChatInput } from './ChatInput';
import { ChatMessage } from './ChatMessage';
import { extractText, extractThinking } from './message-utils';
import type { RawMessage } from '@/stores/chat';
import '@xterm/xterm/css/xterm.css';

interface NativeCliTerminalProps {
  agentId: string;
  sessionKey: string;
  cliSessionId?: string;
  cliSessionProvider?: string;
  sessionTitle?: string;
  sessionUpdatedAt?: number;
  onUserText?: (text: string) => void;
}

interface GatewayStatus {
  port: number;
  state: string;
  tls?: boolean;
}

type InputShellState = 'collapsed' | 'auto' | 'focused';

type TerminalStreamMarker =
  | { kind: 'turn_start'; conversationId: string; turnId: string; userText: string }
  | { kind: 'turn_idle'; conversationId: string; turnId: string }
  | { kind: 'turn_end'; conversationId: string; turnId: string };

type TerminalTurn = {
  id: string;
  conversationId: string;
  userText: string;
  state: 'active' | 'idle' | 'closed';
  startedAt: number;
};

type NativeCliTranscriptResponse = {
  success: boolean;
  resolved?: boolean;
  sessionId?: string;
  messages?: RawMessage[];
};

type NativeClaudeLiveSnapshot = {
  routeModel?: string;
  sessionKey?: string;
  turnId?: string;
  status?: 'running' | 'completed' | 'error';
  content?: unknown[];
  text?: string;
  thinking?: string;
};

type NativeClaudeLiveTurn = {
  turnId: string;
  register: Promise<void>;
};

type PersistedNativeCliSession = {
  key: string;
  cliSessionId?: string;
  provider?: string;
};

type PersistedTerminalState = {
  buffer?: string;
  userHasInteracted?: boolean;
  cliSessionId?: string;
};

type HostNativeCliResolveResponse = {
  success: boolean;
  resolved?: boolean;
  sessionId?: string;
};

const NATIVE_CLI_SESSIONS_KEY = 'openclaw-native-cli-sessions';
const RUNTIME_NATIVE_CLI_SESSION_PATH = '/api/runtime/sessions/native-cli';
const RUNTIME_NATIVE_CLI_RESOLVE_PATH = '/api/runtime/sessions/native-cli/resolve';
const RUNTIME_NATIVE_CLI_TRANSCRIPT_PATH = '/api/runtime/sessions/native-cli/transcript';
const TERMINAL_STREAM_MARKER_PREFIX = '\x1b]777;OPENCLAW;';
const TERMINAL_STREAM_MARKER_SUFFIX = '\x07';
const TERMINAL_STREAM_OSC_PREFIX = 'OPENCLAW;';
const TERMINAL_SHELL_PASSTHROUGH_BUFFER_CHARS = 12_000;
const TERMINAL_SHELL_PASSTHROUGH_SIGNATURES = [
  '? for shortcuts',
  'Aider',
  'Claude Code',
  'Codex',
  'Cursor Agent',
  'Gemini',
  'Goose',
  'MCP server',
  'OpenClaw',
  'Ask anything',
  'Plan, search, build',
  'Qwen',
  'esc to interrupt',
  'cursor-agent@',
  'opencode',
];
const TERMINAL_SHELL_PASSTHROUGH_COMMANDS = new Set([
  'agent',
  'aider',
  'claude',
  'claude-code',
  'codex',
  'cursor-agent',
  'gemini',
  'goose',
  'openclaw',
  'opencode',
  'qwen',
]);
const TERMINAL_SHELL_PASSTHROUGH_WRAPPERS = new Set(['bun', 'bunx', 'corepack', 'npx', 'npm', 'pnpm', 'uvx', 'yarn']);
const TERMINAL_SHELL_PASSTHROUGH_WRAPPER_SUBCOMMANDS = new Set(['dlx', 'exec', 'run', 'x']);
const TERMINAL_MIN_COLS = 40;
const TERMINAL_MAX_REASONABLE_CELL_WIDTH = 32;
const TRANSCRIPT_ACTIVE_POLL_MS = 900;
const TRANSCRIPT_IDLE_POLL_RETENTION_MS = 120_000;
const PENDING_LOCAL_USER_TTL_MS = 120_000;
const TERMINAL_STATUS_BUFFER_CHARS = 2400;
const TERMINAL_STATUS_MAX_CHARS = 480;
const CLAUDE_TERMINAL_LOADING_SENTINEL = '__openclaw_terminal_loading__';
const TERMINAL_ESCAPE = String.fromCharCode(27);
const TERMINAL_BELL = String.fromCharCode(7);
const TERMINAL_OSC_PATTERN = new RegExp(`${TERMINAL_ESCAPE}\\][^${TERMINAL_BELL}]*(?:${TERMINAL_BELL}|${TERMINAL_ESCAPE}\\\\)`, 'g');
const TERMINAL_STREAM_MARKER_PATTERN = new RegExp(`${TERMINAL_ESCAPE}\\]777;OPENCLAW;[^${TERMINAL_BELL}${TERMINAL_ESCAPE}]*(?:${TERMINAL_BELL}|${TERMINAL_ESCAPE}\\\\)`, 'g');
const TERMINAL_CSI_PATTERN = new RegExp(`${TERMINAL_ESCAPE}\\[[0-?]*[ -/]*[@-~]`, 'g');
const TERMINAL_CHARSET_PATTERN = new RegExp(`${TERMINAL_ESCAPE}[()][A-Za-z0-9]`, 'g');
const NATIVE_CLI_SESSION_KEY_PATTERN = /^agent:[^:]+:cli:/i;
const CLAUDE_NATIVE_PROXY_PORT = 13211;
const CLAUDE_NATIVE_SONNET_ALIAS = 'claude-sonnet-4-6';
const CLAUDE_NATIVE_OPUS_ALIAS = 'claude-opus-4-7';
const CLAUDE_NATIVE_HAIKU_ALIAS = 'claude-haiku-4-5';

function messageDiagnostic(text: string) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return {
    length: text.length,
    hash: (hash >>> 0).toString(16).padStart(8, '0'),
  };
}

function claudeLiveContentSignature(snapshot: NativeClaudeLiveSnapshot): string {
  const content = Array.isArray(snapshot.content) ? snapshot.content : [];
  const blockSummary = content.map((block) => {
    if (!block || typeof block !== 'object') return 'unknown';
    const record = block as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type : 'unknown';
    const name = typeof record.name === 'string' ? record.name : '';
    const text = typeof record.text === 'string' ? record.text : '';
    const thinking = typeof record.thinking === 'string' ? record.thinking : '';
    const input = record.input == null ? '' : JSON.stringify(record.input);
    return JSON.stringify({ type, name, text, thinking, input });
  }).join(',');
  return [
    snapshot.status ?? '',
    typeof snapshot.text === 'string' ? snapshot.text : '',
    typeof snapshot.thinking === 'string' ? snapshot.thinking : '',
    blockSummary,
  ].join('|');
}

function claudeLiveContentDebug(snapshot: NativeClaudeLiveSnapshot) {
  const content = Array.isArray(snapshot.content) ? snapshot.content : [];
  return content.map((block) => {
    if (!block || typeof block !== 'object') return { type: 'unknown' };
    const record = block as Record<string, unknown>;
    return {
      type: typeof record.type === 'string' ? record.type : 'unknown',
      name: typeof record.name === 'string' ? record.name : undefined,
      textLength: typeof record.text === 'string' ? record.text.length : 0,
      thinkingLength: typeof record.thinking === 'string' ? record.thinking.length : 0,
      inputLength: record.input == null ? 0 : JSON.stringify(record.input).length,
    };
  });
}

function dataDiagnostic(data: string) {
  let hash = 2166136261;
  for (let index = 0; index < data.length; index += 1) {
    hash ^= data.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return {
    length: data.length,
    hash: (hash >>> 0).toString(16).padStart(8, '0'),
  };
}

function wsReadyStateName(state: number | undefined) {
  switch (state) {
    case WebSocket.CONNECTING:
      return 'CONNECTING';
    case WebSocket.OPEN:
      return 'OPEN';
    case WebSocket.CLOSING:
      return 'CLOSING';
    case WebSocket.CLOSED:
      return 'CLOSED';
    default:
      return 'MISSING';
  }
}

function storageKey(sessionKey: string) {
  return `openclaw-terminal-state:native-cli:${sessionKey}`;
}

function isNativeCliSessionKey(sessionKey: string) {
  return NATIVE_CLI_SESSION_KEY_PATTERN.test(sessionKey);
}

function hasPrintableTerminalContent(data: string) {
  const printable = data
    .replace(TERMINAL_OSC_PATTERN, '')
    .replace(TERMINAL_CSI_PATTERN, '')
    .replace(TERMINAL_CHARSET_PATTERN, '')
    .split('')
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join('')
    .trim();
  return printable.length > 0;
}

function terminalStatusText(data: string, activeUserText?: string): string {
  const normalizedUserText = normalizeTerminalLineText(activeUserText ?? '');
  const plain = data
    .replace(TERMINAL_STREAM_MARKER_PATTERN, '')
    .replace(TERMINAL_OSC_PATTERN, '')
    .replace(TERMINAL_CSI_PATTERN, '')
    .replace(TERMINAL_CHARSET_PATTERN, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => {
      if (!line) return false;
      const normalizedLine = normalizeTerminalLineText(line);
      if (normalizedUserText && normalizedLine === normalizedUserText) return false;
      if (/bypass permissions/i.test(line)) return false;
      if (/shift\s*\+\s*tab/i.test(line)) return false;
      if (/permissions\s+on/i.test(line)) return false;
      if (/esc\s+to\s+interrupt/i.test(line)) return false;
      if (/^[│┌┐└┘─╭╮╰╯═╔╗╚╝┼├┤]+$/.test(line)) return false;
      if (/^\? for shortcuts$/i.test(line)) return false;
      return true;
    })
    .join('\n')
    .trim();
  if (!plain) return '';
  if (plain.length <= TERMINAL_STATUS_MAX_CHARS) return plain;
  return plain.slice(-TERMINAL_STATUS_MAX_CHARS).trimStart();
}

function terminalHasVisibleContent(term: Terminal | null, mount: HTMLElement | null) {
  if (!term || !mount) return false;
  const buffer = term.buffer.active;
  const start = Math.max(0, buffer.viewportY);
  const end = Math.min(buffer.length, start + term.rows);
  for (let lineIndex = start; lineIndex < end; lineIndex += 1) {
    if (buffer.getLine(lineIndex)?.translateToString(true).trim()) return true;
  }
  return Boolean(mount.querySelector<HTMLElement>('.xterm-rows')?.textContent?.trim());
}

function isTerminalNearBottom(term: Terminal | null) {
  if (!term) return true;
  const buffer = term.buffer.active;
  return buffer.baseY - buffer.viewportY <= 1;
}

function normalizeProvider(provider?: string) {
  return provider?.trim().toLowerCase() || undefined;
}

function normalizeOneApiModelId(modelRef: string | null | undefined): string {
  const trimmed = (modelRef || '').trim();
  return trimmed.startsWith('shadan/') ? trimmed.slice('shadan/'.length) : trimmed;
}

function getClaudeProxyBaseUrl(upstreamModel: string): string {
  return `http://127.0.0.1:${CLAUDE_NATIVE_PROXY_PORT}/native-claude/${encodeURIComponent(upstreamModel)}`;
}

function extractClaudeProxyRouteModel(baseUrl: string | undefined): string | undefined {
  const match = baseUrl?.match(/\/native-claude\/([^/]+)(?:\/v1)?\/?$/);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function updateClaudeProxyModel(routeModel: string, upstreamModel: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${CLAUDE_NATIVE_PROXY_PORT}/native-claude/${encodeURIComponent(routeModel)}/__model`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: upstreamModel }),
  });
  if (!response.ok) throw new Error(`Claude proxy model switch failed: ${response.status}`);
}

async function registerClaudeProxyLivePrompt(routeModel: string, params: {
  sessionKey: string;
  turnId: string;
  prompt: string;
}): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${CLAUDE_NATIVE_PROXY_PORT}/native-claude/${encodeURIComponent(routeModel)}/__live-track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!response.ok) throw new Error(`Claude proxy live-track failed: ${response.status}`);
}

function getClaudeProxyLiveStreamUrl(routeModel: string, sessionKey: string, turnId: string): string {
  const params = new URLSearchParams({ sessionKey, turnId });
  return `http://127.0.0.1:${CLAUDE_NATIVE_PROXY_PORT}/native-claude/${encodeURIComponent(routeModel)}/__live-stream?${params.toString()}`;
}

function loadPersistedTerminalState(sessionKey: string): PersistedTerminalState {
  try {
    const raw = sessionStorage.getItem(storageKey(sessionKey));
    return raw ? JSON.parse(raw) as PersistedTerminalState : {};
  } catch {
    return {};
  }
}

function savePersistedTerminalState(sessionKey: string, state: PersistedTerminalState) {
  try {
    sessionStorage.setItem(storageKey(sessionKey), JSON.stringify({
      ...state,
      buffer: state.buffer ? stripTerminalStreamMarkers(state.buffer) : state.buffer,
    }));
  } catch {
    // Ignore quota/storage failures; session resume still works via cliSessionId.
  }
}

function stripTerminalStreamMarkers(buffer: string): string {
  return buffer.replace(TERMINAL_STREAM_MARKER_PATTERN, '');
}

function resolveStoredCliSessionId(sessionKey: string, explicit?: string): string {
  const fromProps = explicit?.trim();
  if (fromProps) return fromProps;
  try {
    const raw = localStorage.getItem(NATIVE_CLI_SESSIONS_KEY);
    const sessions = raw ? JSON.parse(raw) as PersistedNativeCliSession[] : [];
    return sessions.find((entry) => entry.key === sessionKey)?.cliSessionId?.trim() || '';
  } catch {
    return '';
  }
}

function persistNativeCliSessionId(sessionKey: string, cliSessionId: string, provider?: string) {
  const trimmed = cliSessionId.trim();
  if (!trimmed) return;
  try {
    const raw = localStorage.getItem(NATIVE_CLI_SESSIONS_KEY);
    const sessions = raw ? JSON.parse(raw) as PersistedNativeCliSession[] : [];
    const index = sessions.findIndex((entry) => entry.key === sessionKey);
    const nextEntry: PersistedNativeCliSession = {
      key: sessionKey,
      cliSessionId: trimmed,
      provider: normalizeProvider(provider),
    };
    if (index >= 0) {
      sessions[index] = { ...sessions[index], ...nextEntry };
    } else {
      sessions.push(nextEntry);
    }
    localStorage.setItem(NATIVE_CLI_SESSIONS_KEY, JSON.stringify(sessions.slice(-500)));
  } catch {
    // Best effort only; backend also persists cliSessionIds into sessions.json.
  }
}

async function persistNativeCliSessionIdToHost(sessionKey: string, cliSessionId: string, provider?: string) {
  try {
    await hostApiFetch(RUNTIME_NATIVE_CLI_SESSION_PATH, {
      method: 'POST',
      body: JSON.stringify({
        sessionKey,
        cliSessionId,
        provider: normalizeProvider(provider),
      }),
    });
  } catch {
    // LocalStorage is still enough for the current renderer; host persistence is best effort.
  }
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveNativeCliSessionIdToHost(params: {
  sessionKey: string;
  provider?: string;
  userText?: string;
  startedAt?: number;
  latest?: boolean;
}): Promise<string> {
  try {
    const response = await hostApiFetch<HostNativeCliResolveResponse>(RUNTIME_NATIVE_CLI_RESOLVE_PATH, {
      method: 'POST',
      body: JSON.stringify({
        sessionKey: params.sessionKey,
        provider: normalizeProvider(params.provider),
        ...(params.userText ? { userText: params.userText } : {}),
        ...(params.startedAt ? { startedAt: params.startedAt } : {}),
        ...(params.latest ? { latest: true } : {}),
      }),
    });
    return response.success && response.resolved && response.sessionId ? response.sessionId.trim() : '';
  } catch {
    return '';
  }
}

function readThemeColor(cssVariable: string, fallback: string) {
  if (typeof window === 'undefined') return fallback;
  const raw = window.getComputedStyle(document.documentElement).getPropertyValue(cssVariable).trim();
  return raw ? `hsl(${raw})` : fallback;
}

function createTerminalInstance() {
  const background = readThemeColor('--background', '#f1ede1');
  const foreground = readThemeColor('--foreground', '#0f172a');

  return new Terminal({
    cursorBlink: true,
    fontSize: 15,
    lineHeight: 1.35,
    fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace",
    theme: {
      background,
      foreground,
      cursor: '#2563eb',
      selectionBackground: '#dbeafe',
      black: '#0f172a',
      red: '#dc2626',
      green: '#16a34a',
      yellow: '#ca8a04',
      blue: '#2563eb',
      magenta: '#9333ea',
      cyan: '#0891b2',
      white: '#f8fafc',
      brightBlack: '#64748b',
      brightRed: '#ef4444',
      brightGreen: '#22c55e',
      brightYellow: '#eab308',
      brightBlue: '#3b82f6',
      brightMagenta: '#a855f7',
      brightCyan: '#06b6d4',
      brightWhite: '#ffffff',
    },
    scrollback: 5000,
    convertEol: false,
    allowProposedApi: true,
    disableStdin: true,
  });
}

function encodeTerminalStreamMarker(marker: TerminalStreamMarker) {
  const bytes = new TextEncoder().encode(JSON.stringify(marker));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${TERMINAL_STREAM_MARKER_PREFIX}${btoa(binary)}${TERMINAL_STREAM_MARKER_SUFFIX}`;
}

function decodeTerminalStreamMarker(payload: string): TerminalStreamMarker | null {
  try {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<TerminalStreamMarker>;
    if (
      parsed.kind === 'turn_start' &&
      typeof parsed.conversationId === 'string' &&
      typeof parsed.turnId === 'string' &&
      typeof parsed.userText === 'string'
    ) {
      return parsed as TerminalStreamMarker;
    }
    if (
      (parsed.kind === 'turn_idle' || parsed.kind === 'turn_end') &&
      typeof parsed.conversationId === 'string' &&
      typeof parsed.turnId === 'string'
    ) {
      return parsed as TerminalStreamMarker;
    }
  } catch {
    // Malformed private markers are ignored and never rendered.
  }
  return null;
}

function decodeTerminalOscMarker(data: string): TerminalStreamMarker | null {
  if (!data.startsWith(TERMINAL_STREAM_OSC_PREFIX)) return null;
  return decodeTerminalStreamMarker(data.slice(TERMINAL_STREAM_OSC_PREFIX.length));
}

function terminalMarkerPartialSuffixLength(data: string) {
  const max = Math.min(TERMINAL_STREAM_MARKER_PREFIX.length - 1, data.length);
  for (let length = max; length > 0; length -= 1) {
    if (TERMINAL_STREAM_MARKER_PREFIX.startsWith(data.slice(-length))) return length;
  }
  return 0;
}

function normalizeTerminalLineText(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

function nativeCliMessageKey(message: RawMessage, index: number): string {
  return `${message.role}|${message.id ?? ''}|${message.timestamp ?? ''}|${extractText(message)}|${index}`;
}

function nativeCliAttachmentSignature(message: RawMessage): string {
  return (message._attachedFiles || [])
    .map((file) => [
      file.filePath ?? '',
      file.fileName,
      file.mimeType,
      file.fileSize,
      file.preview ? 'preview' : 'no-preview',
      file.source ?? '',
    ].join(':'))
    .join('|');
}

function nativeCliPreviewMergeKey(message: RawMessage): string {
  return `${message.id ?? ''}|${message.role}|${message.timestamp ?? ''}|${getMessageText(message.content)}`;
}

function mergeNativeCliHydratedMessages(
  currentMessages: RawMessage[],
  hydratedMessages: RawMessage[],
): RawMessage[] {
  const hydratedFilesByKey = new Map(
    hydratedMessages
      .filter((message) => message._attachedFiles?.length)
      .map((message) => [
        nativeCliPreviewMergeKey(message),
        message._attachedFiles!.map((file) => ({ ...file })),
      ]),
  );

  return currentMessages.map((message) => {
    const attachedFiles = hydratedFilesByKey.get(nativeCliPreviewMergeKey(message));
    return attachedFiles
      ? { ...message, _attachedFiles: attachedFiles }
      : message;
  });
}

function nativeCliMessageTimestampMs(message: RawMessage): number {
  const timestamp = message.timestamp;
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) return timestamp;
  if (typeof timestamp === 'string') {
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function nativeCliMessagesEqual(a: RawMessage[], b: RawMessage[]) {
  if (a.length !== b.length) return false;
  return a.every((message, index) => (
    nativeCliMessageKey(message, index) === nativeCliMessageKey(b[index], index) &&
    nativeCliAttachmentSignature(message) === nativeCliAttachmentSignature(b[index])
  ));
}

function findLastNativeCliUserIndex(messages: RawMessage[], userText: string): number {
  const normalizedUserText = normalizeTerminalLineText(userText);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user' && normalizeTerminalLineText(extractText(message)) === normalizedUserText) {
      return index;
    }
  }
  return -1;
}

function nativeCliLiveTurnId(message: RawMessage | null): string {
  const id = typeof message?.id === 'string' ? message.id : '';
  return id.startsWith('live-') ? id.slice(5) : '';
}

function isLiveAssistantMessage(message: RawMessage, liveMessage: RawMessage | null): boolean {
  return Boolean(liveMessage?.id && message.id && liveMessage.id === message.id);
}

function nativeCliMessageVisibleText(message: RawMessage): string {
  return normalizeTerminalLineText(extractText(message));
}

function nativeCliMessageVisibleThinking(message: RawMessage): string {
  return normalizeTerminalLineText(extractThinking(message) ?? '');
}

function nativeCliMessagesHaveSharedContent(a: RawMessage, b: RawMessage): boolean {
  const aText = nativeCliMessageVisibleText(a);
  const bText = nativeCliMessageVisibleText(b);
  const aThinking = nativeCliMessageVisibleThinking(a);
  const bThinking = nativeCliMessageVisibleThinking(b);
  const textMatches = Boolean(aText && bText && (
    aText === bText ||
    (
      aText.length >= 80 &&
      bText.length >= 80 &&
      (
        aText.includes(bText.slice(0, 160)) ||
        bText.includes(aText.slice(0, 160))
      )
    )
  ));
  const thinkingMatches = Boolean(aThinking && bThinking && (
    aThinking === bThinking ||
    (
      aThinking.length >= 80 &&
      bThinking.length >= 80 &&
      (
        aThinking.includes(bThinking.slice(0, 160)) ||
        bThinking.includes(aThinking.slice(0, 160))
      )
    )
  ));
  return textMatches || thinkingMatches;
}

function transcriptContainsLiveAssistant(transcriptMessages: RawMessage[], liveMessage: RawMessage | null): boolean {
  if (!liveMessage) return false;
  const liveText = nativeCliMessageVisibleText(liveMessage);
  const liveThinking = nativeCliMessageVisibleThinking(liveMessage);
  if (!liveText && !liveThinking) return false;
  return transcriptMessages.some((message) => {
    if (message.role !== 'assistant') return false;
    return nativeCliMessagesHaveSharedContent(message, liveMessage);
  });
}

function transcriptContainsLiveAssistantForTurn(
  transcriptMessages: RawMessage[],
  liveMessage: RawMessage | null,
  liveTurn: TerminalTurn | undefined,
): boolean {
  if (!liveTurn) return false;
  let turnUserIndex = -1;
  for (let index = transcriptMessages.length - 1; index >= 0; index -= 1) {
    const message = transcriptMessages[index];
    if (message.role !== 'user') continue;
    if (normalizeTerminalLineText(extractText(message)) !== normalizeTerminalLineText(liveTurn.userText)) continue;
    const timestamp = nativeCliMessageTimestampMs(message);
    if (timestamp && timestamp < liveTurn.startedAt - 10_000) continue;
    turnUserIndex = index;
    break;
  }
  const candidateMessages = turnUserIndex >= 0
    ? transcriptMessages.slice(turnUserIndex + 1)
    : transcriptMessages.filter((message) => {
      const timestamp = nativeCliMessageTimestampMs(message);
      return timestamp && timestamp >= liveTurn.startedAt - 10_000;
    });
  return transcriptContainsLiveAssistant(candidateMessages, liveMessage);
}

function findNativeCliTranscriptUserForTurn(
  transcriptMessages: RawMessage[],
  liveTurn: TerminalTurn | undefined,
): RawMessage | null {
  if (!liveTurn) return null;
  for (let index = transcriptMessages.length - 1; index >= 0; index -= 1) {
    const message = transcriptMessages[index];
    if (message.role !== 'user') continue;
    const id = typeof message.id === 'string' ? message.id : '';
    if (id.startsWith('local-')) continue;
    if (normalizeTerminalLineText(extractText(message)) !== normalizeTerminalLineText(liveTurn.userText)) continue;
    const timestamp = nativeCliMessageTimestampMs(message);
    if (timestamp && timestamp < liveTurn.startedAt - 10_000) continue;
    return message;
  }
  return null;
}

function reconcilePendingLocalUserMessages(
  pendingMessages: RawMessage[],
  visibleMessages: RawMessage[],
  activeTurnId: string | null,
): RawMessage[] {
  const consumedTranscriptUserIndexes = new Set<number>();
  const now = Date.now();
  return pendingMessages.filter((pending) => {
    const pendingId = typeof pending.id === 'string' ? pending.id : '';
    if (!pendingId.startsWith('local-')) return false;
    const pendingText = normalizeTerminalLineText(extractText(pending));
    const pendingAt = nativeCliMessageTimestampMs(pending);
    if (!pendingText) return false;
    if (!pendingAt || now - pendingAt > PENDING_LOCAL_USER_TTL_MS) return false;
    const matchIndex = visibleMessages.findIndex((candidate, index) => {
      if (consumedTranscriptUserIndexes.has(index)) return false;
      if (candidate.role !== 'user') return false;
      if (normalizeTerminalLineText(extractText(candidate)) !== pendingText) return false;
      const candidateAt = nativeCliMessageTimestampMs(candidate);
      return Boolean(pendingAt && candidateAt && candidateAt >= pendingAt - 2_000 && candidateAt <= pendingAt + 120_000);
    });
    if (matchIndex >= 0) {
      consumedTranscriptUserIndexes.add(matchIndex);
      return false;
    }
    if (activeTurnId && pendingId === activeTurnId) return true;
    if (!activeTurnId) return false;
    return true;
  });
}

function nativeCliContentBlocks(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : [];
  return content == null ? [] : [content];
}

function nativeCliContentBlockSignature(block: unknown): string {
  if (block == null) return 'null';
  if (typeof block !== 'object') return `${typeof block}:${String(block)}`;
  try {
    return JSON.stringify(block);
  } catch {
    return Object.prototype.toString.call(block);
  }
}

function mergeNativeCliAssistantMessages(previous: RawMessage, next: RawMessage): RawMessage {
  const seen = new Set<string>();
  const content: unknown[] = [];
  for (const block of [
    ...nativeCliContentBlocks(previous.content),
    ...nativeCliContentBlocks(next.content),
  ]) {
    const signature = nativeCliContentBlockSignature(block);
    if (seen.has(signature)) continue;
    seen.add(signature);
    content.push(block);
  }
  return {
    ...previous,
    ...next,
    id: previous.id ?? next.id,
    role: 'assistant',
    timestamp: previous.timestamp ?? next.timestamp,
    content,
  };
}

function mergeNativeCliAssistantFragments(messages: RawMessage[]): RawMessage[] {
  const result: RawMessage[] = [];
  const assistantIndexById = new Map<string, number>();
  for (const message of messages) {
    const id = typeof message.id === 'string' ? message.id : '';
    if (message.role === 'assistant' && id) {
      const existingIndex = assistantIndexById.get(id);
      if (existingIndex !== undefined) {
        result[existingIndex] = mergeNativeCliAssistantMessages(result[existingIndex], message);
        continue;
      }
      assistantIndexById.set(id, result.length);
    }
    result.push(message);
  }
  return result;
}

function nativeCliMessageSignature(message: RawMessage): string {
  const text = normalizeTerminalLineText(extractText(message));
  const content = JSON.stringify(message.content ?? '');
  const id = typeof message.id === 'string' ? message.id : '';
  if (id) return `${message.role}|id:${id}`;
  const timestamp = typeof message.timestamp === 'number' || typeof message.timestamp === 'string'
    ? String(message.timestamp)
    : '';
  if (timestamp) return `${message.role}|time:${timestamp}|${text || content}`;
  return [
    message.role,
    text || content,
  ].join('|');
}

function dedupeNativeCliMessages(messages: RawMessage[]): RawMessage[] {
  const seen = new Set<string>();
  const result: RawMessage[] = [];
  for (const message of messages) {
    const signature = nativeCliMessageSignature(message);
    if (seen.has(signature)) continue;
    seen.add(signature);
    result.push(message);
  }
  return result;
}

function visibleNativeCliMessages(messages: RawMessage[]) {
  return messages.filter((message) => {
    const text = extractText(message).trim();
    if ((message.role === 'system' || message.role === 'assistant' || message.role === 'user')) {
      if (/^(HEARTBEAT_OK|NO_REPLY)\s*$/.test(text)) return false;
      if (text.startsWith('Read HEARTBEAT.md if it exists (workspace context).')) return false;
    }
    return true;
  });
}

function enrichNativeCliTranscriptMessages(messages: RawMessage[]): RawMessage[] {
  const messagesWithToolFiles = enrichWithToolResultFiles(messages);
  const visibleMessages = visibleNativeCliMessages(messagesWithToolFiles)
    .filter((message) => !isToolResultRole(message.role));
  const mergedMessages = dedupeNativeCliMessages(mergeNativeCliAssistantFragments(visibleMessages));
  return enrichWithCachedImages(mergedMessages);
}

function enrichNativeCliLiveMessage(message: RawMessage): RawMessage {
  return enrichWithCachedImages([message])[0] ?? message;
}

function sanitizeClaudeLiveContent(content: unknown[] | undefined, text: string, thinking: string): unknown {
  const blocks = Array.isArray(content)
    ? content.filter((block) => block && typeof block === 'object')
    : [];
  if (blocks.length > 0) {
    const hasText = blocks.some((block) => (
      typeof (block as Record<string, unknown>).text === 'string' &&
      ((block as Record<string, unknown>).text as string).trim()
    ));
    const hasThinking = blocks.some((block) => (
      typeof (block as Record<string, unknown>).thinking === 'string' &&
      ((block as Record<string, unknown>).thinking as string).trim()
    ));
    const normalizedBlocks = [...blocks];
    if (thinking.trim() && !hasThinking) normalizedBlocks.unshift({ type: 'thinking', thinking });
    if (text.trim() && !hasText) normalizedBlocks.push({ type: 'text', text });
    return normalizedBlocks;
  }
  const fallbackBlocks: Array<Record<string, string>> = [];
  if (thinking.trim()) fallbackBlocks.push({ type: 'thinking', thinking });
  if (text.trim()) fallbackBlocks.push({ type: 'text', text });
  return fallbackBlocks.length > 0 ? fallbackBlocks : '';
}

function claudeLiveSnapshotHasVisibleContent(snapshot: NativeClaudeLiveSnapshot): boolean {
  const text = typeof snapshot.text === 'string' ? snapshot.text.trim() : '';
  const thinking = typeof snapshot.thinking === 'string' ? snapshot.thinking.trim() : '';
  const blocks = Array.isArray(snapshot.content) ? snapshot.content : [];
  return Boolean(text || thinking || blocks.some((block) => {
    if (!block || typeof block !== 'object') return false;
    const record = block as Record<string, unknown>;
    return record.type === 'tool_use'
      || (typeof record.text === 'string' && record.text.trim())
      || (typeof record.thinking === 'string' && record.thinking.trim());
  }));
}

function claudeLiveSnapshotToMessage(snapshot: NativeClaudeLiveSnapshot): RawMessage {
  const text = typeof snapshot.text === 'string' ? snapshot.text : '';
  const thinking = typeof snapshot.thinking === 'string' ? snapshot.thinking : '';
  const hasToolUse = Array.isArray(snapshot.content) && snapshot.content.some((block) => (
    block && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_use'
  ));
  return {
    id: `live-${snapshot.turnId || Date.now().toString(36)}`,
    role: 'assistant',
    content: sanitizeClaudeLiveContent(snapshot.content, text, thinking),
    timestamp: Date.now(),
    ...(hasToolUse && snapshot.status === 'running' ? {
      details: {
        streamingTools: true,
      },
    } : {}),
  };
}

function claudeTerminalLoadingMessage(turnId: string): RawMessage {
  return {
    id: `live-${turnId}`,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    details: { terminalLoading: true },
  };
}

function normalizeShellCommandToken(token: string) {
  const unquoted = token.replace(/^['"]|['"]$/g, '');
  return (unquoted.split(/[\\/]/).pop() || unquoted).toLowerCase();
}

function shellPassthroughCommandFromText(text: string) {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? '')) index += 1;
  const command = normalizeShellCommandToken(tokens[index] ?? '');
  if (!command) return '';
  if (!TERMINAL_SHELL_PASSTHROUGH_WRAPPERS.has(command)) return command;

  index += 1;
  while (index < tokens.length) {
    const normalized = normalizeShellCommandToken(tokens[index] ?? '');
    if (!normalized || normalized.startsWith('-') || TERMINAL_SHELL_PASSTHROUGH_WRAPPER_SUBCOMMANDS.has(normalized)) {
      index += 1;
      continue;
    }
    return normalized;
  }
  return command;
}

function shouldLaunchShellPassthrough(text: string) {
  return TERMINAL_SHELL_PASSTHROUGH_COMMANDS.has(shellPassthroughCommandFromText(text));
}

function shellComposeToPtyInput(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '');
  if (!normalized.includes('\n')) return [normalized, '\r'];
  const lines = normalized.split('\n');
  const payloads: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    payloads.push(lines[index]);
    payloads.push(index < lines.length - 1 ? '\n' : '\r');
  }
  return payloads;
}

function claudePromptToPtyInput(text: string): string[] {
  return shellComposeToPtyInput(text);
}

function NativeCliTerminalStyles() {
  return (
    <style>{`
      .native-cli-terminal {
        --terminal-content-width: 960px;
        --terminal-screen-width: min(var(--terminal-content-width), calc(100% - 48px));
        --native-cli-background: hsl(var(--background));
        --native-cli-foreground: hsl(var(--foreground));
        --native-cli-card: hsl(var(--card));
        position: relative;
        display: block;
        height: 100%;
        min-height: 0;
        overflow: hidden;
        background: var(--native-cli-background);
        color: var(--native-cli-foreground);
      }
      .native-cli-terminal__area {
        --terminal-content-inset: max(24px, calc((100% - var(--terminal-screen-width)) / 2));
        position: absolute;
        inset: 0;
        min-height: 0;
        overflow: hidden;
        background: var(--native-cli-background);
      }
      .native-cli-terminal__mount {
        position: absolute;
        width: min(var(--terminal-content-width), calc(100% - 48px));
        height: 420px;
        left: -10000px;
        top: -10000px;
        opacity: 0;
        pointer-events: none;
        background: var(--native-cli-background);
      }
      .native-cli-terminal__transcript {
        position: absolute;
        inset: 0;
        overflow-y: auto;
        padding: 28px var(--terminal-content-inset) 196px;
        scrollbar-width: thin;
        scrollbar-color: hsl(var(--foreground) / 0.14) transparent;
      }
      .native-cli-terminal__transcript::-webkit-scrollbar {
        width: 6px;
      }
      .native-cli-terminal__transcript::-webkit-scrollbar-track {
        background: transparent;
      }
      .native-cli-terminal__transcript::-webkit-scrollbar-thumb {
        background: hsl(var(--foreground) / 0.14);
        border-radius: 999px;
      }
      .native-cli-terminal__messages {
        width: min(var(--terminal-content-width), 100%);
        margin: 0 auto;
        display: flex;
        flex-direction: column;
        gap: 20px;
        min-width: 0;
      }
      .native-cli-terminal__empty {
        display: flex;
        min-height: calc(100vh - 260px);
        align-items: center;
        justify-content: center;
        color: hsl(var(--muted-foreground));
        font-size: 14px;
      }
      .native-cli-terminal__status-row {
        display: inline-flex;
        align-self: flex-start;
        align-items: center;
        gap: 8px;
        min-height: 30px;
        padding: 6px 10px;
        border: 1px solid hsl(var(--border));
        border-radius: 8px;
        background: hsl(var(--card));
        color: hsl(var(--muted-foreground));
        font-size: 12px;
      }
      .native-cli-terminal__status-row svg {
        width: 14px;
        height: 14px;
        animation: native-cli-spin .8s linear infinite;
        color: #2563eb;
      }
      .native-cli-terminal__loading {
        position: absolute;
        top: 20px;
        right: 0;
        bottom: 132px;
        left: 0;
        z-index: 10;
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: none;
        opacity: 1;
        transition: opacity .18s ease;
      }
      .native-cli-terminal__loading--exiting {
        opacity: 0;
      }
      .native-cli-terminal__loading-inner {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        min-height: 38px;
        padding: 8px 14px;
        border: 1px solid hsl(var(--border));
        border-radius: 8px;
        background: hsl(var(--card));
        color: hsl(var(--muted-foreground));
        font-size: 13px;
        box-shadow: 0 10px 30px rgb(15 23 42 / .08);
      }
      .native-cli-terminal__loading-inner svg {
        width: 16px;
        height: 16px;
        animation: native-cli-spin .8s linear infinite;
        color: #2563eb;
      }
      .native-cli-terminal__composer {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 20;
        min-height: 124px;
        padding: 0 0 16px;
        background: linear-gradient(
          180deg,
          hsl(var(--background) / 0),
          hsl(var(--background) / .96) 34%,
          hsl(var(--background))
        );
      }
      .native-cli-terminal__composer-spacer {
        height: 42px;
        pointer-events: none;
      }
      .native-cli-terminal__composer-inner {
        width: min(var(--terminal-screen-width), var(--terminal-content-width), calc(100% - 48px));
        margin: 0 auto;
      }
      @keyframes native-cli-spin {
        to { transform: rotate(360deg); }
      }
      .native-cli-terminal__mount .xterm {
        box-sizing: border-box;
        height: 100%;
        padding: 0;
        background: var(--native-cli-background) !important;
      }
      .native-cli-terminal__mount .xterm-screen {
        background: var(--native-cli-background) !important;
        margin-left: var(--terminal-content-inset);
      }
      .native-cli-terminal__mount .xterm-screen canvas {
        background: var(--native-cli-background) !important;
      }
      .native-cli-terminal__mount .xterm-helpers {
        left: var(--terminal-content-inset);
      }
      .native-cli-terminal__mount .xterm-viewport {
        background: var(--native-cli-background) !important;
        overflow-y: auto !important;
        scrollbar-width: thin;
        scrollbar-color: hsl(var(--foreground) / 0.1) transparent;
      }
      .native-cli-terminal__mount .xterm-viewport::-webkit-scrollbar {
        width: 4px;
      }
      .native-cli-terminal__mount .xterm-viewport::-webkit-scrollbar-track {
        background: transparent;
      }
      .native-cli-terminal__mount .xterm-viewport::-webkit-scrollbar-thumb {
        background: hsl(var(--foreground) / 0.1);
        border-radius: 4px;
      }
      .native-cli-terminal__mount .xterm-viewport::-webkit-scrollbar-thumb:hover {
        background: hsl(var(--foreground) / 0.2);
      }
    `}</style>
  );
}

export function NativeCliTerminal({
  agentId,
  sessionKey,
  cliSessionId,
  cliSessionProvider,
  sessionTitle,
  sessionUpdatedAt,
  onUserText,
}: NativeCliTerminalProps) {
  const areaRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const resizeRafRef = useRef<number>(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcriptPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const terminalTurnsRef = useRef<TerminalTurn[]>([]);
  const activeTerminalTurnIdRef = useRef<string | null>(null);
  const markerBufferRef = useRef('');
  const bufferRef = useRef('');
  const recentOutputRef = useRef('');
  const userHasInteractedRef = useRef(false);
  const shellPassthroughRef = useRef(false);
  const connectInFlightRef = useRef(false);
  const cliSessionIdRef = useRef('');
  const activeSessionResolveRef = useRef('');
  const terminalWsUrlRef = useRef('');
  const skillReloadInFlightRef = useRef(false);
  const forceFreshConnectRef = useRef(false);
  const gatewayWsProtocolOverrideRef = useRef<'ws' | 'wss' | null>(null);
  const suppressNextDisconnectBannerRef = useRef(false);
  const initialOutputRafRef = useRef<number>(0);
  const initialOutputPendingPaintRef = useRef(false);
  const loadingExitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressNativeCliChromeRef = useRef(false);
  const transcriptIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cliSessionIdPropRef = useRef(cliSessionId);
  const sessionTitleRef = useRef(sessionTitle);
  const sessionUpdatedAtRef = useRef(sessionUpdatedAt);
  const skipResumeResolveRef = useRef(false);
  const reconnectDelayRef = useRef(1000);
  const disposedRef = useRef(false);
  const transcriptLoadInFlightRef = useRef(false);
  const transcriptLoadQueuedRef = useRef(false);
  const liveStreamRef = useRef<EventSource | null>(null);
  const liveStreamTurnIdRef = useRef<string | null>(null);
  const liveStreamSnapshotSignatureRef = useRef<string>('');
  const terminalStatusBufferRef = useRef('');
  const terminalStatusSignatureRef = useRef('');
  const terminalDataFrameCountRef = useRef(0);
  const terminalDataLastAtRef = useRef(0);
  const pendingLocalUserMessagesRef = useRef<RawMessage[]>([]);
  const liveAssistantMessageRef = useRef<RawMessage | null>(null);

  const [terminalState, dispatchTerminalState] = useReducer(
    nativeCliTerminalReducer,
    initialNativeCliTerminalState,
  );
  const awaitingInitialOutput = terminalState.awaitingInitialOutput;
  const [displayedLoadingLabel, setDisplayedLoadingLabel] = useState('');
  const [loadingExiting, setLoadingExiting] = useState(false);
  const [inputShellState, setInputShellState] = useState<InputShellState>('auto');
  const [transcriptMessages, setTranscriptMessages] = useState<RawMessage[]>([]);
  const [activeTranscriptTurnId, setActiveTranscriptTurnId] = useState<string | null>(null);
  const [liveAssistantMessage, setLiveAssistantMessage] = useState<RawMessage | null>(null);
  const [liveAssistantStreaming, setLiveAssistantStreaming] = useState(false);
  const inputShellStateRef = useRef<InputShellState>(inputShellState);

  const normalizedProvider = useMemo(() => normalizeProvider(cliSessionProvider), [cliSessionProvider]);
  const agent = useAgentsStore((state) => state.agents.find((entry) => entry.id === agentId));
  const refreshAgents = useAgentsStore((state) => state.fetchAgents);
  const activeClaudeProxyRouteModelRef = useRef<string>('');

  const claudeRuntimeEnv = agent?.runtime?.type === 'native-cli' && agent.runtime.nativeCli?.provider === 'claude'
    ? agent.runtime.nativeCli.env
    : undefined;
  const effectiveProvider = normalizedProvider || normalizeProvider(agent?.runtime?.nativeCli?.provider) || 'claude';
  const configuredClaudeProxyRouteModel = useMemo(
    () => extractClaudeProxyRouteModel(claudeRuntimeEnv?.ANTHROPIC_BASE_URL),
    [claudeRuntimeEnv?.ANTHROPIC_BASE_URL],
  );

  useEffect(() => {
    if (!activeClaudeProxyRouteModelRef.current && configuredClaudeProxyRouteModel) {
      activeClaudeProxyRouteModelRef.current = configuredClaudeProxyRouteModel;
    }
  }, [configuredClaudeProxyRouteModel]);

  useEffect(() => {
    liveAssistantMessageRef.current = liveAssistantMessage;
  }, [liveAssistantMessage]);

  useEffect(() => {
    inputShellStateRef.current = inputShellState;
  }, [inputShellState]);

  useEffect(() => {
    const prev = cliSessionIdPropRef.current;
    cliSessionIdPropRef.current = cliSessionId;
    // If we now have a session ID from store but previously had none and skipped
    // resume, allow a reconnect to pick it up.
    if (cliSessionId && !prev && skipResumeResolveRef.current) {
      skipResumeResolveRef.current = false;
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        // Already connected to a wrong (new) session — close and reconnect.
        wsRef.current.close();
      }
    }
  }, [cliSessionId]);

  useEffect(() => {
    sessionTitleRef.current = sessionTitle;
    sessionUpdatedAtRef.current = sessionUpdatedAt;
  }, [sessionTitle, sessionUpdatedAt]);

  const persistState = useCallback(() => {
    savePersistedTerminalState(sessionKey, {
      buffer: bufferRef.current,
      userHasInteracted: userHasInteractedRef.current,
      cliSessionId: cliSessionIdRef.current,
    });
  }, [sessionKey]);

  const getScrollDrivenInputState = useCallback((): InputShellState => (
    isTerminalNearBottom(termRef.current) ? 'auto' : 'collapsed'
  ), []);

  const updateInputShellStateFromTerminalScroll = useCallback(() => {
    if (inputShellStateRef.current === 'focused') return;
    const nextState = getScrollDrivenInputState();
    setInputShellState((prev) => (prev === nextState ? prev : nextState));
  }, [getScrollDrivenInputState]);

  const handleInputFocusChange = useCallback((focused: boolean) => {
    if (focused) {
      setInputShellState('focused');
      return;
    }
    setInputShellState(getScrollDrivenInputState());
  }, [getScrollDrivenInputState]);

  const resetVisibleTerminalForResume = useCallback(() => {
    markerBufferRef.current = '';
    recentOutputRef.current = '';
    terminalTurnsRef.current = [];
    activeTerminalTurnIdRef.current = null;
    setActiveTranscriptTurnId(null);
    setLiveAssistantMessage(null);
    userHasInteractedRef.current = true;
    persistState();
  }, [persistState]);

  const updateLiveAssistantSnapshot = useCallback((_turnId?: string | null) => {
    // Claude native chat streams through the local proxy, not through hidden xterm output.
  }, []);

  const mergeTranscriptMessages = useCallback((messages: RawMessage[]) => {
    const visibleMessages = enrichNativeCliTranscriptMessages(messages);
    const activeTurnId = activeTerminalTurnIdRef.current;
    if (activeTurnId) {
      const activeTurn = terminalTurnsRef.current.find((turn) => turn.id === activeTurnId);
      const activeUserIndex = activeTurn ? findLastNativeCliUserIndex(visibleMessages, activeTurn.userText) : -1;
      const transcriptHasCurrentAssistant = activeUserIndex >= 0 && visibleMessages
        .slice(activeUserIndex + 1)
        .some((message) => message.role === 'assistant' && extractText(message).trim());
      if (!liveStreamRef.current && transcriptHasCurrentAssistant) setLiveAssistantMessage(null);
    } else if (liveAssistantMessage) {
      const liveText = normalizeTerminalLineText(extractText(liveAssistantMessage));
      const transcriptHasLiveAssistant = Boolean(liveText) && visibleMessages.some((message) => (
        message.role === 'assistant' &&
        normalizeTerminalLineText(extractText(message)).includes(liveText.slice(0, 120))
      ));
      if (!liveStreamRef.current && transcriptHasLiveAssistant) setLiveAssistantMessage(null);
    }
    setTranscriptMessages((prev) => {
      const prevRealMessages = prev.filter((message) => {
        const id = typeof message.id === 'string' ? message.id : '';
        return !id.startsWith('local-');
      });
      pendingLocalUserMessagesRef.current = reconcilePendingLocalUserMessages(
        pendingLocalUserMessagesRef.current,
        visibleMessages,
        activeTurnId,
      );
      const next = dedupeNativeCliMessages(pendingLocalUserMessagesRef.current.length > 0
        ? [...visibleMessages, ...pendingLocalUserMessagesRef.current]
        : visibleMessages);
      if (nativeCliMessagesEqual(prevRealMessages, next)) return prevRealMessages;
      const roleCounts = next.reduce<Record<string, number>>((counts, message) => {
        const role = typeof message.role === 'string' ? message.role : 'unknown';
        counts[role] = (counts[role] ?? 0) + 1;
        return counts;
      }, {});
      const fileMessages = next
        .filter((message) => message._attachedFiles?.length)
        .map((message) => ({
          role: message.role,
          id: message.id,
          files: message._attachedFiles?.map((file) => file.filePath || file.fileName),
        }));
      console.info('[native-cli-terminal] transcript messages updated', {
        agentId,
        sessionKey,
        previousCount: prev.length,
        nextCount: next.length,
        roleCounts,
        fileMessages,
        pendingLocalUsers: pendingLocalUserMessagesRef.current.map((message) => messageDiagnostic(extractText(message))),
      });
      return next;
    });
    loadMissingPreviews(visibleMessages).then((updated) => {
      if (!updated || disposedRef.current) return;
      setTranscriptMessages((current) => mergeNativeCliHydratedMessages(current, visibleMessages));
    });
    requestAnimationFrame(() => {
      const scroller = transcriptScrollRef.current;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
  }, [agentId, liveAssistantMessage, sessionKey]);

  const bindNativeCliSessionId = useCallback((sessionId: string) => {
    const trimmed = sessionId.trim();
    if (!trimmed) return;

    const alreadyBound = cliSessionIdRef.current === trimmed;
    cliSessionIdRef.current = trimmed;
    persistNativeCliSessionId(sessionKey, trimmed, normalizedProvider);
    persistState();
    if (!alreadyBound) void persistNativeCliSessionIdToHost(sessionKey, trimmed, normalizedProvider);

    const provider = normalizeProvider(normalizedProvider) || 'claude';
    useChatStore.setState((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.key !== sessionKey) return session;
        const nextCliSessionIds = {
          ...(session.cliSessionIds ?? {}),
          [provider]: trimmed,
        };
        return {
          ...session,
          sessionId: session.sessionId ?? trimmed,
          cliSessionIds: nextCliSessionIds,
          cliSessionId: session.cliSessionId ?? trimmed,
          claudeCliSessionId: provider === 'claude'
            ? session.claudeCliSessionId ?? trimmed
            : session.claudeCliSessionId,
        };
      }),
    }));
  }, [normalizedProvider, persistState, sessionKey]);

  const loadNativeCliTranscript = useCallback(async (options?: { latest?: boolean; quiet?: boolean; forceDuringLive?: boolean }) => {
    const sessionId = cliSessionIdRef.current.trim();
    if (!sessionId && !options?.latest) return;
    if (liveStreamRef.current && !options?.forceDuringLive) return;
    if (transcriptLoadInFlightRef.current) {
      transcriptLoadQueuedRef.current = true;
      return;
    }
    transcriptLoadInFlightRef.current = true;
    try {
      const data = await hostApiFetch<NativeCliTranscriptResponse>(RUNTIME_NATIVE_CLI_TRANSCRIPT_PATH, {
        method: 'POST',
        body: JSON.stringify({
          sessionKey,
          provider: normalizedProvider,
          sessionId: sessionId || undefined,
          latest: options?.latest || !sessionId,
        }),
      });
      if (data.sessionId) bindNativeCliSessionId(data.sessionId);
      const messages = Array.isArray(data.messages) ? data.messages : [];
      console.debug('[native-cli-terminal] transcript loaded', {
        agentId,
        sessionKey,
        resolved: data.resolved,
        sessionId: data.sessionId,
        messages: messages.length,
      });
      mergeTranscriptMessages(messages);
    } catch (error) {
      console.debug('[native-cli-terminal] transcript load failed', { agentId, sessionKey, error });
    } finally {
      transcriptLoadInFlightRef.current = false;
      if (transcriptLoadQueuedRef.current && !disposedRef.current) {
        transcriptLoadQueuedRef.current = false;
        window.setTimeout(() => {
          void loadNativeCliTranscript({ quiet: true, latest: !cliSessionIdRef.current });
        }, 250);
      }
    }
  }, [agentId, bindNativeCliSessionId, mergeTranscriptMessages, normalizedProvider, sessionKey]);

  const closeClaudeLiveStream = useCallback((turnId?: string | null) => {
    if (turnId && liveStreamTurnIdRef.current && liveStreamTurnIdRef.current !== turnId) return;
    liveStreamRef.current?.close();
    liveStreamRef.current = null;
    liveStreamTurnIdRef.current = null;
    liveStreamSnapshotSignatureRef.current = '';
    terminalStatusBufferRef.current = '';
    terminalStatusSignatureRef.current = '';
    liveAssistantMessageRef.current = null;
    setLiveAssistantStreaming(false);
  }, []);

  const startClaudeLiveStream = useCallback((turnId: string, prompt: string): Promise<void> | null => {
    if (effectiveProvider !== 'claude') return null;
    const routeModel = activeClaudeProxyRouteModelRef.current || configuredClaudeProxyRouteModel;
    if (!routeModel) {
      console.warn('[native-cli-terminal] Claude live stream skipped: missing proxy route model', {
        agentId,
        sessionKey,
        turnId,
      });
      return null;
    }

    closeClaudeLiveStream();
    liveAssistantMessageRef.current = null;
    setLiveAssistantMessage(null);
    setLiveAssistantStreaming(true);
    liveStreamSnapshotSignatureRef.current = '';
    terminalStatusBufferRef.current = '';
    terminalStatusSignatureRef.current = '';
    const source = new EventSource(getClaudeProxyLiveStreamUrl(routeModel, sessionKey, turnId));
    liveStreamRef.current = source;
    liveStreamTurnIdRef.current = turnId;

    const applySnapshot = (event: MessageEvent<string>) => {
      try {
        const snapshot = JSON.parse(event.data) as NativeClaudeLiveSnapshot;
        if (snapshot.turnId && snapshot.turnId !== turnId) return;
        if (!claudeLiveSnapshotHasVisibleContent(snapshot)) return;
        const signature = claudeLiveContentSignature(snapshot);
        if (signature === liveStreamSnapshotSignatureRef.current) return;
        liveStreamSnapshotSignatureRef.current = signature;
        console.debug('[native-cli-terminal] Claude live stream snapshot', {
          agentId,
          sessionKey,
          turnId,
          status: snapshot.status,
          textLength: typeof snapshot.text === 'string' ? snapshot.text.length : 0,
          thinkingLength: typeof snapshot.thinking === 'string' ? snapshot.thinking.length : 0,
          blockCount: Array.isArray(snapshot.content) ? snapshot.content.length : 0,
          blocks: claudeLiveContentDebug(snapshot),
        });
        const nextLiveMessage = enrichNativeCliLiveMessage(claudeLiveSnapshotToMessage({ ...snapshot, turnId }));
        liveAssistantMessageRef.current = nextLiveMessage;
        setLiveAssistantMessage(nextLiveMessage);
        if (nextLiveMessage._attachedFiles?.length) {
          void loadMissingPreviews([nextLiveMessage]).then((updated) => {
            if (!updated || disposedRef.current) return;
            liveAssistantMessageRef.current = { ...nextLiveMessage };
            setLiveAssistantMessage({ ...nextLiveMessage });
          });
        }
        console.debug('[native-cli-terminal] live message applied', {
          agentId,
          sessionKey,
          turnId,
          messageId: nextLiveMessage.id,
          textLength: extractText(nextLiveMessage).length,
          displayedCount: transcriptMessages.length + 1,
        });
        requestAnimationFrame(() => {
          const scroller = transcriptScrollRef.current;
          if (scroller) scroller.scrollTop = scroller.scrollHeight;
        });
      } catch (error) {
        console.warn('[native-cli-terminal] Claude live stream snapshot parse failed', {
          agentId,
          sessionKey,
          turnId,
          error,
        });
      }
    };

    const markStreamIdle = (event?: MessageEvent<string>) => {
      if (event) applySnapshot(event);
      if (activeTerminalTurnIdRef.current === turnId) {
        activeTerminalTurnIdRef.current = null;
        setActiveTranscriptTurnId(null);
      }
      if (liveStreamRef.current === source) {
        source.close();
        liveStreamRef.current = null;
        liveStreamTurnIdRef.current = null;
        liveStreamSnapshotSignatureRef.current = '';
      }
      setLiveAssistantStreaming(false);
      void loadNativeCliTranscript({ quiet: true, latest: !cliSessionIdRef.current });
    };

    source.addEventListener('snapshot', applySnapshot);
    source.addEventListener('open', () => {
      console.info('[native-cli-terminal] Claude live stream opened', {
        agentId,
        sessionKey,
        turnId,
      });
    });
    source.addEventListener('done', markStreamIdle);
    source.onerror = () => {
      console.warn('[native-cli-terminal] Claude live stream disconnected', {
        agentId,
        sessionKey,
        turnId,
        readyState: source.readyState,
      });
      if (liveStreamRef.current === source && source.readyState === EventSource.CLOSED) {
        source.close();
        liveStreamRef.current = null;
        liveStreamTurnIdRef.current = null;
        liveStreamSnapshotSignatureRef.current = '';
        if (activeTerminalTurnIdRef.current === turnId) {
          activeTerminalTurnIdRef.current = null;
          setActiveTranscriptTurnId(null);
        }
        setLiveAssistantStreaming(false);
        void loadNativeCliTranscript({ quiet: true, latest: !cliSessionIdRef.current });
      }
    };

    const register = registerClaudeProxyLivePrompt(routeModel, { sessionKey, turnId, prompt })
      .then(() => {
        console.info('[native-cli-terminal] Claude live stream registered', {
          agentId,
          sessionKey,
          turnId,
        });
      })
      .catch((error) => {
        console.warn('[native-cli-terminal] Claude live stream register failed', {
          agentId,
          sessionKey,
          turnId,
          error,
        });
      });
    return register;
  }, [
    agentId,
    closeClaudeLiveStream,
    configuredClaudeProxyRouteModel,
    effectiveProvider,
    loadNativeCliTranscript,
    sessionKey,
    transcriptMessages.length,
  ]);

  const upsertTerminalTurn = useCallback((marker: Extract<TerminalStreamMarker, { kind: 'turn_start' }>) => {
    const existing = terminalTurnsRef.current.find((turn) => turn.id === marker.turnId);
    if (existing) {
      existing.conversationId = marker.conversationId;
      existing.userText = marker.userText;
      existing.state = 'active';
      activeTerminalTurnIdRef.current = existing.id;
      setActiveTranscriptTurnId(existing.id);
      if (!liveStreamRef.current && (!liveAssistantMessage || liveAssistantMessage.id !== `live-${existing.id}`)) {
        setLiveAssistantMessage(null);
        setLiveAssistantStreaming(false);
      }
      return;
    }

    const localTurn = terminalTurnsRef.current.find((turn) => (
      turn.id.startsWith('local-') &&
      turn.state === 'active' &&
      normalizeTerminalLineText(turn.userText) === normalizeTerminalLineText(marker.userText)
    ));
    if (localTurn && !marker.turnId.startsWith('local-')) {
      const oldLocalTurnId = localTurn.id;
      localTurn.id = marker.turnId;
      localTurn.conversationId = marker.conversationId;
      localTurn.userText = marker.userText;
      activeTerminalTurnIdRef.current = localTurn.id;
      setActiveTranscriptTurnId(localTurn.id);
        setLiveAssistantMessage((current) => (
        current?.id === `live-${oldLocalTurnId}`
          ? { ...current, id: `live-${localTurn.id}` }
          : current
      ));
      return;
    }

    for (const turn of terminalTurnsRef.current) {
      if (turn.state === 'active') turn.state = 'idle';
    }
    const nextTurns = [
      ...terminalTurnsRef.current,
      {
        id: marker.turnId,
        conversationId: marker.conversationId,
        userText: marker.userText,
        state: 'active' as const,
        startedAt: Date.now(),
      },
    ];
    terminalTurnsRef.current = nextTurns.slice(-25);
    activeTerminalTurnIdRef.current = marker.turnId;
    setActiveTranscriptTurnId(marker.turnId);
    if (!liveStreamRef.current && (!liveAssistantMessage || liveAssistantMessage.id !== `live-${marker.turnId}`)) {
      setLiveAssistantMessage(null);
      setLiveAssistantStreaming(false);
    }
    const optimistic: RawMessage = {
      id: marker.turnId,
      role: 'user',
      content: marker.userText,
      timestamp: Date.now(),
    };
    pendingLocalUserMessagesRef.current = [
      ...pendingLocalUserMessagesRef.current.filter((message) => message.id !== optimistic.id),
      optimistic,
    ].slice(-10);
    setTranscriptMessages((prev) => (
      prev.some((message) => message.id === optimistic.id)
        ? prev
        : [...prev, optimistic]
    ));
  }, [liveAssistantMessage, loadNativeCliTranscript]);

  const handleTerminalStreamMarker = useCallback((marker: TerminalStreamMarker) => {
    if (marker.kind === 'turn_start') {
      suppressNativeCliChromeRef.current = false;
      upsertTerminalTurn(marker);
      void loadNativeCliTranscript({ quiet: true, latest: !cliSessionIdRef.current });
      return;
    }
    const turn = terminalTurnsRef.current.find((candidate) => candidate.id === marker.turnId);
    if (!turn) return;
    turn.state = marker.kind === 'turn_idle' ? 'idle' : 'closed';
    if (marker.kind === 'turn_idle') {
      setLiveAssistantStreaming(false);
      if (transcriptIdleTimerRef.current) clearTimeout(transcriptIdleTimerRef.current);
      transcriptIdleTimerRef.current = setTimeout(() => {
        transcriptIdleTimerRef.current = null;
        if (disposedRef.current) return;
        if (activeTerminalTurnIdRef.current === marker.turnId) {
          activeTerminalTurnIdRef.current = null;
          setActiveTranscriptTurnId(null);
          void loadNativeCliTranscript({ quiet: true, latest: !cliSessionIdRef.current });
        }
      }, TRANSCRIPT_IDLE_POLL_RETENTION_MS);
    }
    if (activeTerminalTurnIdRef.current === marker.turnId && marker.kind === 'turn_end') {
      activeTerminalTurnIdRef.current = null;
      setActiveTranscriptTurnId(null);
    }
    if (marker.kind === 'turn_end') {
      closeClaudeLiveStream(marker.turnId);
    }
    updateLiveAssistantSnapshot(marker.turnId);
    void loadNativeCliTranscript({ quiet: true, latest: !cliSessionIdRef.current });
  }, [closeClaudeLiveStream, loadNativeCliTranscript, updateLiveAssistantSnapshot, upsertTerminalTurn]);

  const stripTerminalStreamMarkers = useCallback((chunk: string) => {
    let data = `${markerBufferRef.current}${chunk}`;
    markerBufferRef.current = '';
    let visible = '';

    while (data.length > 0) {
      const markerStart = data.indexOf(TERMINAL_STREAM_MARKER_PREFIX);
      if (markerStart < 0) {
        const partialLength = terminalMarkerPartialSuffixLength(data);
        visible += partialLength > 0 ? data.slice(0, -partialLength) : data;
        markerBufferRef.current = partialLength > 0 ? data.slice(-partialLength) : '';
        break;
      }

      if (markerStart > 0) visible += data.slice(0, markerStart);
      const payloadStart = markerStart + TERMINAL_STREAM_MARKER_PREFIX.length;
      const markerEnd = data.indexOf(TERMINAL_STREAM_MARKER_SUFFIX, payloadStart);
      if (markerEnd < 0) {
        markerBufferRef.current = data.slice(markerStart);
        break;
      }
      data = data.slice(markerEnd + TERMINAL_STREAM_MARKER_SUFFIX.length);
    }

    if (markerBufferRef.current.length > 8192) {
      visible += markerBufferRef.current;
      markerBufferRef.current = '';
    }
    return visible;
  }, []);

  const updateShellPassthroughState = useCallback((chunk: string) => {
    if (effectiveProvider === 'claude') return;
    recentOutputRef.current = `${recentOutputRef.current}${chunk}`.slice(-TERMINAL_SHELL_PASSTHROUGH_BUFFER_CHARS);
    if (TERMINAL_SHELL_PASSTHROUGH_SIGNATURES.some((signature) => recentOutputRef.current.includes(signature))) {
      shellPassthroughRef.current = true;
    } else if (shellPassthroughRef.current && /\n[^\n]*[$%#] $/.test(recentOutputRef.current.slice(-240))) {
      shellPassthroughRef.current = false;
    }
  }, [effectiveProvider]);

  const settleInitialOutputAfterPaint = useCallback(() => {
    if (initialOutputRafRef.current) {
      cancelAnimationFrame(initialOutputRafRef.current);
      initialOutputRafRef.current = 0;
    }
    initialOutputRafRef.current = requestAnimationFrame(() => {
      initialOutputRafRef.current = requestAnimationFrame(() => {
        initialOutputRafRef.current = requestAnimationFrame(() => {
          initialOutputRafRef.current = 0;
          if (disposedRef.current) return;
          dispatchTerminalState({ type: 'initial_output_settled' });
        });
      });
    });
  }, []);

  const maybeSettleInitialOutput = useCallback(() => {
    if (!initialOutputPendingPaintRef.current) return;
    if (!terminalHasVisibleContent(termRef.current, mountRef.current)) return;
    initialOutputPendingPaintRef.current = false;
    settleInitialOutputAfterPaint();
  }, [settleInitialOutputAfterPaint]);

  const settleIfTerminalAlreadyVisible = useCallback(() => {
    if (!awaitingInitialOutput) return;
    if (!terminalHasVisibleContent(termRef.current, mountRef.current)) return;
    initialOutputPendingPaintRef.current = false;
    settleInitialOutputAfterPaint();
  }, [awaitingInitialOutput, settleInitialOutputAfterPaint]);

  const requestInitialOutputSettle = useCallback(() => {
    initialOutputPendingPaintRef.current = true;
    requestAnimationFrame(() => {
      if (disposedRef.current) return;
      maybeSettleInitialOutput();
    });
  }, [maybeSettleInitialOutput]);

  const settleReadyWithoutInitialOutput = useCallback(() => {
    if (initialOutputRafRef.current) {
      cancelAnimationFrame(initialOutputRafRef.current);
      initialOutputRafRef.current = 0;
    }
    initialOutputPendingPaintRef.current = false;
    initialOutputRafRef.current = requestAnimationFrame(() => {
      initialOutputRafRef.current = requestAnimationFrame(() => {
        initialOutputRafRef.current = 0;
        if (disposedRef.current) return;
        dispatchTerminalState({ type: 'ready_without_initial_output' });
      });
    });
  }, []);

  const handleTerminalData = useCallback((raw: string) => {
    terminalDataFrameCountRef.current += 1;
    terminalDataLastAtRef.current = Date.now();
    const visibleRaw = stripTerminalStreamMarkers(raw);
    updateShellPassthroughState(visibleRaw);
    const printable = hasPrintableTerminalContent(visibleRaw);
    const activeTurnId = activeTerminalTurnIdRef.current;
    if (printable || activeTerminalTurnIdRef.current) {
      console.debug('[native-cli-terminal] terminal data frame', {
        agentId,
        sessionKey,
        frame: terminalDataFrameCountRef.current,
        raw: dataDiagnostic(raw),
        visible: dataDiagnostic(visibleRaw),
        printable,
        shellPassthrough: shellPassthroughRef.current,
        activeTurn: activeTerminalTurnIdRef.current,
        suppressedChrome: suppressNativeCliChromeRef.current,
      });
    }
    if (printable && activeTurnId && liveStreamRef.current) {
      terminalStatusBufferRef.current = `${terminalStatusBufferRef.current}${visibleRaw}`.slice(-TERMINAL_STATUS_BUFFER_CHARS);
      const activeTurn = terminalTurnsRef.current.find((turn) => turn.id === activeTurnId);
      const status = terminalStatusText(terminalStatusBufferRef.current, activeTurn?.userText);
      const currentLiveMessage = liveAssistantMessageRef.current;
      const currentLiveText = currentLiveMessage ? extractText(currentLiveMessage).trim() : '';
      const currentLiveThinking = currentLiveMessage ? extractThinking(currentLiveMessage)?.trim() ?? '' : '';
      if (!currentLiveText && !currentLiveThinking) {
        const signature = `${activeTurnId}:${CLAUDE_TERMINAL_LOADING_SENTINEL}`;
        if (signature !== terminalStatusSignatureRef.current) {
          terminalStatusSignatureRef.current = signature;
          console.debug('[native-cli-terminal] terminal status applied', {
            agentId,
            sessionKey,
            turnId: activeTurnId,
            status: messageDiagnostic(status),
            preview: status.slice(0, 160),
            loading: !status,
            raw: dataDiagnostic(visibleRaw),
          });
          const statusMessage = claudeTerminalLoadingMessage(activeTurnId);
          liveAssistantMessageRef.current = statusMessage;
          setLiveAssistantMessage(statusMessage);
        }
      }
    }
    if (suppressNativeCliChromeRef.current && !activeTerminalTurnIdRef.current && !shellPassthroughRef.current) {
      if (printable) settleReadyWithoutInitialOutput();
      return;
    }
    bufferRef.current = `${bufferRef.current}${raw}`.slice(-100_000);
    persistState();
    const term = termRef.current;
    if (term) {
      term.write(raw, () => {
        if (printable) requestInitialOutputSettle();
        if (activeTerminalTurnIdRef.current && printable) {
          updateLiveAssistantSnapshot();
        }
      });
    }
  }, [agentId, persistState, requestInitialOutputSettle, sessionKey, settleReadyWithoutInitialOutput, stripTerminalStreamMarkers, updateLiveAssistantSnapshot, updateShellPassthroughState]);

  const sendTerminalData = useCallback((data: string, trace?: { startedAt: number; frame: number; total: number }) => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) {
      console.warn('[native-cli-terminal] pty data blocked: websocket not open', {
        agentId,
        sessionKey,
        wsState: wsReadyStateName(ws?.readyState),
        length: data.length,
      });
      return false;
    }
    console.info('[native-cli-terminal] sending pty data', {
      agentId,
      sessionKey,
      length: data.length,
      control: data === '\r' ? 'enter' : data === '\u0003' ? 'ctrl-c' : null,
      frame: trace ? `${trace.frame}/${trace.total}` : undefined,
      elapsedMs: trace ? Math.round(performance.now() - trace.startedAt) : undefined,
    });
    ws.send(JSON.stringify({ type: 'data', data }));
    return true;
  }, [agentId, sessionKey]);

  const startCliSessionIdFallbackResolver = useCallback((userText: string, startedAt: number) => {
    if (cliSessionIdRef.current) return;
    const resolveKey = `${sessionKey}:${startedAt}:${userText}`;
    activeSessionResolveRef.current = resolveKey;
    void (async () => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await wait(attempt < 5 ? 1000 : 2000);
        if (disposedRef.current || activeSessionResolveRef.current !== resolveKey || cliSessionIdRef.current) return;
        const resolvedSessionId = await resolveNativeCliSessionIdToHost({
          sessionKey,
          provider: normalizedProvider,
          userText,
          startedAt,
        });
        if (!resolvedSessionId) continue;
        if (disposedRef.current || activeSessionResolveRef.current !== resolveKey || cliSessionIdRef.current) return;
        bindNativeCliSessionId(resolvedSessionId);
        return;
      }
    })();
  }, [bindNativeCliSessionId, normalizedProvider, sessionKey]);

  const fitTerminalToContent = useCallback(() => {
    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    const area = areaRef.current;
    const mount = mountRef.current;
    if (!term || !fitAddon || !area || !mount) return;

    const proposed = fitAddon.proposeDimensions();
    const measuredCell = mount.querySelector<HTMLElement>('.xterm-char-measure-element');
    const measuredCellWidth = measuredCell?.getBoundingClientRect().width ?? 0;
    const cellWidth = measuredCellWidth > 2 && measuredCellWidth < TERMINAL_MAX_REASONABLE_CELL_WIDTH
      ? measuredCellWidth
      : (term.options.fontSize ?? 15) * 0.6;

    if (!proposed || cellWidth <= 0) {
      fitAddon.fit();
      return;
    }
    const areaWidth = area.getBoundingClientRect().width || area.clientWidth;
    const configuredWidth = Math.min(Math.max(0, areaWidth - 48), 960);
    const cols = Math.max(TERMINAL_MIN_COLS, Math.floor(configuredWidth / cellWidth));
    const proposedRows = Number(proposed.rows);
    const rows = Number.isFinite(proposedRows)
      ? Math.max(1, Math.floor(proposedRows))
      : Math.max(1, term.rows || 24);
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
      console.warn('[native-cli-terminal] skipped terminal resize with non-integer dimensions', {
        agentId,
        sessionKey,
        cols,
        rows,
        proposed,
      });
      return;
    }
    const screenWidth = `${Math.ceil(cols * cellWidth)}px`;
    area.closest<HTMLElement>('.native-cli-terminal')?.style.setProperty('--terminal-screen-width', screenWidth);
    if (term.cols !== cols || term.rows !== rows) {
      try {
        term.resize(cols, rows);
      } catch (error) {
        console.warn('[native-cli-terminal] terminal resize failed', {
          agentId,
          sessionKey,
          cols,
          rows,
          error,
        });
      }
    } else {
      term.refresh(0, Math.max(0, rows - 1));
    }
  }, [agentId, sessionKey]);

  const scheduleTerminalResize = useCallback(() => {
    if (resizeRafRef.current) {
      cancelAnimationFrame(resizeRafRef.current);
    }
    resizeRafRef.current = requestAnimationFrame(() => {
      resizeRafRef.current = 0;
      if (disposedRef.current) return;
      fitTerminalToContent();
      updateInputShellStateFromTerminalScroll();
      requestAnimationFrame(() => {
        if (disposedRef.current) return;
        fitTerminalToContent();
      });
    });
  }, [fitTerminalToContent, updateInputShellStateFromTerminalScroll]);

  const requestReconnectSoon = useCallback((reason: string, options?: { skipResumeResolve?: boolean }) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;
    if (connectInFlightRef.current || reconnectTimerRef.current) return;
    if (options?.skipResumeResolve) {
      skipResumeResolveRef.current = true;
      activeSessionResolveRef.current = '';
    }
    console.info('[native-cli-terminal] reconnect requested', {
      agentId,
      sessionKey,
      reason,
      wsState: wsReadyStateName(ws?.readyState),
      skipResumeResolve: Boolean(options?.skipResumeResolve),
    });
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      void mountRef_cb.current.connect();
    }, 50);
  }, [agentId, sessionKey]);

  const restartTerminalForSkillReload = useCallback((skillCount: number) => {
    if (effectiveProvider !== 'claude') return;
    const knownCliSessionId = cliSessionIdRef.current || resolveStoredCliSessionId(sessionKey, cliSessionIdPropRef.current);
    console.info('[native-cli-terminal] skill reload requested', {
      agentId,
      sessionKey,
      skillCount,
      hasCliSessionId: Boolean(knownCliSessionId),
      wsState: wsReadyStateName(wsRef.current?.readyState),
    });
    if (knownCliSessionId) {
      cliSessionIdRef.current = knownCliSessionId;
      skipResumeResolveRef.current = false;
      shellPassthroughRef.current = false;
      recentOutputRef.current = '';
      persistNativeCliSessionId(sessionKey, knownCliSessionId, normalizedProvider);
      persistState();
    } else if (!skillReloadInFlightRef.current) {
      skillReloadInFlightRef.current = true;
      console.info('[native-cli-terminal] resolving latest native-cli session before skill reload', {
        agentId,
        sessionKey,
      });
      void (async () => {
        const resolvedSessionId = await resolveNativeCliSessionIdToHost({
          sessionKey,
          provider: normalizedProvider,
          latest: true,
        });
        if (disposedRef.current) return;
        skillReloadInFlightRef.current = false;
        if (resolvedSessionId) {
          bindNativeCliSessionId(resolvedSessionId);
          console.info('[native-cli-terminal] latest native-cli session resolved for skill reload', {
            agentId,
            sessionKey,
            hasCliSessionId: true,
          });
        } else {
          forceFreshConnectRef.current = true;
          console.warn('[native-cli-terminal] latest native-cli session not found for skill reload; starting fresh', {
            agentId,
            sessionKey,
          });
        }
        restartTerminalForSkillReload(skillCount);
      })();
      return;
    } else {
      return;
    }
    activeSessionResolveRef.current = '';
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectDelayRef.current = 50;
    connectInFlightRef.current = false;
    dispatchTerminalState({
      type: 'connect_requested',
      phase: knownCliSessionId ? 'resuming' : 'preparing',
    });

    const ws = wsRef.current;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      suppressNextDisconnectBannerRef.current = true;
      ws.close();
      return;
    }
    wsRef.current = null;
    void mountRef_cb.current.connect();
  }, [agentId, bindNativeCliSessionId, effectiveProvider, normalizedProvider, persistState, sessionKey]);

  const connect = useCallback(async () => {
    if (disposedRef.current) {
      console.warn('[native-cli-terminal] connect skipped: disposed', { agentId, sessionKey });
      return;
    }
    if (!termRef.current) {
      console.warn('[native-cli-terminal] connect skipped: terminal missing', { agentId, sessionKey });
      return;
    }
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      console.debug('[native-cli-terminal] connect skipped: websocket already open', { agentId, sessionKey });
      return;
    }
    if (wsRef.current?.readyState === WebSocket.CONNECTING) {
      console.debug('[native-cli-terminal] connect skipped: websocket already connecting', { agentId, sessionKey });
      return;
    }
    if (wsRef.current?.readyState === WebSocket.CLOSING) {
      if (!reconnectTimerRef.current) {
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          void mountRef_cb.current.connect();
        }, 250);
      }
      return;
    }
    if (connectInFlightRef.current) {
      console.debug('[native-cli-terminal] connect skipped: connect already in flight', { agentId, sessionKey });
      return;
    }
    connectInFlightRef.current = true;

    const storedCliSessionId = cliSessionIdRef.current || resolveStoredCliSessionId(sessionKey, cliSessionIdPropRef.current);
    const hasHistoricalTitle = Boolean(sessionTitleRef.current?.trim() && sessionTitleRef.current.trim() !== sessionKey);
    const shouldWaitForResumeSessionId = !forceFreshConnectRef.current
      && !storedCliSessionId
      && hasHistoricalTitle
      && isNativeCliSessionKey(sessionKey)
      && !skipResumeResolveRef.current;
    dispatchTerminalState({
      type: 'connect_requested',
      phase: storedCliSessionId ? 'resuming' : shouldWaitForResumeSessionId ? 'preparing' : 'starting',
    });
    initialOutputPendingPaintRef.current = false;

    if (shouldWaitForResumeSessionId) {
      const userText = sessionTitleRef.current?.trim() || '';
      const startedAt = sessionUpdatedAtRef.current ?? Date.now() - 60_000;
      const resolveKey = `resume:${sessionKey}:${userText}:${startedAt}`;
      if (activeSessionResolveRef.current === resolveKey) {
        console.info('[native-cli-terminal] connect waiting for existing session resolve', {
          agentId,
          sessionKey,
          resolveKeyHash: messageDiagnostic(resolveKey),
        });
        connectInFlightRef.current = false;
        return;
      }
      activeSessionResolveRef.current = resolveKey;
      connectInFlightRef.current = false;
      console.info('[native-cli-terminal] resolving native-cli session before reconnect', {
        agentId,
        sessionKey,
        message: messageDiagnostic(userText),
        startedAt,
      });
      void (async () => {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          await wait(attempt < 3 ? 500 : 1500);
          if (disposedRef.current || activeSessionResolveRef.current !== resolveKey) return;
          // Check if the store/prop has already populated a session ID (from loadSessions).
          const propId = cliSessionIdPropRef.current?.trim();
          if (propId) {
            cliSessionIdRef.current = propId;
            activeSessionResolveRef.current = '';
            void connect();
            return;
          }
          const resolvedSessionId = await resolveNativeCliSessionIdToHost({
            sessionKey,
            provider: normalizedProvider,
            userText,
            startedAt,
          });
          if (disposedRef.current || activeSessionResolveRef.current !== resolveKey || cliSessionIdRef.current) return;
          if (resolvedSessionId) {
            bindNativeCliSessionId(resolvedSessionId);
            activeSessionResolveRef.current = '';
            void connect();
            return;
          }
        }
        if (disposedRef.current || activeSessionResolveRef.current !== resolveKey || cliSessionIdRef.current) return;
        skipResumeResolveRef.current = true;
        activeSessionResolveRef.current = '';
        console.info('[native-cli-terminal] native-cli session resolve exhausted; starting fresh websocket', {
          agentId,
          sessionKey,
        });
        dispatchTerminalState({ type: 'connect_requested', phase: 'starting' });
        void connect();
      })();
      return;
    }

    let statusResult: GatewayStatus;
    try {
      statusResult = await invokeIpc<GatewayStatus>('gateway:status', []);
    } catch {
      // Gateway IPC not available yet — schedule reconnect.
      if (disposedRef.current) return;
      dispatchTerminalState({ type: 'gateway_unavailable' });
      connectInFlightRef.current = false;
      initialOutputPendingPaintRef.current = false;
      if (!reconnectTimerRef.current) {
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          void mountRef_cb.current.connect();
        }, reconnectDelayRef.current);
        reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, 30_000);
      }
      return;
    }
    if (disposedRef.current) {
      connectInFlightRef.current = false;
      return;
    }
    if (statusResult?.state !== 'running') {
      dispatchTerminalState({ type: 'gateway_unavailable' });
      connectInFlightRef.current = false;
      initialOutputPendingPaintRef.current = false;
      if (!reconnectTimerRef.current) {
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          void mountRef_cb.current.connect();
        }, reconnectDelayRef.current);
        reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, 30_000);
      }
      console.info('[native-cli-terminal] connect deferred: gateway not running', {
        agentId,
        sessionKey,
        gatewayState: statusResult?.state,
        tls: statusResult?.tls,
      });
      return;
    }
    const port = typeof statusResult?.port === 'number' && statusResult.port > 0 ? statusResult.port : 18789;
    const statusWsProtocol = statusResult?.tls === true ? 'wss' : 'ws';
    const wsProtocol = gatewayWsProtocolOverrideRef.current ?? statusWsProtocol;
    const knownCliSessionId = storedCliSessionId;
    forceFreshConnectRef.current = false;
    cliSessionIdRef.current = knownCliSessionId;
    if (knownCliSessionId) {
      dispatchTerminalState({ type: 'connect_requested', phase: 'resuming' });
      resetVisibleTerminalForResume();
      persistNativeCliSessionId(sessionKey, knownCliSessionId, normalizedProvider);
      persistState();
    } else {
      dispatchTerminalState({ type: 'connect_requested', phase: 'starting' });
    }

    const params = new URLSearchParams({
      agentId,
      sessionKey,
    });
    if (knownCliSessionId) {
      params.set('resume', '1');
      params.set('sessionId', knownCliSessionId);
    }
    const terminalWsUrl = `${wsProtocol}://127.0.0.1:${port}/terminal?${params.toString()}`;
    terminalWsUrlRef.current = terminalWsUrl;
    console.info('[native-cli-terminal] terminal websocket url', terminalWsUrl);
    const ws = new WebSocket(terminalWsUrl);
    wsRef.current = ws;
    let openedAt = 0;
    suppressNativeCliChromeRef.current = effectiveProvider === 'claude';
    console.info('[native-cli-terminal] connecting', {
      agentId,
      sessionKey,
      resume: Boolean(knownCliSessionId),
      provider: normalizedProvider,
      protocol: wsProtocol,
      statusTls: statusResult?.tls,
      protocolOverride: gatewayWsProtocolOverrideRef.current,
    });

    ws.onopen = () => {
      if (disposedRef.current) return;
      if (wsRef.current !== ws) return;
      openedAt = Date.now();
      gatewayWsProtocolOverrideRef.current = null;
      connectInFlightRef.current = false;
      reconnectDelayRef.current = 1000;
      dispatchTerminalState({ type: 'websocket_opened' });
      console.info('[native-cli-terminal] websocket opened', {
        agentId,
        sessionKey,
      });
      mountRef_cb.current.fitTerminalToContent();
      const term = termRef.current;
      if (term) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      if (!knownCliSessionId) mountRef_cb.current.settleReadyWithoutInitialOutput();
    };

    ws.onmessage = (event) => {
      if (disposedRef.current) return;
      if (wsRef.current !== ws) return;
      try {
        const msg = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (msg.type !== 'data') {
          console.debug('[native-cli-terminal] websocket message', {
            agentId,
            sessionKey,
            type: msg.type,
          });
        }
        if (msg.type === 'data' && typeof msg.data === 'string') {
          mountRef_cb.current.handleTerminalData(msg.data);
        } else if (msg.type === 'assistant_turn_start') {
          suppressNativeCliChromeRef.current = false;
          const turnId = typeof msg.turnId === 'string' ? msg.turnId : '';
          const conversationId = typeof msg.conversationId === 'string' ? msg.conversationId : '';
          const userText = typeof msg.userText === 'string' ? msg.userText : '';
          console.info('[native-cli-terminal] assistant turn start', {
            agentId,
            sessionKey,
            turnId,
            conversationId,
            message: messageDiagnostic(userText),
          });
          if (turnId) mountRef_cb.current.upsertTerminalTurn({ kind: 'turn_start', conversationId, turnId, userText });
        } else if (msg.type === 'assistant_idle' && typeof msg.turnId === 'string') {
          console.info('[native-cli-terminal] assistant idle', {
            agentId,
            sessionKey,
            turnId: msg.turnId,
          });
          mountRef_cb.current.handleTerminalStreamMarker({ kind: 'turn_idle', conversationId: String(msg.conversationId ?? ''), turnId: msg.turnId });
        } else if (msg.type === 'assistant_turn_end' && typeof msg.turnId === 'string') {
          console.info('[native-cli-terminal] assistant turn end', {
            agentId,
            sessionKey,
            turnId: msg.turnId,
          });
          mountRef_cb.current.handleTerminalStreamMarker({ kind: 'turn_end', conversationId: String(msg.conversationId ?? ''), turnId: msg.turnId });
        } else if (msg.type === 'session_id' && typeof msg.sessionId === 'string') {
          console.info('[native-cli-terminal] session id received', { agentId, sessionKey });
          mountRef_cb.current.bindNativeCliSessionId(msg.sessionId);
        } else if (msg.type === 'exit' && userHasInteractedRef.current) {
          termRef.current?.write(`\r\n\x1b[33m[process exited: ${String(msg.code ?? 0)}]\x1b[0m\r\n`);
        }
      } catch {
        if (typeof event.data === 'string') mountRef_cb.current.handleTerminalData(event.data);
      }
    };

    ws.onclose = () => {
      if (disposedRef.current) return;
      if (wsRef.current !== ws) return;
      if (wsRef.current === ws) wsRef.current = null;
      connectInFlightRef.current = false;
      dispatchTerminalState({ type: 'websocket_closed' });
      initialOutputPendingPaintRef.current = false;
      const suppressDisconnectBanner = suppressNextDisconnectBannerRef.current;
      suppressNextDisconnectBannerRef.current = false;
      if (!suppressDisconnectBanner && userHasInteractedRef.current) {
        termRef.current?.write('\r\n\x1b[31m[disconnected]\x1b[0m\r\n');
      }
      if (!openedAt) {
        const nextProtocol = wsProtocol === 'ws' ? 'wss' : 'ws';
        if (gatewayWsProtocolOverrideRef.current !== nextProtocol) {
          gatewayWsProtocolOverrideRef.current = nextProtocol;
          reconnectDelayRef.current = 50;
          console.warn('[native-cli-terminal] websocket closed before open; retrying alternate gateway protocol', {
            agentId,
            sessionKey,
            failedProtocol: wsProtocol,
            nextProtocol,
            statusTls: statusResult?.tls,
          });
        }
      } else if (Date.now() - openedAt < 400) {
        reconnectDelayRef.current = Math.min(Math.max(reconnectDelayRef.current * 2, 2000), 60_000);
      }
      if (!reconnectTimerRef.current) {
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          void mountRef_cb.current.connect();
        }, reconnectDelayRef.current);
        reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, 30_000);
      }
      console.info('[native-cli-terminal] websocket closed', {
        agentId,
        sessionKey,
      });
    };

    ws.onerror = () => {
      if (disposedRef.current) return;
      if (wsRef.current !== ws) return;
      connectInFlightRef.current = false;
      dispatchTerminalState({ type: 'websocket_error' });
      initialOutputPendingPaintRef.current = false;
    };
  }, [
    agentId,
    bindNativeCliSessionId,
    effectiveProvider,
    normalizedProvider,
    persistState,
    resetVisibleTerminalForResume,
    sessionKey,
  ]);

  const decorateLocalTerminalTurn = useCallback((userText: string): NativeClaudeLiveTurn | null => {
    const marker: Extract<TerminalStreamMarker, { kind: 'turn_start' }> = {
      kind: 'turn_start',
      conversationId: 'local',
      turnId: `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      userText,
    };
    upsertTerminalTurn(marker);
    const register = startClaudeLiveStream(marker.turnId, userText);
    const markerRaw = encodeTerminalStreamMarker(marker);
    termRef.current?.write(markerRaw);
    persistState();
    return register ? { turnId: marker.turnId, register } : null;
  }, [persistState, startClaudeLiveStream, upsertTerminalTurn]);

  const sendShellCompose = useCallback((text: string, notifyUserText = true): boolean => {
    const diagnostic = messageDiagnostic(text);
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) {
      dispatchTerminalState({ type: 'websocket_closed' });
      requestReconnectSoon('send_shell_compose_socket_not_open');
      console.warn('[native-cli-terminal] send blocked: websocket not open', {
        agentId,
        sessionKey,
        mode: 'pty_input',
        wsState: wsReadyStateName(ws?.readyState),
        message: diagnostic,
      });
      return false;
    }
    if (notifyUserText) onUserText?.(text);
    suppressNativeCliChromeRef.current = false;
    if (!userHasInteractedRef.current) {
      userHasInteractedRef.current = true;
    }
    const payloads = shellComposeToPtyInput(text);
    console.info('[native-cli-terminal] sending shell compose', {
      agentId,
      sessionKey,
      message: diagnostic,
      payloadCount: payloads.length,
      payloadLengths: payloads.map((payload) => payload.length),
    });
    for (const payload of payloads) {
      const sent = sendTerminalData(payload);
      if (!sent) return false;
    }
    persistState();
    return true;
  }, [agentId, onUserText, persistState, requestReconnectSoon, sendTerminalData, sessionKey]);

  const sendText = useCallback(async (text: string): Promise<boolean> => {
    if (!text.trim()) return false;
    const startedAt = Date.now();
    const ws = wsRef.current;
    const diagnostic = messageDiagnostic(text);
    if (ws?.readyState !== WebSocket.OPEN) {
      dispatchTerminalState({ type: 'websocket_closed' });
      requestReconnectSoon('send_text_socket_not_open');
      console.warn('[native-cli-terminal] send blocked: websocket not open', {
        agentId,
        sessionKey,
        mode: 'user_text',
        wsState: wsReadyStateName(ws?.readyState),
        message: diagnostic,
      });
      return false;
    }
    const useNativeCliChatCompose = effectiveProvider === 'claude';
    const launchPassthrough = !useNativeCliChatCompose && shouldLaunchShellPassthrough(text);
    console.info('[native-cli-terminal] sendText route', {
      agentId,
      sessionKey,
      message: diagnostic,
      provider: effectiveProvider,
      transport: useNativeCliChatCompose ? 'pty_compose' : 'user_text',
      shellPassthrough: shellPassthroughRef.current,
      launchPassthrough,
      cliSessionBound: Boolean(cliSessionIdRef.current),
      activeTurn: activeTerminalTurnIdRef.current,
      terminalState: terminalState.status,
      dataFrames: terminalDataFrameCountRef.current,
      lastDataAgoMs: terminalDataLastAtRef.current ? Date.now() - terminalDataLastAtRef.current : null,
    });
    if (useNativeCliChatCompose && liveAssistantStreaming) {
      console.warn('[native-cli-terminal] send blocked: claude turn still streaming', {
        agentId,
        sessionKey,
        message: diagnostic,
        liveAssistantId: liveAssistantMessage?.id,
        activeTurn: activeTerminalTurnIdRef.current,
      });
      return false;
    }
    if (shellPassthroughRef.current || launchPassthrough) {
      const sent = sendShellCompose(text);
      if (!sent) return false;
      if (launchPassthrough) shellPassthroughRef.current = true;
      startCliSessionIdFallbackResolver(text, startedAt);
      return true;
    }
    onUserText?.(text);
    suppressNativeCliChromeRef.current = false;
    if (!userHasInteractedRef.current) {
      userHasInteractedRef.current = true;
    }
    const composeStartedAt = performance.now();
    const liveTurn = decorateLocalTerminalTurn(text);
    if (liveTurn?.register) {
      liveTurn.register.catch(() => {
        // Failure is logged by startClaudeLiveStream; sending should not wait on live UI registration.
      });
    }
    if (useNativeCliChatCompose) {
      const payloads = claudePromptToPtyInput(text);
      const sendStartedAt = performance.now();
      console.info('[native-cli-terminal] sending claude pty compose', {
        agentId,
        sessionKey,
        message: diagnostic,
        payloadCount: payloads.length,
        payloadLengths: payloads.map((payload) => payload.length),
        handoffMs: Math.round(performance.now() - composeStartedAt),
      });
      for (let index = 0; index < payloads.length; index += 1) {
        const sent = sendTerminalData(payloads[index], {
          startedAt: sendStartedAt,
          frame: index + 1,
          total: payloads.length,
        });
        if (!sent) return false;
      }
    } else {
      console.info('[native-cli-terminal] sending user_text', { agentId, sessionKey, message: diagnostic });
      ws.send(JSON.stringify({ type: 'user_text', text }));
    }
    startCliSessionIdFallbackResolver(text, startedAt);
    persistState();
    return true;
  }, [agentId, decorateLocalTerminalTurn, effectiveProvider, liveAssistantMessage?.id, liveAssistantStreaming, onUserText, persistState, requestReconnectSoon, sendShellCompose, sendTerminalData, sessionKey, startCliSessionIdFallbackResolver, terminalState.status]);

  const handleChatInputSend = useCallback((text: string): boolean | Promise<boolean> => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    const ws = wsRef.current;
    const diagnostic = messageDiagnostic(trimmed);
    if (terminalWsUrlRef.current) {
      console.info('[native-cli-terminal] terminal websocket url', terminalWsUrlRef.current);
    }
    console.info('[native-cli-terminal] chat input handoff', {
      agentId,
      sessionKey,
      message: diagnostic,
      wsState: wsReadyStateName(ws?.readyState),
      terminalState: terminalState.status,
      shellPassthrough: shellPassthroughRef.current,
      cliSessionBound: Boolean(cliSessionIdRef.current),
      activeTurn: activeTerminalTurnIdRef.current,
      canSend: nativeCliTerminalCanSend(terminalState),
    });
    if (ws?.readyState !== WebSocket.OPEN) {
      dispatchTerminalState({ type: 'websocket_closed' });
      requestReconnectSoon('chat_input_socket_not_open');
      console.warn('[native-cli-terminal] send rejected: websocket not open', {
        agentId,
        sessionKey,
        wsState: wsReadyStateName(ws?.readyState),
        message: diagnostic,
      });
      return false;
    }
    if (effectiveProvider !== 'claude' && shellPassthroughRef.current) {
      return sendShellCompose(trimmed);
    }
    return sendText(trimmed);
  }, [agentId, effectiveProvider, requestReconnectSoon, sendShellCompose, sendText, sessionKey, terminalState]);

  const handleModelChange = useCallback(async (modelId: string) => {
    const upstreamModel = normalizeOneApiModelId(modelId);
    if (!upstreamModel) return;

    await useModelsStore.getState().setCurrentModel(upstreamModel);

    if (effectiveProvider !== 'claude' || !agent?.runtime?.nativeCli) return;

    const routeModel = activeClaudeProxyRouteModelRef.current || configuredClaudeProxyRouteModel || upstreamModel;
    activeClaudeProxyRouteModelRef.current = routeModel;
    await updateClaudeProxyModel(routeModel, upstreamModel);

    const nativeCli = agent.runtime.nativeCli;
    await hostApiFetch(`/api/agents/${encodeURIComponent(agentId)}/runtime`, {
      method: 'PUT',
      body: JSON.stringify({
        runtime: {
          ...agent.runtime,
          nativeCli: {
            ...nativeCli,
            env: {
              ...(nativeCli.env ?? {}),
              ANTHROPIC_BASE_URL: getClaudeProxyBaseUrl(upstreamModel),
              ANTHROPIC_MODEL: CLAUDE_NATIVE_SONNET_ALIAS,
              ANTHROPIC_DEFAULT_SONNET_MODEL: CLAUDE_NATIVE_SONNET_ALIAS,
              ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: upstreamModel,
              ANTHROPIC_DEFAULT_OPUS_MODEL: CLAUDE_NATIVE_OPUS_ALIAS,
              ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: upstreamModel,
              ANTHROPIC_DEFAULT_HAIKU_MODEL: CLAUDE_NATIVE_HAIKU_ALIAS,
              ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: upstreamModel,
              CLAWX_NATIVE_CLAUDE_UPSTREAM_MODEL: upstreamModel,
            },
          },
        },
      }),
    });
    void refreshAgents().catch((error) => console.warn('[native-cli-terminal] Failed to refresh agents after model switch:', error));

    void sendText(`/model ${CLAUDE_NATIVE_SONNET_ALIAS}`);
  }, [agent, agentId, configuredClaudeProxyRouteModel, effectiveProvider, refreshAgents, sendText]);

  // Stable ref for mount-effect callbacks so the terminal instance survives
  // callback identity changes (e.g. normalizedProvider undefined → 'claude').
  const mountRef_cb = useRef({
    connect, sendTerminalData, fitTerminalToContent, scheduleTerminalResize,
    maybeSettleInitialOutput, handleTerminalStreamMarker, persistState,
    handleTerminalData, upsertTerminalTurn, bindNativeCliSessionId,
    settleReadyWithoutInitialOutput, resetVisibleTerminalForResume,
    updateInputShellStateFromTerminalScroll, restartTerminalForSkillReload,
    closeClaudeLiveStream,
  });
  mountRef_cb.current = {
    connect, sendTerminalData, fitTerminalToContent, scheduleTerminalResize,
    maybeSettleInitialOutput, handleTerminalStreamMarker, persistState,
    handleTerminalData, upsertTerminalTurn, bindNativeCliSessionId,
    settleReadyWithoutInitialOutput, resetVisibleTerminalForResume,
    updateInputShellStateFromTerminalScroll, restartTerminalForSkillReload,
    closeClaudeLiveStream,
  };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    disposedRef.current = false;

    const persisted = loadPersistedTerminalState(sessionKey);
    const initialCliSessionId = resolveStoredCliSessionId(sessionKey, cliSessionIdPropRef.current) || persisted.cliSessionId || '';
    cliSessionIdRef.current = initialCliSessionId;
    userHasInteractedRef.current = Boolean(cliSessionIdRef.current || persisted.userHasInteracted);
    pendingLocalUserMessagesRef.current = [];
    terminalTurnsRef.current = [];
    activeTerminalTurnIdRef.current = null;
    setActiveTranscriptTurnId(null);
    setLiveAssistantMessage(null);
    setLiveAssistantStreaming(false);
    bufferRef.current = stripTerminalStreamMarkers(persisted.buffer ?? '');
    dispatchTerminalState({
      type: 'connect_requested',
      phase: initialCliSessionId ? 'resuming' : 'starting',
    });
    initialOutputPendingPaintRef.current = false;

    const term = createTerminalInstance();
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.parser.registerOscHandler(777, (data: string) => {
      if (shellPassthroughRef.current) return false;
      const marker = decodeTerminalOscMarker(data);
      if (!marker) return false;
      mountRef_cb.current.handleTerminalStreamMarker(marker);
      return true;
    });
    term.open(mount);
    if (bufferRef.current) {
      term.write(bufferRef.current);
    }
    term.onData((data) => {
      mountRef_cb.current.sendTerminalData(data);
    });
    term.onResize(({ cols, rows }) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    });
    term.onScroll(() => {
      mountRef_cb.current.updateInputShellStateFromTerminalScroll();
    });
    term.onWriteParsed(() => {
      mountRef_cb.current.maybeSettleInitialOutput();
      mountRef_cb.current.updateInputShellStateFromTerminalScroll();
    });
    term.onRender(() => {
      mountRef_cb.current.maybeSettleInitialOutput();
    });

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    resizeObserverRef.current = new ResizeObserver(() => {
      mountRef_cb.current.scheduleTerminalResize();
    });
    const observedResizeTargets = new Set<Element>();
    const observeResizeTarget = (target: Element | null | undefined) => {
      if (!target || observedResizeTargets.has(target)) return;
      observedResizeTargets.add(target);
      resizeObserverRef.current?.observe(target);
    };
    observeResizeTarget(areaRef.current);
    observeResizeTarget(mountRef.current);
    let parent: HTMLElement | null = mount.parentElement;
    for (let depth = 0; parent && depth < 6; depth += 1) {
      observeResizeTarget(parent);
      parent = parent.parentElement;
    }

    const handleWindowResize = () => {
      mountRef_cb.current.scheduleTerminalResize();
    };
    window.addEventListener('resize', handleWindowResize);
    window.visualViewport?.addEventListener('resize', handleWindowResize);
    window.addEventListener('orientationchange', handleWindowResize);

    mountRef_cb.current.scheduleTerminalResize();

    void mountRef_cb.current.connect();

    return () => {
      disposedRef.current = true;
      dispatchTerminalState({ type: 'disposed' });
      mountRef_cb.current.closeClaudeLiveStream();
      mountRef_cb.current.persistState();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (transcriptPollTimerRef.current) clearInterval(transcriptPollTimerRef.current);
      if (transcriptIdleTimerRef.current) clearTimeout(transcriptIdleTimerRef.current);
      if (resizeRafRef.current) cancelAnimationFrame(resizeRafRef.current);
      if (initialOutputRafRef.current) cancelAnimationFrame(initialOutputRafRef.current);
      if (loadingExitTimerRef.current) clearTimeout(loadingExitTimerRef.current);
      reconnectTimerRef.current = null;
      transcriptPollTimerRef.current = null;
      transcriptIdleTimerRef.current = null;
      initialOutputPendingPaintRef.current = false;
      resizeObserverRef.current?.disconnect();
      window.removeEventListener('resize', handleWindowResize);
      window.visualViewport?.removeEventListener('resize', handleWindowResize);
      window.removeEventListener('orientationchange', handleWindowResize);
      const ws = wsRef.current;
      wsRef.current = null;
      ws?.close();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionKey]);

  useEffect(() => {
    const nextCliSessionId = cliSessionId?.trim() || '';
    if (!nextCliSessionId || nextCliSessionId === cliSessionIdRef.current) return;
    bindNativeCliSessionId(nextCliSessionId);
    const ws = wsRef.current;
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      void mountRef_cb.current.connect();
    } else if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      // Close current connection — onClose handler will trigger reconnect
      // which now has the correct cliSessionId in cliSessionIdRef.
      ws.close();
    }
  }, [bindNativeCliSessionId, cliSessionId]);

  useEffect(() => (
    addNativeCliAgentSkillsChangedListener((detail) => {
      if (detail.agentId !== agentId) return;
      mountRef_cb.current.restartTerminalForSkillReload(detail.skillCount);
    })
  ), [agentId]);

  useEffect(() => {
    void loadNativeCliTranscript({ latest: true, quiet: true });
  }, [loadNativeCliTranscript]);

  useEffect(() => {
    if (transcriptPollTimerRef.current) {
      clearInterval(transcriptPollTimerRef.current);
      transcriptPollTimerRef.current = null;
    }
    const shouldPoll = terminalState.status === 'connected'
      && !liveAssistantStreaming
      && !liveStreamRef.current
      && Boolean(activeTranscriptTurnId);
    if (!shouldPoll) return;
    transcriptPollTimerRef.current = setInterval(() => {
      void loadNativeCliTranscript({ quiet: true, latest: !cliSessionIdRef.current });
    }, TRANSCRIPT_ACTIVE_POLL_MS);
    return () => {
      if (transcriptPollTimerRef.current) {
        clearInterval(transcriptPollTimerRef.current);
        transcriptPollTimerRef.current = null;
      }
    };
  }, [activeTranscriptTurnId, liveAssistantStreaming, loadNativeCliTranscript, terminalState.status]);

  const nativeCliInputDisabled = wsRef.current?.readyState !== WebSocket.OPEN && !nativeCliTerminalCanSend(terminalState);
  const desiredLoadingLabel = nativeCliInputDisabled ? nativeCliTerminalLoadingLabel(terminalState) : '';

  useEffect(() => {
    if (loadingExitTimerRef.current) {
      clearTimeout(loadingExitTimerRef.current);
      loadingExitTimerRef.current = null;
    }

    if (desiredLoadingLabel) {
      setDisplayedLoadingLabel(desiredLoadingLabel);
      setLoadingExiting(false);
      return;
    }

    if (!displayedLoadingLabel) return;
    setLoadingExiting(true);
    loadingExitTimerRef.current = setTimeout(() => {
      setDisplayedLoadingLabel('');
      setLoadingExiting(false);
      loadingExitTimerRef.current = null;
    }, 180);
  }, [desiredLoadingLabel, displayedLoadingLabel]);

  useEffect(() => {
    if (!awaitingInitialOutput) return;
    const timer = window.setInterval(() => {
      settleIfTerminalAlreadyVisible();
    }, 250);
    settleIfTerminalAlreadyVisible();
    return () => window.clearInterval(timer);
  }, [awaitingInitialOutput, settleIfTerminalAlreadyVisible]);

  const displayedTranscriptMessages = useMemo(() => {
    if (!liveAssistantMessage) return transcriptMessages;
    const liveTurnId = nativeCliLiveTurnId(liveAssistantMessage);
    const liveTurn = liveTurnId
      ? terminalTurnsRef.current.find((turn) => turn.id === liveTurnId)
      : undefined;
    const transcriptHasLiveAssistant = transcriptContainsLiveAssistantForTurn(
      transcriptMessages,
      liveAssistantMessage,
      liveTurn,
    );
    if (!liveAssistantStreaming && transcriptHasLiveAssistant) return transcriptMessages;
    const result: RawMessage[] = [];
    let insertedLive = false;
    const transcriptUserForLiveTurn = findNativeCliTranscriptUserForTurn(transcriptMessages, liveTurn);
    const liveAnchorId = String(transcriptUserForLiveTurn?.id ?? liveTurnId);
    for (const message of transcriptMessages) {
      if (message.id === liveAssistantMessage.id) continue;
      result.push(message);
      if (liveAnchorId && message.id === liveAnchorId) {
        result.push(liveAssistantMessage);
        insertedLive = true;
      }
    }
    if (!insertedLive) {
      if (liveTurn && !transcriptUserForLiveTurn) {
        result.push({
          id: liveTurn.id,
          role: 'user',
          content: liveTurn.userText,
          timestamp: liveTurn.startedAt,
        });
      }
      result.push(liveAssistantMessage);
    }
    return dedupeNativeCliMessages(result);
  }, [liveAssistantMessage, liveAssistantStreaming, transcriptMessages]);

  return (
    <div className="native-cli-terminal">
      <NativeCliTerminalStyles />
      <div ref={areaRef} className="native-cli-terminal__area">
        <div ref={mountRef} className="native-cli-terminal__mount" />
        <div ref={transcriptScrollRef} className="native-cli-terminal__transcript">
          <div className="native-cli-terminal__messages">
            {displayedTranscriptMessages.length > 0 ? (
              displayedTranscriptMessages.map((message, index) => (
                <ChatMessage
                  key={isLiveAssistantMessage(message, liveAssistantMessage) ? message.id : nativeCliMessageKey(message, index)}
                  message={message}
                  showThinking
                  isStreaming={isLiveAssistantMessage(message, liveAssistantMessage) && liveAssistantStreaming}
                />
              ))
            ) : (
              <div className="native-cli-terminal__empty">
                {displayedLoadingLabel || 'No messages yet'}
              </div>
            )}
          </div>
        </div>
        {displayedLoadingLabel ? (
          <div
            className={`native-cli-terminal__loading${loadingExiting ? ' native-cli-terminal__loading--exiting' : ''}`}
            role="status"
            aria-live="polite"
          >
            <div className="native-cli-terminal__loading-inner">
              <Loader2 />
              <span>{displayedLoadingLabel}</span>
            </div>
          </div>
        ) : null}
      </div>
      <div className="native-cli-terminal__composer pointer-events-none">
        <div className="native-cli-terminal__composer-spacer" />
        <div className="native-cli-terminal__composer-inner pointer-events-auto">
          <ChatInput
            onSend={handleChatInputSend}
            onModelChange={handleModelChange}
            disabled={nativeCliInputDisabled}
            disabledPlaceholder={desiredLoadingLabel || '正在连接会话'}
            sending={false}
            isExpanded={inputShellState !== 'collapsed'}
            onFocusChange={handleInputFocusChange}
          />
        </div>
      </div>
    </div>
  );
}
