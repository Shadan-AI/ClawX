import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import {
  Loader2,
} from 'lucide-react';
import { invokeIpc } from '@/lib/api-client';
import { hostApiFetch } from '@/lib/host-api';
import { useChatStore } from '@/stores/chat';
import {
  initialNativeCliTerminalState,
  nativeCliTerminalCanSend,
  nativeCliTerminalLoadingLabel,
  nativeCliTerminalReducer,
} from '@/lib/native-cli-terminal-state';
import { ChatInput } from './ChatInput';
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
const TERMINAL_USER_ECHO_DEBOUNCE_MS = 96;
const TERMINAL_ESCAPE = String.fromCharCode(27);
const TERMINAL_BELL = String.fromCharCode(7);
const TERMINAL_OSC_PATTERN = new RegExp(`${TERMINAL_ESCAPE}\\][^${TERMINAL_BELL}]*(?:${TERMINAL_BELL}|${TERMINAL_ESCAPE}\\\\)`, 'g');
const TERMINAL_CSI_PATTERN = new RegExp(`${TERMINAL_ESCAPE}\\[[0-?]*[ -/]*[@-~]`, 'g');
const TERMINAL_CHARSET_PATTERN = new RegExp(`${TERMINAL_ESCAPE}[()][A-Za-z0-9]`, 'g');
const NATIVE_CLI_SESSION_KEY_PATTERN = /^agent:[^:]+:cli:/i;

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
    sessionStorage.setItem(storageKey(sessionKey), JSON.stringify(state));
  } catch {
    // Ignore quota/storage failures; session resume still works via cliSessionId.
  }
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
  userText: string;
  startedAt: number;
}): Promise<string> {
  try {
    const response = await hostApiFetch<HostNativeCliResolveResponse>(RUNTIME_NATIVE_CLI_RESOLVE_PATH, {
      method: 'POST',
      body: JSON.stringify({
        sessionKey: params.sessionKey,
        provider: normalizeProvider(params.provider),
        userText: params.userText,
        startedAt: params.startedAt,
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
    disableStdin: false,
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

function compactTerminalLineText(text: string) {
  return text.replace(/\s+/g, '').trim();
}

function terminalLineContainsUserText(lineText: string, userText: string) {
  const normalizedLine = normalizeTerminalLineText(lineText);
  const normalizedUser = normalizeTerminalLineText(userText);
  if (normalizedUser && normalizedLine.includes(normalizedUser)) return true;
  const compactLine = compactTerminalLineText(lineText);
  const compactUser = compactTerminalLineText(userText);
  return Boolean(compactUser && compactLine.includes(compactUser));
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
        position: absolute;
        inset: 0;
        min-height: 0;
        overflow: hidden;
        background: var(--native-cli-background);
      }
      .native-cli-terminal__mount {
        --terminal-content-inset: max(24px, calc((100% - var(--terminal-screen-width)) / 2));
        position: absolute;
        top: 20px;
        bottom: 132px;
        left: 0;
        width: 100%;
        overflow: hidden;
        background: var(--native-cli-background);
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
      .native-cli-terminal__mount .xterm-rows div.openclaw-user-echo-row {
        display: flex !important;
        justify-content: flex-end;
        align-items: center;
        width: min(var(--terminal-content-width), calc(100% - 48px)) !important;
        min-height: 2.2em;
        padding: 8px 0;
        pointer-events: auto;
        color: transparent !important;
      }
      .native-cli-terminal__mount .xterm-rows div.openclaw-user-echo-row * {
        visibility: hidden !important;
      }
      .native-cli-terminal__mount .xterm-rows div.openclaw-user-echo-row::after {
        content: attr(data-openclaw-user-text);
        display: block;
        max-width: min(72%, 680px);
        padding: 10px 16px;
        border-radius: 18px 18px 6px 18px;
        background: #f3f3f3;
        color: #1a1a1a;
        font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        font-size: 15px;
        font-weight: 400;
        line-height: 1.6;
        visibility: visible !important;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
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
  const userEchoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userEchoRafRef = useRef<number>(0);
  const rowsObserverRef = useRef<MutationObserver | null>(null);
  const terminalTurnsRef = useRef<TerminalTurn[]>([]);
  const activeTerminalTurnIdRef = useRef<string | null>(null);
  const markerBufferRef = useRef('');
  const bufferRef = useRef('');
  const recentOutputRef = useRef('');
  const userHasInteractedRef = useRef(false);
  const shellPassthroughRef = useRef(false);
  const cliSessionIdRef = useRef('');
  const activeSessionResolveRef = useRef('');
  const initialOutputRafRef = useRef<number>(0);
  const initialOutputPendingPaintRef = useRef(false);
  const loadingExitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cliSessionIdPropRef = useRef(cliSessionId);
  const sessionTitleRef = useRef(sessionTitle);
  const sessionUpdatedAtRef = useRef(sessionUpdatedAt);
  const skipResumeResolveRef = useRef(false);
  const reconnectDelayRef = useRef(1000);
  const disposedRef = useRef(false);

  const [terminalState, dispatchTerminalState] = useReducer(
    nativeCliTerminalReducer,
    initialNativeCliTerminalState,
  );
  const awaitingInitialOutput = terminalState.awaitingInitialOutput;
  const [displayedLoadingLabel, setDisplayedLoadingLabel] = useState('');
  const [loadingExiting, setLoadingExiting] = useState(false);
  const [inputShellState, setInputShellState] = useState<InputShellState>('auto');
  const inputShellStateRef = useRef<InputShellState>(inputShellState);

  const normalizedProvider = useMemo(() => normalizeProvider(cliSessionProvider), [cliSessionProvider]);

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

  const clearTerminalUserEchoRow = useCallback((row: HTMLElement) => {
    row.classList.remove('openclaw-user-echo-row');
    row.removeAttribute('data-openclaw-user-text');
  }, []);

  const resetVisibleTerminalForResume = useCallback(() => {
    termRef.current?.clear();
    bufferRef.current = '';
    markerBufferRef.current = '';
    recentOutputRef.current = '';
    terminalTurnsRef.current = [];
    activeTerminalTurnIdRef.current = null;
    userHasInteractedRef.current = true;
    persistState();
  }, [persistState]);

  const decorateTerminalUserEchoRow = useCallback((row: HTMLElement, userText: string) => {
    const trimmed = userText.trim();
    if (row.classList.contains('openclaw-user-echo-row') && row.dataset.openclawUserText === trimmed) return;
    row.classList.add('openclaw-user-echo-row');
    row.dataset.openclawUserText = trimmed;
  }, []);

  const matchingUserEchoTurn = useCallback((...lineTexts: string[]) => {
    if (lineTexts.map(normalizeTerminalLineText).filter(Boolean).length === 0) return null;
    for (const turn of [...terminalTurnsRef.current].reverse()) {
      if (lineTexts.some((lineText) => terminalLineContainsUserText(lineText, turn.userText))) return turn;
    }
    return null;
  }, []);

  const styleVisibleTerminalUserEchoes = useCallback(() => {
    if (shellPassthroughRef.current) return;
    const term = termRef.current;
    const rowsContainer = mountRef.current?.querySelector<HTMLElement>('.xterm-rows');
    if (!term || !rowsContainer) return;

    const observer = rowsObserverRef.current;
    observer?.disconnect();
    try {
      const rows = [...rowsContainer.querySelectorAll<HTMLElement>(':scope > div')];
      const buffer = term.buffer.active;
      const viewportY = buffer.viewportY;
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex];
        const line = buffer.getLine(viewportY + rowIndex);
        if (!line) {
          clearTerminalUserEchoRow(row);
          continue;
        }
        const turn = matchingUserEchoTurn(line.translateToString(true), row.textContent ?? '');
        if (turn) {
          decorateTerminalUserEchoRow(row, turn.userText);
        } else {
          clearTerminalUserEchoRow(row);
        }
      }
    } finally {
      observer?.observe(rowsContainer, { childList: true, subtree: true, characterData: true });
    }
  }, [clearTerminalUserEchoRow, decorateTerminalUserEchoRow, matchingUserEchoTurn]);

  const scheduleTerminalUserEchoStyle = useCallback((immediate = false) => {
    if (shellPassthroughRef.current) return;
    if (userEchoTimerRef.current) {
      clearTimeout(userEchoTimerRef.current);
      userEchoTimerRef.current = null;
    }
    const run = () => {
      if (userEchoRafRef.current) return;
      userEchoRafRef.current = requestAnimationFrame(() => {
        userEchoRafRef.current = 0;
        styleVisibleTerminalUserEchoes();
      });
    };
    if (immediate) {
      run();
    } else {
      userEchoTimerRef.current = setTimeout(run, TERMINAL_USER_ECHO_DEBOUNCE_MS);
    }
  }, [styleVisibleTerminalUserEchoes]);

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

  const ensureRowsObserver = useCallback(() => {
    if (rowsObserverRef.current) return;
    const rows = mountRef.current?.querySelector<HTMLElement>('.xterm-rows');
    if (!rows) return;
    rowsObserverRef.current = new MutationObserver(() => scheduleTerminalUserEchoStyle());
    rowsObserverRef.current.observe(rows, { childList: true, subtree: true, characterData: true });
  }, [scheduleTerminalUserEchoStyle]);

  const upsertTerminalTurn = useCallback((marker: Extract<TerminalStreamMarker, { kind: 'turn_start' }>) => {
    const existing = terminalTurnsRef.current.find((turn) => turn.id === marker.turnId);
    if (existing) {
      existing.conversationId = marker.conversationId;
      existing.userText = marker.userText;
      existing.state = 'active';
      activeTerminalTurnIdRef.current = existing.id;
      scheduleTerminalUserEchoStyle(true);
      return;
    }

    const localTurn = terminalTurnsRef.current.find((turn) => (
      turn.id.startsWith('local-') &&
      turn.state === 'active' &&
      normalizeTerminalLineText(turn.userText) === normalizeTerminalLineText(marker.userText)
    ));
    if (localTurn && !marker.turnId.startsWith('local-')) {
      localTurn.id = marker.turnId;
      localTurn.conversationId = marker.conversationId;
      localTurn.userText = marker.userText;
      activeTerminalTurnIdRef.current = localTurn.id;
      scheduleTerminalUserEchoStyle(true);
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
      },
    ];
    terminalTurnsRef.current = nextTurns.slice(-25);
    activeTerminalTurnIdRef.current = marker.turnId;
    scheduleTerminalUserEchoStyle(true);
  }, [scheduleTerminalUserEchoStyle]);

  const handleTerminalStreamMarker = useCallback((marker: TerminalStreamMarker) => {
    if (marker.kind === 'turn_start') {
      upsertTerminalTurn(marker);
      return;
    }
    const turn = terminalTurnsRef.current.find((candidate) => candidate.id === marker.turnId);
    if (!turn) return;
    turn.state = marker.kind === 'turn_idle' ? 'idle' : 'closed';
    if (activeTerminalTurnIdRef.current === marker.turnId && marker.kind === 'turn_end') {
      activeTerminalTurnIdRef.current = null;
    }
    scheduleTerminalUserEchoStyle(true);
  }, [scheduleTerminalUserEchoStyle, upsertTerminalTurn]);

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
    recentOutputRef.current = `${recentOutputRef.current}${chunk}`.slice(-TERMINAL_SHELL_PASSTHROUGH_BUFFER_CHARS);
    if (TERMINAL_SHELL_PASSTHROUGH_SIGNATURES.some((signature) => recentOutputRef.current.includes(signature))) {
      shellPassthroughRef.current = true;
    } else if (shellPassthroughRef.current && /\n[^\n]*[$%#] $/.test(recentOutputRef.current.slice(-240))) {
      shellPassthroughRef.current = false;
    }
  }, []);

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
    const visibleRaw = stripTerminalStreamMarkers(raw);
    updateShellPassthroughState(visibleRaw);
    bufferRef.current = `${bufferRef.current}${raw}`.slice(-100_000);
    persistState();
    const term = termRef.current;
    if (term) {
      term.write(raw, () => {
        if (hasPrintableTerminalContent(visibleRaw)) requestInitialOutputSettle();
      });
    }
    scheduleTerminalUserEchoStyle();
  }, [persistState, requestInitialOutputSettle, scheduleTerminalUserEchoStyle, stripTerminalStreamMarkers, updateShellPassthroughState]);

  const sendTerminalData = useCallback((data: string) => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ type: 'data', data }));
    return true;
  }, []);

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
    const rows = Math.max(1, proposed.rows);
    const screenWidth = `${Math.ceil(cols * cellWidth)}px`;
    area.closest<HTMLElement>('.native-cli-terminal')?.style.setProperty('--terminal-screen-width', screenWidth);
    if (term.cols !== cols || term.rows !== rows) {
      term.resize(cols, rows);
    } else {
      term.refresh(0, Math.max(0, rows - 1));
    }
  }, []);

  const scheduleTerminalResize = useCallback(() => {
    if (resizeRafRef.current) {
      cancelAnimationFrame(resizeRafRef.current);
    }
    resizeRafRef.current = requestAnimationFrame(() => {
      resizeRafRef.current = 0;
      if (disposedRef.current) return;
      fitTerminalToContent();
      scheduleTerminalUserEchoStyle();
      updateInputShellStateFromTerminalScroll();
      requestAnimationFrame(() => {
        if (disposedRef.current) return;
        fitTerminalToContent();
      });
    });
  }, [fitTerminalToContent, scheduleTerminalUserEchoStyle, updateInputShellStateFromTerminalScroll]);

  const connect = useCallback(async () => {
    if (disposedRef.current) return;
    if (!termRef.current) return;
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) return;

    const storedCliSessionId = cliSessionIdRef.current || resolveStoredCliSessionId(sessionKey, cliSessionIdPropRef.current);
    const hasHistoricalTitle = Boolean(sessionTitleRef.current?.trim() && sessionTitleRef.current.trim() !== sessionKey);
    const shouldWaitForResumeSessionId = !storedCliSessionId
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
      if (activeSessionResolveRef.current === resolveKey) return;
      activeSessionResolveRef.current = resolveKey;
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
    if (disposedRef.current) return;
    const port = typeof statusResult?.port === 'number' && statusResult.port > 0 ? statusResult.port : 18789;
    const wsProtocol = statusResult?.tls === true ? 'wss' : 'ws';
    const knownCliSessionId = storedCliSessionId;
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
    const ws = new WebSocket(`${wsProtocol}://127.0.0.1:${port}/terminal?${params.toString()}`);
    wsRef.current = ws;
    let openedAt = 0;

    ws.onopen = () => {
      if (disposedRef.current) return;
      if (wsRef.current !== ws) return;
      openedAt = Date.now();
      reconnectDelayRef.current = 1000;
      dispatchTerminalState({ type: 'websocket_opened' });
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
        if (msg.type === 'data' && typeof msg.data === 'string') {
          mountRef_cb.current.handleTerminalData(msg.data);
        } else if (msg.type === 'assistant_turn_start') {
          const turnId = typeof msg.turnId === 'string' ? msg.turnId : '';
          const conversationId = typeof msg.conversationId === 'string' ? msg.conversationId : '';
          const userText = typeof msg.userText === 'string' ? msg.userText : '';
          if (turnId) mountRef_cb.current.upsertTerminalTurn({ kind: 'turn_start', conversationId, turnId, userText });
        } else if (msg.type === 'assistant_idle' && typeof msg.turnId === 'string') {
          mountRef_cb.current.handleTerminalStreamMarker({ kind: 'turn_idle', conversationId: String(msg.conversationId ?? ''), turnId: msg.turnId });
        } else if (msg.type === 'assistant_turn_end' && typeof msg.turnId === 'string') {
          mountRef_cb.current.handleTerminalStreamMarker({ kind: 'turn_end', conversationId: String(msg.conversationId ?? ''), turnId: msg.turnId });
        } else if (msg.type === 'session_id' && typeof msg.sessionId === 'string') {
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
      dispatchTerminalState({ type: 'websocket_closed' });
      initialOutputPendingPaintRef.current = false;
      if (userHasInteractedRef.current) {
        termRef.current?.write('\r\n\x1b[31m[disconnected]\x1b[0m\r\n');
      }
      if (openedAt > 0 && Date.now() - openedAt < 400) {
        reconnectDelayRef.current = Math.min(Math.max(reconnectDelayRef.current * 2, 2000), 60_000);
      }
      if (!reconnectTimerRef.current) {
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          void mountRef_cb.current.connect();
        }, reconnectDelayRef.current);
        reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, 30_000);
      }
    };

    ws.onerror = () => {
      if (disposedRef.current) return;
      if (wsRef.current !== ws) return;
      dispatchTerminalState({ type: 'websocket_error' });
      initialOutputPendingPaintRef.current = false;
    };
  }, [
    agentId,
    bindNativeCliSessionId,
    normalizedProvider,
    persistState,
    resetVisibleTerminalForResume,
    sessionKey,
  ]);

  const decorateLocalTerminalTurn = useCallback((userText: string) => {
    const marker: Extract<TerminalStreamMarker, { kind: 'turn_start' }> = {
      kind: 'turn_start',
      conversationId: 'local',
      turnId: `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      userText,
    };
    upsertTerminalTurn(marker);
    const markerRaw = encodeTerminalStreamMarker(marker);
    termRef.current?.write(markerRaw);
    bufferRef.current = `${bufferRef.current}${markerRaw}`.slice(-100_000);
    persistState();
  }, [persistState, upsertTerminalTurn]);

  const sendShellCompose = useCallback((text: string, notifyUserText = true) => {
    if (notifyUserText) onUserText?.(text);
    if (!userHasInteractedRef.current) {
      userHasInteractedRef.current = true;
      termRef.current?.clear();
    }
    for (const payload of shellComposeToPtyInput(text)) {
      sendTerminalData(payload);
    }
    persistState();
  }, [onUserText, persistState, sendTerminalData]);

  const sendText = useCallback((text: string) => {
    if (!text.trim()) return;
    const startedAt = Date.now();
    onUserText?.(text);
    const launchPassthrough = shouldLaunchShellPassthrough(text);
    if (shellPassthroughRef.current || launchPassthrough) {
      sendShellCompose(text, false);
      if (launchPassthrough) shellPassthroughRef.current = true;
      startCliSessionIdFallbackResolver(text, startedAt);
      return;
    }
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (!userHasInteractedRef.current) {
      userHasInteractedRef.current = true;
      termRef.current?.clear();
    }
    decorateLocalTerminalTurn(text);
    ws.send(JSON.stringify({ type: 'user_text', text }));
    startCliSessionIdFallbackResolver(text, startedAt);
    scheduleTerminalUserEchoStyle(true);
    persistState();
  }, [decorateLocalTerminalTurn, onUserText, persistState, scheduleTerminalUserEchoStyle, sendShellCompose, startCliSessionIdFallbackResolver]);

  const handleChatInputSend = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (shellPassthroughRef.current) {
      sendShellCompose(trimmed);
      return;
    }
    sendText(trimmed);
  }, [sendShellCompose, sendText]);

  // Stable ref for mount-effect callbacks so the terminal instance survives
  // callback identity changes (e.g. normalizedProvider undefined → 'claude').
  const mountRef_cb = useRef({
    connect, sendTerminalData, fitTerminalToContent, scheduleTerminalResize,
    scheduleTerminalUserEchoStyle, ensureRowsObserver,
    maybeSettleInitialOutput, handleTerminalStreamMarker, persistState,
    handleTerminalData, upsertTerminalTurn, bindNativeCliSessionId,
    settleReadyWithoutInitialOutput, resetVisibleTerminalForResume,
    updateInputShellStateFromTerminalScroll,
  });
  mountRef_cb.current = {
    connect, sendTerminalData, fitTerminalToContent, scheduleTerminalResize,
    scheduleTerminalUserEchoStyle, ensureRowsObserver,
    maybeSettleInitialOutput, handleTerminalStreamMarker, persistState,
    handleTerminalData, upsertTerminalTurn, bindNativeCliSessionId,
    settleReadyWithoutInitialOutput, resetVisibleTerminalForResume,
    updateInputShellStateFromTerminalScroll,
  };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    disposedRef.current = false;

    const persisted = loadPersistedTerminalState(sessionKey);
    const initialCliSessionId = resolveStoredCliSessionId(sessionKey, cliSessionIdPropRef.current) || persisted.cliSessionId || '';
    cliSessionIdRef.current = initialCliSessionId;
    userHasInteractedRef.current = Boolean(cliSessionIdRef.current || persisted.userHasInteracted);
    bufferRef.current = initialCliSessionId ? '' : persisted.buffer ?? '';
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
    if (!initialCliSessionId && userHasInteractedRef.current && bufferRef.current) {
      term.write(bufferRef.current);
    }
    term.onData((data) => {
      mountRef_cb.current.sendTerminalData(data);
    });
    term.onResize(({ cols, rows }) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      mountRef_cb.current.scheduleTerminalUserEchoStyle();
    });
    term.onScroll(() => {
      mountRef_cb.current.scheduleTerminalUserEchoStyle();
      mountRef_cb.current.updateInputShellStateFromTerminalScroll();
    });
    term.onWriteParsed(() => {
      mountRef_cb.current.ensureRowsObserver();
      mountRef_cb.current.maybeSettleInitialOutput();
      mountRef_cb.current.scheduleTerminalUserEchoStyle();
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
      mountRef_cb.current.persistState();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (userEchoTimerRef.current) clearTimeout(userEchoTimerRef.current);
      if (userEchoRafRef.current) cancelAnimationFrame(userEchoRafRef.current);
      if (resizeRafRef.current) cancelAnimationFrame(resizeRafRef.current);
      if (initialOutputRafRef.current) cancelAnimationFrame(initialOutputRafRef.current);
      if (loadingExitTimerRef.current) clearTimeout(loadingExitTimerRef.current);
      initialOutputPendingPaintRef.current = false;
      rowsObserverRef.current?.disconnect();
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

  const desiredLoadingLabel = nativeCliTerminalLoadingLabel(terminalState);

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

  return (
    <div className="native-cli-terminal">
      <NativeCliTerminalStyles />
      <div ref={areaRef} className="native-cli-terminal__area">
        <div ref={mountRef} className="native-cli-terminal__mount" />
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
            disabled={!nativeCliTerminalCanSend(terminalState)}
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
