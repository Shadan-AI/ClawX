import { access, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { testHome, testUserData } = vi.hoisted(() => {
  const suffix = Math.random().toString(36).slice(2);
  return {
    testHome: `/tmp/clawx-agent-config-${suffix}`,
    testUserData: `/tmp/clawx-agent-config-user-data-${suffix}`,
  };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  const mocked = {
    ...actual,
    homedir: () => testHome,
  };
  return {
    ...mocked,
    default: mocked,
  };
});

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => testUserData,
    getVersion: () => '0.0.0-test',
  },
}));

async function writeOpenClawJson(config: unknown): Promise<void> {
  const openclawDir = join(testHome, '.openclaw');
  await mkdir(openclawDir, { recursive: true });
  await writeFile(join(openclawDir, 'openclaw.json'), JSON.stringify(config, null, 2), 'utf8');
}

async function readOpenClawJson(): Promise<Record<string, unknown>> {
  const content = await readFile(join(testHome, '.openclaw', 'openclaw.json'), 'utf8');
  return JSON.parse(content) as Record<string, unknown>;
}

describe('agent config lifecycle', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    await rm(testHome, { recursive: true, force: true });
    await rm(testUserData, { recursive: true, force: true });
  });

  it('lists configured agent ids from openclaw.json', async () => {
    await writeOpenClawJson({
      agents: {
        list: [
          { id: 'main', name: 'Main', default: true },
          { id: 'test3', name: 'test3' },
        ],
      },
    });

    const { listConfiguredAgentIds } = await import('@electron/utils/agent-config');

    await expect(listConfiguredAgentIds()).resolves.toEqual(['main', 'test3']);
  });

  it('falls back to the implicit main agent when no list exists', async () => {
    await writeOpenClawJson({});

    const { listConfiguredAgentIds } = await import('@electron/utils/agent-config');

    await expect(listConfiguredAgentIds()).resolves.toEqual(['main']);
  });

  it('includes canonical per-agent main session keys in the snapshot', async () => {
    await writeOpenClawJson({
      session: {
        mainKey: 'desk',
      },
      agents: {
        list: [
          { id: 'main', name: 'Main', default: true },
          { id: 'research', name: 'Research' },
        ],
      },
    });

    const { listAgentsSnapshot } = await import('@electron/utils/agent-config');

    const snapshot = await listAgentsSnapshot();
    expect(snapshot.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'main',
          mainSessionKey: 'agent:main:desk',
        }),
        expect.objectContaining({
          id: 'research',
          mainSessionKey: 'agent:research:desk',
        }),
      ]),
    );
  });

  it('exposes effective and override model refs in the snapshot', async () => {
    await writeOpenClawJson({
      agents: {
        defaults: {
          model: {
            primary: 'moonshot/kimi-k2.5',
          },
        },
        list: [
          { id: 'main', name: 'Main', default: true },
          { id: 'coder', name: 'Coder', model: { primary: 'ark/ark-code-latest' } },
        ],
      },
    });

    const { listAgentsSnapshot } = await import('@electron/utils/agent-config');
    const snapshot = await listAgentsSnapshot();
    const main = snapshot.agents.find((agent) => agent.id === 'main');
    const coder = snapshot.agents.find((agent) => agent.id === 'coder');

    expect(snapshot.defaultModelRef).toBe('moonshot/kimi-k2.5');
    expect(main).toMatchObject({
      modelRef: 'moonshot/kimi-k2.5',
      overrideModelRef: null,
      inheritedModel: true,
      modelDisplay: 'kimi-k2.5',
    });
    expect(coder).toMatchObject({
      modelRef: 'ark/ark-code-latest',
      overrideModelRef: 'ark/ark-code-latest',
      inheritedModel: false,
      modelDisplay: 'ark-code-latest',
    });
  });

  it('updates and clears per-agent model overrides', async () => {
    await writeOpenClawJson({
      agents: {
        defaults: {
          model: {
            primary: 'moonshot/kimi-k2.5',
          },
        },
        list: [
          { id: 'main', name: 'Main', default: true },
          { id: 'coder', name: 'Coder' },
        ],
      },
    });

    const { listAgentsSnapshot, updateAgentModel } = await import('@electron/utils/agent-config');

    await updateAgentModel('coder', 'ark/ark-code-latest');
    let config = await readOpenClawJson();
    let coder = ((config.agents as { list: Array<{ id: string; model?: { primary?: string } }> }).list)
      .find((agent) => agent.id === 'coder');
    expect(coder?.model?.primary).toBe('ark/ark-code-latest');

    let snapshot = await listAgentsSnapshot();
    let snapshotCoder = snapshot.agents.find((agent) => agent.id === 'coder');
    expect(snapshotCoder).toMatchObject({
      modelRef: 'ark/ark-code-latest',
      overrideModelRef: 'ark/ark-code-latest',
      inheritedModel: false,
    });

    await updateAgentModel('coder', null);
    config = await readOpenClawJson();
    coder = ((config.agents as { list: Array<{ id: string; model?: unknown }> }).list)
      .find((agent) => agent.id === 'coder');
    expect(coder?.model).toBeUndefined();

    snapshot = await listAgentsSnapshot();
    snapshotCoder = snapshot.agents.find((agent) => agent.id === 'coder');
    expect(snapshotCoder).toMatchObject({
      modelRef: 'moonshot/kimi-k2.5',
      overrideModelRef: null,
      inheritedModel: true,
    });
  });

  it('rejects invalid model ref formats when updating agent model', async () => {
    await writeOpenClawJson({
      agents: {
        list: [{ id: 'main', name: 'Main', default: true }],
      },
    });

    const { updateAgentModel } = await import('@electron/utils/agent-config');

    await expect(updateAgentModel('main', 'invalid-model-ref')).rejects.toThrow(
      'modelRef must be in "provider/model" format',
    );
  });

  it('deletes the config entry, bindings, runtime directory, and managed workspace for a removed agent', async () => {
    await writeOpenClawJson({
      agents: {
        defaults: {
          model: {
            primary: 'custom-custom27/MiniMax-M2.7',
            fallbacks: [],
          },
        },
        list: [
          {
            id: 'main',
            name: 'Main',
            default: true,
            workspace: '~/.openclaw/workspace',
            agentDir: '~/.openclaw/agents/main/agent',
          },
          {
            id: 'test2',
            name: 'test2',
            workspace: '~/.openclaw/workspace-test2',
            agentDir: '~/.openclaw/agents/test2/agent',
          },
          {
            id: 'test3',
            name: 'test3',
            workspace: '~/.openclaw/workspace-test3',
            agentDir: '~/.openclaw/agents/test3/agent',
          },
        ],
      },
      channels: {
        feishu: {
          enabled: true,
        },
      },
      bindings: [
        {
          agentId: 'test2',
          match: {
            channel: 'feishu',
          },
        },
      ],
    });

    const test2RuntimeDir = join(testHome, '.openclaw', 'agents', 'test2');
    const test2WorkspaceDir = join(testHome, '.openclaw', 'workspace-test2');
    await mkdir(join(test2RuntimeDir, 'agent'), { recursive: true });
    await mkdir(join(test2RuntimeDir, 'sessions'), { recursive: true });
    await mkdir(join(test2WorkspaceDir, '.openclaw'), { recursive: true });
    await writeFile(
      join(test2RuntimeDir, 'agent', 'auth-profiles.json'),
      JSON.stringify({ version: 1, profiles: {} }, null, 2),
      'utf8',
    );
    await writeFile(join(test2WorkspaceDir, 'AGENTS.md'), '# test2', 'utf8');

    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { deleteAgentConfig } = await import('@electron/utils/agent-config');

    const { snapshot } = await deleteAgentConfig('test2');

    expect(snapshot.agents.map((agent) => agent.id)).toEqual(['main', 'test3']);
    expect(snapshot.channelOwners.feishu).toBe('main');

    const config = await readOpenClawJson();
    expect((config.agents as { list: Array<{ id: string }> }).list.map((agent) => agent.id)).toEqual([
      'main',
      'test3',
    ]);
    expect(config.bindings).toEqual([]);
    await expect(access(test2RuntimeDir)).rejects.toThrow();
    // Workspace deletion is intentionally deferred by `deleteAgentConfig` to avoid
    // ENOENT errors during Gateway restart, so it should still exist here.
    await expect(access(test2WorkspaceDir)).resolves.toBeUndefined();

    infoSpy.mockRestore();
  });

  it('preserves unmanaged custom workspaces when deleting an agent', async () => {
    const customWorkspaceDir = join(testHome, 'custom-workspace-test2');

    await writeOpenClawJson({
      agents: {
        list: [
          {
            id: 'main',
            name: 'Main',
            default: true,
            workspace: '~/.openclaw/workspace',
            agentDir: '~/.openclaw/agents/main/agent',
          },
          {
            id: 'test2',
            name: 'test2',
            workspace: customWorkspaceDir,
            agentDir: '~/.openclaw/agents/test2/agent',
          },
        ],
      },
    });

    await mkdir(join(testHome, '.openclaw', 'agents', 'test2', 'agent'), { recursive: true });
    await mkdir(customWorkspaceDir, { recursive: true });
    await writeFile(join(customWorkspaceDir, 'AGENTS.md'), '# custom', 'utf8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { deleteAgentConfig } = await import('@electron/utils/agent-config');

    await deleteAgentConfig('test2');

    await expect(access(customWorkspaceDir)).resolves.toBeUndefined();

    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it('does not delete a legacy-named account when it is owned by another agent', async () => {
    await writeOpenClawJson({
      agents: {
        list: [
          { id: 'main', name: 'Main', default: true },
          { id: 'test2', name: 'test2' },
          { id: 'test3', name: 'test3' },
        ],
      },
      channels: {
        feishu: {
          enabled: true,
          defaultAccount: 'default',
          accounts: {
            default: { enabled: true, appId: 'main-app' },
            test2: { enabled: true, appId: 'legacy-test2-app' },
          },
        },
      },
      bindings: [
        {
          agentId: 'test3',
          match: {
            channel: 'feishu',
            accountId: 'test2',
          },
        },
      ],
    });

    const { deleteAgentConfig } = await import('@electron/utils/agent-config');
    await deleteAgentConfig('test2');

    const config = await readOpenClawJson();
    const feishu = (config.channels as Record<string, unknown>).feishu as {
      accounts?: Record<string, unknown>;
    };
    expect(feishu.accounts?.test2).toBeDefined();
  });

  it('allows the same agent to bind multiple different channels', async () => {
    await writeOpenClawJson({
      agents: {
        list: [
          { id: 'main', name: 'Main', default: true },
        ],
      },
      channels: {
        feishu: { enabled: true },
        telegram: { enabled: true },
      },
    });

    const { assignChannelAccountToAgent, listAgentsSnapshot } = await import('@electron/utils/agent-config');

    await assignChannelAccountToAgent('main', 'feishu', 'default');
    await assignChannelAccountToAgent('main', 'telegram', 'default');

    const snapshot = await listAgentsSnapshot();
    expect(snapshot.channelAccountOwners['feishu:default']).toBe('main');
    expect(snapshot.channelAccountOwners['telegram:default']).toBe('main');
  });

  it('replaces previous account binding for the same agent and channel', async () => {
    await writeOpenClawJson({
      agents: {
        list: [
          { id: 'main', name: 'Main', default: true },
        ],
      },
      channels: {
        feishu: {
          enabled: true,
          defaultAccount: 'default',
          accounts: {
            default: { enabled: true, appId: 'main-app' },
            alt: { enabled: true, appId: 'alt-app' },
          },
        },
      },
    });

    const { assignChannelAccountToAgent, listAgentsSnapshot } = await import('@electron/utils/agent-config');

    await assignChannelAccountToAgent('main', 'feishu', 'default');
    await assignChannelAccountToAgent('main', 'feishu', 'alt');

    const snapshot = await listAgentsSnapshot();
    expect(snapshot.channelAccountOwners['feishu:default']).toBeUndefined();
    expect(snapshot.channelAccountOwners['feishu:alt']).toBe('main');
  });

  it('keeps a single owner for the same channel account', async () => {
    await writeOpenClawJson({
      agents: {
        list: [
          { id: 'main', name: 'Main', default: true },
          { id: 'test2', name: 'test2' },
        ],
      },
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            default: { enabled: true, appId: 'main-app' },
          },
        },
      },
    });

    const { assignChannelAccountToAgent, listAgentsSnapshot } = await import('@electron/utils/agent-config');

    await assignChannelAccountToAgent('main', 'feishu', 'default');
    await assignChannelAccountToAgent('test2', 'feishu', 'default');

    const snapshot = await listAgentsSnapshot();
    expect(snapshot.channelAccountOwners['feishu:default']).toBe('test2');
  });

  it('can clear one channel account binding without affecting another channel on the same agent', async () => {
    await writeOpenClawJson({
      agents: {
        list: [
          { id: 'main', name: 'Main', default: true },
        ],
      },
      channels: {
        feishu: { enabled: true },
        telegram: { enabled: true },
      },
    });

    const { assignChannelAccountToAgent, clearChannelBinding, listAgentsSnapshot } = await import('@electron/utils/agent-config');

    await assignChannelAccountToAgent('main', 'feishu', 'default');
    await assignChannelAccountToAgent('main', 'telegram', 'default');
    await clearChannelBinding('feishu', 'default');

    const snapshot = await listAgentsSnapshot();
    expect(snapshot.channelAccountOwners['feishu:default']).toBeUndefined();
    expect(snapshot.channelAccountOwners['telegram:default']).toBe('main');
  });

  it('avoids numeric-only ids when creating agents from CJK names', async () => {
    await writeOpenClawJson({
      agents: {
        list: [{ id: 'main', name: 'Main', default: true }],
      },
    });

    const { createAgent, listAgentsSnapshot } = await import('@electron/utils/agent-config');

    await createAgent('测试2');
    await createAgent('测试1');

    const snapshot = await listAgentsSnapshot();
    const agentIds = snapshot.agents.map((agent) => agent.id);

    expect(agentIds).toContain('agent');
    expect(agentIds).toContain('agent-2');
    expect(agentIds).not.toContain('2');
    expect(agentIds).not.toContain('1');
  });

  it('normalizes Claude native cli runtime to API-key auth with isolated config', async () => {
    await writeOpenClawJson({
      agents: {
        list: [
          { id: 'main', name: 'Main', default: true },
          { id: 'coder', name: 'Coder' },
        ],
      },
    });

    const { updateAgentRuntime } = await import('@electron/utils/agent-config');

    await updateAgentRuntime('coder', {
      type: 'native-cli',
      nativeCli: {
        provider: 'claude',
        command: 'claude',
        env: {
          ANTHROPIC_BASE_URL: 'https://one-api.shadanai.com',
          ANTHROPIC_API_KEY: 'oneapi-key',
          ANTHROPIC_AUTH_TOKEN: 'stale-claude-login-token',
          ANTHROPIC_MODEL: 'deepseek-v4-flash',
        },
      },
    });

    const config = await readOpenClawJson();
    const coder = ((config.agents as { list: Array<{ id: string; runtime?: { nativeCli?: { args?: string[]; resumeArgs?: string[]; env?: Record<string, string> } } }> }).list)
      .find((agent) => agent.id === 'coder');
    const nativeCli = coder?.runtime?.nativeCli;
    const env = nativeCli?.env;

    expect(nativeCli?.args).toEqual(['--bare', '--dangerously-skip-permissions', '--model', 'claude-sonnet-4-6']);
    expect(nativeCli?.resumeArgs).toEqual(['--bare', '--dangerously-skip-permissions', '--model', 'claude-sonnet-4-6', '--resume', '{sessionId}']);
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:13211/native-claude/deepseek-v4-flash',
      ANTHROPIC_API_KEY: 'oneapi-key',
      ANTHROPIC_MODEL: 'claude-sonnet-4-6',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6',
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'deepseek-v4-flash',
      CLAWX_NATIVE_CLAUDE_UPSTREAM_MODEL: 'deepseek-v4-flash',
      CLAUDE_CONFIG_DIR: join(testHome, '.openclaw', 'agents', 'coder', 'claude-code'),
    });
    expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
    await expect(access(join(testHome, '.openclaw', 'agents', 'coder', 'claude-code'))).resolves.toBeUndefined();
    const settings = JSON.parse(await readFile(join(testHome, '.openclaw', 'agents', 'coder', 'claude-code', 'settings.json'), 'utf8')) as {
      hooks?: { PreToolUse?: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }> };
    };
    expect(settings.hooks?.PreToolUse?.[0]?.matcher).toBe('Bash');
    expect(settings.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command).toContain('clawx-block-auto-open.cjs');
    await expect(readFile(join(testHome, '.openclaw', 'agents', 'coder', 'claude-code', 'hooks', 'clawx-block-auto-open.cjs'), 'utf8'))
      .resolves.toContain('Blocked by ClawX');
  });

  it('repairs existing Claude native cli auth env on startup migration', async () => {
    await writeOpenClawJson({
      agents: {
        list: [
          {
            id: 'legacy',
            name: 'Legacy',
            runtime: {
              type: 'native-cli',
              nativeCli: {
                command: 'claude',
                args: ['--dangerously-skip-permissions', '--model', 'deepseek-v4-pro'],
                resumeArgs: ['--dangerously-skip-permissions', '--model=deepseek-v4-pro', '--resume', '{sessionId}'],
                env: {
                  ANTHROPIC_AUTH_TOKEN: 'legacy-oneapi-key',
                  ANTHROPIC_BASE_URL: 'https://one-api.shadanai.com',
                  ANTHROPIC_MODEL: 'deepseek-v4-pro',
                },
              },
            },
          },
        ],
      },
    });

    const { ensureNativeCliRuntimeResumeArgs } = await import('@electron/utils/agent-config');

    await expect(ensureNativeCliRuntimeResumeArgs()).resolves.toBe(true);

    const config = await readOpenClawJson();
    const legacy = ((config.agents as { list: Array<{ id: string; runtime?: { nativeCli?: { provider?: string; args?: string[]; resumeArgs?: string[]; env?: Record<string, string> } } }> }).list)
      .find((agent) => agent.id === 'legacy');
    const nativeCli = legacy?.runtime?.nativeCli;

    expect(nativeCli?.provider).toBe('claude');
    expect(nativeCli?.args).toEqual(['--bare', '--dangerously-skip-permissions', '--model', 'claude-sonnet-4-6']);
    expect(nativeCli?.resumeArgs).toEqual(['--bare', '--dangerously-skip-permissions', '--model', 'claude-sonnet-4-6', '--resume', '{sessionId}']);
    expect(nativeCli?.env).toMatchObject({
      ANTHROPIC_API_KEY: 'legacy-oneapi-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:13211/native-claude/deepseek-v4-pro',
      ANTHROPIC_MODEL: 'claude-sonnet-4-6',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6',
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'deepseek-v4-pro',
      CLAWX_NATIVE_CLAUDE_UPSTREAM_MODEL: 'deepseek-v4-pro',
      CLAUDE_CONFIG_DIR: join(testHome, '.openclaw', 'agents', 'legacy', 'claude-code'),
    });
    expect(nativeCli?.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
    await expect(access(join(testHome, '.openclaw', 'agents', 'legacy', 'claude-code'))).resolves.toBeUndefined();
    await expect(readFile(join(testHome, '.openclaw', 'agents', 'legacy', 'claude-code', 'hooks', 'clawx-block-auto-open.cjs'), 'utf8'))
      .resolves.toContain('open files or external apps');
  });

  it('preserves Claude settings when adding managed safety hooks', async () => {
    const claudeConfigDir = join(testHome, '.openclaw', 'agents', 'coder', 'claude-code');
    await mkdir(claudeConfigDir, { recursive: true });
    await writeFile(join(claudeConfigDir, 'settings.json'), JSON.stringify({
      theme: 'dark',
      hooks: {
        PreToolUse: [
          {
            matcher: 'Write',
            hooks: [
              {
                type: 'command',
                command: 'node custom-hook.cjs',
              },
            ],
          },
        ],
      },
    }, null, 2), 'utf8');
    await writeOpenClawJson({
      agents: {
        list: [
          {
            id: 'coder',
            name: 'Coder',
            runtime: {
              type: 'native-cli',
              nativeCli: {
                provider: 'claude',
                command: 'claude',
                env: {
                  ANTHROPIC_API_KEY: 'test-key',
                  ANTHROPIC_MODEL: 'deepseek-v4-flash',
                },
              },
            },
          },
        ],
      },
    });

    const { ensureNativeCliRuntimeResumeArgs } = await import('@electron/utils/agent-config');

    await expect(ensureNativeCliRuntimeResumeArgs()).resolves.toBe(true);

    const settings = JSON.parse(await readFile(join(claudeConfigDir, 'settings.json'), 'utf8')) as {
      theme?: string;
      hooks?: { PreToolUse?: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }> };
    };
    const preToolUse = settings.hooks?.PreToolUse ?? [];
    expect(settings.theme).toBe('dark');
    expect(preToolUse.some((entry) => entry.matcher === 'Write' && entry.hooks?.[0]?.command === 'node custom-hook.cjs')).toBe(true);
    expect(preToolUse.filter((entry) => entry.hooks?.some((hook) => hook.command?.includes('clawx-block-auto-open.cjs')))).toHaveLength(1);
  });

  it('syncs selected OpenClaw skills into a Claude native cli plugin', async () => {
    const skillDir = join(testHome, '.openclaw', 'skills', 'apple-notes');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: apple-notes\n---\nUse Apple Notes.\n', 'utf8');
    await writeOpenClawJson({
      agents: {
        list: [
          {
            id: 'claude-agent',
            name: 'Claude Agent',
            runtime: {
              type: 'native-cli',
              nativeCli: {
                provider: 'claude',
                command: 'claude',
                args: [
                  '--bare',
                  '--plugin-dir',
                  join(testHome, '.openclaw', 'agents', 'claude-agent', 'claude-code', 'plugins', 'clawx-agent-skills'),
                ],
                env: {
                  ANTHROPIC_API_KEY: 'test-key',
                  ANTHROPIC_MODEL: 'deepseek-v4-flash',
                },
              },
            },
          },
        ],
      },
    });

    const { updateAgentSkills } = await import('@electron/utils/agent-config');

    await updateAgentSkills('claude-agent', ['apple-notes', 'missing-skill']);

    const config = await readOpenClawJson();
    const agent = ((config.agents as { list: Array<{ id: string; runtime?: { nativeCli?: { args?: string[]; resumeArgs?: string[] } } }> }).list)
      .find((item) => item.id === 'claude-agent');
    const pluginDir = join(testHome, '.openclaw', 'agents', 'claude-agent', 'claude-code', 'plugins', 'clawx-agent-skills');
    expect(agent?.runtime?.nativeCli?.args).toContain('--plugin-dir');
    expect(agent?.runtime?.nativeCli?.args).toContain(pluginDir);
    expect(agent?.runtime?.nativeCli?.resumeArgs).toContain('--plugin-dir');
    expect(agent?.runtime?.nativeCli?.resumeArgs).toContain(pluginDir);
    await expect(readFile(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8')).resolves.toContain('clawx-agent-skills');
    await expect(readFile(join(pluginDir, 'skills', 'apple-notes', 'SKILL.md'), 'utf8')).resolves.toContain('Use Apple Notes.');
    await expect(access(join(pluginDir, 'skills', 'missing-skill', 'SKILL.md'))).rejects.toBeTruthy();
  });

  it('refreshes Claude native cli plugin when selected skills change', async () => {
    for (const skillId of ['apple-notes', 'bear-notes']) {
      const skillDir = join(testHome, '.openclaw', 'skills', skillId);
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), `---\nname: ${skillId}\n---\n${skillId}\n`, 'utf8');
    }
    await writeOpenClawJson({
      agents: {
        list: [
          {
            id: 'claude-agent',
            name: 'Claude Agent',
            skills: ['apple-notes'],
            runtime: {
              type: 'native-cli',
              nativeCli: {
                provider: 'claude',
                command: 'claude',
                args: [
                  '--bare',
                  '--plugin-dir',
                  join(testHome, '.openclaw', 'agents', 'claude-agent', 'claude-code', 'plugins', 'clawx-agent-skills'),
                ],
                env: {
                  ANTHROPIC_API_KEY: 'test-key',
                  ANTHROPIC_MODEL: 'deepseek-v4-flash',
                },
              },
            },
          },
        ],
      },
    });

    const { updateAgentSkills } = await import('@electron/utils/agent-config');

    await updateAgentSkills('claude-agent', ['bear-notes']);

    const config = await readOpenClawJson();
    const agent = ((config.agents as { list: Array<{ id: string; runtime?: { nativeCli?: { args?: string[] } } }> }).list)
      .find((item) => item.id === 'claude-agent');
    const pluginDir = join(testHome, '.openclaw', 'agents', 'claude-agent', 'claude-code', 'plugins', 'clawx-agent-skills');
    expect(agent?.runtime?.nativeCli?.args?.filter((arg) => arg === '--plugin-dir')).toHaveLength(1);
    await expect(access(join(pluginDir, 'skills', 'apple-notes', 'SKILL.md'))).rejects.toBeTruthy();
    await expect(readFile(join(pluginDir, 'skills', 'bear-notes', 'SKILL.md'), 'utf8')).resolves.toContain('bear-notes');
  });

  it('syncs selected bundled OpenClaw skills when they are not user-installed', async () => {
    const bundledSkillDir = join(testHome, '.openclaw-package', 'skills', 'apple-notes');
    await mkdir(bundledSkillDir, { recursive: true });
    await writeFile(join(bundledSkillDir, 'SKILL.md'), '---\nname: apple-notes\n---\nBundled Apple Notes.\n', 'utf8');
    process.env.CLAWX_OPENCLAW_DIR = join(testHome, '.openclaw-package');
    await writeOpenClawJson({
      agents: {
        list: [
          {
            id: 'claude-agent',
            name: 'Claude Agent',
            skills: ['apple-notes'],
            runtime: {
              type: 'native-cli',
              nativeCli: {
                provider: 'claude',
                command: 'claude',
                env: {
                  ANTHROPIC_API_KEY: 'test-key',
                  ANTHROPIC_MODEL: 'deepseek-v4-flash',
                },
              },
            },
          },
        ],
      },
    });

    const { ensureNativeCliRuntimeResumeArgs } = await import('@electron/utils/agent-config');

    await expect(ensureNativeCliRuntimeResumeArgs()).resolves.toBe(true);

    const pluginDir = join(testHome, '.openclaw', 'agents', 'claude-agent', 'claude-code', 'plugins', 'clawx-agent-skills');
    await expect(readFile(join(pluginDir, 'skills', 'apple-notes', 'SKILL.md'), 'utf8')).resolves.toContain('Bundled Apple Notes.');
  });

  it('does not attach a Claude skills plugin when selected skills are not installed', async () => {
    await writeOpenClawJson({
      agents: {
        list: [
          {
            id: 'claude-agent',
            name: 'Claude Agent',
            runtime: {
              type: 'native-cli',
              nativeCli: {
                provider: 'claude',
                command: 'claude',
                env: {
                  ANTHROPIC_API_KEY: 'test-key',
                  ANTHROPIC_MODEL: 'deepseek-v4-flash',
                },
              },
            },
          },
        ],
      },
    });

    const { updateAgentSkills } = await import('@electron/utils/agent-config');

    await updateAgentSkills('claude-agent', ['missing-skill']);

    const config = await readOpenClawJson();
    const agent = ((config.agents as { list: Array<{ id: string; runtime?: { nativeCli?: { args?: string[] } } }> }).list)
      .find((item) => item.id === 'claude-agent');
    expect(agent?.runtime?.nativeCli?.args).not.toContain('--plugin-dir');
    await expect(access(join(testHome, '.openclaw', 'agents', 'claude-agent', 'claude-code', 'plugins', 'clawx-agent-skills'))).rejects.toBeTruthy();
  });

  it('repairs Windows Claude native cli command from npm shim to executable', async () => {
    const originalPlatform = process.platform;
    const originalPath = process.env.PATH;
    const npmBinDir = join(testHome, 'npm-bin');
    const claudeExe = join(npmBinDir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');

    await mkdir(join(npmBinDir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin'), { recursive: true });
    await writeFile(claudeExe, '', 'utf8');
    await writeFile(
      join(npmBinDir, 'claude.cmd'),
      '@ECHO off\r\n"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\r\n',
      'utf8',
    );
    await writeOpenClawJson({
      agents: {
        list: [
          {
            id: 'win-coder',
            name: 'Windows Coder',
            runtime: {
              type: 'native-cli',
              nativeCli: {
                provider: 'claude',
                command: 'claude',
                env: {
                  ANTHROPIC_API_KEY: 'oneapi-key',
                  ANTHROPIC_MODEL: 'deepseek-v4-flash',
                },
              },
            },
          },
        ],
      },
    });

    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      process.env.PATH = npmBinDir;
      vi.resetModules();

      const { ensureNativeCliRuntimeResumeArgs } = await import('@electron/utils/agent-config');
      await expect(ensureNativeCliRuntimeResumeArgs()).resolves.toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      process.env.PATH = originalPath;
    }

    const config = await readOpenClawJson();
    const agent = ((config.agents as { list: Array<{ id: string; runtime?: { nativeCli?: { command?: string } } }> }).list)
      .find((item) => item.id === 'win-coder');

    expect(agent?.runtime?.nativeCli?.command).toBe(claudeExe);
  });
});
