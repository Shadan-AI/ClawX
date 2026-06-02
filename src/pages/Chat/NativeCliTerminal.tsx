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

type NativeClaudeLiveTurn = {
  turnId: string;
  register: Promise<void> | null;
};

type PendingClaudeSend = {
  text: string;
  queuedAt: number;
  startedAt: number;
  turnId: string;
  diagnosticTimer?: ReturnType<typeof setTimeout>;
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
const TERMINAL_ESCAPE = String.fromCharCode(27);
const TERMINAL_BELL = String.fromCharCode(7);
const TERMINAL_OSC_PATTERN = new RegExp(`${TERMINAL_ESCAPE}\\][^${TERMINAL_BELL}]*(?:${TERMINAL_BELL}|${TERMINAL_ESCAPE}\\\\)`, 'g');
const TERMINAL_STREAM_MARKER_PATTERN = new RegExp(`${TERMINAL_ESCAPE}\\]777;OPENCLAW;[^${TERMINAL_BELL}${TERMINAL_ESCAPE}]*(?:${TERMINAL_BELL}|${TERMINAL_ESCAPE}\\\\)`, 'g');
const TERMINAL_CSI_PATTERN = new RegExp(`${TERMINAL_ESCAPE}\\[[0-?]*[ -/]*[@-~]`, 'g');
const TERMINAL_CHARSET_PATTERN = new RegExp(`${TERMINAL_ESCAPE}[()][A-Za-z0-9]`, 'g');
const CLAUDE_NATIVE_PROXY_PORT = 13211;
const CLAUDE_NATIVE_SONNET_ALIAS = 'claude-sonnet-4-6';
const CLAUDE_NATIVE_OPUS_ALIAS = 'claude-opus-4-7';
const CLAUDE_NATIVE_HAIKU_ALIAS = 'claude-haiku-4-5';
const CLAUDE_PROMPT_BUFFER_CHARS = 20_000;
const CLAUDE_NATIVE_VIEWPORT_BOTTOM_GAP = 44;
const CLAUDE_NATIVE_START_ROW = 1;
const CLAUDE_PROMPT_READY_TIMEOUT_MS = 12_000;
const CLAUDE_STARTUP_LOG_FRAME_LIMIT = 12;

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

function terminalDebugPreview(data: string, maxChars = 260): string {
  return data
    .replace(TERMINAL_STREAM_MARKER_PATTERN, '')
    .replace(TERMINAL_OSC_PATTERN, '')
    .replace(TERMINAL_CSI_PATTERN, '')
    .replace(TERMINAL_CHARSET_PATTERN, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

function plainTerminalText(data: string): string {
  return data
    .replace(TERMINAL_STREAM_MARKER_PATTERN, '')
    .replace(TERMINAL_OSC_PATTERN, '')
    .replace(TERMINAL_CSI_PATTERN, '')
    .replace(TERMINAL_CHARSET_PATTERN, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function terminalPlainLines(data: string): string[] {
  return data
    .replace(TERMINAL_STREAM_MARKER_PATTERN, '')
    .replace(TERMINAL_OSC_PATTERN, '')
    .replace(TERMINAL_CSI_PATTERN, '')
    .replace(TERMINAL_CHARSET_PATTERN, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim());
}

function claudePlainTerminalText(data: string): string {
  return data
    .replace(TERMINAL_STREAM_MARKER_PATTERN, '')
    .replace(TERMINAL_OSC_PATTERN, '')
    .replace(TERMINAL_CSI_PATTERN, '')
    .replace(TERMINAL_CHARSET_PATTERN, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function isClaudeUserPromptLine(text: string): boolean {
  return /^(?:\u276f|>)\s+\S/.test(text.trim());
}

function isClaudeAssistantLine(text: string): boolean {
  return /^\u25cf\s+\S/.test(text.trim());
}

function isClaudeProgressLine(text: string): boolean {
  return /^(?:\u273b|\u2722|\u2736|\u273d|\*)\s+\S/.test(text.trim());
}

function isClaudeActiveSpinnerFrame(data: string): boolean {
  const lines = terminalPlainLines(data).filter(Boolean);
  return lines.length > 0 && lines.every((line) => isClaudeSpinnerOnlyText(line));
}

function claudePromptReadySignal(data: string): { ready: boolean; reason: string } {
  const plain = plainTerminalText(data);
  if (!plain) return { ready: false, reason: 'empty' };
  const hasFooter = /bypass permissions on/i.test(plain)
    || /shift\s*\+\s*tab/i.test(plain)
    || /esc\s+to\s+interrupt/i.test(plain)
    || /\? for shortcuts/i.test(plain)
    || /Ctrl\+Alt\+K\s+to\s+reference/i.test(plain)
    || /reference files or paste images/i.test(plain);
  const hasStartupOnlyText = /Claude Code v\d/i.test(plain)
    || /Opus\s+\d/i.test(plain)
    || /Welcome to Claude Code/i.test(plain)
    || /Review Claude Code's changes/i.test(plain);
  if (hasFooter) return { ready: true, reason: 'footer' };
  return { ready: false, reason: hasStartupOnlyText ? 'startup_chrome' : 'no_prompt' };
}

function claudeStartupConfirmationSignal(data: string): { confirm: boolean; reason: string } {
  const plain = plainTerminalText(data);
  if (!plain) return { confirm: false, reason: 'empty' };
  const hasConfirmControls = /enter\s+to\s+confirm/i.test(plain)
    && /esc\s+to\s+cancel/i.test(plain);
  if (!hasConfirmControls) return { confirm: false, reason: 'no_confirm_controls' };
  const looksLikeClaudeStartup = /claude/i.test(plain)
    || /trust|workspace|project|folder|onboarding|permission|security/i.test(plain)
    || /[╭╮╰╯│─]/.test(data);
  return {
    confirm: looksLikeClaudeStartup,
    reason: looksLikeClaudeStartup ? 'startup_confirmation' : 'unknown_confirmation',
  };
}

function hasClaudeConversationOutput(data: string): boolean {
  const plain = plainTerminalText(data);
  if (!plain) return false;
  if (/\b(?:Cooked|Crunched|Thought|Thinking)\s+for\s+\d+/i.test(plain)) return true;
  if (/\b(?:Read|Wrote|Edited|Opened|Created|Updated)\s+\d*\s*files?\b/i.test(plain)) return true;

  const hasUserPrompt = /(?:^|\s)[\u276f>]\s+(?![\u2500\u2501\-\s]|$)(?![\u00b7/])(?!bypass\b|shift\b|for agents\b|esc\b)(?=\S)/i.test(plain);
  const hasAssistantText = /(?:^|\s)\u25cf\s+(?!high\b|medium\b|low\b|thinking\b|bypass\b|shift\b|\/effort\b)(?=\S)/i.test(plain);
  return hasUserPrompt && hasAssistantText;
}

function isClaudeSpinnerOnlyText(text: string): boolean {
  return /^[\u00b7*0-9\u25cf\u2733\u2736\u273b\u273d\u2722\u2800-\u28ff]$/.test(text.trim());
}

function isClaudeTerminalChromeLine(text: string): boolean {
  if (!text) return true;
  return /^[-\u2500\u2501]{8,}$/.test(text)
    || /^[\u276f>]\s*$/.test(text)
    || /^\s*\u25cf\s+(?:high|medium|low)\s*(?:\u00b7|Â·)\s*\/effort\b/i.test(text)
    || /bypass permissions on/i.test(text)
    || /shift\s*\+\s*tab/i.test(text)
    || /esc\s+to\s+interrupt/i.test(text)
    || /for agents/i.test(text)
    || /\/effort/i.test(text)
    || /\? for shortcuts/i.test(text)
    || /Ctrl\+Alt\+K\s+to\s+reference/i.test(text)
    || /reference files or paste images/i.test(text);
}

function isClaudePromptEchoLine(text: string, activeUserText?: string): boolean {
  const normalizedUserText = normalizeTerminalLineText(activeUserText ?? '').toLowerCase();
  if (!normalizedUserText) return false;
  const normalizedLine = normalizeTerminalLineText(text).toLowerCase();
  return normalizedLine === normalizedUserText
    || normalizedLine === `\u276f ${normalizedUserText}`
    || normalizedLine === `> ${normalizedUserText}`;
}

function cleanClaudeVisibleLine(text: string): string {
  return text
    .replace(/\s+$/g, '')
    .replace(/\s+[-\u2500\u2501]{8,}\s*$/g, '')
    .replace(/^\s{8,}(?=\S)/, '');
}

function extractClaudeActivityStatus(data: string, activeUserText?: string): string {
  const normalizedUserText = normalizeTerminalLineText(activeUserText ?? '').toLowerCase();
  const candidates = terminalPlainLines(data)
    .filter((line) => {
      if (!line) return false;
      const normalizedLine = normalizeTerminalLineText(line).toLowerCase();
      if (normalizedUserText && (
        normalizedLine === normalizedUserText
        || normalizedLine === `\u276f ${normalizedUserText}`
        || normalizedLine === `> ${normalizedUserText}`
      )) return false;
      if (isClaudeTerminalChromeLine(line)) return false;
      return true;
    });

  for (const line of candidates) {
    if (/(?:Thinking|Thought|Puttering|Photosynthesizing|Cooked|Crunched|Worked|Baked|Brewed)\b/i.test(line)) {
      return line;
    }
  }
  for (const line of candidates) {
    if (!isClaudeSpinnerOnlyText(line)) return line;
  }
  return '';
}

function isClaudeStatusOnlyFrame(data: string, activeUserText?: string): boolean {
  if (hasClaudeConversationOutput(data)) return false;
  const status = extractClaudeActivityStatus(data, activeUserText);
  if (!status) return false;
  const remaining = terminalPlainLines(data).filter((line) => {
    if (!line) return false;
    if (line === status) return false;
    if (isClaudeTerminalChromeLine(line)) return false;
    if (isClaudeSpinnerOnlyText(line)) return false;
    const normalizedUserText = normalizeTerminalLineText(activeUserText ?? '').toLowerCase();
    const normalizedLine = normalizeTerminalLineText(line).toLowerCase();
    return !(normalizedUserText && (
      normalizedLine === normalizedUserText
      || normalizedLine === `\u276f ${normalizedUserText}`
      || normalizedLine === `> ${normalizedUserText}`
    ));
  });
  return remaining.length === 0 || remaining.every((line) => /(?:Thinking|Puttering|Photosynthesizing)\b/i.test(line));
}

function isClaudeNativeChromeFrame(data: string, activeUserText?: string): boolean {
  if (hasClaudeConversationOutput(data)) return false;
  if (isClaudeStatusOnlyFrame(data, activeUserText)) return false;
  const plain = plainTerminalText(data);
  if (!plain) return false;
  const normalizedPlain = normalizeTerminalLineText(plain).toLowerCase();
  const normalizedUserText = normalizeTerminalLineText(activeUserText ?? '').toLowerCase();
  const hasActivePromptEcho = Boolean(normalizedUserText) && (
    normalizedPlain.includes(`\u276f ${normalizedUserText}`) ||
    normalizedPlain.startsWith(normalizedUserText)
  );
  const hasPromptChrome = /[\u2500\u2501]{8,}/.test(plain)
    || /bypass permissions on/i.test(plain)
    || /shift\s*\+\s*tab/i.test(plain)
    || /for agents/i.test(plain)
    || /Puttering/i.test(plain)
    || /\/effort/i.test(plain);
  const isBarePromptChrome = hasPromptChrome
    && /^[\s\u276f>\u2500\u2501\u00b7/().:+\-a-z0-9\u2190\u2192\u2191\u2193]*$/i.test(plain);
  return (hasActivePromptEcho && hasPromptChrome)
    || isBarePromptChrome
    || /Claude Code v\d/i.test(plain)
    || /Welcome to Claude Code/i.test(plain)
    || /bypass permissions on/i.test(plain)
    || /shift\s*\+\s*tab/i.test(plain)
    || /esc\s+to\s+interrupt/i.test(plain)
    || /\? for shortcuts/i.test(plain)
    || /Ctrl\+Alt\+K\s+to\s+reference/i.test(plain)
    || /reference files or paste images/i.test(plain)
    || /enter\s+to\s+confirm/i.test(plain)
    || /esc\s+to\s+cancel/i.test(plain)
    || /Review Claude Code's changes/i.test(plain)
    || /Opus\s+\d/i.test(plain);
}

function linearizeClaudeTerminalFrameV2(data: string): { data: string; changed: boolean } {
  if (!data) return { data, changed: false };
  let changed = false;
  const plainData = claudePlainTerminalText(data);
  const lines = plainData.replace(/\r/g, '\n').split('\n');
  const keptLines: string[] = [];
  let skippingStartupBox = false;
  let sawUsefulOutput = false;

  for (const line of lines) {
    const plainLine = cleanClaudeVisibleLine(line);
    const normalized = plainLine.trim();
    const isStartupBoxLine = /Claude Code v\d/i.test(plainLine)
      || /Welcome back!/i.test(plainLine)
      || /Tips for getting started/i.test(plainLine)
      || /What's new/i.test(plainLine)
      || /Sonnet\s+\d|Opus\s+\d/i.test(plainLine)
      || /API Usage Billing/i.test(plainLine)
      || /~\\\.openclaw\\workspace-/i.test(plainLine)
      || (/^[\u256d\u2502\u2570]/.test(plainLine) && !/[\u276f\u25cf\u273b\u2722\u2736]/.test(plainLine));
    const startsConversationLine = isClaudeUserPromptLine(normalized)
      || isClaudeAssistantLine(normalized)
      || /(?:Thought|Thinking|Puttering|Cooked|Crunched|Worked|Baked|Brewed|Churned|Cogitated|Frosting)\s+(?:for\s+)?\d+s/i.test(normalized)
      || /\b(?:Read|Wrote|Edited|Opened|Created|Updated)\s+\d*\s*files?\b/i.test(normalized);

    if (isStartupBoxLine) {
      changed = true;
      skippingStartupBox = !/^\u2570/.test(plainLine);
      continue;
    }
    if (skippingStartupBox) {
      changed = true;
      if (/^\u2570/.test(plainLine)) skippingStartupBox = false;
      continue;
    }
    if (!sawUsefulOutput && !startsConversationLine) {
      changed = true;
      continue;
    }
    if (startsConversationLine || isClaudeProgressLine(normalized)) {
      sawUsefulOutput = true;
    }

    const isIdleChromeLine = /^[-\u2500\u2501]{8,}$/.test(plainLine)
      || /^\u276f\s*$/.test(plainLine)
      || /bypass permissions on/i.test(plainLine)
      || /shift\s*\+\s*tab/i.test(plainLine)
      || /for agents/i.test(plainLine)
      || /\/effort/i.test(plainLine);
    if (isIdleChromeLine) {
      changed = true;
      if (sawUsefulOutput) break;
      continue;
    }
    if (!normalized) {
      const previous = keptLines[keptLines.length - 1] ?? '';
      if (!previous.trim()) {
        changed = true;
        continue;
      }
    }
    keptLines.push(plainLine);
  }

  const sanitized = keptLines
    .join('\r\n')
    .replace(/^(?:\r?\n)+/, '')
    .replace(/(?:\r?\n)+$/, '\r\n');
  return { data: sanitized, changed };
}

function stripClaudeActivePromptEchoFrame(data: string, activeUserText?: string): { data: string; changed: boolean } {
  const normalizedUserText = normalizeTerminalLineText(activeUserText ?? '').toLowerCase();
  if (!data || !normalizedUserText) return { data, changed: false };

  const plainData = claudePlainTerminalText(data);
  const lines = plainData.replace(/\r/g, '\n').split('\n');
  const keptLines: string[] = [];
  let changed = plainData !== data;
  let sawUsefulOutput = false;

  for (const line of lines) {
    const plainLine = cleanClaudeVisibleLine(line);
    const normalizedLine = normalizeTerminalLineText(plainLine).toLowerCase();
    const isPromptEcho = normalizedLine === `\u276f ${normalizedUserText}`
      || normalizedLine === `> ${normalizedUserText}`
      || normalizedLine === normalizedUserText;
    if (isPromptEcho) {
      changed = true;
      continue;
    }

    const isIdleChromeLine = isClaudeTerminalChromeLine(normalizedLine) || /^[-\u2500\u2501]{8,}$/.test(plainLine)
      || /^[\u276f>]\s*$/.test(normalizedLine)
      || /bypass permissions on/i.test(plainLine)
      || /shift\s*\+\s*tab/i.test(plainLine)
      || /esc\s+to\s+/i.test(plainLine)
      || /for agents/i.test(plainLine)
      || /\/effort/i.test(plainLine);
    if (isIdleChromeLine) {
      changed = true;
      if (sawUsefulOutput) break;
      continue;
    }

    if (!normalizeTerminalLineText(plainLine)) {
      const previous = keptLines[keptLines.length - 1] ?? '';
      if (!previous.trim()) {
        changed = true;
        continue;
      }
    } else {
      sawUsefulOutput = true;
    }
    keptLines.push(plainLine);
  }

  const sanitized = keptLines
    .join('\r\n')
    .replace(/^(?:\r?\n)+/, '')
    .replace(/(?:\r?\n)+$/, '\r\n');
  return { data: sanitized, changed };
}

function claudeActiveFrameContainsPromptEchoOrChrome(data: string, activeUserText?: string): boolean {
  const normalizedUserText = normalizeTerminalLineText(activeUserText ?? '').toLowerCase();
  if (!data || !normalizedUserText) return false;
  const lines = terminalPlainLines(data);
  return lines.some((line) => {
    const normalizedLine = normalizeTerminalLineText(line).toLowerCase();
    return normalizedLine === `\u276f ${normalizedUserText}`
      || normalizedLine === `> ${normalizedUserText}`
      || normalizedLine === normalizedUserText
      || /^[-\u2500\u2501]{8,}$/.test(line)
      || /^[\u276f>]\s*$/.test(normalizedLine)
      || /bypass permissions on/i.test(line)
      || /shift\s*\+\s*tab/i.test(line)
      || /esc\s+to\s+/i.test(line)
      || /for agents/i.test(line)
      || /\/effort/i.test(line);
  });
}

function clearPendingClaudeSendTimer(pending: PendingClaudeSend | null) {
  if (pending?.diagnosticTimer) clearTimeout(pending.diagnosticTimer);
}

function claudeIdleChromeBufferLine(line: string): boolean {
  const normalized = normalizeTerminalLineText(line);
  if (!normalized) return true;
  return /^[-\u2500\u2501]{8,}$/.test(normalized)
    || /^[\u276f>]\s*$/.test(normalized)
    || /bypass permissions on/i.test(normalized)
    || /shift\s*\+\s*tab/i.test(normalized)
    || /esc\s+to\s+interrupt/i.test(normalized)
    || /for agents/i.test(normalized)
    || /\/effort/i.test(normalized);
}

function clearClaudeIdlePromptRows(term: Terminal | null) {
  if (!term) return false;
  try {
    const buffer = term.buffer.active;
    const visibleStart = Math.max(0, buffer.viewportY);
    const visibleEnd = Math.min(buffer.length - 1, buffer.viewportY + term.rows - 1);
    const rowsToClear: number[] = [];
    let sawPromptChrome = false;

    for (let lineIndex = visibleEnd; lineIndex >= visibleStart; lineIndex -= 1) {
      const text = buffer.getLine(lineIndex)?.translateToString(true) ?? '';
      if (!claudeIdleChromeBufferLine(text)) break;
      const normalized = normalizeTerminalLineText(text);
      if (
        /^[\u276f>]\s*$/.test(normalized)
        || /bypass permissions on/i.test(normalized)
        || /shift\s*\+\s*tab/i.test(normalized)
        || /for agents/i.test(normalized)
        || /\/effort/i.test(normalized)
      ) {
        sawPromptChrome = true;
      }
      rowsToClear.push(lineIndex - buffer.viewportY + 1);
    }

    if (!sawPromptChrome || rowsToClear.length === 0) return false;
    const clearSequence = rowsToClear
      .map((row) => `\x1b[${row};1H\x1b[2K`)
      .join('');
    term.write(`\x1b[s${clearSequence}\x1b[u`);
    return true;
  } catch {
    return false;
  }
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
  try {
    const buffer = term.buffer.active;
    const start = Math.max(0, buffer.viewportY);
    const end = Math.min(buffer.length, start + term.rows);
    for (let lineIndex = start; lineIndex < end; lineIndex += 1) {
      if (buffer.getLine(lineIndex)?.translateToString(true).trim()) return true;
    }
  } catch {
    return Boolean(mount.querySelector<HTMLElement>('.xterm-rows')?.textContent?.trim());
  }
  return Boolean(mount.querySelector<HTMLElement>('.xterm-rows')?.textContent?.trim());
}

function terminalHasVisibleNonChromeContent(term: Terminal | null, mount: HTMLElement | null) {
  if (!term || !mount) return false;
  try {
    const buffer = term.buffer.active;
    const start = Math.max(0, buffer.viewportY);
    const end = Math.min(buffer.length, start + term.rows);
    for (let lineIndex = start; lineIndex < end; lineIndex += 1) {
      const line = buffer.getLine(lineIndex)?.translateToString(true).trim() ?? '';
      if (line && !claudeIdleChromeBufferLine(line)) return true;
    }
    return false;
  } catch {
    return Boolean(mount.querySelector<HTMLElement>('.xterm-rows')?.textContent?.trim());
  }
}

function resetTerminalToTop(term: Terminal | null) {
  if (!term) return;
  try {
    term.reset();
    term.clear();
    term.write('\x1b[2J\x1b[3J\x1b[H');
  } catch {
    // The terminal may be disposed during navigation.
  }
}

function terminalHasScrolledVisibleContent(term: Terminal | null, mount: HTMLElement | null) {
  if (!terminalHasVisibleNonChromeContent(term, mount)) return false;
  try {
    return (term?.buffer.active.baseY ?? 0) > 0;
  } catch {
    return false;
  }
}

function rebaseClaudeFrameRows(data: string, rowOffset: number) {
  if (!data || rowOffset <= 0) return data;
  return data.replace(/\x1b\[([0-9]{1,3})(?:;([0-9]{1,3}))?([Hf])/g, (match, rowValue: string, colValue: string | undefined, suffix: string) => {
    const row = Number(rowValue);
    if (!Number.isFinite(row) || row <= rowOffset) return match;
    const nextRow = Math.max(CLAUDE_NATIVE_START_ROW, row - rowOffset);
    return `\x1b[${nextRow}${colValue ? `;${colValue}` : ''}${suffix}`;
  });
}

function firstAbsoluteCursorRow(data: string) {
  const match = /\x1b\[([0-9]{1,3})(?:;[0-9]{1,3})?[Hf]/.exec(data);
  if (!match) return 0;
  const row = Number(match[1]);
  return Number.isFinite(row) ? row : 0;
}

function isTerminalNearBottom(term: Terminal | null) {
  if (!term) return true;
  try {
    const buffer = term.buffer.active;
    return buffer.baseY - buffer.viewportY <= 1;
  } catch {
    return true;
  }
}

function scrollTerminalToBottom(term: Terminal | null) {
  if (!term) return;
  try {
    term.scrollToBottom();
  } catch {
    // xterm can throw if the instance is already disposed during navigation.
  }
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

function transcriptHasAssistantAfterUser(transcriptMessages: RawMessage[], userText: string, startedAt: number): boolean {
  const normalizedUserText = normalizeTerminalLineText(userText);
  if (!normalizedUserText) return false;
  let userIndex = -1;
  for (let index = transcriptMessages.length - 1; index >= 0; index -= 1) {
    const message = transcriptMessages[index];
    if (message.role !== 'user') continue;
    if (normalizeTerminalLineText(extractText(message)) !== normalizedUserText) continue;
    const timestamp = nativeCliMessageTimestampMs(message);
    if (timestamp && timestamp < startedAt - 10_000) continue;
    userIndex = index;
    break;
  }
  if (userIndex < 0) return false;
  return transcriptMessages.slice(userIndex + 1).some((message) => (
    message.role === 'assistant' && (nativeCliMessageVisibleText(message) || nativeCliMessageVisibleThinking(message))
  ));
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
        --native-cli-composer-height: 124px;
        --native-cli-terminal-gap: 18px;
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
      .native-cli-terminal__mount--native {
        inset: 0 0 calc(var(--native-cli-composer-height) + var(--native-cli-terminal-gap) + ${CLAUDE_NATIVE_VIEWPORT_BOTTOM_GAP}px);
        width: auto;
        height: auto;
        box-sizing: border-box;
        padding: 28px 0 ${CLAUDE_NATIVE_VIEWPORT_BOTTOM_GAP}px;
        opacity: 1;
        pointer-events: auto;
        overflow: hidden;
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
      .native-cli-terminal__loading-inner--error {
        color: hsl(var(--destructive));
        border-color: hsl(var(--destructive) / .25);
        background: hsl(var(--destructive) / .08);
      }
      .native-cli-terminal__composer {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 20;
        min-height: var(--native-cli-composer-height);
        padding: 0 0 16px;
        background: linear-gradient(
          180deg,
          hsl(var(--background) / 0),
          hsl(var(--background) / .96) 34%,
          hsl(var(--background))
        );
      }
      .native-cli-terminal--native .native-cli-terminal__composer {
        background: linear-gradient(
          180deg,
          hsl(var(--background) / 0),
          hsl(var(--background) / .98) 22%,
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
        padding-bottom: ${CLAUDE_NATIVE_VIEWPORT_BOTTOM_GAP}px;
      }
      .native-cli-terminal__mount--native .xterm {
        height: 100% !important;
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
  const claudePromptReadyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const postSendTranscriptRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cliSessionIdPropRef = useRef(cliSessionId);
  const skipResumeResolveRef = useRef(false);
  const reconnectDelayRef = useRef(1000);
  const disposedRef = useRef(false);
  const transcriptLoadInFlightRef = useRef(false);
  const transcriptLoadQueuedRef = useRef(false);
  const liveStreamRef = useRef<EventSource | null>(null);
  const liveStreamTurnIdRef = useRef<string | null>(null);
  const liveStreamSnapshotSignatureRef = useRef<string>('');
  const terminalStatusBufferRef = useRef('');
  const terminalWsMessageCountRef = useRef(0);
  const terminalWsDataFrameCountRef = useRef(0);
  const terminalDataFrameCountRef = useRef(0);
  const terminalDataLastAtRef = useRef(0);
  const terminalFirstOutputAtRef = useRef(0);
  const terminalLastOutputPreviewRef = useRef('');
  const claudePromptReadyFallbackRef = useRef(false);
  const claudeResumeReplayCompleteRef = useRef(false);
  const claudePromptBufferRef = useRef('');
  const claudePromptReadyRef = useRef(false);
  const claudeStartupConfirmationAcceptedRef = useRef(false);
  const claudeNativeRowOffsetRef = useRef(0);
  const pendingClaudeSendRef = useRef<PendingClaudeSend | null>(null);
  const pendingLocalUserMessagesRef = useRef<RawMessage[]>([]);
  const liveAssistantMessageRef = useRef<RawMessage | null>(null);
  const transcriptMessagesRef = useRef<RawMessage[]>([]);

  const [terminalState, dispatchTerminalState] = useReducer(
    nativeCliTerminalReducer,
    initialNativeCliTerminalState,
  );
  const awaitingInitialOutput = terminalState.awaitingInitialOutput;
  const [displayedLoadingLabel, setDisplayedLoadingLabel] = useState('');
  const [startupError, setStartupError] = useState('');
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
    if (effectiveProvider !== 'claude') return;
    const routeModel = configuredClaudeProxyRouteModel;
    const upstreamModel = normalizeOneApiModelId(claudeRuntimeEnv?.CLAWX_NATIVE_CLAUDE_UPSTREAM_MODEL || routeModel);
    if (!routeModel || !upstreamModel || routeModel === upstreamModel) return;
    activeClaudeProxyRouteModelRef.current = routeModel;
    updateClaudeProxyModel(routeModel, upstreamModel).catch((error) => {
      console.warn('[native-cli-terminal] Claude proxy initial model sync failed', {
        agentId,
        sessionKey,
        routeModel,
        upstreamModel,
        error,
      });
    });
  }, [agentId, claudeRuntimeEnv?.CLAWX_NATIVE_CLAUDE_UPSTREAM_MODEL, configuredClaudeProxyRouteModel, effectiveProvider, sessionKey]);

  useEffect(() => {
    liveAssistantMessageRef.current = liveAssistantMessage;
  }, [liveAssistantMessage]);

  useEffect(() => {
    transcriptMessagesRef.current = transcriptMessages;
  }, [transcriptMessages]);

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

  const clearClaudePromptReadyTimer = useCallback(() => {
    if (claudePromptReadyTimerRef.current) {
      clearTimeout(claudePromptReadyTimerRef.current);
      claudePromptReadyTimerRef.current = null;
    }
  }, []);

  const logClaudeStartupFrame = useCallback((raw: string, signal: { ready: boolean; reason: string } | null) => {
    if (effectiveProvider !== 'claude') return;
    if (claudePromptReadyRef.current) return;
    if (terminalDataFrameCountRef.current > CLAUDE_STARTUP_LOG_FRAME_LIMIT) return;
    console.warn('[native-cli-terminal] claude startup frame', {
      agentId,
      sessionKey,
      frame: terminalDataFrameCountRef.current,
      wsMessages: terminalWsMessageCountRef.current,
      dataFrames: terminalWsDataFrameCountRef.current,
      signal,
      preview: terminalDebugPreview(raw),
    });
  }, [agentId, effectiveProvider, sessionKey]);

  const resetVisibleTerminalForResume = useCallback(() => {
    markerBufferRef.current = '';
    recentOutputRef.current = '';
    terminalTurnsRef.current = [];
    activeTerminalTurnIdRef.current = null;
    claudeResumeReplayCompleteRef.current = false;
    claudePromptBufferRef.current = '';
    claudePromptReadyRef.current = false;
    claudePromptReadyFallbackRef.current = false;
    terminalFirstOutputAtRef.current = 0;
    terminalLastOutputPreviewRef.current = '';
    claudeStartupConfirmationAcceptedRef.current = false;
    claudeNativeRowOffsetRef.current = 0;
    setStartupError('');
    clearClaudePromptReadyTimer();
    suppressNativeCliChromeRef.current = effectiveProvider === 'claude';
    if (effectiveProvider === 'claude') {
      bufferRef.current = '';
      termRef.current?.clear();
    }
    clearPendingClaudeSendTimer(pendingClaudeSendRef.current);
    pendingClaudeSendRef.current = null;
    setActiveTranscriptTurnId(null);
    setLiveAssistantMessage(null);
    userHasInteractedRef.current = true;
    persistState();
  }, [effectiveProvider, persistState]);

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

  const refreshTranscriptUntilAssistant = useCallback((prompt: string, startedAt: number, attempt = 1) => {
    if (disposedRef.current) return;
    void loadNativeCliTranscript({ quiet: true, latest: !cliSessionIdRef.current, forceDuringLive: true });
    if (transcriptHasAssistantAfterUser(transcriptMessagesRef.current, prompt, startedAt) || attempt >= 12) return;
    if (postSendTranscriptRefreshTimerRef.current) {
      clearTimeout(postSendTranscriptRefreshTimerRef.current);
    }
    postSendTranscriptRefreshTimerRef.current = setTimeout(() => {
      postSendTranscriptRefreshTimerRef.current = null;
      refreshTranscriptUntilAssistant(prompt, startedAt, attempt + 1);
    }, Math.min(500 + attempt * 250, 1800));
  }, [loadNativeCliTranscript]);

  const closeClaudeLiveStream = useCallback((turnId?: string | null) => {
    if (turnId && liveStreamTurnIdRef.current && liveStreamTurnIdRef.current !== turnId) return;
    liveStreamRef.current?.close();
    liveStreamRef.current = null;
    liveStreamTurnIdRef.current = null;
    liveStreamSnapshotSignatureRef.current = '';
    terminalStatusBufferRef.current = '';
    liveAssistantMessageRef.current = null;
    setLiveAssistantStreaming(false);
  }, []);

  const startClaudeLiveStream = useCallback((_turnId: string, _prompt: string): Promise<void> | null => (
    null
  ), []);

  const upsertTerminalTurn = useCallback((marker: Extract<TerminalStreamMarker, { kind: 'turn_start' }>) => {
    const existing = terminalTurnsRef.current.find((turn) => turn.id === marker.turnId);
    if (existing) {
      existing.conversationId = marker.conversationId;
      existing.userText = marker.userText;
      existing.state = 'active';
      activeTerminalTurnIdRef.current = existing.id;
      terminalStatusBufferRef.current = '';
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
      terminalStatusBufferRef.current = '';
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
    terminalStatusBufferRef.current = '';
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
      void loadNativeCliTranscript({ quiet: true, latest: !cliSessionIdRef.current, forceDuringLive: true });
      return;
    }
    if (effectiveProvider === 'claude') {
      suppressNativeCliChromeRef.current = true;
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
  }, [closeClaudeLiveStream, effectiveProvider, loadNativeCliTranscript, updateLiveAssistantSnapshot, upsertTerminalTurn]);

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

  const markClaudePromptReady = useCallback((reason: string, fallback = false) => {
    if (effectiveProvider !== 'claude') return;
    if (claudePromptReadyRef.current) return;
    claudePromptReadyRef.current = true;
    claudePromptReadyFallbackRef.current = fallback;
    clearClaudePromptReadyTimer();
    if (!fallback) {
      setStartupError('');
    }
    console.warn('[native-cli-terminal] claude prompt ready', {
      agentId,
      sessionKey,
      reason,
      fallback,
      frames: terminalDataFrameCountRef.current,
      wsMessages: terminalWsMessageCountRef.current,
      dataFrames: terminalWsDataFrameCountRef.current,
      firstOutputAgoMs: terminalFirstOutputAtRef.current ? Date.now() - terminalFirstOutputAtRef.current : null,
      lastOutput: terminalLastOutputPreviewRef.current,
    });
    persistState();
    settleReadyWithoutInitialOutput();
    mountRef_cb.current.flushPendingClaudeSend();
  }, [agentId, clearClaudePromptReadyTimer, effectiveProvider, persistState, sessionKey, settleReadyWithoutInitialOutput]);

  const handleTerminalData = useCallback((raw: string) => {
    terminalDataFrameCountRef.current += 1;
    terminalDataLastAtRef.current = Date.now();
    const wasClaudePromptReady = claudePromptReadyRef.current;
    const visibleRaw = stripTerminalStreamMarkers(raw);
    const claudeFrameHasConversation = effectiveProvider === 'claude' && hasClaudeConversationOutput(visibleRaw);
    updateShellPassthroughState(visibleRaw);
    const printable = hasPrintableTerminalContent(visibleRaw);
    if (printable) {
      terminalFirstOutputAtRef.current ||= Date.now();
      terminalLastOutputPreviewRef.current = terminalDebugPreview(visibleRaw);
    }
    const activeTurnId = activeTerminalTurnIdRef.current;
    let claudeReadySignal: { ready: boolean; reason: string } | null = null;
    if (effectiveProvider === 'claude' && printable) {
      claudePromptBufferRef.current = `${claudePromptBufferRef.current}${visibleRaw}`.slice(-CLAUDE_PROMPT_BUFFER_CHARS);
      claudeReadySignal = claudePromptReadySignal(claudePromptBufferRef.current);
      if (claudeReadySignal.ready && !claudePromptReadyRef.current) {
        const pending = pendingClaudeSendRef.current;
        clearPendingClaudeSendTimer(pending);
        if (
          !claudeFrameHasConversation
          && !claudeResumeReplayCompleteRef.current
          && !bufferRef.current
          && !terminalHasVisibleNonChromeContent(termRef.current, mountRef.current)
        ) {
          bufferRef.current = '';
          const cursorRow = termRef.current?.buffer.active.cursorY ?? 0;
          claudeNativeRowOffsetRef.current = Math.max(0, cursorRow - (CLAUDE_NATIVE_START_ROW - 1));
          resetTerminalToTop(termRef.current);
        }
        markClaudePromptReady(claudeReadySignal.reason);
      } else {
        logClaudeStartupFrame(visibleRaw, claudeReadySignal);
        const startupConfirmation = claudeStartupConfirmationSignal(claudePromptBufferRef.current);
        if (
          startupConfirmation.confirm
          && !claudeStartupConfirmationAcceptedRef.current
          && wsRef.current?.readyState === WebSocket.OPEN
        ) {
          claudeStartupConfirmationAcceptedRef.current = true;
          wsRef.current.send(JSON.stringify({ type: 'data', data: '\r' }));
        }
      }
    }
    if (
      effectiveProvider === 'claude'
      && !shellPassthroughRef.current
      && !wasClaudePromptReady
      && !claudeFrameHasConversation
    ) {
      return;
    }
    const activeTurn = activeTurnId
      ? terminalTurnsRef.current.find((turn) => turn.id === activeTurnId)
      : undefined;
    const isClaudeTurnActivelyStreaming = effectiveProvider === 'claude'
      && activeTurn?.state === 'active';
    const shouldSuppressClaudeResumeChrome = effectiveProvider === 'claude'
      && suppressNativeCliChromeRef.current
      && !activeTurnId
      && !shellPassthroughRef.current
      && isClaudeNativeChromeFrame(visibleRaw);
    const shouldSuppressClaudeIdleChrome = effectiveProvider === 'claude'
      && Boolean(activeTurnId)
      && !isClaudeTurnActivelyStreaming
      && !shellPassthroughRef.current
      && isClaudeNativeChromeFrame(visibleRaw, activeTurn?.userText);
    const shouldSuppressClaudeStartupChrome = effectiveProvider === 'claude'
      && !activeTurnId
      && !userHasInteractedRef.current
      && !shellPassthroughRef.current
      && isClaudeNativeChromeFrame(visibleRaw);
    const shouldSuppressNativeCliChrome = suppressNativeCliChromeRef.current
      && !activeTurnId
      && !shellPassthroughRef.current
      && (effectiveProvider !== 'claude' || shouldSuppressClaudeResumeChrome);
    const shouldSuppressTerminalFrame = shouldSuppressNativeCliChrome
      || shouldSuppressClaudeIdleChrome
      || shouldSuppressClaudeStartupChrome;
    if (shouldSuppressTerminalFrame) {
      if (printable && effectiveProvider !== 'claude') settleReadyWithoutInitialOutput();
      if (printable && effectiveProvider === 'claude' && claudePromptReadyRef.current) {
        if (!activeTurnId) {
          if (!claudeResumeReplayCompleteRef.current && !bufferRef.current) {
            bufferRef.current = '';
            const cursorRow = termRef.current?.buffer.active.cursorY ?? 0;
            claudeNativeRowOffsetRef.current = Math.max(0, cursorRow - (CLAUDE_NATIVE_START_ROW - 1));
            resetTerminalToTop(termRef.current);
          }
        }
        settleReadyWithoutInitialOutput();
        mountRef_cb.current.flushPendingClaudeSend();
      }
      return;
    }
    if (
      effectiveProvider === 'claude'
      && !shellPassthroughRef.current
      && !activeTurnId
      && claudeResumeReplayCompleteRef.current
    ) {
      if (!printable || isClaudeNativeChromeFrame(visibleRaw)) {
        settleReadyWithoutInitialOutput();
        mountRef_cb.current.flushPendingClaudeSend();
        return;
      }
    }
    const shouldLinearizeClaudeFrame = effectiveProvider === 'claude' && !shellPassthroughRef.current && (
      !isClaudeTurnActivelyStreaming
      && (
        claudeFrameHasConversation
        || /^[\s\S]*\x1b\[[0-9;]*[Hf][\s\S]*/.test(raw)
      )
    );
    const shouldStripActiveClaudePromptEcho = effectiveProvider === 'claude'
      && !shellPassthroughRef.current
      && isClaudeTurnActivelyStreaming
      && Boolean(activeTurn?.userText)
      && claudeActiveFrameContainsPromptEchoOrChrome(visibleRaw, activeTurn?.userText);
    const activeClaudePromptEchoFrame = shouldStripActiveClaudePromptEcho
      && activeTurn?.userText
      && terminalPlainLines(visibleRaw).some((line) => isClaudePromptEchoLine(line, activeTurn.userText));
    const shouldSuppressActiveClaudeSpinnerFrame = effectiveProvider === 'claude'
      && !shellPassthroughRef.current
      && isClaudeTurnActivelyStreaming
      && isClaudeActiveSpinnerFrame(visibleRaw);
    if (shouldSuppressActiveClaudeSpinnerFrame) {
      settleReadyWithoutInitialOutput();
      mountRef_cb.current.flushPendingClaudeSend();
      return;
    }
    const shouldLinearizeActiveClaudeFrame = effectiveProvider === 'claude'
      && !shellPassthroughRef.current
      && isClaudeTurnActivelyStreaming
      && (
        claudeFrameHasConversation
        || activeClaudePromptEchoFrame
        || shouldStripActiveClaudePromptEcho
      );
    if (
      effectiveProvider === 'claude'
      && !shellPassthroughRef.current
      && claudeNativeRowOffsetRef.current === 0
      && !terminalHasScrolledVisibleContent(termRef.current, mountRef.current)
    ) {
      const firstRow = firstAbsoluteCursorRow(visibleRaw);
      if (firstRow > CLAUDE_NATIVE_START_ROW) {
        claudeNativeRowOffsetRef.current = firstRow - CLAUDE_NATIVE_START_ROW;
      }
    }
    const frameToWrite = effectiveProvider === 'claude'
      ? (
        rebaseClaudeFrameRows(
          shouldLinearizeActiveClaudeFrame
            ? (
              claudeFrameHasConversation || activeClaudePromptEchoFrame
                ? linearizeClaudeTerminalFrameV2(visibleRaw).data
                : stripClaudeActivePromptEchoFrame(visibleRaw, activeTurn?.userText).data
            )
            : (
              shouldLinearizeClaudeFrame
                ? linearizeClaudeTerminalFrameV2(visibleRaw).data
                : (
                  shouldStripActiveClaudePromptEcho
                    ? stripClaudeActivePromptEchoFrame(visibleRaw, activeTurn?.userText).data
                    : visibleRaw
                )
            ),
          terminalHasScrolledVisibleContent(termRef.current, mountRef.current)
            ? 0
            : claudeNativeRowOffsetRef.current,
        )
      )
      : raw;
    if (!frameToWrite) {
      settleReadyWithoutInitialOutput();
      mountRef_cb.current.flushPendingClaudeSend();
      return;
    }
    if (effectiveProvider === 'claude' && !shellPassthroughRef.current && claudeFrameHasConversation && !activeTurnId) {
      claudeResumeReplayCompleteRef.current = true;
    }
    bufferRef.current = `${bufferRef.current}${frameToWrite}`.slice(-100_000);
    persistState();
    const term = termRef.current;
    if (term) {
      term.write(frameToWrite, () => {
        if (effectiveProvider === 'claude' && clearClaudeIdlePromptRows(term)) {
        }
        scrollTerminalToBottom(term);
        if (printable) requestInitialOutputSettle();
        if (activeTerminalTurnIdRef.current && printable) {
          updateLiveAssistantSnapshot();
        }
      });
    }
  }, [agentId, effectiveProvider, persistState, requestInitialOutputSettle, sessionKey, settleReadyWithoutInitialOutput, stripTerminalStreamMarkers, updateLiveAssistantSnapshot, updateShellPassthroughState]);

  const sendTerminalData = useCallback((data: string) => {
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
    scrollTerminalToBottom(term);
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

  const requestReconnectSoon = useCallback((...args: [reason: string, options?: { skipResumeResolve?: boolean }]) => {
    const [, options] = args;
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;
    if (connectInFlightRef.current || reconnectTimerRef.current) return;
    if (options?.skipResumeResolve) {
      skipResumeResolveRef.current = true;
      activeSessionResolveRef.current = '';
    }
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      void mountRef_cb.current.connect();
    }, 50);
  }, [agentId, sessionKey]);

  const restartTerminalForSkillReload = useCallback((skillCount: number) => {
    if (effectiveProvider !== 'claude') return;
    const knownCliSessionId = cliSessionIdRef.current || resolveStoredCliSessionId(sessionKey, cliSessionIdPropRef.current);
    if (knownCliSessionId) {
      cliSessionIdRef.current = knownCliSessionId;
      skipResumeResolveRef.current = false;
      shellPassthroughRef.current = false;
      recentOutputRef.current = '';
      persistNativeCliSessionId(sessionKey, knownCliSessionId, normalizedProvider);
      persistState();
    } else if (!skillReloadInFlightRef.current) {
      skillReloadInFlightRef.current = true;
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
      return;
    }
    if (wsRef.current?.readyState === WebSocket.CONNECTING) {
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
      return;
    }
    connectInFlightRef.current = true;

    const storedCliSessionId = cliSessionIdRef.current || resolveStoredCliSessionId(sessionKey, cliSessionIdPropRef.current);
    dispatchTerminalState({
      type: 'connect_requested',
      phase: storedCliSessionId ? 'resuming' : 'starting',
    });
    initialOutputPendingPaintRef.current = false;

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
      return;
    }
    const port = typeof statusResult?.port === 'number' && statusResult.port > 0 ? statusResult.port : 18789;
    const statusWsProtocol = statusResult?.tls === true ? 'wss' : 'ws';
    const wsProtocol = gatewayWsProtocolOverrideRef.current ?? statusWsProtocol;
    const knownCliSessionId = storedCliSessionId;
    forceFreshConnectRef.current = false;
    cliSessionIdRef.current = knownCliSessionId;
    claudePromptBufferRef.current = '';
    claudePromptReadyFallbackRef.current = false;
    terminalFirstOutputAtRef.current = 0;
    terminalLastOutputPreviewRef.current = '';
    claudeStartupConfirmationAcceptedRef.current = false;
    setStartupError('');
    clearClaudePromptReadyTimer();
    if (knownCliSessionId) {
      dispatchTerminalState({ type: 'connect_requested', phase: 'resuming' });
      resetVisibleTerminalForResume();
      claudePromptReadyRef.current = effectiveProvider !== 'claude';
      persistNativeCliSessionId(sessionKey, knownCliSessionId, normalizedProvider);
      persistState();
    } else {
      claudePromptReadyRef.current = effectiveProvider !== 'claude';
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
    const ws = new WebSocket(terminalWsUrl);
    wsRef.current = ws;
    let openedAt = 0;
    terminalWsMessageCountRef.current = 0;
    terminalWsDataFrameCountRef.current = 0;
    suppressNativeCliChromeRef.current = effectiveProvider === 'claude';

    ws.onopen = () => {
      if (disposedRef.current) return;
      if (wsRef.current !== ws) return;
      openedAt = Date.now();
      gatewayWsProtocolOverrideRef.current = null;
      connectInFlightRef.current = false;
      reconnectDelayRef.current = 1000;
      dispatchTerminalState({ type: 'websocket_opened' });
      mountRef_cb.current.fitTerminalToContent();
      const term = termRef.current;
      if (term) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      if (effectiveProvider !== 'claude' && !knownCliSessionId) mountRef_cb.current.settleReadyWithoutInitialOutput();
      if (effectiveProvider === 'claude') {
        clearClaudePromptReadyTimer();
        claudePromptReadyTimerRef.current = setTimeout(() => {
          if (disposedRef.current) return;
          if (wsRef.current !== ws) return;
          if (claudePromptReadyRef.current) return;
          const hasOutput = terminalFirstOutputAtRef.current > 0;
          console.warn('[native-cli-terminal] claude prompt readiness timeout', {
            agentId,
            sessionKey,
            timeoutMs: CLAUDE_PROMPT_READY_TIMEOUT_MS,
            hasOutput,
            wsMessages: terminalWsMessageCountRef.current,
            dataFrames: terminalWsDataFrameCountRef.current,
            terminalFrames: terminalDataFrameCountRef.current,
            lastOutput: terminalLastOutputPreviewRef.current,
            url: terminalWsUrlRef.current,
          });
          setStartupError('');
          markClaudePromptReady(hasOutput ? 'timeout_after_output' : 'timeout_without_output', true);
        }, CLAUDE_PROMPT_READY_TIMEOUT_MS);
      }
    };

    ws.onmessage = (event) => {
      if (disposedRef.current) return;
      if (wsRef.current !== ws) return;
      terminalWsMessageCountRef.current += 1;
      try {
        const msg = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (msg.type === 'data' && typeof msg.data === 'string') {
          terminalWsDataFrameCountRef.current += 1;
          mountRef_cb.current.handleTerminalData(msg.data);
        } else if (msg.type === 'assistant_turn_start') {
          suppressNativeCliChromeRef.current = false;
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
        } else if (msg.type === 'exit') {
          const exitCode = String(msg.code ?? 0);
          const message = `Claude CLI process exited (${exitCode}). Check that Claude Code is installed, logged in, and usable from this environment.`;
          clearClaudePromptReadyTimer();
          setStartupError(message);
          console.warn('[native-cli-terminal] process exited', {
            agentId,
            sessionKey,
            provider: effectiveProvider,
            code: msg.code ?? 0,
            wsMessages: terminalWsMessageCountRef.current,
            dataFrames: terminalWsDataFrameCountRef.current,
            lastOutput: terminalLastOutputPreviewRef.current,
          });
          if (userHasInteractedRef.current || effectiveProvider === 'claude') {
            termRef.current?.write(`\r\n\x1b[33m[process exited: ${exitCode}]\x1b[0m\r\n`);
          }
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
      clearClaudePromptReadyTimer();
      if (effectiveProvider === 'claude' && !suppressNextDisconnectBannerRef.current) {
        setStartupError('Claude CLI connection closed. Reconnecting...');
      }
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
    };

    ws.onerror = () => {
      if (disposedRef.current) return;
      if (wsRef.current !== ws) return;
      connectInFlightRef.current = false;
      dispatchTerminalState({ type: 'websocket_error' });
      initialOutputPendingPaintRef.current = false;
      clearClaudePromptReadyTimer();
      if (effectiveProvider === 'claude') {
        setStartupError('Claude CLI WebSocket error. Reconnecting...');
      }
      console.warn('[native-cli-terminal] websocket error', {
        agentId,
        sessionKey,
        provider: effectiveProvider,
        url: terminalWsUrlRef.current,
        wsMessages: terminalWsMessageCountRef.current,
        dataFrames: terminalWsDataFrameCountRef.current,
        lastOutput: terminalLastOutputPreviewRef.current,
      });
    };
  }, [
    agentId,
    bindNativeCliSessionId,
    clearClaudePromptReadyTimer,
    effectiveProvider,
    markClaudePromptReady,
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
    return { turnId: marker.turnId, register };
  }, [agentId, persistState, sessionKey, startClaudeLiveStream, upsertTerminalTurn]);

  const sendClaudePtyCompose = useCallback((
    text: string,
    options: {
      startedAt: number;
      queuedAt?: number;
      turnId?: string;
      reason?: string;
    },
  ): boolean => {
    const ws = wsRef.current;
    const diagnostic = messageDiagnostic(text);
    if (ws?.readyState !== WebSocket.OPEN) {
      dispatchTerminalState({ type: 'websocket_closed' });
      requestReconnectSoon('send_claude_compose_socket_not_open');
      console.warn('[native-cli-terminal] claude pty compose blocked: websocket not open', {
        agentId,
        sessionKey,
        turnId: options.turnId ?? activeTerminalTurnIdRef.current,
        wsState: wsReadyStateName(ws?.readyState),
        message: diagnostic,
      });
      return false;
    }

    const payloads = claudePromptToPtyInput(text);
    for (let index = 0; index < payloads.length; index += 1) {
      const sent = sendTerminalData(payloads[index]);
      if (!sent) return false;
    }
    refreshTranscriptUntilAssistant(text, options.startedAt);
    startCliSessionIdFallbackResolver(text, options.startedAt);
    persistState();
    return true;
  }, [
    agentId,
    persistState,
    refreshTranscriptUntilAssistant,
    requestReconnectSoon,
    sendTerminalData,
    sessionKey,
    startCliSessionIdFallbackResolver,
  ]);

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
    if (
      effectiveProvider === 'claude'
      && !activeTerminalTurnIdRef.current
      && !terminalHasVisibleNonChromeContent(termRef.current, mountRef.current)
    ) {
      bufferRef.current = '';
      const cursorRow = termRef.current?.buffer.active.cursorY ?? 0;
      claudeNativeRowOffsetRef.current = Math.max(0, cursorRow - (CLAUDE_NATIVE_START_ROW - 1));
      resetTerminalToTop(termRef.current);
    }
    const liveTurn = decorateLocalTerminalTurn(text);
    if (liveTurn?.register) {
      liveTurn.register.catch(() => {
        // Failure is logged by startClaudeLiveStream; sending should not wait on live UI registration.
      });
    }
    if (useNativeCliChatCompose) {
      const turnId = liveTurn?.turnId ?? activeTerminalTurnIdRef.current ?? `local-${Date.now().toString(36)}`;
      if (!claudePromptReadyRef.current) {
        closeClaudeLiveStream(turnId);
        activeTerminalTurnIdRef.current = null;
        terminalTurnsRef.current = terminalTurnsRef.current.filter((turn) => turn.id !== turnId);
        setActiveTranscriptTurnId(null);
        persistState();
        return false;
      }
      const sent = sendClaudePtyCompose(text, {
        startedAt,
        turnId,
        reason: 'prompt_ready',
      });
      if (!sent) return false;
    } else {
      ws.send(JSON.stringify({ type: 'user_text', text }));
      startCliSessionIdFallbackResolver(text, startedAt);
      persistState();
    }
    return true;
  }, [agentId, closeClaudeLiveStream, decorateLocalTerminalTurn, effectiveProvider, onUserText, persistState, requestReconnectSoon, sendClaudePtyCompose, sendShellCompose, sessionKey, startCliSessionIdFallbackResolver, terminalState.status]);

  const flushPendingClaudeSend = useCallback(() => {
    const pending = pendingClaudeSendRef.current;
    if (!pending) return;
    if (effectiveProvider !== 'claude' || !claudePromptReadyRef.current) return;
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    clearPendingClaudeSendTimer(pending);
    pendingClaudeSendRef.current = null;
    const sent = sendClaudePtyCompose(pending.text, {
      startedAt: pending.startedAt,
      queuedAt: pending.queuedAt,
      turnId: pending.turnId,
      reason: 'prompt_ready_flush',
    });
    if (!sent) {
      pendingClaudeSendRef.current = pending;
      console.warn('[native-cli-terminal] queued claude send flush failed', {
        agentId,
        sessionKey,
        turnId: pending.turnId,
        message: messageDiagnostic(pending.text),
        wsState: wsReadyStateName(wsRef.current?.readyState),
      });
    }
  }, [agentId, effectiveProvider, sendClaudePtyCompose, sessionKey]);

  const handleChatInputSend = useCallback((text: string): boolean | Promise<boolean> => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    const ws = wsRef.current;
    const diagnostic = messageDiagnostic(trimmed);
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
    if (effectiveProvider === 'claude' && !claudePromptReadyRef.current) {
      return false;
    }
    if (effectiveProvider !== 'claude' && !nativeCliTerminalCanSend(terminalState)) {
      console.warn('[native-cli-terminal] send rejected: terminal not ready', {
        agentId,
        sessionKey,
        wsState: wsReadyStateName(ws?.readyState),
        terminalState: terminalState.status,
        awaitingInitialOutput: terminalState.awaitingInitialOutput,
        message: diagnostic,
      });
      return false;
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
        reloadGateway: false,
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
  }, [agent, agentId, configuredClaudeProxyRouteModel, effectiveProvider, refreshAgents]);

  // Stable ref for mount-effect callbacks so the terminal instance survives
  // callback identity changes (e.g. normalizedProvider undefined → 'claude').
  const mountRef_cb = useRef({
    connect, sendTerminalData, fitTerminalToContent, scheduleTerminalResize,
    maybeSettleInitialOutput, handleTerminalStreamMarker, persistState,
    handleTerminalData, upsertTerminalTurn, bindNativeCliSessionId,
    settleReadyWithoutInitialOutput, resetVisibleTerminalForResume,
    updateInputShellStateFromTerminalScroll, restartTerminalForSkillReload,
    closeClaudeLiveStream, flushPendingClaudeSend, markClaudePromptReady,
  });
  mountRef_cb.current = {
    connect, sendTerminalData, fitTerminalToContent, scheduleTerminalResize,
    maybeSettleInitialOutput, handleTerminalStreamMarker, persistState,
    handleTerminalData, upsertTerminalTurn, bindNativeCliSessionId,
    settleReadyWithoutInitialOutput, resetVisibleTerminalForResume,
    updateInputShellStateFromTerminalScroll, restartTerminalForSkillReload,
    closeClaudeLiveStream, flushPendingClaudeSend, markClaudePromptReady,
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
    bufferRef.current = effectiveProvider === 'claude' ? '' : stripTerminalStreamMarkers(persisted.buffer ?? '');
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
      term.write(bufferRef.current, () => {
        scrollTerminalToBottom(term);
        if (effectiveProvider === 'claude') {
        }
      });
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
    if (effectiveProvider === 'claude') {
      requestAnimationFrame(() => {
        if (disposedRef.current) return;
        if (termRef.current !== term || mountRef.current !== mount) return;
      });
    }

    void mountRef_cb.current.connect();

    return () => {
      disposedRef.current = true;
      dispatchTerminalState({ type: 'disposed' });
      mountRef_cb.current.closeClaudeLiveStream();
      mountRef_cb.current.persistState();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (transcriptPollTimerRef.current) clearInterval(transcriptPollTimerRef.current);
      if (transcriptIdleTimerRef.current) clearTimeout(transcriptIdleTimerRef.current);
      if (postSendTranscriptRefreshTimerRef.current) clearTimeout(postSendTranscriptRefreshTimerRef.current);
      clearClaudePromptReadyTimer();
      clearPendingClaudeSendTimer(pendingClaudeSendRef.current);
      pendingClaudeSendRef.current = null;
      if (resizeRafRef.current) cancelAnimationFrame(resizeRafRef.current);
      if (initialOutputRafRef.current) cancelAnimationFrame(initialOutputRafRef.current);
      if (loadingExitTimerRef.current) clearTimeout(loadingExitTimerRef.current);
      reconnectTimerRef.current = null;
      transcriptPollTimerRef.current = null;
      transcriptIdleTimerRef.current = null;
      postSendTranscriptRefreshTimerRef.current = null;
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
  }, [effectiveProvider, sessionKey]);

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
    const activeTranscriptTurn = activeTranscriptTurnId
      ? terminalTurnsRef.current.find((turn) => turn.id === activeTranscriptTurnId)
      : null;
    const shouldPoll = terminalState.status === 'connected'
      && !liveAssistantStreaming
      && !liveStreamRef.current
      && activeTranscriptTurn?.state === 'active';
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

  const terminalSocketOpen = wsRef.current?.readyState === WebSocket.OPEN;
  const nativeCliInputDisabled = !terminalSocketOpen
    || (effectiveProvider === 'claude'
      ? !claudePromptReadyRef.current
      : !nativeCliTerminalCanSend(terminalState));
  const desiredLoadingLabel = startupError
    || (nativeCliInputDisabled ? nativeCliTerminalLoadingLabel(terminalState) : '');
  const displayedStatusLabel = startupError || displayedLoadingLabel;

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
  const showNativeClaudeTerminal = effectiveProvider === 'claude';

  return (
    <div className={`native-cli-terminal${showNativeClaudeTerminal ? ' native-cli-terminal--native' : ''}`}>
      <NativeCliTerminalStyles />
      <div ref={areaRef} className="native-cli-terminal__area">
        <div
          ref={mountRef}
          className={`native-cli-terminal__mount${showNativeClaudeTerminal ? ' native-cli-terminal__mount--native' : ''}`}
        />
        {!showNativeClaudeTerminal ? (
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
        ) : null}
        {displayedStatusLabel ? (
          <div
            className={`native-cli-terminal__loading${loadingExiting ? ' native-cli-terminal__loading--exiting' : ''}`}
            role="status"
            aria-live="polite"
          >
            <div className={`native-cli-terminal__loading-inner${startupError ? ' native-cli-terminal__loading-inner--error' : ''}`}>
              {startupError ? null : <Loader2 />}
              <span>{displayedStatusLabel}</span>
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
            disabledPlaceholder={startupError || desiredLoadingLabel || '正在连接会话'}
            sending={false}
            isExpanded={inputShellState !== 'collapsed'}
            onFocusChange={handleInputFocusChange}
          />
        </div>
      </div>
    </div>
  );
}
