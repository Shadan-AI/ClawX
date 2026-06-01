import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';

vi.mock('@electron/utils/config', () => ({
  getPort: () => 0,
}));

vi.mock('@electron/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const originalFetch = globalThis.fetch;

function sseResponse(events: string[]): Response {
  return new Response(events.join(''), {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
    },
  });
}

async function readSseUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (raw: string) => boolean,
  initialRaw = '',
  timeoutMs = 2_000,
): Promise<string> {
  const decoder = new TextDecoder();
  let raw = initialRaw;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const read = await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
        setTimeout(() => reject(new Error('timed out waiting for SSE')), remaining);
      }),
    ]);
    if (read.done) break;
    raw += decoder.decode(read.value, { stream: true });
    if (predicate(raw)) return raw;
  }
  throw new Error(`SSE predicate not satisfied: ${raw}`);
}

function parseSsePayloads(raw: string, eventName: string): unknown[] {
  return raw
    .split(/\n\n/)
    .filter((block) => block.includes(`event: ${eventName}`))
    .map((block) => {
      const dataLine = block.split(/\n/).find((line) => line.startsWith('data: '));
      return dataLine ? JSON.parse(dataLine.slice('data: '.length)) : null;
    })
    .filter(Boolean);
}

describe('Claude native proxy live stream', () => {
  let server: ReturnType<typeof import('@electron/native-cli/claude-proxy').startClaudeNativeProxy> | null = null;

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server?.close((error?: Error) => (error ? reject(error) : resolve()));
      });
      server = null;
    }
  });

  it('keeps one live turn open across tool-use requests and finishes on final answer', async () => {
    const upstreamFetch = vi.fn()
      .mockResolvedValueOnce(sseResponse([
        'event: message_start\n',
        'data: {"type":"message_start"}\n\n',
        'event: content_block_delta\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Checking identity."}}\n\n',
        'event: content_block_start\n',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_1","name":"Read","input":{"file_path":"IDENTITY.md"}}}\n\n',
        'event: message_delta\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
        'event: message_stop\n',
        'data: {"type":"message_stop"}\n\n',
      ]))
      .mockResolvedValueOnce(sseResponse([
        'event: message_start\n',
        'data: {"type":"message_start"}\n\n',
        'event: content_block_delta\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"I am your workspace assistant."}}\n\n',
        'event: message_delta\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
        'event: message_stop\n',
        'data: {"type":"message_stop"}\n\n',
      ]));
    const { startClaudeNativeProxy } = await import('@electron/native-cli/claude-proxy');
    server = startClaudeNativeProxy(0);
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}/native-claude/glm-5`;
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      return url.startsWith(`http://127.0.0.1:${port}/`)
        ? originalFetch(input, init)
        : upstreamFetch(input, init);
    }) as typeof fetch;

    await fetch(`${base}/__live-track`, {
      method: 'POST',
      body: JSON.stringify({
        sessionKey: 'agent:test:cli:session',
        turnId: 'turn-1',
        prompt: 'who are you',
      }),
    });
    const streamController = new AbortController();
    const stream = await fetch(`${base}/__live-stream?sessionKey=${encodeURIComponent('agent:test:cli:session')}&turnId=turn-1`, {
      signal: streamController.signal,
    });
    const reader = stream.body?.getReader();
    if (!reader) throw new Error('missing live stream body');

    await fetch(`${base}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'who are you' }],
      }),
    });

    let raw = await readSseUntil(reader, (chunk) => chunk.includes('Checking identity.'));
    expect(raw).not.toContain('event: done');

    await fetch(`${base}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [
          { role: 'user', content: 'who are you' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Read the identity file before answering.', signature: '' },
              { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'IDENTITY.md' } },
            ],
          },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'Name: test' }] },
        ],
      }),
    });

    raw = await readSseUntil(reader, (chunk) => (
      chunk.includes('I am your workspace assistant.') && chunk.includes('event: done')
    ), raw);
    const donePayloads = parseSsePayloads(raw, 'done');
    expect(donePayloads).toEqual([
      expect.objectContaining({
        status: 'completed',
        text: 'I am your workspace assistant.',
      }),
    ]);
    const secondUpstreamBody = JSON.parse(String(upstreamFetch.mock.calls[1]?.[1]?.body)) as {
      messages: Array<{ role: string; content: unknown[] }>;
    };
    expect(secondUpstreamBody.messages[1]?.content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'IDENTITY.md' } },
    ]);
    await reader.cancel();
    streamController.abort();
  });
});
