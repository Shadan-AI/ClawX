import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { getPort } from '../utils/config';
import { logger } from '../utils/logger';

const ONEAPI_BASE_URL = 'https://one-api.shadanai.com/v1';
const CLAUDE_ALIAS_MODELS = [
  { id: 'claude-haiku-4-5', display_name: 'ClawX Haiku' },
  { id: 'claude-sonnet-4-6', display_name: 'ClawX Sonnet' },
  { id: 'claude-opus-4-7', display_name: 'ClawX Opus' },
];
const modelOverrides = new Map<string, string>();

type LivePromptRegistration = {
  sessionKey: string;
  turnId: string;
  prompt: string;
  createdAt: number;
};

type LiveContentBlock = Record<string, unknown> & {
  type?: string;
  text?: string;
  thinking?: string;
  input?: unknown;
  _inputJson?: string;
};

type ContentBlockGuardResult =
  | { action: 'allow' }
  | { action: 'replace'; block: Record<string, unknown> };

type LiveTurnState = {
  routeModel: string;
  sessionKey: string;
  turnId: string;
  prompt: string;
  status: 'running' | 'completed' | 'error';
  awaitingToolContinuation: boolean;
  content: LiveContentBlock[];
  text: string;
  thinking: string;
  eventCount: number;
  requestCount: number;
  lastRequestAt: number;
  loggedFirstChunk: boolean;
  updatedAt: number;
  subscribers: Set<ServerResponse>;
};

const pendingLivePrompts = new Map<string, LivePromptRegistration[]>();
const liveTurns = new Map<string, LiveTurnState>();
const LIVE_PROMPT_MAX_AGE_MS = 2 * 60 * 1000;
const LIVE_TURN_RETENTION_MS = 10 * 60 * 1000;

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function sendText(res: ServerResponse, statusCode: number, text: string): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(text);
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, anthropic-version, anthropic-beta, x-api-key, authorization');
}

function stripOneMMarker(model: string): string {
  return model.trim().replace(/\s*\[1m\]\s*$/i, '');
}

function isAutoOpenShellCommand(command: string): boolean {
  return /(?:^|[;&|]\s*)(?:(?:cmd(?:\.exe)?\s*\/c|powershell(?:\.exe)?\s+-Command)\s+)?(?:start(?:\s|$)|explorer(?:\.exe)?(?:\s|$)|start-process(?:\s|$)|invoke-item(?:\s|$)|ii(?:\s|$)|rundll32\s+url\.dll,FileProtocolHandler(?:\s|$)|open(?:\s|$)|xdg-open(?:\s|$)|gio\s+open(?:\s|$)|gnome-open(?:\s|$)|kde-open5?(?:\s|$))/im.test(command);
}

function guardClaudeContentBlock(block: Record<string, unknown>): ContentBlockGuardResult {
  if (block?.type !== 'tool_use' && block?.type !== 'server_tool_use') return { action: 'allow' };
  if (block.name !== 'Bash') return { action: 'allow' };
  const input = block.input && typeof block.input === 'object' ? block.input as Record<string, unknown> : {};
  const command = typeof input.command === 'string' ? input.command : '';
  if (!command || !isAutoOpenShellCommand(command)) return { action: 'allow' };
  return {
    action: 'replace',
    block: {
      type: 'text',
      text: 'The file is ready in your workspace. ClawX blocked automatic opening; use the file card to open it when you choose.',
    },
  };
}

function bodyDiagnostic(rawBody: Buffer) {
  let hash = 2166136261;
  for (const byte of rawBody) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return {
    bytes: rawBody.length,
    hash: (hash >>> 0).toString(16).padStart(8, '0'),
  };
}

function extractUpstreamModel(pathname: string): string | null {
  const match = pathname.match(/^\/native-claude\/([^/]+)(?:\/|$)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]).trim() || null;
  } catch {
    return null;
  }
}

function resolveUpstreamModel(routeModel: string): string {
  return modelOverrides.get(routeModel) || routeModel;
}

function upstreamPath(pathname: string): string | null {
  const match = pathname.match(/^\/native-claude\/[^/]+(?:\/v1)?(\/.*)?$/);
  if (!match) return null;
  const path = match[1] || '/';
  return path.startsWith('/v1/') ? path.slice(3) : path;
}

function buildForwardHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  const contentType = req.headers['content-type'];
  const anthropicVersion = req.headers['anthropic-version'];
  const anthropicBeta = req.headers['anthropic-beta'];
  const xApiKey = req.headers['x-api-key'];
  const authorization = req.headers.authorization;

  if (typeof contentType === 'string') headers.set('content-type', contentType);
  if (typeof anthropicVersion === 'string') headers.set('anthropic-version', anthropicVersion);
  if (typeof anthropicBeta === 'string') headers.set('anthropic-beta', anthropicBeta);
  if (typeof xApiKey === 'string') {
    headers.set('x-api-key', xApiKey);
    if (!authorization) headers.set('authorization', `Bearer ${xApiKey}`);
  }
  if (typeof authorization === 'string') headers.set('authorization', authorization);

  return headers;
}

function routeDiagnostic(req: IncomingMessage, pathname: string, routeModel: string | null, path: string | null) {
  return {
    method: req.method,
    pathname,
    routeModel,
    path,
    contentType: req.headers['content-type'],
    hasAnthropicVersion: typeof req.headers['anthropic-version'] === 'string',
    hasApiKey: typeof req.headers['x-api-key'] === 'string' || typeof req.headers.authorization === 'string',
  };
}

type RewriteMessagesBodyResult = {
  body: Buffer;
  strippedThinkingBlockCount: number;
  droppedAssistantMessageCount: number;
};

function isAnthropicReasoningBlock(block: unknown): boolean {
  return Boolean(block && typeof block === 'object' && [
    'thinking',
    'redacted_thinking',
  ].includes(String((block as Record<string, unknown>).type ?? '')));
}

function sanitizeAssistantReasoningHistory(body: Record<string, unknown>): {
  body: Record<string, unknown>;
  strippedThinkingBlockCount: number;
  droppedAssistantMessageCount: number;
} {
  const messages = Array.isArray(body.messages)
    ? body.messages as Array<Record<string, unknown>>
    : null;
  if (!messages) {
    return { body, strippedThinkingBlockCount: 0, droppedAssistantMessageCount: 0 };
  }

  let strippedThinkingBlockCount = 0;
  let droppedAssistantMessageCount = 0;
  const sanitizedMessages = messages.flatMap((message) => {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) {
      return [message];
    }

    const nextContent = message.content.filter((block) => {
      if (!isAnthropicReasoningBlock(block)) return true;
      strippedThinkingBlockCount += 1;
      return false;
    });
    if (nextContent.length === message.content.length) return [message];
    if (nextContent.length === 0) {
      droppedAssistantMessageCount += 1;
      return [];
    }
    return [{ ...message, content: nextContent }];
  });

  if (strippedThinkingBlockCount === 0 && droppedAssistantMessageCount === 0) {
    return { body, strippedThinkingBlockCount, droppedAssistantMessageCount };
  }

  return {
    body: { ...body, messages: sanitizedMessages },
    strippedThinkingBlockCount,
    droppedAssistantMessageCount,
  };
}

function rewriteMessagesBody(rawBody: Buffer, upstreamModel: string): RewriteMessagesBodyResult {
  if (rawBody.length === 0) {
    return { body: rawBody, strippedThinkingBlockCount: 0, droppedAssistantMessageCount: 0 };
  }
  const body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
  body.model = stripOneMMarker(upstreamModel);
  const routingNote = [
    `ClawX routing note: the visible Claude Code CLI alias is backed by upstream model "${body.model}".`,
    `If the user asks what model is currently running, answer "${body.model}", not the Claude CLI alias.`,
  ].join(' ');
  if (typeof body.system === 'string') {
    body.system = `${body.system}\n\n${routingNote}`;
  } else if (Array.isArray(body.system)) {
    body.system = [
      ...body.system,
      { type: 'text', text: routingNote },
    ];
  } else {
    body.system = routingNote;
  }
  const sanitized = sanitizeAssistantReasoningHistory(body);
  return {
    body: Buffer.from(JSON.stringify(sanitized.body), 'utf8'),
    strippedThinkingBlockCount: sanitized.strippedThinkingBlockCount,
    droppedAssistantMessageCount: sanitized.droppedAssistantMessageCount,
  };
}

function jsonByteLength(value: unknown): number {
  if (value == null) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}

function requestBodyBreakdown(rawBody: Buffer, rewrittenBody: Buffer) {
  try {
    const body = JSON.parse(rewrittenBody.toString('utf8')) as Record<string, unknown>;
    const messages = Array.isArray(body.messages) ? body.messages as Array<Record<string, unknown>> : [];
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const system = body.system;
    const lastUser = [...messages].reverse().find((message) => message?.role === 'user') ?? null;
    const messageBytes = messages.map((message, index) => ({
      index,
      role: typeof message.role === 'string' ? message.role : 'unknown',
      bytes: jsonByteLength(message),
    }));
    const largestMessages = [...messageBytes]
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 5);
    return {
      rawBytes: rawBody.length,
      rewrittenBytes: rewrittenBody.length,
      messageCount: messages.length,
      systemBytes: jsonByteLength(system),
      toolsCount: tools.length,
      toolsBytes: jsonByteLength(tools),
      lastUserBytes: jsonByteLength(lastUser),
      largestMessages,
    };
  } catch {
    return {
      rawBytes: rawBody.length,
      rewrittenBytes: rewrittenBody.length,
      parseError: true,
    };
  }
}

function normalizePrompt(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const block = part as Record<string, unknown>;
      if (typeof block.text === 'string') return block.text;
      if (typeof block.content === 'string') return block.content;
      if (Array.isArray(block.content)) return contentText(block.content);
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractUserPrompts(rawBody: Buffer): string[] {
  try {
    const body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    const messages = Array.isArray(body.messages) ? body.messages as Array<Record<string, unknown>> : [];
    return messages
      .filter((message) => message?.role === 'user')
      .map((message) => contentText(message.content).trim())
      .filter(Boolean);
  } catch {
    // Request diagnostics still proceed without live UI matching.
  }
  return [];
}

function promptMatches(candidate: string, expected: string): boolean {
  const a = normalizePrompt(candidate);
  const b = normalizePrompt(expected);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function liveTurnKey(sessionKey: string, turnId: string): string {
  return `${sessionKey}\n${turnId}`;
}

function pruneLiveState(): void {
  const now = Date.now();
  for (const [routeModel, registrations] of pendingLivePrompts) {
    const kept = registrations.filter((entry) => now - entry.createdAt <= LIVE_PROMPT_MAX_AGE_MS);
    if (kept.length > 0) pendingLivePrompts.set(routeModel, kept);
    else pendingLivePrompts.delete(routeModel);
  }
  for (const [key, turn] of liveTurns) {
    if (turn.subscribers.size > 0 || now - turn.updatedAt <= LIVE_TURN_RETENTION_MS) continue;
    liveTurns.delete(key);
  }
}

function getOrCreateLiveTurn(routeModel: string, sessionKey: string, turnId: string, prompt = ''): LiveTurnState {
  const key = liveTurnKey(sessionKey, turnId);
  const existing = liveTurns.get(key);
  if (existing) {
    if (!existing.prompt && prompt) existing.prompt = prompt;
    return existing;
  }
  const created: LiveTurnState = {
    routeModel,
    sessionKey,
    turnId,
    prompt,
    status: 'running',
    awaitingToolContinuation: false,
    content: [],
    text: '',
    thinking: '',
    eventCount: 0,
    requestCount: 0,
    lastRequestAt: 0,
    loggedFirstChunk: false,
    updatedAt: Date.now(),
    subscribers: new Set(),
  };
  liveTurns.set(key, created);
  return created;
}

function isToolContinuationStopReason(reason: unknown): boolean {
  return typeof reason === 'string' && [
    'tool_use',
    'tool_calls',
    'function_call',
  ].includes(reason);
}

function liveSnapshot(turn: LiveTurnState) {
  return {
    routeModel: turn.routeModel,
    sessionKey: turn.sessionKey,
    turnId: turn.turnId,
    status: turn.status,
    content: turn.content.map(({ _inputJson, ...block }) => block),
    text: turn.text,
    thinking: turn.thinking,
    updatedAt: turn.updatedAt,
  };
}

function sendSse(res: ServerResponse, event: string, payload: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastLiveTurn(turn: LiveTurnState, event = 'snapshot'): void {
  turn.updatedAt = Date.now();
  if (!turn.loggedFirstChunk && (turn.text.trim() || turn.thinking.trim() || turn.content.length > 0)) {
    turn.loggedFirstChunk = true;
    logger.info('[native-claude-proxy] first live chunk', {
      routeModel: turn.routeModel,
      sessionKey: turn.sessionKey,
      turnId: turn.turnId,
      textLength: turn.text.length,
      thinkingLength: turn.thinking.length,
      blockCount: turn.content.length,
      subscriberCount: turn.subscribers.size,
    });
  }
  const payload = liveSnapshot(turn);
  for (const subscriber of turn.subscribers) {
    sendSse(subscriber, event, payload);
  }
}

function registerLivePrompt(routeModel: string, registration: LivePromptRegistration): void {
  pruneLiveState();
  const existing = pendingLivePrompts.get(routeModel) ?? [];
  pendingLivePrompts.set(routeModel, [...existing, registration].slice(-50));
  getOrCreateLiveTurn(routeModel, registration.sessionKey, registration.turnId, registration.prompt);
}

function attachLiveSubscriber(turn: LiveTurnState, res: ServerResponse): void {
  turn.subscribers.add(res);
  logger.info('[native-claude-proxy] live subscriber attached', {
    routeModel: turn.routeModel,
    sessionKey: turn.sessionKey,
    turnId: turn.turnId,
    subscriberCount: turn.subscribers.size,
    textLength: turn.text.length,
    thinkingLength: turn.thinking.length,
    blockCount: turn.content.length,
  });
  sendSse(res, 'snapshot', liveSnapshot(turn));
}

function matchLivePromptFromPrompts(routeModel: string, prompts: string[]): LivePromptRegistration | null {
  pruneLiveState();
  const registrations = pendingLivePrompts.get(routeModel) ?? [];
  let index = -1;
  let createdAt = -1;
  registrations.forEach((entry, candidateIndex) => {
    if (!prompts.some((prompt) => promptMatches(prompt, entry.prompt))) return;
    if (entry.createdAt < createdAt) return;
    index = candidateIndex;
    createdAt = entry.createdAt;
  });
  if (index < 0) return null;
  const [matched] = registrations.splice(index, 1);
  if (registrations.length > 0) pendingLivePrompts.set(routeModel, registrations);
  else pendingLivePrompts.delete(routeModel);
  return matched ?? null;
}

function matchLiveTurnFromRequest(routeModel: string, rawBody: Buffer): LiveTurnState | null {
  const prompts = extractUserPrompts(rawBody);
  if (prompts.length === 0) return null;

  const registration = matchLivePromptFromPrompts(routeModel, prompts);
  if (registration) {
    return getOrCreateLiveTurn(routeModel, registration.sessionKey, registration.turnId, registration.prompt);
  }

  const now = Date.now();
  const hasPendingPrompt = (pendingLivePrompts.get(routeModel) ?? []).some((entry) => (
    now - entry.createdAt <= LIVE_PROMPT_MAX_AGE_MS
  ));
  if (hasPendingPrompt) return null;

  const candidates = [...liveTurns.values()]
    .filter((turn) => (
      turn.routeModel === routeModel &&
      turn.status !== 'error' &&
      Boolean(turn.prompt) &&
      now - turn.updatedAt <= LIVE_PROMPT_MAX_AGE_MS &&
      (turn.subscribers.size > 0 || now - turn.lastRequestAt <= LIVE_PROMPT_MAX_AGE_MS) &&
      prompts.some((prompt) => promptMatches(prompt, turn.prompt))
    ))
    .sort((a, b) => Math.max(b.lastRequestAt, b.updatedAt) - Math.max(a.lastRequestAt, a.updatedAt));
  return candidates[0] ?? null;
}

function ensureLiveContentBlock(turn: LiveTurnState, index: number, fallbackType: string): LiveContentBlock {
  if (!turn.content[index]) {
    turn.content[index] = { type: fallbackType };
  }
  return turn.content[index];
}

function appendLiveContentBlock(turn: LiveTurnState, fallbackType: string): LiveContentBlock {
  const previous = turn.content[turn.content.length - 1];
  if (!previous || previous.type !== fallbackType) {
    const block = { type: fallbackType };
    turn.content.push(block);
    return block;
  }
  return previous;
}

function appendLiveText(turn: LiveTurnState, text: string): void {
  if (!text) return;
  const block = appendLiveContentBlock(turn, 'text');
  block.type = 'text';
  block.text = `${block.text ?? ''}${text}`;
  turn.text += text;
  broadcastLiveTurn(turn);
}

function appendLiveThinking(turn: LiveTurnState, thinking: string): void {
  if (!thinking) return;
  const block = appendLiveContentBlock(turn, 'thinking');
  block.type = 'thinking';
  block.thinking = `${block.thinking ?? ''}${thinking}`;
  turn.thinking += thinking;
  broadcastLiveTurn(turn);
}

function applyCompleteMessage(turn: LiveTurnState, payload: Record<string, unknown>): void {
  const content = Array.isArray(payload.content) ? payload.content as Array<Record<string, unknown>> : [];
  let changed = false;
  for (const block of content) {
    if (block?.type === 'thinking' && typeof block.thinking === 'string') {
      turn.content.push({ type: 'thinking', thinking: block.thinking });
      turn.thinking += block.thinking;
      changed = true;
    } else if (block?.type === 'text' && typeof block.text === 'string') {
      turn.content.push({ type: 'text', text: block.text });
      turn.text += block.text;
      changed = true;
    } else if (block?.type === 'tool_use' || block?.type === 'server_tool_use') {
      const guard = guardClaudeContentBlock(block);
      if (guard.action === 'replace') {
        const text = typeof guard.block.text === 'string' ? guard.block.text : '';
        turn.content.push(guard.block);
        turn.text += text;
        changed = true;
        continue;
      }
      turn.content.push({
        type: 'tool_use',
        id: typeof block.id === 'string' ? block.id : '',
        name: typeof block.name === 'string' ? block.name : 'tool',
        input: block.input ?? {},
      });
      changed = true;
    }
  }
  if (!changed && typeof payload.content === 'string') {
    appendLiveText(turn, payload.content);
    return;
  }
  if (changed) broadcastLiveTurn(turn);
}

function applyLiveSseEvent(turn: LiveTurnState, eventName: string, payload: Record<string, unknown>): void {
  turn.eventCount += 1;
  const effectiveEventName = eventName === 'message' && typeof payload.type === 'string'
    ? payload.type
    : eventName;

  const choices = Array.isArray(payload.choices) ? payload.choices as Array<Record<string, unknown>> : [];
  const firstChoice = choices[0];
  const openAiDelta = firstChoice?.delta && typeof firstChoice.delta === 'object'
    ? firstChoice.delta as Record<string, unknown>
    : null;
  if (openAiDelta) {
    const text = typeof openAiDelta.content === 'string' ? openAiDelta.content : '';
    const reasoning = typeof openAiDelta.reasoning_content === 'string'
      ? openAiDelta.reasoning_content
      : typeof openAiDelta.reasoning === 'string'
        ? openAiDelta.reasoning
        : '';
    if (reasoning) appendLiveThinking(turn, reasoning);
    if (text) appendLiveText(turn, text);
    if (isToolContinuationStopReason(firstChoice.finish_reason)) {
      turn.awaitingToolContinuation = true;
      turn.status = 'running';
      broadcastLiveTurn(turn);
    } else if (firstChoice.finish_reason && turn.status !== 'completed') {
      turn.awaitingToolContinuation = false;
      turn.status = 'completed';
      broadcastLiveTurn(turn, 'done');
    }
    return;
  }

  if (effectiveEventName === 'message_start') {
    turn.status = 'running';
    return;
  }

  if (effectiveEventName === 'message_delta') {
    const delta = payload.delta && typeof payload.delta === 'object' ? payload.delta as Record<string, unknown> : {};
    const stopReason = delta.stop_reason ?? payload.stop_reason;
    if (isToolContinuationStopReason(stopReason)) {
      turn.awaitingToolContinuation = true;
      turn.status = 'running';
      broadcastLiveTurn(turn);
    } else if (stopReason && turn.status !== 'completed') {
      turn.awaitingToolContinuation = false;
      turn.status = 'completed';
      broadcastLiveTurn(turn, 'done');
    }
    return;
  }

  if (effectiveEventName === 'content_block_start') {
    const index = typeof payload.index === 'number' ? payload.index : turn.content.length;
    const block = payload.content_block && typeof payload.content_block === 'object'
      ? payload.content_block as LiveContentBlock
      : {};
    const type = typeof block.type === 'string' ? block.type : 'text';
    if (type === 'tool_use' || type === 'server_tool_use') {
      turn.content[index] = {
        type: 'tool_use',
        id: typeof block.id === 'string' ? block.id : '',
        name: typeof block.name === 'string' ? block.name : 'tool',
        input: block.input ?? {},
        _inputJson: '',
      };
      return;
    }
    if (type === 'thinking') {
      turn.content[index] = { type: 'thinking', thinking: typeof block.thinking === 'string' ? block.thinking : '' };
      return;
    }
    turn.content[index] = { type: 'text', text: typeof block.text === 'string' ? block.text : '' };
    return;
  }

  if (effectiveEventName === 'content_block_delta') {
    const index = typeof payload.index === 'number' ? payload.index : Math.max(0, turn.content.length - 1);
    const delta = payload.delta && typeof payload.delta === 'object' ? payload.delta as Record<string, unknown> : {};
    const deltaType = typeof delta.type === 'string' ? delta.type : '';
    if (deltaType === 'text_delta' && typeof delta.text === 'string') {
      const block = ensureLiveContentBlock(turn, index, 'text');
      block.type = 'text';
      block.text = `${block.text ?? ''}${delta.text}`;
      turn.text += delta.text;
      broadcastLiveTurn(turn);
      return;
    }
    if (deltaType === 'thinking_delta' && typeof delta.thinking === 'string') {
      const block = ensureLiveContentBlock(turn, index, 'thinking');
      block.type = 'thinking';
      block.thinking = `${block.thinking ?? ''}${delta.thinking}`;
      turn.thinking += delta.thinking;
      broadcastLiveTurn(turn);
      return;
    }
    if (deltaType === 'input_json_delta' && typeof delta.partial_json === 'string') {
      const block = ensureLiveContentBlock(turn, index, 'tool_use');
      block.type = 'tool_use';
      block._inputJson = `${block._inputJson ?? ''}${delta.partial_json}`;
      try {
        block.input = JSON.parse(block._inputJson);
      } catch {
        block.input = block._inputJson;
      }
      broadcastLiveTurn(turn);
    }
    return;
  }

  if (effectiveEventName === 'content_block_stop') {
    const index = typeof payload.index === 'number' ? payload.index : Math.max(0, turn.content.length - 1);
    const block = turn.content[index];
    if (block?._inputJson && typeof block._inputJson === 'string') {
      try {
        block.input = JSON.parse(block._inputJson);
      } catch {
        block.input = block._inputJson;
      }
      broadcastLiveTurn(turn);
    }
    return;
  }

  if (effectiveEventName === 'message_stop') {
    if (turn.awaitingToolContinuation) {
      turn.status = 'running';
      broadcastLiveTurn(turn);
    } else if (turn.status !== 'completed') {
      turn.status = 'completed';
      broadcastLiveTurn(turn, 'done');
    }
    return;
  }

  if (effectiveEventName === 'error') {
    turn.status = 'error';
    broadcastLiveTurn(turn, 'error');
    return;
  }

  if (Array.isArray(payload.content) || typeof payload.content === 'string') {
    applyCompleteMessage(turn, payload);
  }
}

function parseSseBlock(block: string): { eventName: string; data: string } | null {
  const lines = block.split(/\r?\n/);
  let eventName = 'message';
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim() || eventName;
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  return { eventName, data: dataLines.join('\n') };
}

function processLiveSseText(turn: LiveTurnState, text: string, flush = false): string {
  let buffer = text;
  let separatorIndex = buffer.search(/\r?\n\r?\n/);
  while (separatorIndex >= 0) {
    const block = buffer.slice(0, separatorIndex);
    const separatorLength = buffer[separatorIndex] === '\r' ? 4 : 2;
    buffer = buffer.slice(separatorIndex + separatorLength);
    const parsed = parseSseBlock(block);
    if (parsed && parsed.data !== '[DONE]') {
      try {
        applyLiveSseEvent(turn, parsed.eventName, JSON.parse(parsed.data) as Record<string, unknown>);
      } catch {
        // Ignore malformed upstream chunks; the raw stream is still forwarded.
      }
    }
    separatorIndex = buffer.search(/\r?\n\r?\n/);
  }
  if (flush && buffer.trim()) {
    const parsed = parseSseBlock(buffer);
    if (parsed && parsed.data !== '[DONE]') {
      try {
        applyLiveSseEvent(turn, parsed.eventName, JSON.parse(parsed.data) as Record<string, unknown>);
      } catch {
        // Ignore malformed final chunks.
      }
    }
    return '';
  }
  return buffer;
}

async function pipeResponseWithLiveCapture(
  body: ReadableStream<Uint8Array>,
  res: ServerResponse,
  turn: LiveTurnState,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (!turn.loggedFirstChunk && turn.eventCount === 0) {
        logger.info('[native-claude-proxy] first upstream stream bytes', {
          routeModel: turn.routeModel,
          sessionKey: turn.sessionKey,
          turnId: turn.turnId,
          byteLength: value.byteLength,
          subscriberCount: turn.subscribers.size,
        });
      }
      const chunk = decoder.decode(value, { stream: true });
      sseBuffer = processLiveSseText(turn, `${sseBuffer}${chunk}`);
      res.write(Buffer.from(value));
    }
    const finalChunk = decoder.decode();
    sseBuffer = processLiveSseText(turn, `${sseBuffer}${finalChunk}`, true);
    if (turn.status === 'running' && !turn.awaitingToolContinuation) {
      turn.status = 'completed';
      broadcastLiveTurn(turn, 'done');
    } else if (turn.awaitingToolContinuation) {
      broadcastLiveTurn(turn);
    }
  } catch (error) {
    turn.status = 'error';
    broadcastLiveTurn(turn, 'error');
    throw error;
  } finally {
    res.end();
    reader.releaseLock();
  }
}

async function forwardToOneApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  routeModel: string,
  upstreamModel: string,
): Promise<void> {
  const startedAt = Date.now();
  const rawBody = await readRequestBody(req);
  const liveTurn = path === '/messages' ? matchLiveTurnFromRequest(routeModel, rawBody) : null;
  if (liveTurn && liveTurn.status !== 'error') {
    liveTurn.status = 'running';
    liveTurn.awaitingToolContinuation = false;
    liveTurn.requestCount += 1;
    liveTurn.lastRequestAt = Date.now();
    liveTurn.updatedAt = liveTurn.lastRequestAt;
  }
  const rewrite = path === '/messages' || path === '/messages/count_tokens'
    ? rewriteMessagesBody(rawBody, upstreamModel)
    : { body: rawBody, strippedThinkingBlockCount: 0, droppedAssistantMessageCount: 0 };
  const body = rewrite.body;
  const requestDiagnostic = bodyDiagnostic(body);
  logger.info('[native-claude-proxy] forwarding request', {
    method: req.method,
    path,
    routeModel,
    upstreamModel,
    live: Boolean(liveTurn),
    liveTurnId: liveTurn?.turnId,
    body: requestDiagnostic,
    rewrite: (rewrite.strippedThinkingBlockCount || rewrite.droppedAssistantMessageCount) ? {
      strippedThinkingBlockCount: rewrite.strippedThinkingBlockCount,
      droppedAssistantMessageCount: rewrite.droppedAssistantMessageCount,
    } : undefined,
    breakdown: path === '/messages' ? requestBodyBreakdown(rawBody, body) : undefined,
  });
  const response = await fetch(`${ONEAPI_BASE_URL}${path}`, {
    method: req.method,
    headers: buildForwardHeaders(req),
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
  });
  logger.info('[native-claude-proxy] upstream response', {
    method: req.method,
    path,
    routeModel,
    upstreamModel,
    status: response.status,
    live: Boolean(liveTurn),
    elapsedMs: Date.now() - startedAt,
    body: requestDiagnostic,
  });

  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'content-encoding') return;
    res.setHeader(key, value);
  });
  if (response.body && liveTurn && path === '/messages') {
    await pipeResponseWithLiveCapture(response.body, res, liveTurn);
    return;
  }
  if (response.body) {
    Readable.fromWeb(response.body).pipe(res);
    return;
  }
  res.end();
}

function handleModels(res: ServerResponse, upstreamModel: string): void {
  sendJson(res, 200, {
    data: CLAUDE_ALIAS_MODELS.map((model) => ({
      type: 'model',
      id: model.id,
      display_name: model.id === 'claude-sonnet-4-6'
        ? stripOneMMarker(upstreamModel)
        : model.display_name,
      created_at: '2026-01-01T00:00:00Z',
    })),
  });
}

function handleRouteHealth(req: IncomingMessage, res: ServerResponse, routeModel: string, upstreamModel: string): void {
  if (req.method === 'HEAD') {
    res.statusCode = 204;
    res.end();
    return;
  }

  sendJson(res, 200, {
    ok: true,
    routeModel,
    upstreamModel,
  });
}

export function startClaudeNativeProxy(port = getPort('CLAWX_NATIVE_CLAUDE_PROXY')): Server {
  const server = createServer(async (req, res) => {
    try {
      setCorsHeaders(res);
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      const upstreamModel = extractUpstreamModel(url.pathname);
      const path = upstreamPath(url.pathname);
      if (!upstreamModel) {
        logger.warn('[native-claude-proxy] request without route model', routeDiagnostic(req, url.pathname, upstreamModel, path));
        sendText(res, 404, 'Not Found');
        return;
      }

      if (req.method === 'POST' && url.pathname === `/native-claude/${encodeURIComponent(upstreamModel)}/__live-track`) {
        const rawBody = await readRequestBody(req);
        const body = rawBody.length > 0 ? JSON.parse(rawBody.toString('utf8')) as Record<string, unknown> : {};
        const sessionKey = typeof body.sessionKey === 'string' ? body.sessionKey.trim() : '';
        const turnId = typeof body.turnId === 'string' ? body.turnId.trim() : '';
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
        if (!sessionKey || !turnId || !prompt) {
          sendJson(res, 400, { success: false, error: 'sessionKey, turnId, and prompt are required' });
          return;
        }
        registerLivePrompt(upstreamModel, { sessionKey, turnId, prompt, createdAt: Date.now() });
        logger.info('[native-claude-proxy] registered live prompt', {
          routeModel: upstreamModel,
          sessionKey,
          turnId,
        });
        sendJson(res, 200, { success: true });
        return;
      }

      if (req.method === 'GET' && url.pathname === `/native-claude/${encodeURIComponent(upstreamModel)}/__live-stream`) {
        const sessionKey = url.searchParams.get('sessionKey')?.trim() || '';
        const turnId = url.searchParams.get('turnId')?.trim() || '';
        if (!sessionKey || !turnId) {
          sendJson(res, 400, { success: false, error: 'sessionKey and turnId are required' });
          return;
        }
        const turn = getOrCreateLiveTurn(upstreamModel, sessionKey, turnId);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();
        attachLiveSubscriber(turn, res);
        const heartbeat = setInterval(() => {
          if (!res.destroyed) res.write(': ping\n\n');
        }, 15_000);
        req.on('close', () => {
          clearInterval(heartbeat);
          turn.subscribers.delete(res);
          logger.info('[native-claude-proxy] live subscriber detached', {
            routeModel: turn.routeModel,
            sessionKey: turn.sessionKey,
            turnId: turn.turnId,
            subscriberCount: turn.subscribers.size,
          });
        });
        return;
      }

      if ((req.method === 'POST' || req.method === 'PUT') && url.pathname === `/native-claude/${encodeURIComponent(upstreamModel)}/__model`) {
        const rawBody = await readRequestBody(req);
        const body = rawBody.length > 0 ? JSON.parse(rawBody.toString('utf8')) as Record<string, unknown> : {};
        const model = typeof body.model === 'string' ? stripOneMMarker(body.model) : '';
        if (!model) {
          sendJson(res, 400, { success: false, error: 'Missing model' });
          return;
        }
        modelOverrides.set(upstreamModel, model);
        sendJson(res, 200, { success: true, routeModel: upstreamModel, upstreamModel: model });
        return;
      }

      if (!path) {
        logger.warn('[native-claude-proxy] request path not matched', routeDiagnostic(req, url.pathname, upstreamModel, path));
        sendText(res, 404, 'Not Found');
        return;
      }

      const resolvedUpstreamModel = resolveUpstreamModel(upstreamModel);

      if ((req.method === 'GET' || req.method === 'HEAD') && path === '/') {
        handleRouteHealth(req, res, upstreamModel, resolvedUpstreamModel);
        return;
      }

      if (req.method === 'GET' && path === '/models') {
        handleModels(res, resolvedUpstreamModel);
        return;
      }

      if (req.method === 'POST' && (path === '/messages' || path === '/messages/count_tokens')) {
        await forwardToOneApi(req, res, path, upstreamModel, resolvedUpstreamModel);
        return;
      }

      logger.warn('[native-claude-proxy] unsupported request route', routeDiagnostic(req, url.pathname, upstreamModel, path));
      sendText(res, 404, 'Not Found');
    } catch (error) {
      logger.error('[native-claude-proxy] Request failed:', error);
      sendJson(res, 500, { error: { message: String(error), type: 'proxy_error' } });
    }
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EACCES' || error.code === 'EADDRINUSE') {
      logger.error(
        `Native Claude proxy failed to bind port ${port}: ${error.message}. ` +
        'Set CLAWX_PORT_CLAWX_NATIVE_CLAUDE_PROXY env var to override the default port.',
      );
    } else {
      logger.error('Native Claude proxy error:', error);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    logger.info(`Native Claude proxy listening on http://127.0.0.1:${port}`);
  });

  return server;
}
