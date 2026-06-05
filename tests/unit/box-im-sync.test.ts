import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  readOpenClawConfigMock,
  writeOpenClawConfigMock,
  testOpenClawDir,
} = vi.hoisted(() => {
  const suffix = Math.random().toString(36).slice(2);
  return {
    readOpenClawConfigMock: vi.fn(),
    writeOpenClawConfigMock: vi.fn(),
    testOpenClawDir: `${process.cwd()}/tmp/box-im-openclaw-${suffix}`,
  };
});

vi.mock('@electron/utils/channel-config', () => ({
  readOpenClawConfig: readOpenClawConfigMock,
  writeOpenClawConfig: writeOpenClawConfigMock,
}));

vi.mock('@electron/utils/paths', () => ({
  getOpenClawResolvedDir: () => testOpenClawDir,
}));

vi.mock('@electron/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('box-im sync config writes', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    await rm(testOpenClawDir, { recursive: true, force: true });
  });

  it('does not mutate plugins.allow when box-im is bundled by OpenClaw', async () => {
    const manifestDir = join(testOpenClawDir, 'dist', 'extensions', 'box-im');
    await mkdir(manifestDir, { recursive: true });
    await writeFile(
      join(manifestDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'box-im', channels: ['box-im'] }),
      'utf-8',
    );

    const config = {
      channels: {
        'box-im': { enabled: true },
      },
      plugins: {
        entries: {
          'box-im': { enabled: true },
        },
      },
      agents: {
        defaults: { model: { primary: 'custom-provider/glm-5' } },
        list: [{
          id: 'agent_523',
          name: 'OpenClaw',
          agentDir: join(testOpenClawDir, 'agents', 'agent_523', 'agent'),
          workspace: join(testOpenClawDir, 'workspace-agent_523'),
        }],
      },
      bindings: [],
    };
    readOpenClawConfigMock.mockResolvedValue(config);

    const { saveBoxImAccounts } = await import('@electron/utils/box-im-sync');

    await saveBoxImAccounts({
      agent_523: {
        enabled: true,
        accessToken: '',
        userId: 523,
        botName: 'OpenClaw',
        model: 'custom-provider/glm-5',
      },
    });

    expect(writeOpenClawConfigMock).toHaveBeenCalledTimes(1);
    const written = writeOpenClawConfigMock.mock.calls[0][0] as Record<string, any>;
    expect(written.plugins.allow).toBeUndefined();
    expect(written.plugins.entries['box-im']).toEqual({ enabled: true });
    expect(written.channels['box-im'].enabled).toBe(true);
  });

  it('allowlists box-im when it is not bundled by OpenClaw', async () => {
    const config = {
      channels: {},
      plugins: {},
      agents: {
        defaults: { model: { primary: 'custom-provider/glm-5' } },
        list: [{
          id: 'agent_523',
          name: 'OpenClaw',
          agentDir: join(testOpenClawDir, 'agents', 'agent_523', 'agent'),
          workspace: join(testOpenClawDir, 'workspace-agent_523'),
        }],
      },
      bindings: [],
    };
    readOpenClawConfigMock.mockResolvedValue(config);

    const { saveBoxImAccounts } = await import('@electron/utils/box-im-sync');

    await saveBoxImAccounts({
      agent_523: {
        enabled: true,
        accessToken: '',
        userId: 523,
        botName: 'OpenClaw',
        model: 'custom-provider/glm-5',
      },
    });

    const written = writeOpenClawConfigMock.mock.calls[0][0] as Record<string, any>;
    expect(written.plugins.allow).toEqual(['box-im']);
    expect(written.plugins.entries['box-im']).toEqual({ enabled: true });
  });

  it('disables box-im bot account auto-start before gateway launch', async () => {
    const config = {
      channels: {
        'box-im': {
          enabled: true,
          ownerAuth: { tokenKey: 'owner-token' },
          accounts: {
            'bot-one': { enabled: true, accessToken: 'one', userId: 1, botName: 'One' },
            'bot-two': { accessToken: 'two', userId: 2, botName: 'Two' },
            'bot-three': { enabled: false, accessToken: 'three', userId: 3, botName: 'Three' },
          },
        },
      },
      plugins: {
        entries: {
          'box-im': { enabled: true },
        },
      },
      agents: { list: [] },
      bindings: [],
    };
    readOpenClawConfigMock.mockResolvedValue(config);

    const { disableBoxImBotAccountAutoStart } = await import('@electron/utils/box-im-sync');

    await expect(disableBoxImBotAccountAutoStart()).resolves.toBe(true);

    const written = writeOpenClawConfigMock.mock.calls[0][0] as Record<string, any>;
    expect(written.channels['box-im'].enabled).toBe(true);
    expect(written.channels['box-im'].ownerAuth).toEqual({ tokenKey: 'owner-token' });
    expect(written.channels['box-im'].accounts['bot-one'].enabled).toBe(false);
    expect(written.channels['box-im'].accounts['bot-two'].enabled).toBe(false);
    expect(written.channels['box-im'].accounts['bot-three'].enabled).toBe(false);
  });
});
