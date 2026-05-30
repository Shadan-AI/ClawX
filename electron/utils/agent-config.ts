import { access, copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import { constants, existsSync, readFileSync } from 'fs';
import { delimiter, dirname, extname, isAbsolute, join, normalize, sep } from 'path';
import { deleteAgentChannelAccounts, listConfiguredChannels, readOpenClawConfig, writeOpenClawConfig } from './channel-config';
import type { OpenClawConfig } from './channel-config';
import { withConfigLock } from './config-mutex';
import { expandPath, getOpenClawConfigDir, getOpenClawDir } from './paths';
import { getPort } from './config';
import * as logger from './logger';
import { toUiChannelType } from './channel-alias';
import { getBoxImConfig } from './box-im-sync';

const MAIN_AGENT_ID = 'main';
const MAIN_AGENT_NAME = 'Main Agent';
const DEFAULT_ACCOUNT_ID = 'default';
const DEFAULT_WORKSPACE_PATH = '~/.openclaw/workspace';
const SHADAN_ONEAPI_NATIVE_BASE_URL = 'https://one-api.shadanai.com/v1';
const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';
const CLAUDE_NATIVE_PROXY_PORT = getPort('CLAWX_NATIVE_CLAUDE_PROXY');
const CLAUDE_NATIVE_HAIKU_ALIAS = 'claude-haiku-4-5';
const CLAUDE_NATIVE_SONNET_ALIAS = 'claude-sonnet-4-6';
const CLAUDE_NATIVE_OPUS_ALIAS = 'claude-opus-4-7';
const CLAUDE_AGENT_SKILLS_PLUGIN_DIRNAME = 'clawx-agent-skills';
const CLAUDE_BLOCK_AUTO_OPEN_HOOK = 'clawx-block-auto-open.cjs';
const AGENT_BOOTSTRAP_FILES = [
  'AGENTS.md',
  'SOUL.md',
  'TOOLS.md',
  'USER.md',
  'IDENTITY.md',
  'BOOT.md',
];

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === 'string');
  return items.length > 0 ? items : undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => [key.trim(), item] as const)
    .filter((entry): entry is readonly [string, string] => !!entry[0] && typeof entry[1] === 'string');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function getClaudeConfigDir(agentId: string | undefined): string | undefined {
  const normalizedAgentId = agentId?.trim();
  if (!normalizedAgentId) return undefined;
  return join(getOpenClawConfigDir(), 'agents', normalizedAgentId, 'claude-code');
}

function getClaudeAgentSkillsPluginDir(agentId: string | undefined): string | undefined {
  const claudeConfigDir = getClaudeConfigDir(agentId);
  return claudeConfigDir ? join(claudeConfigDir, 'plugins', CLAUDE_AGENT_SKILLS_PLUGIN_DIRNAME) : undefined;
}

function getClaudeProxyBaseUrl(upstreamModel: string): string {
  return `http://127.0.0.1:${CLAUDE_NATIVE_PROXY_PORT}/native-claude/${encodeURIComponent(upstreamModel)}`;
}

function extractClaudeProxyModel(baseUrl: string | undefined): string | undefined {
  const match = baseUrl?.match(/\/native-claude\/([^/]+)(?:\/v1)?\/?$/);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]).trim() || undefined;
  } catch {
    return undefined;
  }
}

function normalizeClaudeUpstreamModel(env: Record<string, string>): string | undefined {
  return (
    env.CLAWX_NATIVE_CLAUDE_UPSTREAM_MODEL
    || extractClaudeProxyModel(env.ANTHROPIC_BASE_URL)
    || env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME
    || env.ANTHROPIC_MODEL
    || env.ANTHROPIC_DEFAULT_SONNET_MODEL
    || env.ANTHROPIC_DEFAULT_OPUS_MODEL
    || env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  )?.trim() || undefined;
}

function normalizeNativeCliEnv(
  provider: string,
  env: Record<string, string> | undefined,
  options?: { agentId?: string },
): Record<string, string> | undefined {
  if (provider !== 'claude') return env;

  const next = { ...(env ?? {}) };
  const baseUrl = next.ANTHROPIC_BASE_URL?.trim().replace(/\/+$/, '');
  if (baseUrl === 'https://one-api.shadanai.com') {
    next.ANTHROPIC_BASE_URL = SHADAN_ONEAPI_NATIVE_BASE_URL;
  }

  const apiKey = next.ANTHROPIC_API_KEY?.trim();
  const authToken = next.ANTHROPIC_AUTH_TOKEN?.trim();
  if (!apiKey && authToken) next.ANTHROPIC_API_KEY = authToken;
  delete next.ANTHROPIC_AUTH_TOKEN;

  const upstreamModel = normalizeClaudeUpstreamModel(next);
  if (upstreamModel) {
    next.ANTHROPIC_BASE_URL = getClaudeProxyBaseUrl(upstreamModel);
    next.ANTHROPIC_MODEL = CLAUDE_NATIVE_SONNET_ALIAS;
    next.ANTHROPIC_DEFAULT_HAIKU_MODEL = CLAUDE_NATIVE_HAIKU_ALIAS;
    next.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME = upstreamModel;
    next.ANTHROPIC_DEFAULT_SONNET_MODEL = CLAUDE_NATIVE_SONNET_ALIAS;
    next.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = upstreamModel;
    next.ANTHROPIC_DEFAULT_OPUS_MODEL = CLAUDE_NATIVE_OPUS_ALIAS;
    next.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME = upstreamModel;
    next.CLAWX_NATIVE_CLAUDE_UPSTREAM_MODEL = upstreamModel;
    delete next.ANTHROPIC_SMALL_FAST_MODEL;
    delete next.ANTHROPIC_CUSTOM_MODEL_OPTION;
  }

  const claudeConfigDir = getClaudeConfigDir(options?.agentId);
  if (claudeConfigDir) {
    next[CLAUDE_CONFIG_DIR_ENV] = claudeConfigDir;
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeNativeCliProvider(provider: unknown, command: unknown): string {
  const configured = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
  if (configured) return configured;
  const commandName = typeof command === 'string'
    ? command.trim().toLowerCase().split(/[\\/]/).pop() ?? ''
    : '';
  if (commandName.includes('codex')) return 'codex';
  if (commandName.includes('claude')) return 'claude';
  return 'custom';
}

function normalizeSkillIds(skills: string[]): string[] {
  return [...new Set(
    skills
      .map((skill) => skill.trim())
      .filter((skill) => skill.length > 0 && !skill.includes('/') && !skill.includes('\\')),
  )];
}

function getSkillSourceCandidates(skillId: string): string[] {
  return [
    join(getOpenClawConfigDir(), 'skills', skillId),
    join(getOpenClawDir(), 'skills', skillId),
  ];
}

function hasInstalledSelectedSkillSync(skills: string[]): boolean {
  return normalizeSkillIds(skills).some((skillId) => (
    getSkillSourceCandidates(skillId).some((dir) => fileExistsSyncSafe(join(dir, 'SKILL.md')))
  ));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function syncClaudeAgentSkillsPlugin(agentId: string, skills: string[]): Promise<void> {
  const pluginDir = getClaudeAgentSkillsPluginDir(agentId);
  if (!pluginDir) return;

  const selectedSkills = normalizeSkillIds(skills);
  if (selectedSkills.length === 0) {
    await rm(pluginDir, { recursive: true, force: true });
    return;
  }

  const sourceSkillDirs: Array<{ id: string; sourceDir: string }> = [];
  for (const skillId of selectedSkills) {
    const sourceDir = getSkillSourceCandidates(skillId)
      .find((candidate) => existsSync(join(candidate, 'SKILL.md')));
    if (sourceDir) {
      sourceSkillDirs.push({ id: skillId, sourceDir });
    } else {
      logger.warn('Selected agent skill is not installed; skipping Claude sync', { agentId, skillId });
    }
  }

  if (sourceSkillDirs.length === 0) {
    await rm(pluginDir, { recursive: true, force: true });
    return;
  }

  await rm(pluginDir, { recursive: true, force: true });
  await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true });
  await mkdir(join(pluginDir, 'skills'), { recursive: true });
  await writeFile(
    join(pluginDir, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify({
      name: CLAUDE_AGENT_SKILLS_PLUGIN_DIRNAME,
      description: 'ClawX generated plugin that exposes the selected agent skill package to Claude Code.',
      author: { name: 'ClawX' },
    }, null, 2)}\n`,
    'utf8',
  );

  for (const { id, sourceDir } of sourceSkillDirs) {
    await cp(sourceDir, join(pluginDir, 'skills', id), { recursive: true, force: true });
  }

  logger.info('Synced Claude agent skills plugin', {
    agentId,
    skillCount: sourceSkillDirs.length,
    skippedSkillCount: selectedSkills.length - sourceSkillDirs.length,
  });
}

function quoteShellArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    const content = await readFile(path, 'utf8');
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('Failed to read Claude settings; recreating managed settings fields', {
        path,
        error: String(error),
      });
    }
  }
  return {};
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => (
      Boolean(item) && typeof item === 'object' && !Array.isArray(item)
    ))
    : [];
}

function hookEntryUsesCommand(entry: Record<string, unknown>, command: string): boolean {
  return asRecordArray(entry.hooks).some((hook) => hook.command === command);
}

async function ensureClaudeCodeSafetyHooks(claudeConfigDir: string): Promise<void> {
  const hooksDir = join(claudeConfigDir, 'hooks');
  const hookScript = join(hooksDir, CLAUDE_BLOCK_AUTO_OPEN_HOOK);
  const hookCommand = `node ${quoteShellArg(hookScript)}`;
  const settingsPath = join(claudeConfigDir, 'settings.json');

  await mkdir(hooksDir, { recursive: true });
  await writeFile(
    hookScript,
    `'use strict';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  let payload = {};
  try {
    payload = input ? JSON.parse(input) : {};
  } catch {
    process.exit(0);
    return;
  }

  const toolInput = payload && typeof payload === 'object'
    ? (payload.tool_input || payload.toolInput || payload.input || {})
    : {};
  const command = toolInput && typeof toolInput === 'object' && typeof toolInput.command === 'string'
    ? toolInput.command
    : '';
  if (!command.trim()) {
    process.exit(0);
    return;
  }

  const openerPattern = /(?:^|[;&|]\\s*)(?:(?:cmd(?:\\.exe)?\\s*\\/c|powershell(?:\\.exe)?\\s+-Command)\\s+)?(?:start(?:\\s|$)|explorer(?:\\.exe)?(?:\\s|$)|start-process(?:\\s|$)|invoke-item(?:\\s|$)|ii(?:\\s|$)|rundll32\\s+url\\.dll,FileProtocolHandler(?:\\s|$)|open(?:\\s|$)|xdg-open(?:\\s|$)|gio\\s+open(?:\\s|$)|gnome-open(?:\\s|$)|kde-open5?(?:\\s|$))/im;
  if (!openerPattern.test(command)) {
    process.exit(0);
    return;
  }

  console.error('Blocked by ClawX: do not open files or external apps automatically. Tell the user the file is ready and let them click the file card in ClawX.');
  process.exit(2);
});
`,
    'utf8',
  );

  const settings = await readJsonObject(settingsPath);
  const hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
    ? { ...settings.hooks as Record<string, unknown> }
    : {};
  const preToolUse = asRecordArray(hooks.PreToolUse)
    .filter((entry) => !hookEntryUsesCommand(entry, hookCommand));
  preToolUse.unshift({
    matcher: 'Bash',
    hooks: [
      {
        type: 'command',
        command: hookCommand,
      },
    ],
  });
  hooks.PreToolUse = preToolUse;
  settings.hooks = hooks;

  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function stripClaudeAgentSkillsPluginArgs(args: string[], pluginDir: string | undefined): string[] {
  if (!pluginDir) return args;
  const normalizedPluginDir = normalize(pluginDir);
  const next: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--plugin-dir') {
      const value = args[index + 1];
      if (value && normalize(value) === normalizedPluginDir) {
        index += 1;
        continue;
      }
    }
    if (arg.startsWith('--plugin-dir=')) {
      const value = arg.slice('--plugin-dir='.length);
      if (normalize(value) === normalizedPluginDir) continue;
    }
    next.push(arg);
  }
  return next;
}

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^["'](.+)["']$/);
  return match ? match[1] : trimmed;
}

function fileExistsSyncSafe(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function expandCmdShimPath(value: string, cmdPath: string): string {
  const shimDir = dirname(cmdPath);
  const dp0 = shimDir.endsWith(sep) ? shimDir : `${shimDir}${sep}`;
  return value
    .replace(/%~dp0/gi, dp0)
    .replace(/%dp0%/gi, dp0);
}

function readCmdShimExeTarget(cmdPath: string): string | undefined {
  try {
    const content = readFileSync(cmdPath, 'utf-8');
    const candidates = [
      ...Array.from(content.matchAll(/"([^"]+\.exe)"/gi), (match) => match[1]),
      ...Array.from(content.matchAll(/([^\s"]+\.exe)\b/gi), (match) => match[1]),
    ];

    for (const candidate of candidates) {
      const expanded = stripOuterQuotes(expandCmdShimPath(candidate, cmdPath));
      const resolved = isAbsolute(expanded) ? expanded : join(dirname(cmdPath), expanded);
      if (fileExistsSyncSafe(resolved)) {
        return normalize(resolved);
      }
    }
  } catch {
    // Keep the original command if the shim cannot be inspected.
  }
  return undefined;
}

function windowsCommandCandidates(command: string): string[] {
  const trimmed = stripOuterQuotes(command);
  if (!trimmed) return [];

  const extension = extname(trimmed).toLowerCase();
  const suffixes = extension ? [''] : ['.exe', '.cmd', '.bat', '.ps1', ''];
  const hasPathSeparator = /[\\/]/.test(trimmed);
  const directories = hasPathSeparator
    ? ['']
    : (process.env.PATH || process.env.Path || '')
      .split(delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean);

  const candidates: string[] = [];
  for (const directory of directories) {
    for (const suffix of suffixes) {
      candidates.push(directory ? join(directory, `${trimmed}${suffix}`) : `${trimmed}${suffix}`);
    }
  }
  return candidates;
}

function resolveWindowsClaudeCommand(command: string): string {
  if (process.platform !== 'win32') return command;

  for (const candidate of windowsCommandCandidates(command)) {
    if (!fileExistsSyncSafe(candidate)) continue;

    const extension = extname(candidate).toLowerCase();
    if (extension === '.exe') {
      return normalize(candidate);
    }
    if (extension === '.cmd' || extension === '.bat') {
      const target = readCmdShimExeTarget(candidate);
      if (target) return target;
    }
  }

  return command;
}

function normalizeNativeCliCommand(provider: string, command: string): string {
  if (provider === 'claude') {
    return resolveWindowsClaudeCommand(command);
  }
  return command;
}

function defaultNativeCliResumeArgs(provider: string, args: string[] | undefined, pluginDir?: string): string[] | undefined {
  const existingArgs = args ?? [];
  if (provider === 'claude') {
    const extraArgs: string[] = [];
    for (let index = 0; index < existingArgs.length; index += 1) {
      const arg = existingArgs[index];
      if (arg === '--bare' || arg === '--dangerously-skip-permissions' || arg.startsWith('--model=')) continue;
      if (arg === '--model') {
        index += 1;
        continue;
      }
      extraArgs.push(arg);
    }
    return normalizeClaudeResumeArgs(['--resume', '{sessionId}', ...extraArgs], undefined, pluginDir, pluginDir);
  }
  if (provider === 'codex') return ['--full-auto', 'resume', '{sessionId}', ...existingArgs];
  return undefined;
}

function prependMissingArgs(args: string[] | undefined, requiredArgs: string[]): string[] {
  const next = args ? [...args] : [];
  for (let index = requiredArgs.length - 1; index >= 0; index -= 1) {
    const requiredArg = requiredArgs[index];
    if (!next.includes(requiredArg)) {
      next.unshift(requiredArg);
    }
  }
  return next;
}

function stripClaudeManagedArgs(args: string[]): string[] {
  const next: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--bare' || arg === '--dangerously-skip-permissions' || arg.startsWith('--model=')) continue;
    if (arg === '--model') {
      index += 1;
      continue;
    }
    next.push(arg);
  }
  return next;
}

function setClaudeModelArg(
  args: string[],
  modelId: string | undefined,
  pluginDir?: string,
  managedPluginDir?: string,
): string[] {
  const normalizedModelId = modelId?.trim();
  const nextArgs = managedPluginDir
    ? stripClaudeAgentSkillsPluginArgs(stripClaudeManagedArgs(args), managedPluginDir)
    : stripClaudeManagedArgs(args);
  const pluginArgs = pluginDir ? ['--plugin-dir', pluginDir] : [];
  if (!normalizedModelId) {
    const baseArgs = managedPluginDir ? stripClaudeAgentSkillsPluginArgs(args, managedPluginDir) : args;
    return [...baseArgs, ...pluginArgs];
  }
  return ['--bare', '--dangerously-skip-permissions', '--model', normalizedModelId, ...pluginArgs, ...nextArgs];
}

function normalizeClaudeArgs(
  args: string[] | undefined,
  modelId: string | undefined,
  pluginDir?: string,
  managedPluginDir?: string,
): string[] {
  const next = prependMissingArgs(args, ['--bare', '--dangerously-skip-permissions']);
  return setClaudeModelArg(next, modelId, pluginDir, managedPluginDir);
}

function normalizeClaudeResumeArgs(
  resumeArgs: string[] | undefined,
  modelId: string | undefined,
  pluginDir?: string,
  managedPluginDir?: string,
): string[] {
  const next = setClaudeModelArg(
    prependMissingArgs(resumeArgs, ['--bare', '--dangerously-skip-permissions']),
    modelId,
    pluginDir,
    managedPluginDir,
  );
  if (!next.includes('--resume') && !next.includes('-r')) {
    next.push('--resume', '{sessionId}');
  }
  return next;
}

function normalizeAgentRuntime(
  runtime: Record<string, unknown>,
  options?: { agentId?: string; skills?: string[] },
): Record<string, unknown> {
  if (runtime.type !== 'native-cli') return runtime;
  const nativeCli = runtime.nativeCli;
  if (!nativeCli || typeof nativeCli !== 'object' || Array.isArray(nativeCli)) return runtime;

  const nativeCliRecord = nativeCli as Record<string, unknown>;
  const command = typeof nativeCliRecord.command === 'string' ? nativeCliRecord.command.trim() : '';
  if (!command) return runtime;

  const provider = normalizeNativeCliProvider(nativeCliRecord.provider, command);
  const normalizedCommand = normalizeNativeCliCommand(provider, command);
  const env = normalizeNativeCliEnv(provider, asStringRecord(nativeCliRecord.env), options);
  const modelId = provider === 'claude' ? env?.ANTHROPIC_MODEL : undefined;
  const pluginDir = provider === 'claude' && hasInstalledSelectedSkillSync(options?.skills ?? [])
    ? getClaudeAgentSkillsPluginDir(options?.agentId)
    : undefined;
  const managedPluginDir = provider === 'claude' ? getClaudeAgentSkillsPluginDir(options?.agentId) : undefined;
  const rawArgs = asStringArray(nativeCliRecord.args);
  const args = provider === 'claude' ? normalizeClaudeArgs(rawArgs, modelId, pluginDir, managedPluginDir) : rawArgs;
  const rawResumeArgs = asStringArray(nativeCliRecord.resumeArgs);
  const resumeArgs = provider === 'claude'
    ? normalizeClaudeResumeArgs(rawResumeArgs ?? defaultNativeCliResumeArgs(provider, args, pluginDir), modelId, pluginDir, managedPluginDir)
    : rawResumeArgs ?? defaultNativeCliResumeArgs(provider, args, pluginDir);

  return {
    ...runtime,
    nativeCli: {
      ...nativeCliRecord,
      provider,
      command: normalizedCommand,
      ...(args ? { args } : {}),
      ...(resumeArgs ? { resumeArgs } : {}),
      ...(env ? { env } : {}),
    },
  };
}

function getClaudeConfigDirForRuntime(agentId: string, runtime: Record<string, unknown>): string | undefined {
  if (runtime.type !== 'native-cli') return undefined;
  const nativeCli = runtime.nativeCli;
  if (!nativeCli || typeof nativeCli !== 'object' || Array.isArray(nativeCli)) return undefined;

  const nativeCliRecord = nativeCli as Record<string, unknown>;
  const command = typeof nativeCliRecord.command === 'string' ? nativeCliRecord.command.trim() : '';
  const provider = normalizeNativeCliProvider(nativeCliRecord.provider, command);
  return provider === 'claude' ? getClaudeConfigDir(agentId) : undefined;
}
const AGENT_RUNTIME_FILES = [
  'auth-profiles.json',
  'models.json',
];

interface AgentModelConfig {
  primary?: string;
  [key: string]: unknown;
}

interface AgentDefaultsConfig {
  workspace?: string;
  model?: string | AgentModelConfig;
  [key: string]: unknown;
}

interface AgentListEntry extends Record<string, unknown> {
  id: string;
  name?: string;
  default?: boolean;
  workspace?: string;
  agentDir?: string;
  model?: string | AgentModelConfig;
}

interface AgentsConfig extends Record<string, unknown> {
  defaults?: AgentDefaultsConfig;
  list?: AgentListEntry[];
}

interface BindingMatch extends Record<string, unknown> {
  channel?: string;
  accountId?: string;
}

interface BindingConfig extends Record<string, unknown> {
  agentId?: string;
  match?: BindingMatch;
}

interface ChannelSectionConfig extends Record<string, unknown> {
  accounts?: Record<string, Record<string, unknown>>;
  defaultAccount?: string;
  enabled?: boolean;
}

interface AgentConfigDocument extends Record<string, unknown> {
  agents?: AgentsConfig;
  bindings?: BindingConfig[];
  channels?: Record<string, ChannelSectionConfig>;
  session?: {
    mainKey?: string;
    [key: string]: unknown;
  };
}

export interface AgentSummary {
  id: string;
  name: string;
  isDefault: boolean;
  modelDisplay: string;
  modelRef: string | null;
  overrideModelRef: string | null;
  inheritedModel: boolean;
  workspace: string;
  agentDir: string;
  mainSessionKey: string;
  channelTypes: string[];
  skills?: string[];
  runtime?: { type: string; nativeCli?: { provider: string; command: string; args?: string[]; resumeArgs?: string[]; env?: Record<string, string> } };
}

export interface AgentsSnapshot {
  agents: AgentSummary[];
  defaultAgentId: string;
  defaultModelRef: string | null;
  configuredChannelTypes: string[];
  channelOwners: Record<string, string>;
  channelAccountOwners: Record<string, string>;
}

function resolveModelRef(model: unknown): string | null {
  if (typeof model === 'string' && model.trim()) {
    return model.trim();
  }

  if (model && typeof model === 'object') {
    const primary = (model as AgentModelConfig).primary;
    if (typeof primary === 'string' && primary.trim()) {
      return primary.trim();
    }
  }

  return null;
}

function formatModelLabel(model: unknown): string | null {
  const modelRef = resolveModelRef(model);
  if (modelRef) {
    const trimmed = modelRef;
    const parts = trimmed.split('/');
    return parts[parts.length - 1] || trimmed;
  }

  return null;
}

function normalizeAgentName(name: string): string {
  return name.trim() || 'Agent';
}

function slugifyAgentId(name: string): string {
  const normalized = name
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!normalized || /^\d+$/.test(normalized)) return 'agent';
  if (normalized === MAIN_AGENT_ID) return 'agent';
  return normalized;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(path: string): Promise<void> {
  if (!(await fileExists(path))) {
    await mkdir(path, { recursive: true });
  }
}

function getDefaultWorkspacePath(config: AgentConfigDocument): string {
  const defaults = (config.agents && typeof config.agents === 'object'
    ? (config.agents as AgentsConfig).defaults
    : undefined);
  return typeof defaults?.workspace === 'string' && defaults.workspace.trim()
    ? defaults.workspace
    : DEFAULT_WORKSPACE_PATH;
}

function getDefaultAgentDirPath(agentId: string): string {
  return `~/.openclaw/agents/${agentId}/agent`;
}

function createImplicitMainEntry(config: AgentConfigDocument): AgentListEntry {
  return {
    id: MAIN_AGENT_ID,
    name: MAIN_AGENT_NAME,
    default: true,
    workspace: getDefaultWorkspacePath(config),
    agentDir: getDefaultAgentDirPath(MAIN_AGENT_ID),
  };
}

function normalizeAgentsConfig(config: AgentConfigDocument): {
  agentsConfig: AgentsConfig;
  entries: AgentListEntry[];
  defaultAgentId: string;
  syntheticMain: boolean;
} {
  const agentsConfig = (config.agents && typeof config.agents === 'object'
    ? { ...(config.agents as AgentsConfig) }
    : {}) as AgentsConfig;
  const rawEntries = Array.isArray(agentsConfig.list)
    ? agentsConfig.list.filter((entry): entry is AgentListEntry => (
      Boolean(entry) && typeof entry === 'object' && typeof entry.id === 'string' && entry.id.trim().length > 0
    ))
    : [];

  if (rawEntries.length === 0) {
    const main = createImplicitMainEntry(config);
    return {
      agentsConfig,
      entries: [main],
      defaultAgentId: MAIN_AGENT_ID,
      syntheticMain: true,
    };
  }

  const defaultEntry = rawEntries.find((entry) => entry.default) ?? rawEntries[0];
  return {
    agentsConfig,
    entries: rawEntries.map((entry) => ({ ...entry })),
    defaultAgentId: defaultEntry.id,
    syntheticMain: false,
  };
}

function isChannelBinding(binding: unknown): binding is BindingConfig {
  if (!binding || typeof binding !== 'object') return false;
  const candidate = binding as BindingConfig;
  if (typeof candidate.agentId !== 'string' || !candidate.agentId) return false;
  if (!candidate.match || typeof candidate.match !== 'object' || Array.isArray(candidate.match)) return false;
  if (typeof candidate.match.channel !== 'string' || !candidate.match.channel) return false;
  const keys = Object.keys(candidate.match);
  // Accept bindings with just {channel} or {channel, accountId}
  if (keys.length === 1 && keys[0] === 'channel') return true;
  if (keys.length === 2 && keys.includes('channel') && keys.includes('accountId')) return true;
  return false;
}

/** Normalize agent ID for consistent comparison (bindings vs entries). */
function normalizeAgentIdForBinding(id: string): string {
  return (id ?? '').trim().toLowerCase() || '';
}

function normalizeMainKey(value: unknown): string {
  if (typeof value !== 'string') return 'main';
  const trimmed = value.trim().toLowerCase();
  return trimmed || 'main';
}

function buildAgentMainSessionKey(config: AgentConfigDocument, agentId: string): string {
  return `agent:${normalizeAgentIdForBinding(agentId) || MAIN_AGENT_ID}:${normalizeMainKey(config.session?.mainKey)}`;
}

/**
 * Returns a map of channelType -> agentId from bindings.
 * Account-scoped bindings are preferred; channel-wide bindings serve as fallback.
 * Multiple agents can own the same channel type (different accounts).
 */
function getChannelBindingMap(bindings: unknown): {
  channelToAgent: Map<string, string>;
  accountToAgent: Map<string, string>;
} {
  const channelToAgent = new Map<string, string>();
  const accountToAgent = new Map<string, string>();
  if (!Array.isArray(bindings)) return { channelToAgent, accountToAgent };

  for (const binding of bindings) {
    if (!isChannelBinding(binding)) continue;
    const agentId = normalizeAgentIdForBinding(binding.agentId!);
    const channel = binding.match?.channel;
    if (!agentId || !channel) continue;

    const accountId = binding.match?.accountId;
    if (accountId) {
      accountToAgent.set(`${channel}:${accountId}`, agentId);
    } else {
      channelToAgent.set(channel, agentId);
    }
  }

  return { channelToAgent, accountToAgent };
}

function upsertBindingsForChannel(
  bindings: unknown,
  channelType: string,
  agentId: string | null,
  accountId?: string,
): BindingConfig[] | undefined {
  const normalizedAgentId = agentId ? normalizeAgentIdForBinding(agentId) : '';
  const nextBindings = Array.isArray(bindings)
    ? [...bindings as BindingConfig[]].filter((binding) => {
      if (!isChannelBinding(binding)) return true;
      if (binding.match?.channel !== channelType) return true;
      // Keep a single account binding per (agent, channelType). Rebinding to
      // another account should replace the previous one.
      if (normalizedAgentId && normalizeAgentIdForBinding(binding.agentId || '') === normalizedAgentId) {
        return false;
      }
      // Only remove binding that matches the exact accountId scope
      if (accountId) {
        return binding.match?.accountId !== accountId;
      }
      // No accountId: remove channel-wide binding (legacy)
      return Boolean(binding.match?.accountId);
    })
    : [];

  if (agentId) {
    const match: BindingMatch = { channel: channelType };
    if (accountId) {
      match.accountId = accountId;
    }
    nextBindings.push({ agentId, match });
  }

  return nextBindings.length > 0 ? nextBindings : undefined;
}

async function listExistingAgentIdsOnDisk(): Promise<Set<string>> {
  const ids = new Set<string>();
  const agentsDir = join(getOpenClawConfigDir(), 'agents');

  try {
    if (!(await fileExists(agentsDir))) return ids;
    const entries = await readdir(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) ids.add(entry.name);
    }
  } catch {
    // ignore discovery failures
  }

  return ids;
}

async function removeAgentRuntimeDirectory(agentId: string): Promise<void> {
  const runtimeDir = join(getOpenClawConfigDir(), 'agents', agentId);
  try {
    await rm(runtimeDir, { recursive: true, force: true });
  } catch (error) {
    logger.warn('Failed to remove agent runtime directory', {
      agentId,
      runtimeDir,
      error: String(error),
    });
  }
}

function trimTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, '');
}

function getManagedWorkspaceDirectory(agent: AgentListEntry): string | null {
  if (agent.id === MAIN_AGENT_ID) return null;

  const configuredWorkspace = expandPath(agent.workspace || `~/.openclaw/workspace-${agent.id}`);
  const managedWorkspace = join(getOpenClawConfigDir(), `workspace-${agent.id}`);
  const normalizedConfigured = trimTrailingSeparators(normalize(configuredWorkspace));
  const normalizedManaged = trimTrailingSeparators(normalize(managedWorkspace));

  return normalizedConfigured === normalizedManaged ? configuredWorkspace : null;
}

export async function removeAgentWorkspaceDirectory(agent: { id: string; workspace?: string }): Promise<void> {
  const workspaceDir = getManagedWorkspaceDirectory(agent as AgentListEntry);
  if (!workspaceDir) {
    logger.warn('Skipping agent workspace deletion for unmanaged path', {
      agentId: agent.id,
      workspace: agent.workspace,
    });
    return;
  }

  try {
    await rm(workspaceDir, { recursive: true, force: true });
  } catch (error) {
    logger.warn('Failed to remove agent workspace directory', {
      agentId: agent.id,
      workspaceDir,
      error: String(error),
    });
  }
}

async function copyBootstrapFiles(sourceWorkspace: string, targetWorkspace: string): Promise<void> {
  await ensureDir(targetWorkspace);

  for (const fileName of AGENT_BOOTSTRAP_FILES) {
    const source = join(sourceWorkspace, fileName);
    const target = join(targetWorkspace, fileName);
    if (!(await fileExists(source)) || (await fileExists(target))) continue;
    await copyFile(source, target);
  }
}

async function copyRuntimeFiles(sourceAgentDir: string, targetAgentDir: string): Promise<void> {
  await ensureDir(targetAgentDir);

  for (const fileName of AGENT_RUNTIME_FILES) {
    const source = join(sourceAgentDir, fileName);
    const target = join(targetAgentDir, fileName);
    if (!(await fileExists(source)) || (await fileExists(target))) continue;
    await copyFile(source, target);
  }
}

async function provisionAgentFilesystem(
  config: AgentConfigDocument,
  agent: AgentListEntry,
  options?: { inheritWorkspace?: boolean },
): Promise<void> {
  const { entries } = normalizeAgentsConfig(config);
  const mainEntry = entries.find((entry) => entry.id === MAIN_AGENT_ID) ?? createImplicitMainEntry(config);
  const sourceWorkspace = expandPath(mainEntry.workspace || getDefaultWorkspacePath(config));
  const targetWorkspace = expandPath(agent.workspace || `~/.openclaw/workspace-${agent.id}`);
  const sourceAgentDir = expandPath(mainEntry.agentDir || getDefaultAgentDirPath(MAIN_AGENT_ID));
  const targetAgentDir = expandPath(agent.agentDir || getDefaultAgentDirPath(agent.id));
  const targetSessionsDir = join(getOpenClawConfigDir(), 'agents', agent.id, 'sessions');

  await ensureDir(targetWorkspace);
  await ensureDir(targetAgentDir);
  await ensureDir(targetSessionsDir);

  // When inheritWorkspace is true, copy the main agent's workspace bootstrap
  // files (SOUL.md, AGENTS.md, etc.) so the new agent inherits the same
  // personality / instructions. When false (default), leave the workspace
  // empty and let OpenClaw Gateway seed the default bootstrap files on startup.
  if (options?.inheritWorkspace && targetWorkspace !== sourceWorkspace) {
    await copyBootstrapFiles(sourceWorkspace, targetWorkspace);
  }
  if (targetAgentDir !== sourceAgentDir) {
    await copyRuntimeFiles(sourceAgentDir, targetAgentDir);
  }
}

export function resolveAccountIdForAgent(agentId: string): string {
  return agentId === MAIN_AGENT_ID ? DEFAULT_ACCOUNT_ID : agentId;
}

function listConfiguredAccountIdsForChannel(config: AgentConfigDocument, channelType: string): string[] {
  const channelSection = config.channels?.[channelType];
  if (!channelSection || channelSection.enabled === false) {
    return [];
  }

  const accounts = channelSection.accounts;
  if (!accounts || typeof accounts !== 'object' || Object.keys(accounts).length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }

  return Object.keys(accounts)
    .filter(Boolean)
    .sort((a, b) => {
      if (a === DEFAULT_ACCOUNT_ID) return -1;
      if (b === DEFAULT_ACCOUNT_ID) return 1;
      return a.localeCompare(b);
    });
}

async function buildSnapshotFromConfig(config: AgentConfigDocument, preloadedChannels?: string[]): Promise<AgentsSnapshot> {
  const { entries, defaultAgentId } = normalizeAgentsConfig(config);
  const configuredChannels = preloadedChannels ?? await listConfiguredChannels();
  const { channelToAgent, accountToAgent } = getChannelBindingMap(config.bindings);
  const defaultAgentIdNorm = normalizeAgentIdForBinding(defaultAgentId);
  const channelOwners: Record<string, string> = {};
  const channelAccountOwners: Record<string, string> = {};

  // Build per-agent channel lists from account-scoped bindings
  const agentChannelSets = new Map<string, Set<string>>();

  for (const channelType of configuredChannels) {
    const accountIds = listConfiguredAccountIdsForChannel(config, channelType);
    let primaryOwner: string | undefined;
    const hasExplicitAccountBindingForChannel = accountIds.some((accountId) =>
      accountToAgent.has(`${channelType}:${accountId}`),
    );

    for (const accountId of accountIds) {
      const owner =
        accountToAgent.get(`${channelType}:${accountId}`)
        || (
          accountId === DEFAULT_ACCOUNT_ID && !hasExplicitAccountBindingForChannel
            ? channelToAgent.get(channelType)
            : undefined
        );

      if (!owner) {
        continue;
      }

      channelAccountOwners[`${channelType}:${accountId}`] = owner;
      primaryOwner ??= owner;
      const existing = agentChannelSets.get(owner) ?? new Set();
      existing.add(channelType);
      agentChannelSets.set(owner, existing);
    }

    if (!primaryOwner) {
      primaryOwner = channelToAgent.get(channelType) || defaultAgentIdNorm;
      const existing = agentChannelSets.get(primaryOwner) ?? new Set();
      existing.add(channelType);
      agentChannelSets.set(primaryOwner, existing);
    }

    channelOwners[channelType] = primaryOwner;
  }

  const defaultModelConfig = (config.agents as AgentsConfig | undefined)?.defaults?.model;
  const defaultModelLabel = formatModelLabel(defaultModelConfig);
  const defaultModelRef = resolveModelRef(defaultModelConfig);
  const agents: AgentSummary[] = entries.map((entry) => {
    const explicitModelRef = resolveModelRef(entry.model);
    const modelLabel = formatModelLabel(entry.model) || defaultModelLabel || 'Not configured';
    const inheritedModel = !explicitModelRef && Boolean(defaultModelLabel);
    const entryIdNorm = normalizeAgentIdForBinding(entry.id);
    const ownedChannels = agentChannelSets.get(entryIdNorm) ?? new Set<string>();
    return {
      id: entry.id,
      name: entry.name || (entry.id === MAIN_AGENT_ID ? MAIN_AGENT_NAME : entry.id),
      isDefault: entry.id === defaultAgentId,
      modelDisplay: modelLabel,
      modelRef: explicitModelRef || defaultModelRef || null,
      overrideModelRef: explicitModelRef,
      inheritedModel,
      workspace: entry.workspace || (entry.id === MAIN_AGENT_ID ? getDefaultWorkspacePath(config) : `~/.openclaw/workspace-${entry.id}`),
      agentDir: entry.agentDir || getDefaultAgentDirPath(entry.id),
      mainSessionKey: buildAgentMainSessionKey(config, entry.id),
      channelTypes: configuredChannels
        .filter((ct) => ownedChannels.has(ct))
        .map((channelType) => toUiChannelType(channelType)),
      skills: Array.isArray(entry.skills) ? entry.skills : undefined,
      runtime: entry.runtime as { type: string; nativeCli?: { provider: string; command: string; args?: string[]; resumeArgs?: string[]; env?: Record<string, string> } } | undefined,
    };
  });

  return {
    agents,
    defaultAgentId,
    defaultModelRef,
    configuredChannelTypes: configuredChannels.map((channelType) => toUiChannelType(channelType)),
    channelOwners,
    channelAccountOwners,
  };
}

export async function listAgentsSnapshot(): Promise<AgentsSnapshot> {
  const config = await readOpenClawConfig() as AgentConfigDocument;
  return buildSnapshotFromConfig(config);
}

export async function listAgentsSnapshotFromConfig(config: OpenClawConfig, configuredChannels?: string[]): Promise<AgentsSnapshot> {
  return buildSnapshotFromConfig(config as AgentConfigDocument, configuredChannels);
}

export async function listConfiguredAgentIds(): Promise<string[]> {
  const config = await readOpenClawConfig() as AgentConfigDocument;
  const { entries } = normalizeAgentsConfig(config);
  const ids = [...new Set(entries.map((entry) => entry.id.trim()).filter(Boolean))];
  return ids.length > 0 ? ids : [MAIN_AGENT_ID];
}

export async function createAgent(
  name: string,
  options?: { inheritWorkspace?: boolean },
): Promise<AgentsSnapshot> {
  return withConfigLock(async () => {
    const config = await readOpenClawConfig() as AgentConfigDocument;
    const { agentsConfig, entries, syntheticMain } = normalizeAgentsConfig(config);
    const normalizedName = normalizeAgentName(name);
    const existingIds = new Set(entries.map((entry) => entry.id));
    const diskIds = await listExistingAgentIdsOnDisk();
    let nextId = slugifyAgentId(normalizedName);
    let suffix = 2;

    while (existingIds.has(nextId) || diskIds.has(nextId)) {
      nextId = `${slugifyAgentId(normalizedName)}-${suffix}`;
      suffix += 1;
    }

    const nextEntries = syntheticMain ? [createImplicitMainEntry(config), ...entries.filter((_, index) => index > 0)] : [...entries];
    const newAgent: AgentListEntry = {
      id: nextId,
      name: normalizedName,
      workspace: `~/.openclaw/workspace-${nextId}`,
      agentDir: getDefaultAgentDirPath(nextId),
    };

    if (!nextEntries.some((entry) => entry.id === MAIN_AGENT_ID) && syntheticMain) {
      nextEntries.unshift(createImplicitMainEntry(config));
    }
    nextEntries.push(newAgent);

    config.agents = {
      ...agentsConfig,
      list: nextEntries,
    };

    await provisionAgentFilesystem(config, newAgent, { inheritWorkspace: options?.inheritWorkspace });
    await writeOpenClawConfig(config);
    logger.info('Created agent config entry', { agentId: nextId, inheritWorkspace: !!options?.inheritWorkspace });
    return buildSnapshotFromConfig(config);
  });
}

// 同步员工名称到数据库
async function _syncAgentNameToDatabase(agentId: string, nickName: string): Promise<void> {
  const { tokenKey, apiUrl } = await getBoxImConfig();
  if (!tokenKey) {
    logger.warn('[agent-config] No tokenKey, skipping name sync to database');
    return;
  }

  try {
    const response = await fetch(`${apiUrl}/bot/name/${encodeURIComponent(agentId)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Token-Key': tokenKey,
      },
      body: JSON.stringify({ nickName }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to sync name to database: ${response.status} ${errorText}`);
    }

    logger.info('[agent-config] Synced agent name to database', { agentId, nickName });
  } catch (error) {
    logger.error('[agent-config] Failed to sync agent name to database:', error);
    throw error;
  }
}

// 同步员工模型到数据库
async function syncAgentModelToDatabase(agentId: string, model: string | null): Promise<void> {
  const { tokenKey, apiUrl } = await getBoxImConfig();
  if (!tokenKey) {
    logger.warn('[agent-config] No tokenKey, skipping model sync to database');
    return;
  }

  try {
    const response = await fetch(`${apiUrl}/bot/model/${encodeURIComponent(agentId)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Token-Key': tokenKey,
      },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to sync model to database: ${response.status} ${errorText}`);
    }

    logger.info('[agent-config] Synced agent model to database', { agentId, model });
  } catch (error) {
    logger.error('[agent-config] Failed to sync agent model to database:', error);
    throw error;
  }
}

export async function updateAgentName(agentId: string, name: string): Promise<AgentsSnapshot> {
  return withConfigLock(async () => {
    const config = await readOpenClawConfig() as AgentConfigDocument;
    const { agentsConfig, entries } = normalizeAgentsConfig(config);
    const normalizedName = normalizeAgentName(name);
    const index = entries.findIndex((entry) => entry.id === agentId);
    if (index === -1) {
      throw new Error(`Agent "${agentId}" not found`);
    }

    entries[index] = {
      ...entries[index],
      name: normalizedName,
    };

    config.agents = {
      ...agentsConfig,
      list: entries,
    };

    await writeOpenClawConfig(config);
    logger.info('Updated agent name', { agentId, name: normalizedName });
    return buildSnapshotFromConfig(config);
  });
}

function isValidModelRef(modelRef: string): boolean {
  const firstSlash = modelRef.indexOf('/');
  return firstSlash > 0 && firstSlash < modelRef.length - 1;
}

export async function updateAgentModel(agentId: string, modelRef: string | null): Promise<AgentsSnapshot> {
  return withConfigLock(async () => {
    const config = await readOpenClawConfig() as AgentConfigDocument;
    const { agentsConfig, entries } = normalizeAgentsConfig(config);
    const index = entries.findIndex((entry) => entry.id === agentId);
    if (index === -1) {
      throw new Error(`Agent "${agentId}" not found`);
    }

    const normalizedModelRef = typeof modelRef === 'string' ? modelRef.trim() : '';
    const nextEntry: AgentListEntry = { ...entries[index] };

    if (!normalizedModelRef) {
      delete nextEntry.model;
    } else {
      if (!isValidModelRef(normalizedModelRef)) {
        throw new Error('modelRef must be in "provider/model" format');
      }
      nextEntry.model = { primary: normalizedModelRef };
    }

    entries[index] = nextEntry;
    config.agents = {
      ...agentsConfig,
      list: entries,
    };

    await writeOpenClawConfig(config);
    logger.info('Updated agent model', { agentId, modelRef: normalizedModelRef || null });
    
    // 同步到数据库
    try {
      await syncAgentModelToDatabase(agentId, normalizedModelRef || null);
    } catch (err) {
      logger.warn('Failed to sync agent model to database:', err);
    }
    
    return buildSnapshotFromConfig(config);
  });
}

export async function deleteAgentConfig(agentId: string): Promise<{ snapshot: AgentsSnapshot; removedEntry: AgentListEntry }> {
  return withConfigLock(async () => {
    if (agentId === MAIN_AGENT_ID) {
      throw new Error('The main agent cannot be deleted');
    }

    const config = await readOpenClawConfig() as AgentConfigDocument;
    const { agentsConfig, entries, defaultAgentId } = normalizeAgentsConfig(config);
    const snapshotBeforeDeletion = await buildSnapshotFromConfig(config);
    const removedEntry = entries.find((entry) => entry.id === agentId);
    const nextEntries = entries.filter((entry) => entry.id !== agentId);
    if (!removedEntry || nextEntries.length === entries.length) {
      throw new Error(`Agent "${agentId}" not found`);
    }

    config.agents = {
      ...agentsConfig,
      list: nextEntries,
    };
    config.bindings = Array.isArray(config.bindings)
      ? config.bindings.filter((binding) => !(isChannelBinding(binding) && binding.agentId === agentId))
      : undefined;

    if (defaultAgentId === agentId && nextEntries.length > 0) {
      nextEntries[0] = {
        ...nextEntries[0],
        default: true,
      };
    }

    const normalizedAgentId = normalizeAgentIdForBinding(agentId);
    const legacyAccountId = resolveAccountIdForAgent(agentId);
    const ownedLegacyAccounts = new Set(
      Object.entries(snapshotBeforeDeletion.channelAccountOwners)
        .filter(([channelAccountKey, owner]) => {
          if (owner !== normalizedAgentId) return false;
          const accountId = channelAccountKey.slice(channelAccountKey.indexOf(':') + 1);
          return accountId === legacyAccountId;
        })
        .map(([channelAccountKey]) => channelAccountKey),
    );

    await writeOpenClawConfig(config);
    await deleteAgentChannelAccounts(agentId, ownedLegacyAccounts);
    await removeAgentRuntimeDirectory(agentId);
    // NOTE: workspace directory is NOT deleted here intentionally.
    // The caller (route handler) defers workspace removal until after
    // the Gateway process has fully restarted, so that any in-flight
    // process.chdir(workspace) calls complete before the directory
    // disappears (otherwise process.cwd() throws ENOENT for the rest
    // of the Gateway's lifetime).
    logger.info('Deleted agent config entry', { agentId });
    return { snapshot: await buildSnapshotFromConfig(config), removedEntry };
  });
}

export async function assignChannelToAgent(agentId: string, channelType: string): Promise<AgentsSnapshot> {
  return withConfigLock(async () => {
    const config = await readOpenClawConfig() as AgentConfigDocument;
    const { entries } = normalizeAgentsConfig(config);
    if (!entries.some((entry) => entry.id === agentId)) {
      throw new Error(`Agent "${agentId}" not found`);
    }

    const accountId = resolveAccountIdForAgent(agentId);
    config.bindings = upsertBindingsForChannel(config.bindings, channelType, agentId, accountId);
    await writeOpenClawConfig(config);
    logger.info('Assigned channel to agent', { agentId, channelType, accountId });
    return buildSnapshotFromConfig(config);
  });
}

export async function assignChannelAccountToAgent(
  agentId: string,
  channelType: string,
  accountId: string,
): Promise<AgentsSnapshot> {
  return withConfigLock(async () => {
    const config = await readOpenClawConfig() as AgentConfigDocument;
    const { agentsConfig, entries } = normalizeAgentsConfig(config);
    const agentIndex = entries.findIndex((entry) => entry.id === agentId);
    if (agentIndex === -1) {
      throw new Error(`Agent "${agentId}" not found`);
    }
    if (!accountId.trim()) {
      throw new Error('accountId is required');
    }

    config.bindings = upsertBindingsForChannel(config.bindings, channelType, agentId, accountId.trim());

    // If this agent is a digital employee (box-im bot), sync its model from box-im accounts
    const boxImAccounts = (config.channels?.['box-im'] as ChannelSectionConfig)?.accounts;
    if (boxImAccounts && boxImAccounts[agentId]) {
      const botAccount = boxImAccounts[agentId] as Record<string, unknown>;
      const botModel = botAccount.model;
      if (typeof botModel === 'string' && botModel.trim()) {
        // Update agent model in agents.list
        const currentAgent = entries[agentIndex];
        const currentModel = typeof currentAgent.model === 'object' && currentAgent.model !== null
          ? (currentAgent.model as AgentModelConfig).primary
          : typeof currentAgent.model === 'string'
          ? currentAgent.model
          : undefined;

        if (currentModel !== botModel) {
          entries[agentIndex] = {
            ...currentAgent,
            model: { primary: botModel },
          };
          config.agents = {
            ...agentsConfig,
            list: entries,
          };
          logger.info('Synced digital employee model to agent', { agentId, model: botModel });
        }
      }
    }

    await writeOpenClawConfig(config);
    logger.info('Assigned channel account to agent', { agentId, channelType, accountId: accountId.trim() });
    return buildSnapshotFromConfig(config);
  });
}

/**
 * Sync all digital employee models from box-im accounts to agents.list
 * This should be called on gateway startup to ensure all agents have the correct model
 */
export async function syncAllDigitalEmployeeModels(): Promise<boolean> {
  return withConfigLock(async () => {
    const config = await readOpenClawConfig() as AgentConfigDocument;
    const { agentsConfig, entries } = normalizeAgentsConfig(config);
    const boxImAccounts = (config.channels?.['box-im'] as ChannelSectionConfig)?.accounts;

    if (!boxImAccounts) {
      logger.debug('No box-im accounts found, skipping digital employee model sync');
      return false;
    }

    let updated = false;
    for (const [agentId, accountData] of Object.entries(boxImAccounts)) {
      const botAccount = accountData as Record<string, unknown>;
      const botModel = botAccount.model;
      
      if (typeof botModel === 'string' && botModel.trim()) {
        const agentIndex = entries.findIndex((entry) => entry.id === agentId);
        if (agentIndex !== -1) {
          const currentAgent = entries[agentIndex];
          const currentModel = typeof currentAgent.model === 'object' && currentAgent.model !== null
            ? (currentAgent.model as AgentModelConfig).primary
            : typeof currentAgent.model === 'string'
            ? currentAgent.model
            : undefined;

          if (currentModel !== botModel) {
            entries[agentIndex] = {
              ...currentAgent,
              model: { primary: botModel },
            };
            updated = true;
            logger.info('Synced digital employee model to agent', { agentId, from: currentModel, to: botModel });
          }
        }
      }
    }

    if (updated) {
      config.agents = {
        ...agentsConfig,
        list: entries,
      };
      await writeOpenClawConfig(config);
      logger.info('Digital employee models synced to agents.list');
    }
    return updated;
  });
}

/**
 * Start auto-sync timer to periodically sync digital employee models from database
 * This ensures local config stays in sync with database changes
 */
let autoSyncTimer: NodeJS.Timeout | null = null;

export function startAutoSyncDigitalEmployeeModels(intervalMs: number = 60000): void {
  if (autoSyncTimer) {
    logger.debug('Auto-sync timer already running');
    return;
  }

  logger.info(`Starting auto-sync for digital employee models (interval: ${intervalMs}ms)`);
  
  // Run immediately on start
  syncAllDigitalEmployeeModels().catch(err => {
    logger.warn('Initial auto-sync failed:', err);
  });

  // Then run periodically
  autoSyncTimer = setInterval(() => {
    syncAllDigitalEmployeeModels().catch(err => {
      logger.warn('Auto-sync failed:', err);
    });
  }, intervalMs);
}

export function stopAutoSyncDigitalEmployeeModels(): void {
  if (autoSyncTimer) {
    clearInterval(autoSyncTimer);
    autoSyncTimer = null;
    logger.info('Stopped auto-sync for digital employee models');
  }
}

export async function clearChannelBinding(channelType: string, accountId?: string): Promise<AgentsSnapshot> {
  return withConfigLock(async () => {
    const config = await readOpenClawConfig() as AgentConfigDocument;
    config.bindings = upsertBindingsForChannel(config.bindings, channelType, null, accountId);
    await writeOpenClawConfig(config);
    logger.info('Cleared channel binding', { channelType, accountId });
    return buildSnapshotFromConfig(config);
  });
}

export async function clearAllBindingsForChannel(channelType: string): Promise<void> {
  return withConfigLock(async () => {
    const config = await readOpenClawConfig() as AgentConfigDocument;
    if (!Array.isArray(config.bindings)) return;

    const nextBindings = config.bindings.filter((binding) => {
      if (!isChannelBinding(binding)) return true;
      return binding.match?.channel !== channelType;
    });

    config.bindings = nextBindings.length > 0 ? nextBindings : undefined;
    await writeOpenClawConfig(config);
    logger.info('Cleared all bindings for channel', { channelType });
  });
}

export async function updateAgentSkills(agentId: string, skills: string[]): Promise<AgentsSnapshot> {
  return withConfigLock(async () => {
    const config = await readOpenClawConfig() as AgentConfigDocument;
    const { agentsConfig, entries } = normalizeAgentsConfig(config);
    const index = entries.findIndex((entry) => entry.id === agentId);
    if (index === -1) {
      throw new Error(`Agent "${agentId}" not found`);
    }

    let nextEntry: AgentListEntry = { ...entries[index], skills };
    const runtime = nextEntry.runtime;
    if (runtime && typeof runtime === 'object' && !Array.isArray(runtime)) {
      nextEntry = {
        ...nextEntry,
        runtime: normalizeAgentRuntime(runtime as Record<string, unknown>, { agentId, skills }),
      };
    }
    entries[index] = nextEntry;
    config.agents = {
      ...agentsConfig,
      list: entries,
    };

    await writeOpenClawConfig(config);
    const normalizedRuntime = nextEntry.runtime;
    if (normalizedRuntime && typeof normalizedRuntime === 'object' && !Array.isArray(normalizedRuntime)) {
      const claudeConfigDir = getClaudeConfigDirForRuntime(agentId, normalizedRuntime as Record<string, unknown>);
      if (claudeConfigDir) {
        await syncClaudeAgentSkillsPlugin(agentId, skills);
      }
    }
    logger.info('Updated agent skills', { agentId, skillCount: skills.length });
    return buildSnapshotFromConfig(config);
  });
}

export async function updateAgentRuntime(agentId: string, runtime: Record<string, unknown>): Promise<AgentsSnapshot> {
  return withConfigLock(async () => {
    const config = await readOpenClawConfig() as AgentConfigDocument;
    const { agentsConfig, entries } = normalizeAgentsConfig(config);
    const index = entries.findIndex((entry) => entry.id === agentId);
    if (index === -1) {
      throw new Error(`Agent "${agentId}" not found`);
    }

    const normalizedRuntime = normalizeAgentRuntime(runtime, { agentId, skills: asStringArray(entries[index].skills) ?? [] });
    const claudeConfigDir = getClaudeConfigDirForRuntime(agentId, normalizedRuntime);
    if (claudeConfigDir) {
      await ensureDir(claudeConfigDir);
      await ensureClaudeCodeSafetyHooks(claudeConfigDir);
    }
    const nextEntry: AgentListEntry = { ...entries[index], runtime: normalizedRuntime };
    entries[index] = nextEntry;
    config.agents = {
      ...agentsConfig,
      list: entries,
    };

    await writeOpenClawConfig(config);
    if (claudeConfigDir) {
      await syncClaudeAgentSkillsPlugin(agentId, asStringArray(nextEntry.skills) ?? []);
    }
    const runtimeType = typeof normalizedRuntime.type === 'string' ? normalizedRuntime.type : undefined;
    logger.info('Updated agent runtime', { agentId, runtimeType });
    return buildSnapshotFromConfig(config);
  });
}

export async function ensureNativeCliRuntimeResumeArgs(): Promise<boolean> {
  return withConfigLock(async () => {
    const config = await readOpenClawConfig() as AgentConfigDocument;
    const { agentsConfig, entries } = normalizeAgentsConfig(config);
    let changed = false;
    const nextEntries = entries.map((entry) => {
      const runtime = entry.runtime;
      if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) return entry;
      const normalizedRuntime = normalizeAgentRuntime(
        runtime as Record<string, unknown>,
        { agentId: entry.id, skills: asStringArray(entry.skills) ?? [] },
      );
      if (normalizedRuntime === runtime) return entry;
      const before = JSON.stringify(runtime);
      const after = JSON.stringify(normalizedRuntime);
      if (before === after) return entry;
      changed = true;
      return { ...entry, runtime: normalizedRuntime };
    });

    for (const entry of nextEntries) {
      const runtime = entry.runtime;
      if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) continue;
      const claudeConfigDir = getClaudeConfigDirForRuntime(entry.id, runtime as Record<string, unknown>);
      if (claudeConfigDir) {
        await ensureDir(claudeConfigDir);
        await ensureClaudeCodeSafetyHooks(claudeConfigDir);
        await syncClaudeAgentSkillsPlugin(entry.id, asStringArray(entry.skills) ?? []);
      }
    }
    if (!changed) return false;
    config.agents = {
      ...agentsConfig,
      list: nextEntries,
    };
    await writeOpenClawConfig(config);
    logger.info('Repaired native-cli runtime resumeArgs');
    return true;
  });
}
