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
import { useModelsStore } from '@/stores/models';
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
const TERMINAL_ESCAPE = String.fromCharCode(27);
const TERMINAL_BELL = String.fromCharCode(7);
const TERMINAL_OSC_PATTERN = new RegExp(`${TERMINAL_ESCAPE}\\][^${TERMINAL_BELL}]*(?:${TERMINAL_BELL}|${TERMINAL_ESCAPE}\\\\)`, 'g');
const TERMINAL_CSI_PATTERN = new RegExp(`${TERMINAL_ESCAPE}\\[[0-?]*[ -/]*[@-~]`, 'g');
const TERMINAL_CHARSET_PATTERN = new RegExp(`${TERMINAL_ESCAPE}[()][A-Za-z0-9]`, 'g');
const NATIVE_CLI_SESSION_KEY_PATTERN = /^agent:[^:]+:cli:/i;
const CLAUDE_NATIVE_PROXY_PORT = 13211;
const CLAUDE_NATIVE_SONNET_ALIAS = 'claude-sonnet-4-6';
const CLAUDE_NATIVE_OPUS_ALIAS = 'claude-opus-4-7';
const CLAUDE_NATIVE_HAIKU_ALIAS = 'claude-haiku-4-5';
const NATIVE_CLI_TERMINAL_DEBUG_STORAGE_KEY = 'openclaw-debug-native-cli';
const NATIVE_CLI_TERMINAL_DEBUG_CHUNK_LIMIT = 80;
const NATIVE_CLI_TERMINAL_DEBUG_PREVIEW_LIMIT = 1200;

function isNativeCliTerminalDebugEnabled(): boolean {
  if (import.meta.env.DEV) return true;
  try {
    return window.localStorage.getItem(NATIVE_CLI_TERMINAL_DEBUG_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function previewNativeCliTerminalChunk(text: string, limit = NATIVE_CLI_TERMINAL_DEBUG_PREVIEW_LIMIT): string {
  const preview = text
    .replace(TERMINAL_OSC_PATTERN, '')
    .replace(TERMINAL_CSI_PATTERN, '')
    .replace(TERMINAL_CHARSET_PATTERN, '')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
  return preview.length > limit ? `${preview.slice(0, limit)}…` : preview;
}

function previewNativeCliTerminalChunkWithAnsi(text: string, limit = NATIVE_CLI_TERMINAL_DEBUG_PREVIEW_LIMIT): string {
  const preview = text
    .replace(new RegExp(TERMINAL_ESCAPE, 'g'), '\\x1b')
    .replace(new RegExp(TERMINAL_BELL, 'g'), '\\x07')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
  return preview.length > limit ? `${preview.slice(0, limit)}…` : preview;
}

function terminalControlSummary(text: string) {
  const csi = [...text.matchAll(/\x1b\[[0-?]*[ -/]*[@-~]/g)]
    .map((match) => match[0].replace(/\x1b/g, '\\x1b'));
  const osc = [...text.matchAll(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g)]
    .map((match) => match[0].replace(/\x1b/g, '\\x1b').replace(/\x07/g, '\\x07'));
  return {
    csiCount: csi.length,
    csiFirst: csi.slice(0, 24),
    oscCount: osc.length,
    oscFirst: osc.slice(0, 8),
    carriageReturns: (text.match(/\r/g) ?? []).length,
    newlines: (text.match(/\n/g) ?? []).length,
    backspaces: (text.match(/\x08/g) ?? []).length,
    cursorAddressing: csi.filter((entry) => /\\x1b\[[0-9;?]*[HfGdABCDJK]/.test(entry)).slice(0, 24),
  };
}

function traceNativeCliTerminal(stage: string, payload: Record<string, unknown>): void {
  // Temporary deep trace: shows exactly which data reaches the xterm UI and from where.
  // Keep this as console.info (not console.debug) so it is visible with default DevTools filters.
  console.info(`[native-cli-terminal:trace] ${stage}`, payload);
}

// Blank Claude Code's startup-header printable characters in place, preserving
// every ANSI control byte and `\r\n`. This only changes printable chars on
// rows that contain a banner-unique signature, so Claude's cursor coordinates
// (every absolute move, scroll region, line-clear) stay byte-for-byte
// identical — no garbling, no blank-band desync, no row hacks.
//
// Trade-off: the rows the banner used to occupy stay visible but are blank.
// Claude's own layout still anchors below the banner footprint, so the live
// region behaves exactly as before; we simply hide the printable characters.
//
// Banner-unique signatures (none ever appear in normal Claude conversation):
//   - mascot glyphs: U+2580–U+259F box-drawing characters mixed into the
//     three "▐▛███▜▌" / "▝▜█████▛▘" / "▘▘ ▝▝" rows.
//   - "Claude Code v" — appears only in the title row of the minimal logo.
//   - " · API Usage Billing" — appears only in the billing row.
const CLAUDE_BANNER_LINE_SIGNATURES: RegExp[] = [
  /[▀-▟]{2,}/,          // mascot row (any banner row)
  /Claude Code v\d/,              // "Claude Code v2.1.162"
  /· API Usage Billing/,          // billing line
  /· Subscription/,               // alternate billing label seen in some plans
  /\\workspace-[A-Za-z0-9_-]+$/,  // cwd row tail (Windows path inside banner)
];

function isClaudeBannerLine(rawLine: string): boolean {
  const cleaned = rawLine
    .replace(TERMINAL_OSC_PATTERN, '')
    .replace(TERMINAL_CSI_PATTERN, '')
    .replace(TERMINAL_CHARSET_PATTERN, '');
  return CLAUDE_BANNER_LINE_SIGNATURES.some((re) => re.test(cleaned));
}

function blankPrintableInLine(rawLine: string): string {
  // Walk the line, skipping ANSI sequences verbatim, and replace every
  // printable codepoint with a space. Width-preserving: one input char (in
  // logical "columns") -> one space. Wide-character handling is unnecessary
  // here because the banner uses only single-cell glyphs.
  let i = 0;
  let out = '';
  while (i < rawLine.length) {
    const ch = rawLine[i];
    const code = ch.charCodeAt(0);
    // ESC: copy the whole CSI/OSC/charset sequence as-is.
    if (code === 27) {
      // Try CSI ESC [ ... letter
      const csi = rawLine.slice(i).match(/^\x1b\[[0-?]*[ -/]*[@-~]/);
      if (csi) { out += csi[0]; i += csi[0].length; continue; }
      // OSC ESC ] ... BEL or ESC \
      const osc = rawLine.slice(i).match(/^\x1b\][^\x07]*(?:\x07|\x1b\\)/);
      if (osc) { out += osc[0]; i += osc[0].length; continue; }
      // Charset ESC ( X / ESC ) X
      const charset = rawLine.slice(i).match(/^\x1b[()][A-Za-z0-9]/);
      if (charset) { out += charset[0]; i += charset[0].length; continue; }
      // Lone ESC: keep it.
      out += ch; i += 1; continue;
    }
    // Other C0/C1 controls (BS, BEL, etc.): keep verbatim.
    if (code < 32 || code === 127) { out += ch; i += 1; continue; }
    // Printable: replace with a space (preserves cell width for the banner's
    // single-cell glyphs).
    out += ' '; i += 1;
  }
  return out;
}

function maskClaudeBannerInChunk(chunk: string): string {
  // Split on `\r\n` while keeping the separators so reassembly is exact.
  const parts: string[] = [];
  let i = 0;
  while (i < chunk.length) {
    const next = chunk.indexOf('\r\n', i);
    if (next < 0) { parts.push(chunk.slice(i)); break; }
    parts.push(chunk.slice(i, next));
    parts.push('\r\n');
    i = next + 2;
  }
  let masked = false;
  for (let p = 0; p < parts.length; p += 1) {
    const part = parts[p];
    if (part === '\r\n') continue;
    if (isClaudeBannerLine(part)) {
      parts[p] = blankPrintableInLine(part);
      masked = true;
    }
  }
  return masked ? parts.join('') : chunk;
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

function terminalCursorSnapshot(term: Terminal | null) {
  if (!term) return null;
  try {
    const buffer = term.buffer.active;
    return {
      cols: term.cols,
      rows: term.rows,
      cursorX: buffer.cursorX,
      cursorY: buffer.cursorY,
      baseY: buffer.baseY,
      viewportY: buffer.viewportY,
      bufferLength: buffer.length,
    };
  } catch {
    return {
      cols: term.cols,
      rows: term.rows,
    };
  }
}

function terminalRowsSnapshot(term: Terminal | null, mount: HTMLElement | null) {
  const domRows = [...(mount?.querySelectorAll<HTMLElement>('.xterm-rows > div') ?? [])];
  const domTexts = domRows.map((row) => row.textContent ?? '');
  const firstNonEmptyDomRow = domTexts.findIndex((text) => text.trim().length > 0);
  const buffer = term?.buffer.active;
  const viewportY = buffer?.viewportY ?? 0;
  const bufferTexts = term && buffer
    ? Array.from({ length: Math.min(term.rows, 18) }, (_, index) => (
      buffer.getLine(viewportY + index)?.translateToString(true) ?? ''
    ))
    : [];
  const firstNonEmptyBufferRow = bufferTexts.findIndex((text) => text.trim().length > 0);
  return {
    domRowCount: domRows.length,
    firstNonEmptyDomRow,
    emptyDomRowsBeforeFirstText: firstNonEmptyDomRow < 0 ? domRows.length : firstNonEmptyDomRow,
    topDomRows: domTexts.slice(0, 18).map((text, index) => ({ index, text })),
    firstNonEmptyBufferRow,
    emptyBufferRowsBeforeFirstText: firstNonEmptyBufferRow < 0 ? bufferTexts.length : firstNonEmptyBufferRow,
    topBufferRows: bufferTexts.map((text, index) => ({ index, text })),
    cursor: terminalCursorSnapshot(term),
  };
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

function terminalMarkerPartialSuffixLength(data: string) {
  const max = Math.min(TERMINAL_STREAM_MARKER_PREFIX.length - 1, data.length);
  for (let length = max; length > 0; length -= 1) {
    if (TERMINAL_STREAM_MARKER_PREFIX.startsWith(data.slice(-length))) return length;
  }
  return 0;
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
  const terminalDebugChunkCountRef = useRef(0);
  const markerBufferRef = useRef('');
  const bufferRef = useRef('');
  const recentOutputRef = useRef('');
  const userHasInteractedRef = useRef(false);
  const shellPassthroughRef = useRef(false);
  const ignoredManagedPassthroughSignatureLoggedRef = useRef(false);
  const cliSessionIdRef = useRef('');
  const activeSessionResolveRef = useRef('');
  const initialOutputRafRef = useRef<number>(0);
  const initialOutputPendingPaintRef = useRef(false);
  const loadingExitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cliSessionIdPropRef = useRef(cliSessionId);
  const sessionTitleRef = useRef(sessionTitle);
  const sessionUpdatedAtRef = useRef(sessionUpdatedAt);
  const skipResumeResolveRef = useRef(false);
  const suppressReconnectRef = useRef(false);
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
    termRef.current?.clear();
    termRef.current?.write('\x1b[H');
    bufferRef.current = '';
    markerBufferRef.current = '';
    recentOutputRef.current = '';
    shellPassthroughRef.current = false;
    userHasInteractedRef.current = true;
    persistState();
  }, [persistState]);

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
    const before = shellPassthroughRef.current;
    const combinedOutput = `${recentOutputRef.current}${chunk}`;
    const outputSignature = TERMINAL_SHELL_PASSTHROUGH_SIGNATURES.find((signature) => (
      combinedOutput.includes(signature)
    ));
    const managedClaudeSignature = effectiveProvider === 'claude' ? outputSignature : undefined;
    const matchedSignature = managedClaudeSignature ? undefined : outputSignature;
    recentOutputRef.current = combinedOutput.slice(-TERMINAL_SHELL_PASSTHROUGH_BUFFER_CHARS);
    if (managedClaudeSignature && !ignoredManagedPassthroughSignatureLoggedRef.current) {
      ignoredManagedPassthroughSignatureLoggedRef.current = true;
      traceNativeCliTerminal('shell-passthrough-managed-claude-signature-ignored', {
        sessionKey,
        signature: managedClaudeSignature,
        recentPreview: previewNativeCliTerminalChunk(recentOutputRef.current),
      });
    }
    if (matchedSignature) {
      shellPassthroughRef.current = true;
    } else if (shellPassthroughRef.current && /\n[^\n]*[$%#] $/.test(recentOutputRef.current.slice(-240))) {
      shellPassthroughRef.current = false;
    }
    if (before !== shellPassthroughRef.current) {
      traceNativeCliTerminal('shell-passthrough-state-changed', {
        sessionKey,
        before,
        after: shellPassthroughRef.current,
        matchedSignature,
        recentPreview: previewNativeCliTerminalChunk(recentOutputRef.current),
      });
    }
  }, [effectiveProvider, sessionKey]);

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
    // Strip-in-place: ANSI control bytes pass through untouched; only the
    // printable characters of Claude Code's startup-header rows are blanked.
    // Same byte length, same cursor coordinates, no row hacks. Resize-redraws
    // are masked too because each redraw chunk re-emits the same banner bytes.
    const visibleRaw = stripTerminalStreamMarkers(raw);
    updateShellPassthroughState(visibleRaw);

    const renderRaw = effectiveProvider === 'claude'
      ? maskClaudeBannerInChunk(visibleRaw)
      : visibleRaw;

    const chunkIndex = terminalDebugChunkCountRef.current + 1;
    terminalDebugChunkCountRef.current = chunkIndex;

    if (renderRaw.length === 0) return;

    const renderHasPrintable = hasPrintableTerminalContent(renderRaw);
    bufferRef.current = `${bufferRef.current}${renderRaw}`.slice(-100_000);

    if (terminalDebugChunkCountRef.current <= NATIVE_CLI_TERMINAL_DEBUG_CHUNK_LIMIT) {
      traceNativeCliTerminal('handle-terminal-data-before-render', {
        sessionKey,
        chunkIndex,
        rawBytes: raw.length,
        renderBytes: renderRaw.length,
        bannerMasked: renderRaw !== visibleRaw,
        hasPrintable: renderHasPrintable,
        shellPassthrough: shellPassthroughRef.current,
        bufferBytes: bufferRef.current.length,
        renderAnsiPreview: previewNativeCliTerminalChunkWithAnsi(renderRaw),
        renderControls: terminalControlSummary(renderRaw),
        rowsBeforeWrite: terminalRowsSnapshot(termRef.current, mountRef.current),
      });
    }

    persistState();
    const term = termRef.current;
    if (term) {
      term.write(renderRaw, () => {
        if (renderHasPrintable) requestInitialOutputSettle();
      });
    } else {
      traceNativeCliTerminal('terminal-data-dropped-no-xterm', {
        sessionKey,
        chunkIndex,
        rawPreview: previewNativeCliTerminalChunk(raw),
      });
    }
  }, [effectiveProvider, persistState, requestInitialOutputSettle, sessionKey, stripTerminalStreamMarkers, updateShellPassthroughState]);

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
      updateInputShellStateFromTerminalScroll();
      requestAnimationFrame(() => {
        if (disposedRef.current) return;
        fitTerminalToContent();
      });
    });
  }, [fitTerminalToContent, updateInputShellStateFromTerminalScroll]);

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

    mountRef_cb.current.fitTerminalToContent();
    const initialTerm = termRef.current;
    const initialTerminalSize = initialTerm
      ? { cols: initialTerm.cols, rows: initialTerm.rows }
      : null;
    const params = new URLSearchParams({
      agentId,
      sessionKey,
    });
    if (initialTerminalSize) {
      params.set('cols', String(initialTerminalSize.cols));
      params.set('rows', String(initialTerminalSize.rows));
    }
    if (knownCliSessionId) {
      params.set('resume', '1');
      params.set('sessionId', knownCliSessionId);
    }
    const wsUrl = `${wsProtocol}://127.0.0.1:${port}/terminal?${params.toString()}`;
    traceNativeCliTerminal('websocket-create-terminal-stream', {
      sessionKey,
      agentId,
      knownCliSessionId,
      normalizedProvider,
      initialTerminalSize,
      wsUrl,
      phase: knownCliSessionId ? 'resume' : 'start',
    });
    suppressReconnectRef.current = false;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    let openedAt = 0;

    ws.onopen = () => {
      if (disposedRef.current) return;
      if (wsRef.current !== ws) return;
      openedAt = Date.now();
      reconnectDelayRef.current = 1000;
      traceNativeCliTerminal('websocket-opened-terminal-stream', {
        sessionKey,
        agentId,
        knownCliSessionId,
        normalizedProvider,
      });
      dispatchTerminalState({ type: 'websocket_opened' });
      mountRef_cb.current.fitTerminalToContent();
      const term = termRef.current;
      if (term) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      if (!knownCliSessionId) mountRef_cb.current.settleReadyWithoutInitialOutput();
    };

    ws.onmessage = (event) => {
      if (disposedRef.current) return;
      if (wsRef.current !== ws) return;
      const eventText = String(event.data);
      traceNativeCliTerminal('websocket-message-raw-from-backend', {
        sessionKey,
        bytes: eventText.length,
        preview: previewNativeCliTerminalChunk(eventText),
      });
      try {
        const msg = JSON.parse(eventText) as Record<string, unknown>;
        traceNativeCliTerminal('websocket-message-parsed', {
          sessionKey,
          type: String(msg.type ?? ''),
          keys: Object.keys(msg),
        });
        if (msg.type === 'data' && typeof msg.data === 'string') {
          traceNativeCliTerminal('websocket-data-payload-going-to-terminal-ui', {
            sessionKey,
            bytes: msg.data.length,
            preview: previewNativeCliTerminalChunk(msg.data),
          });
          mountRef_cb.current.handleTerminalData(msg.data);
        } else if (msg.type === 'session_id' && typeof msg.sessionId === 'string') {
          mountRef_cb.current.bindNativeCliSessionId(msg.sessionId);
        } else if (msg.type === 'exit') {
          suppressReconnectRef.current = true;
          traceNativeCliTerminal('terminal-process-exit-suppressing-reconnect', {
            sessionKey,
            code: msg.code,
            cliSessionId: cliSessionIdRef.current,
          });
          if (userHasInteractedRef.current) {
            termRef.current?.write(`\r\n\x1b[33m[process exited: ${String(msg.code ?? 0)}]\x1b[0m\r\n`);
          }
        }
      } catch (error) {
        traceNativeCliTerminal('websocket-message-json-parse-failed-treat-as-terminal-data', {
          sessionKey,
          error: String(error),
          bytes: eventText.length,
          preview: previewNativeCliTerminalChunk(eventText),
        });
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
      if (suppressReconnectRef.current) {
        traceNativeCliTerminal('websocket-closed-reconnect-suppressed', {
          sessionKey,
          cliSessionId: cliSessionIdRef.current,
        });
        return;
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

  const sendShellCompose = useCallback((text: string, notifyUserText = true) => {
    if (notifyUserText) onUserText?.(text);
    const isFirstUserInput = !userHasInteractedRef.current;
    if (isFirstUserInput) {
      userHasInteractedRef.current = true;
      traceNativeCliTerminal('first-user-input-no-local-terminal-reset', {
        sessionKey,
        source: 'shell-compose',
        cursor: terminalCursorSnapshot(termRef.current),
        rowsBeforeInput: terminalRowsSnapshot(termRef.current, mountRef.current),
      });
    }
    for (const payload of shellComposeToPtyInput(text)) {
      sendTerminalData(payload);
    }
    persistState();
  }, [onUserText, persistState, sendTerminalData, sessionKey]);

  const sendText = useCallback((text: string) => {
    if (!text.trim()) return;
    const startedAt = Date.now();
    onUserText?.(text);
    const launchPassthrough = shouldLaunchShellPassthrough(text);
    if (shellPassthroughRef.current || launchPassthrough) {
      sendShellCompose(text, false);
      if (launchPassthrough) {
        shellPassthroughRef.current = true;
        traceNativeCliTerminal('shell-passthrough-launched-by-user-command', {
          sessionKey,
          command: shellPassthroughCommandFromText(text),
        });
      }
      startCliSessionIdFallbackResolver(text, startedAt);
      return;
    }
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (!userHasInteractedRef.current) {
      userHasInteractedRef.current = true;
      traceNativeCliTerminal('first-user-input-no-local-terminal-reset', {
        sessionKey,
        source: 'user-text',
        cursor: terminalCursorSnapshot(termRef.current),
        rowsBeforeInput: terminalRowsSnapshot(termRef.current, mountRef.current),
      });
    }
    for (const payload of shellComposeToPtyInput(text)) {
      ws.send(JSON.stringify({ type: 'data', data: payload }));
    }
    startCliSessionIdFallbackResolver(text, startedAt);
    persistState();
  }, [onUserText, persistState, sendShellCompose, sessionKey, startCliSessionIdFallbackResolver]);

  const handleChatInputSend = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (shellPassthroughRef.current) {
      sendShellCompose(trimmed);
      return;
    }
    sendText(trimmed);
  }, [sendShellCompose, sendText]);

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

    sendText(`/model ${CLAUDE_NATIVE_SONNET_ALIAS}`);
  }, [agent, agentId, configuredClaudeProxyRouteModel, effectiveProvider, refreshAgents, sendText]);

  // Stable ref for mount-effect callbacks so the terminal instance survives
  // callback identity changes (e.g. normalizedProvider undefined → 'claude').
  const mountRef_cb = useRef({
    connect, sendTerminalData, fitTerminalToContent, scheduleTerminalResize,
    maybeSettleInitialOutput, persistState,
    handleTerminalData, bindNativeCliSessionId,
    settleReadyWithoutInitialOutput, resetVisibleTerminalForResume,
    updateInputShellStateFromTerminalScroll,
  });
  mountRef_cb.current = {
    connect, sendTerminalData, fitTerminalToContent, scheduleTerminalResize,
    maybeSettleInitialOutput, persistState,
    handleTerminalData, bindNativeCliSessionId,
    settleReadyWithoutInitialOutput, resetVisibleTerminalForResume,
    updateInputShellStateFromTerminalScroll,
  };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    disposedRef.current = false;
    terminalDebugChunkCountRef.current = 0;
    ignoredManagedPassthroughSignatureLoggedRef.current = false;
    markerBufferRef.current = '';
    recentOutputRef.current = '';
    shellPassthroughRef.current = false;
    suppressReconnectRef.current = false;

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
    term.open(mount);
    if (!initialCliSessionId && userHasInteractedRef.current && bufferRef.current) {
      if (isNativeCliTerminalDebugEnabled()) {
        console.debug('[native-cli-terminal] restoring persisted terminal buffer before first paint', {
          sessionKey,
          bytes: bufferRef.current.length,
          preview: previewNativeCliTerminalChunk(bufferRef.current),
        });
      }
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
      mountRef_cb.current.persistState();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (resizeRafRef.current) cancelAnimationFrame(resizeRafRef.current);
      if (initialOutputRafRef.current) cancelAnimationFrame(initialOutputRafRef.current);
      if (loadingExitTimerRef.current) clearTimeout(loadingExitTimerRef.current);
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
            onModelChange={handleModelChange}
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
