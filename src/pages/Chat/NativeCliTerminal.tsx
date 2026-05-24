import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import {
  Globe,
  Image,
  Mic,
  MoreHorizontal,
  PenLine,
  Plus,
  Send,
  Terminal as TerminalIcon,
  Zap,
} from 'lucide-react';
import { invokeIpc } from '@/lib/api-client';
import '@xterm/xterm/css/xterm.css';

interface NativeCliTerminalProps {
  agentId: string;
  sessionKey: string;
  cliSessionId?: string;
  cliSessionProvider?: string;
}

interface GatewayStatus {
  port: number;
  state: string;
  tls?: boolean;
}

type TerminalStatus = 'disconnected' | 'connecting' | 'connected';

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

const NATIVE_CLI_SESSIONS_KEY = 'openclaw-native-cli-sessions';
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

function storageKey(sessionKey: string) {
  return `openclaw-terminal-state:native-cli:${sessionKey}`;
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
        --native-cli-background: hsl(var(--background));
        --native-cli-foreground: hsl(var(--foreground));
        --native-cli-card: hsl(var(--card));
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        overflow: hidden;
        background: var(--native-cli-background);
        color: var(--native-cli-foreground);
      }
      .native-cli-terminal__area {
        flex: 1;
        min-height: 0;
        overflow: hidden;
        position: relative;
        background: var(--native-cli-background);
      }
      .native-cli-terminal__mount {
        position: absolute;
        top: 20px;
        left: 0;
        width: 100%;
        height: calc(100% - 20px);
        overflow: hidden;
        background: var(--native-cli-background);
      }
      .native-cli-terminal__mount .xterm {
        box-sizing: border-box;
        height: 100%;
        padding: 0;
        background: var(--native-cli-background) !important;
      }
      .native-cli-terminal__mount .xterm-screen {
        background: var(--native-cli-background) !important;
        margin-left: max(24px, calc((100vw - var(--terminal-content-width)) / 2));
      }
      .native-cli-terminal__mount .xterm-screen canvas {
        background: var(--native-cli-background) !important;
      }
      .native-cli-terminal__mount .xterm-helpers {
        left: max(24px, calc((100vw - var(--terminal-content-width)) / 2));
      }
      .native-cli-terminal__mount .xterm-viewport {
        background: var(--native-cli-background) !important;
        overflow-y: auto !important;
      }
      .native-cli-terminal__mount .xterm-rows div.openclaw-user-echo-row {
        display: flex !important;
        justify-content: flex-end;
        align-items: center;
        width: min(var(--terminal-content-width), calc(100vw - 48px)) !important;
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
      .native-cli-terminal__compose {
        flex-shrink: 0;
        position: relative;
        z-index: 4;
        width: 100%;
        padding: 14px max(24px, calc((100vw - var(--terminal-content-width)) / 2)) 18px;
        background: var(--native-cli-background);
      }
      .native-cli-terminal__box {
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-width: var(--terminal-content-width);
        margin: 0 auto;
        border: 1px solid transparent;
        border-radius: 22px;
        background: var(--native-cli-card);
        padding: 14px 14px 12px 16px;
        box-shadow: 0 18px 54px rgb(37 99 235 / .13), 0 2px 10px rgb(15 23 42 / .04);
      }
      .native-cli-terminal__box:focus-within {
        border-color: #bfdbfe;
      }
      .native-cli-terminal textarea {
        resize: none;
        min-height: 44px;
        max-height: 132px;
        border: 0;
        outline: 0;
        padding: 2px 4px;
        background: transparent;
        color: var(--native-cli-foreground);
        font: inherit;
        font-size: 15px;
        line-height: 1.45;
      }
      .native-cli-terminal textarea::placeholder {
        color: #9ca3af;
      }
      .native-cli-terminal__footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        min-height: 34px;
      }
      .native-cli-terminal__tools,
      .native-cli-terminal__actions {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }
      .native-cli-terminal__actions {
        flex-shrink: 0;
        gap: 8px;
      }
      .native-cli-terminal__tool {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        height: 30px;
        padding: 0 8px;
        border-radius: 10px;
        color: var(--native-cli-foreground);
        font-size: 13px;
        white-space: nowrap;
      }
      .native-cli-terminal__tool--icon {
        width: 30px;
        padding: 0;
        justify-content: center;
        border-radius: 999px;
      }
      .native-cli-terminal svg {
        width: 16px;
        height: 16px;
        fill: none;
        stroke: currentColor;
        stroke-width: 2;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .native-cli-terminal__send,
      .native-cli-terminal__voice {
        width: 38px;
        height: 38px;
        border: 0;
        border-radius: 999px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .native-cli-terminal__send {
        cursor: pointer;
        color: #fff;
        background: #2563eb;
      }
      .native-cli-terminal__send:disabled {
        opacity: .45;
        cursor: default;
      }
      .native-cli-terminal__voice {
        color: var(--native-cli-foreground);
        background: hsl(var(--muted));
      }
      @media (max-width: 760px) {
        .native-cli-terminal__tool span { display: none; }
        .native-cli-terminal__tool { width: 30px; padding: 0; justify-content: center; }
        .native-cli-terminal__tools { gap: 2px; }
      }
    `}</style>
  );
}

export function NativeCliTerminal({
  agentId,
  sessionKey,
  cliSessionId,
  cliSessionProvider,
}: NativeCliTerminalProps) {
  const areaRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
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
  const reconnectDelayRef = useRef(1000);
  const disposedRef = useRef(false);

  const [status, setStatus] = useState<TerminalStatus>('disconnected');
  const [draft, setDraft] = useState('');

  const normalizedProvider = useMemo(() => normalizeProvider(cliSessionProvider), [cliSessionProvider]);

  const persistState = useCallback(() => {
    savePersistedTerminalState(sessionKey, {
      buffer: bufferRef.current,
      userHasInteracted: userHasInteractedRef.current,
      cliSessionId: cliSessionIdRef.current,
    });
  }, [sessionKey]);

  const clearTerminalUserEchoRow = useCallback((row: HTMLElement) => {
    row.classList.remove('openclaw-user-echo-row');
    row.removeAttribute('data-openclaw-user-text');
  }, []);

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

  const handleTerminalData = useCallback((raw: string) => {
    const visibleRaw = stripTerminalStreamMarkers(raw);
    updateShellPassthroughState(visibleRaw);
    bufferRef.current = `${bufferRef.current}${raw}`.slice(-100_000);
    persistState();
    if (!userHasInteractedRef.current) return;
    termRef.current?.write(raw);
    scheduleTerminalUserEchoStyle();
  }, [persistState, scheduleTerminalUserEchoStyle, stripTerminalStreamMarkers, updateShellPassthroughState]);

  const sendTerminalData = useCallback((data: string) => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ type: 'data', data }));
    return true;
  }, []);

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
    const configuredWidth = Math.min(area.clientWidth, 960);
    const cols = Math.max(TERMINAL_MIN_COLS, Math.floor(configuredWidth / cellWidth));
    const rows = Math.max(1, proposed.rows);
    if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
  }, []);

  const connect = useCallback(async () => {
    if (disposedRef.current) return;
    if (!termRef.current) return;
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) return;

    const statusResult = await invokeIpc<GatewayStatus>('gateway:status', []);
    const port = typeof statusResult?.port === 'number' && statusResult.port > 0 ? statusResult.port : 18789;
    const wsProtocol = statusResult?.tls === true ? 'wss' : 'ws';
    const knownCliSessionId = cliSessionIdRef.current || resolveStoredCliSessionId(sessionKey, cliSessionId);
    cliSessionIdRef.current = knownCliSessionId;

    const params = new URLSearchParams({
      agentId,
      sessionKey,
    });
    if (knownCliSessionId && userHasInteractedRef.current) {
      params.set('resume', '1');
      params.set('sessionId', knownCliSessionId);
    }
    const ws = new WebSocket(`${wsProtocol}://127.0.0.1:${port}/terminal?${params.toString()}`);
    wsRef.current = ws;
    setStatus('connecting');
    let openedAt = 0;

    ws.onopen = () => {
      if (disposedRef.current) return;
      if (wsRef.current !== ws) return;
      openedAt = Date.now();
      reconnectDelayRef.current = 1000;
      setStatus('connected');
      fitTerminalToContent();
      const term = termRef.current;
      if (term) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };

    ws.onmessage = (event) => {
      if (disposedRef.current) return;
      if (wsRef.current !== ws) return;
      try {
        const msg = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (msg.type === 'data' && typeof msg.data === 'string') {
          handleTerminalData(msg.data);
        } else if (msg.type === 'assistant_turn_start') {
          const turnId = typeof msg.turnId === 'string' ? msg.turnId : '';
          const conversationId = typeof msg.conversationId === 'string' ? msg.conversationId : '';
          const userText = typeof msg.userText === 'string' ? msg.userText : '';
          if (turnId) upsertTerminalTurn({ kind: 'turn_start', conversationId, turnId, userText });
        } else if (msg.type === 'assistant_idle' && typeof msg.turnId === 'string') {
          handleTerminalStreamMarker({ kind: 'turn_idle', conversationId: String(msg.conversationId ?? ''), turnId: msg.turnId });
        } else if (msg.type === 'assistant_turn_end' && typeof msg.turnId === 'string') {
          handleTerminalStreamMarker({ kind: 'turn_end', conversationId: String(msg.conversationId ?? ''), turnId: msg.turnId });
        } else if (msg.type === 'session_id' && typeof msg.sessionId === 'string') {
          cliSessionIdRef.current = msg.sessionId;
          persistNativeCliSessionId(sessionKey, msg.sessionId, normalizedProvider);
          persistState();
        } else if (msg.type === 'exit' && userHasInteractedRef.current) {
          termRef.current?.write(`\r\n\x1b[33m[process exited: ${String(msg.code ?? 0)}]\x1b[0m\r\n`);
        }
      } catch {
        if (typeof event.data === 'string') handleTerminalData(event.data);
      }
    };

    ws.onclose = () => {
      if (disposedRef.current) return;
      if (wsRef.current !== ws) return;
      if (wsRef.current === ws) wsRef.current = null;
      setStatus('disconnected');
      if (userHasInteractedRef.current) {
        termRef.current?.write('\r\n\x1b[31m[disconnected]\x1b[0m\r\n');
      }
      if (openedAt > 0 && Date.now() - openedAt < 400) {
        reconnectDelayRef.current = Math.min(Math.max(reconnectDelayRef.current * 2, 2000), 60_000);
      }
      if (!reconnectTimerRef.current) {
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          void connect();
        }, reconnectDelayRef.current);
        reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, 30_000);
      }
    };

    ws.onerror = () => {
      if (disposedRef.current) return;
      if (wsRef.current !== ws) return;
      setStatus('disconnected');
    };
  }, [
    agentId,
    cliSessionId,
    fitTerminalToContent,
    handleTerminalData,
    handleTerminalStreamMarker,
    normalizedProvider,
    persistState,
    sessionKey,
    upsertTerminalTurn,
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

  const sendShellCompose = useCallback((text: string) => {
    setDraft('');
    if (!userHasInteractedRef.current) {
      userHasInteractedRef.current = true;
      termRef.current?.clear();
    }
    for (const payload of shellComposeToPtyInput(text)) {
      sendTerminalData(payload);
    }
    persistState();
  }, [persistState, sendTerminalData]);

  const sendText = useCallback((text: string) => {
    if (!text.trim()) return;
    const launchPassthrough = shouldLaunchShellPassthrough(text);
    if (shellPassthroughRef.current || launchPassthrough) {
      sendShellCompose(text);
      if (launchPassthrough) shellPassthroughRef.current = true;
      return;
    }
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (!userHasInteractedRef.current) {
      userHasInteractedRef.current = true;
      termRef.current?.clear();
    }
    setDraft('');
    decorateLocalTerminalTurn(text);
    ws.send(JSON.stringify({ type: 'user_text', text }));
    scheduleTerminalUserEchoStyle(true);
    persistState();
  }, [decorateLocalTerminalTurn, persistState, scheduleTerminalUserEchoStyle, sendShellCompose]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (draft.trim()) {
        if (shellPassthroughRef.current) {
          sendShellCompose(draft);
        } else {
          sendText(draft);
        }
      } else if (sendTerminalData('\r')) {
        setDraft('');
      }
      return;
    }

    if (event.metaKey || event.altKey || event.shiftKey) return;

    if (event.ctrlKey) {
      const data = ({ c: '\x03', d: '\x04', l: '\x0c' } as Record<string, string>)[event.key.toLowerCase()];
      if (data) {
        event.preventDefault();
        sendTerminalData(data);
      }
      return;
    }

    if (event.key === 'Tab') {
      event.preventDefault();
      const prefix = draft;
      setDraft('');
      sendTerminalData(`${prefix}\t`);
      return;
    }

    if (draft.length > 0) return;
    const data = ({
      ArrowUp: '\x1b[A',
      ArrowDown: '\x1b[B',
      ArrowRight: '\x1b[C',
      ArrowLeft: '\x1b[D',
      Escape: '\x1b',
      Backspace: '\x7f',
    } as Record<string, string>)[event.key];
    if (data) {
      event.preventDefault();
      sendTerminalData(data);
    }
  }, [draft, sendShellCompose, sendTerminalData, sendText]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    disposedRef.current = false;

    const persisted = loadPersistedTerminalState(sessionKey);
    cliSessionIdRef.current = resolveStoredCliSessionId(sessionKey, cliSessionId) || persisted.cliSessionId || '';
    userHasInteractedRef.current = Boolean(cliSessionIdRef.current || persisted.userHasInteracted);
    bufferRef.current = persisted.buffer ?? '';

    const term = createTerminalInstance();
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.parser.registerOscHandler(777, (data: string) => {
      if (shellPassthroughRef.current) return false;
      const marker = decodeTerminalOscMarker(data);
      if (!marker) return false;
      handleTerminalStreamMarker(marker);
      return true;
    });
    term.open(mount);
    if (userHasInteractedRef.current && bufferRef.current) {
      term.write(bufferRef.current);
    }
    term.onData((data) => {
      sendTerminalData(data);
    });
    term.onResize(({ cols, rows }) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      scheduleTerminalUserEchoStyle();
    });
    term.onScroll(() => scheduleTerminalUserEchoStyle());
    term.onWriteParsed(() => {
      ensureRowsObserver();
      scheduleTerminalUserEchoStyle();
    });

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    resizeObserverRef.current = new ResizeObserver(() => {
      fitTerminalToContent();
      scheduleTerminalUserEchoStyle();
    });
    if (areaRef.current) resizeObserverRef.current.observe(areaRef.current);

    void connect();

    return () => {
      disposedRef.current = true;
      persistState();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (userEchoTimerRef.current) clearTimeout(userEchoTimerRef.current);
      if (userEchoRafRef.current) cancelAnimationFrame(userEchoRafRef.current);
      rowsObserverRef.current?.disconnect();
      resizeObserverRef.current?.disconnect();
      const ws = wsRef.current;
      wsRef.current = null;
      ws?.close();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [
    cliSessionId,
    connect,
    ensureRowsObserver,
    fitTerminalToContent,
    handleTerminalStreamMarker,
    persistState,
    scheduleTerminalUserEchoStyle,
    sendTerminalData,
    sessionKey,
  ]);

  const canSend = status === 'connected' && draft.trim().length > 0;

  return (
    <div className="native-cli-terminal">
      <NativeCliTerminalStyles />
      <div ref={areaRef} className="native-cli-terminal__area">
        <div ref={mountRef} className="native-cli-terminal__mount" />
      </div>
      <div className="native-cli-terminal__compose">
        <div className="native-cli-terminal__box">
          <textarea
            value={draft}
            rows={1}
            placeholder={status === 'connected' ? '发消息或输入命令' : 'Terminal is disconnected'}
            disabled={status !== 'connected'}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="native-cli-terminal__footer">
            <div className="native-cli-terminal__tools" aria-hidden="true">
              <span className="native-cli-terminal__tool native-cli-terminal__tool--icon"><Plus /></span>
              <span className="native-cli-terminal__tool"><Zap /><span>快速</span></span>
              <span className="native-cli-terminal__tool"><PenLine /><span>写作</span></span>
              <span className="native-cli-terminal__tool"><TerminalIcon /><span>编程</span></span>
              <span className="native-cli-terminal__tool"><Image /><span>图像</span></span>
              <span className="native-cli-terminal__tool"><Globe /><span>翻译</span></span>
              <span className="native-cli-terminal__tool"><MoreHorizontal /><span>更多</span></span>
            </div>
            <div className="native-cli-terminal__actions">
              <span className="native-cli-terminal__voice" aria-hidden="true"><Mic /></span>
              <button
                type="button"
                className="native-cli-terminal__send"
                title="Send"
                disabled={!canSend}
                onClick={() => sendText(draft)}
              >
                <Send />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
