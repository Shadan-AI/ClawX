import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const sendJsonMock = vi.fn();
const parseJsonBodyMock = vi.fn();
const readOpenClawConfigMock = vi.fn();
const testOpenClawConfigDir = join(tmpdir(), 'clawx-tests', 'session-routes-openclaw');

vi.mock('@electron/api/route-utils', () => ({
  parseJsonBody: (...args: unknown[]) => parseJsonBodyMock(...args),
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

vi.mock('@electron/utils/paths', () => ({
  expandPath: (value: string) => value,
  getOpenClawConfigDir: () => testOpenClawConfigDir,
}));

vi.mock('@electron/utils/channel-config', () => ({
  readOpenClawConfig: (...args: unknown[]) => readOpenClawConfigMock(...args),
}));

function writeSessionsJson(agentId: string, data: unknown): string {
  const sessionsDir = join(testOpenClawConfigDir, 'agents', agentId, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const sessionsJsonPath = join(sessionsDir, 'sessions.json');
  writeFileSync(sessionsJsonPath, JSON.stringify(data, null, 2), 'utf8');
  return sessionsJsonPath;
}

describe('handleSessionRoutes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    rmSync(testOpenClawConfigDir, { recursive: true, force: true });
    parseJsonBodyMock.mockResolvedValue({});
    readOpenClawConfigMock.mockResolvedValue({ agents: { list: [] } });
  });

  afterAll(() => {
    rmSync(testOpenClawConfigDir, { recursive: true, force: true });
  });

  it('keeps native-cli history entries without transcript files in local indexes', async () => {
    writeSessionsJson('coder', {
      'agent:coder:cli:title-only': {
        displayName: 'Fix terminal resume',
        updatedAt: 1,
      },
      'agent:coder:cli:with-cli-id': {
        displayName: 'agent:coder:cli:with-cli-id',
        updatedAt: 1,
        cliSessionId: 'claude-session-123',
      },
    });

    const { handleSessionRoutes } = await import('@electron/api/routes/sessions');

    const handled = await handleSessionRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:13210/api/sessions/indexes'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        success: true,
        sessions: expect.arrayContaining([
          expect.objectContaining({ key: 'agent:coder:cli:title-only' }),
          expect.objectContaining({ key: 'agent:coder:cli:with-cli-id', cliSessionId: 'claude-session-123' }),
        ]),
      }),
    );
  });

  it('repair-indexes does not prune resumable native-cli sessions', async () => {
    const sessionsJsonPath = writeSessionsJson('coder', {
      'agent:coder:cli:old-native': {
        displayName: 'Resume this terminal',
        updatedAt: 1,
      },
    });

    const { handleSessionRoutes } = await import('@electron/api/routes/sessions');

    await handleSessionRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:13210/api/sessions/repair-indexes'),
      {} as never,
    );

    const repaired = JSON.parse(readFileSync(sessionsJsonPath, 'utf8')) as Record<string, unknown>;
    expect(repaired['agent:coder:cli:old-native']).toBeDefined();
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({ success: true }),
    );
  });

  it('infers native-cli provider from agent config when persisting session ids', async () => {
    parseJsonBodyMock.mockResolvedValueOnce({
      sessionKey: 'agent:coder:cli:codex-session',
      cliSessionId: 'codex-session-123',
    });
    readOpenClawConfigMock.mockResolvedValueOnce({
      agents: {
        list: [
          {
            id: 'coder',
            runtime: {
              type: 'native-cli',
              nativeCli: {
                provider: 'codex',
                command: 'codex',
              },
            },
          },
        ],
      },
    });

    const { handleSessionRoutes } = await import('@electron/api/routes/sessions');

    await handleSessionRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:13210/api/sessions/native-cli-session'),
      {} as never,
    );

    const sessionsJsonPath = join(testOpenClawConfigDir, 'agents', 'coder', 'sessions', 'sessions.json');
    const sessionsJson = JSON.parse(readFileSync(sessionsJsonPath, 'utf8')) as Record<string, Record<string, unknown>>;
    expect(sessionsJson['agent:coder:cli:codex-session']).toMatchObject({
      cliSessionId: 'codex-session-123',
      cliSessionIds: {
        codex: 'codex-session-123',
      },
    });
  });

  it('persists native-cli sessions through the runtime session API', async () => {
    parseJsonBodyMock.mockResolvedValueOnce({
      sessionKey: 'agent:coder:cli:runtime-session',
      cliSessionId: 'claude-session-456',
      provider: 'claude',
    });

    const { handleSessionRoutes } = await import('@electron/api/routes/sessions');

    await handleSessionRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:13210/api/runtime/sessions/native-cli'),
      {} as never,
    );

    const sessionsJsonPath = join(testOpenClawConfigDir, 'agents', 'coder', 'sessions', 'sessions.json');
    const sessionsJson = JSON.parse(readFileSync(sessionsJsonPath, 'utf8')) as Record<string, Record<string, unknown>>;
    expect(sessionsJson['agent:coder:cli:runtime-session']).toMatchObject({
      cliSessionId: 'claude-session-456',
      cliSessionIds: {
        claude: 'claude-session-456',
      },
    });
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        success: true,
        runtimeType: 'native-cli',
        sessionKey: 'agent:coder:cli:runtime-session',
      }),
    );
  });

  it('resolves the latest Claude transcript for native-cli skill reloads', async () => {
    const claudeConfigDir = join(testOpenClawConfigDir, 'agents', 'coder', 'claude-code');
    const workspace = join(testOpenClawConfigDir, 'workspace-coder');
    const projectDirName = workspace.replace(/[^A-Za-z0-9_-]/g, '-');
    const projectDir = join(claudeConfigDir, 'projects', projectDirName);
    mkdirSync(projectDir, { recursive: true });
    const olderTranscript = join(projectDir, 'older-session.jsonl');
    const latestTranscript = join(projectDir, 'latest-session.jsonl');
    writeFileSync(olderTranscript, JSON.stringify({ type: 'summary', sessionId: 'older-session' }), 'utf8');
    writeFileSync(latestTranscript, [
      JSON.stringify({ type: 'summary', sessionId: 'latest-session' }),
      JSON.stringify({ type: 'message', sessionId: 'latest-session', message: { role: 'assistant', content: 'ready' } }),
    ].join('\n'), 'utf8');
    const now = new Date();
    const earlier = new Date(now.getTime() - 10_000);
    await import('node:fs/promises').then((fsP) => Promise.all([
      fsP.utimes(olderTranscript, earlier, earlier),
      fsP.utimes(latestTranscript, now, now),
    ]));
    parseJsonBodyMock.mockResolvedValueOnce({
      sessionKey: 'agent:coder:cli:runtime-session',
      provider: 'claude',
      latest: true,
    });
    readOpenClawConfigMock.mockResolvedValueOnce({
      agents: {
        list: [
          {
            id: 'coder',
            workspace,
            runtime: {
              type: 'native-cli',
              nativeCli: {
                provider: 'claude',
                command: 'claude',
                env: { CLAUDE_CONFIG_DIR: claudeConfigDir },
              },
            },
          },
        ],
      },
    });

    const { handleSessionRoutes } = await import('@electron/api/routes/sessions');

    await handleSessionRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:13210/api/runtime/sessions/native-cli/resolve'),
      {} as never,
    );

    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        success: true,
        resolved: true,
        sessionId: 'latest-session',
        sessionFile: latestTranscript,
      }),
    );
  });
});
