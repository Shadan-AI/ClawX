import { app } from 'electron';
import path from 'path';
import { existsSync, readFileSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { homedir } from 'os';
import { join } from 'path';

function fsPath(filePath: string): string {
  if (process.platform !== 'win32') return filePath;
  if (!filePath) return filePath;
  if (filePath.startsWith('\\\\?\\')) return filePath;
  const windowsPath = filePath.replace(/\//g, '\\');
  if (!path.win32.isAbsolute(windowsPath)) return windowsPath;
  if (windowsPath.startsWith('\\\\')) {
    return `\\\\?\\UNC\\${windowsPath.slice(2)}`;
  }
  return `\\\\?\\${windowsPath}`;
}
import { getAllSettings } from '../utils/store';
import { getApiKey, getDefaultProvider, getProvider } from '../utils/secure-storage';
import { getProviderEnvVar, getKeyableProviderTypes } from '../utils/provider-registry';
import { getOpenClawDir, getOpenClawEntryPath, isOpenClawPresent } from '../utils/paths';
import { getUvMirrorEnv } from '../utils/uv-env';
import { cleanupDanglingWeChatPluginState, listConfiguredChannels, readOpenClawConfig } from '../utils/channel-config';
import { sanitizeOpenClawConfig } from '../utils/openclaw-auth';
import { startOpenClawConfigLanReconciliationWatcher } from '../utils/openclaw-config-watch';
import { buildProxyEnv, resolveProxySettings } from '../utils/proxy';
import { syncProxyConfigToOpenClaw } from '../utils/openclaw-proxy';
import { normalizeOpenClawConfigHealthBaseline } from '../utils/openclaw-config-health';
import { ensureNativeCliRuntimeResumeArgs } from '../utils/agent-config';
import { logger } from '../utils/logger';
import { prependPathEntry } from '../utils/env-path';
import { copyPluginFromNodeModules, fixupPluginManifest, cpSyncSafe } from '../utils/plugin-install';
import { stripSystemdSupervisorEnv } from './config-sync-env';
import { SKILL_MARKET_BASE_URL } from '../utils/skill-market';


export interface GatewayLaunchContext {
  appSettings: Awaited<ReturnType<typeof getAllSettings>>;
  openclawDir: string;
  entryScript: string;
  gatewayArgs: string[];
  forkEnv: Record<string, string | undefined>;
  mode: 'dev' | 'packaged';
  binPathExists: boolean;
  loadedProviderKeyCount: number;
  proxySummary: string;
  channelStartupSummary: string;
}

// ── Auto-upgrade bundled plugins on startup ──────────────────────

const CHANNEL_PLUGIN_MAP: Record<string, { dirName: string; npmName: string }> = {
  dingtalk: { dirName: 'dingtalk', npmName: '@soimy/dingtalk' },
  wecom: { dirName: 'wecom', npmName: '@wecom/wecom-openclaw-plugin' },
  feishu: { dirName: 'feishu-openclaw-plugin', npmName: '@larksuite/openclaw-lark' },
  'openclaw-weixin': { dirName: 'openclaw-weixin', npmName: '@tencent-weixin/openclaw-weixin' },
};

/**
 * OpenClaw 3.22+ ships Discord, Telegram, and other channels as built-in
 * extensions.  If a previous ClawX version copied one of these into
 * ~/.openclaw/extensions/, the broken copy overrides the working built-in
 * plugin and must be removed.
 */
const BUILTIN_CHANNEL_EXTENSIONS = ['discord', 'telegram'];

function cleanupStaleBuiltInExtensions(): void {
  for (const ext of BUILTIN_CHANNEL_EXTENSIONS) {
    const extDir = join(homedir(), '.openclaw', 'extensions', ext);
    if (existsSync(fsPath(extDir))) {
      logger.info(`[plugin] Removing stale built-in extension copy: ${ext}`);
      try {
        rmSync(fsPath(extDir), { recursive: true, force: true });
      } catch (err) {
        logger.warn(`[plugin] Failed to remove stale extension ${ext}:`, err);
      }
    }
  }
}

function readPluginVersion(pkgJsonPath: string): string | null {
  try {
    const raw = readFileSync(fsPath(pkgJsonPath), 'utf-8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? null;
  } catch {
    return null;
  }
}

function timeGatewayPrep<T>(label: string, fn: () => T): T {
  const startedAt = Date.now();
  try {
    return fn();
  } finally {
    logger.debug(`[gateway-prep] ${label} completed in ${Date.now() - startedAt}ms`);
  }
}

function findFilesByName(rootDir: string, matcher: RegExp, maxDepth = 8): string[] {
  const matches: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = readdirSync(fsPath(current.dir), { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < maxDepth) {
          stack.push({ dir: fullPath, depth: current.depth + 1 });
        }
        continue;
      }
      if (entry.isFile() && matcher.test(entry.name)) {
        matches.push(fullPath);
      }
    }
  }
  return matches;
}

function replaceSnippetInFile(filePath: string, search: string, replace: string): boolean {
  try {
    const current = readFileSync(fsPath(filePath), 'utf-8');
    if (!current.includes(search)) return false;
    const next = current.replaceAll(search, replace);
    if (next === current) return false;
    writeFileSync(fsPath(filePath), next, 'utf-8');
    return true;
  } catch (error) {
    logger.warn(`[gateway-prep] Failed to patch runtime file ${filePath}:`, error);
    return false;
  }
}

function findStatementEnd(source: string, start: number): number {
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let stringQuote: '"' | "'" | '`' | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (stringQuote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === stringQuote) stringQuote = null;
      continue;
    }

    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      stringQuote = char;
      continue;
    }

    if (char === '(') parenDepth += 1;
    else if (char === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (char === '{') braceDepth += 1;
    else if (char === '}') braceDepth = Math.max(0, braceDepth - 1);
    else if (char === '[') bracketDepth += 1;
    else if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (char === ';' && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
      return index + 1;
    }
  }

  return -1;
}

function removeConsoleWarnStatementsByMarker(source: string, markers: string[]): { text: string; removed: number } {
  let text = source;
  let removed = 0;
  for (const marker of markers) {
    let searchFrom = 0;
    while (searchFrom < text.length) {
      const markerIndex = text.indexOf(marker, searchFrom);
      if (markerIndex < 0) break;

      const statementStart = text.lastIndexOf('console.warn(', markerIndex);
      if (statementStart < 0) {
        searchFrom = markerIndex + marker.length;
        continue;
      }

      const between = text.slice(statementStart, markerIndex);
      if (!between.includes('console.warn(')) {
        const statementEnd = findStatementEnd(text, statementStart);
        if (statementEnd > statementStart) {
          const lineStart = text.lastIndexOf('\n', statementStart - 1) + 1;
          const prefix = text.slice(lineStart, statementStart);
          const removeStart = /^\s*$/.test(prefix) ? lineStart : statementStart;
          const removeEnd = text[statementEnd] === '\n' ? statementEnd + 1 : statementEnd;
          text = text.slice(0, removeStart) + text.slice(removeEnd);
          removed += 1;
          searchFrom = removeStart;
          continue;
        }
      }

      searchFrom = markerIndex + marker.length;
    }
  }
  return { text, removed };
}

function removeInjectedTerminalDiagnosticStatements(filePath: string): number {
  try {
    const current = readFileSync(fsPath(filePath), 'utf-8');
    const result = removeConsoleWarnStatementsByMarker(current, [
      '[openclaw] terminal pty output',
      '[openclaw] terminal pty spawn',
      '[openclaw] terminal pty spawned',
      '[openclaw] terminal pty exit',
      '[openclaw] terminal ws message',
      '[openclaw] terminal pty write',
      '[openclaw] terminal pty resize',
    ]);
    if (result.removed === 0 || result.text === current) return 0;
    writeFileSync(fsPath(filePath), result.text, 'utf-8');
    return result.removed;
  } catch (error) {
    logger.warn(`[gateway-prep] Failed to clean terminal diagnostics from ${filePath}:`, error);
    return 0;
  }
}

function patchOpenClawBoxImModelValidation(openclawDir: string): number {
  const ownerBootstrapTargets = findFilesByName(join(openclawDir, 'dist'), /^owner-bootstrap-.*\.js$/, 2);
  const patches = [
    {
      label: 'resolver',
      search: `/**
* Validate and fix model configurations on startup.
* Ensures all configured models exist in OneAPI.
* If a model doesn't exist, replaces it with the first available model.
*/`,
      replace: `function resolveOneApiModelId(modelRef) {
\tif (typeof modelRef === "string") {
\t\tconst trimmed = modelRef.trim();
\t\tif (!trimmed) return void 0;
\t\tif (trimmed.includes("/") && !trimmed.startsWith("shadan/")) return void 0;
\t\treturn trimmed.replace(/^shadan\\//, "").trim() || void 0;
\t}
\tif (modelRef && typeof modelRef === "object") return resolveOneApiModelId(modelRef.primary);
\treturn void 0;
}
/**
* Validate and fix OneAPI-backed model configurations on startup.
* Provider-qualified custom models are not validated against OneAPI.
* If a OneAPI model doesn't exist, replaces it with the first available model.
*/`,
    },
    {
      label: 'default',
      search: `\t\t\tconst modelId = typeof defaultModel === "string" ? defaultModel.replace(/^shadan\\//, "") : defaultModel.primary?.replace(/^shadan\\//, "");`,
      replace: `\t\t\tconst modelId = resolveOneApiModelId(defaultModel);`,
    },
    {
      label: 'agent',
      search: `\t\t\t\tconst modelId = typeof agent.model === "string" ? agent.model.replace(/^shadan\\//, "") : agent.model.primary?.replace(/^shadan\\//, "");`,
      replace: `\t\t\t\tconst modelId = resolveOneApiModelId(agent.model);`,
    },
    {
      label: 'account',
      search: `\t\t\tconst modelId = account.model?.replace(/^shadan\\//, "");`,
      replace: `\t\t\tconst modelId = resolveOneApiModelId(account.model);`,
    },
  ];

  let patched = 0;
  for (const patch of patches) {
    let patchedThisSnippet = 0;
    for (const target of ownerBootstrapTargets) {
      if (replaceSnippetInFile(target, patch.search, patch.replace)) {
        patchedThisSnippet++;
      }
    }
    patched += patchedThisSnippet;
  }
  return patched;
}

function patchOpenClawTerminalInitialSize(openclawDir: string): number {
  const gatewayTargets = findFilesByName(join(openclawDir, 'dist'), /^gateway-cli-.*\.js$/, 2);
  const parseSearch = `\tconst sessionKey = url.searchParams.get("sessionKey")?.trim() || void 0;
\treturn {`;
  const parseReplace = `\tconst sessionKey = url.searchParams.get("sessionKey")?.trim() || void 0;
\tconst queryCols = Number.parseInt(url.searchParams.get("cols") ?? "", 10);
\tconst queryRows = Number.parseInt(url.searchParams.get("rows") ?? "", 10);
\tconst initialCols = Number.isFinite(queryCols) && queryCols > 0 ? Math.min(300, queryCols) : void 0;
\tconst initialRows = Number.isFinite(queryRows) && queryRows > 0 ? Math.min(120, queryRows) : void 0;
\treturn {`;
  const configSearch = `\t\t\targs: nativeCli.args?.filter((arg) => typeof arg === "string"),
\t\t\tresumeArgs: nativeCli.resumeArgs?.filter((arg) => typeof arg === "string")
\t\t},`;
  const configReplace = `\t\t\targs: nativeCli.args?.filter((arg) => typeof arg === "string"),
\t\t\tresumeArgs: nativeCli.resumeArgs?.filter((arg) => typeof arg === "string"),
\t\t\tcols: initialCols ?? nativeCli.cols,
\t\t\trows: initialRows ?? nativeCli.rows
\t\t},`;

  let patched = 0;
  for (const target of gatewayTargets) {
    let current = '';
    try {
      current = readFileSync(fsPath(target), 'utf-8');
    } catch {
      continue;
    }
    if (current.includes('const initialCols = Number.isFinite(queryCols)')) continue;
    if (replaceSnippetInFile(target, parseSearch, parseReplace)) patched++;
    if (replaceSnippetInFile(target, configSearch, configReplace)) patched++;
  }
  return patched;
}

function patchOpenClawTerminalDiagnostics(openclawDir: string): number {
  const gatewayTargets = findFilesByName(join(openclawDir, 'dist'), /^gateway-cli-.*\.js$/, 2);
  const helperSearch = `function userTextToPtyInput(text) {
\treturn text.endsWith("\\r") || text.endsWith("\\n") ? text : \`\${text}\\r\`;
}`;
  const existingHelperWithoutPreviewSearch = `function terminalDataDebug(data) {
\tlet hash = 2166136261;
\tconst text = typeof data === "string" ? data : String(data ?? "");
\tfor (let index = 0; index < text.length; index += 1) {
\t\thash ^= text.charCodeAt(index);
\t\thash = Math.imul(hash, 16777619);
\t}
\treturn {
\t\tlength: text.length,
\t\thash: (hash >>> 0).toString(16).padStart(8, "0"),
\t\tcontrol: text === "\\r" ? "enter" : text === "\\n" ? "newline" : text === "\\u0003" ? "ctrl-c" : null
\t};
}`;
  const helperReplace = `function terminalDataDebug(data) {
\tlet hash = 2166136261;
\tconst text = typeof data === "string" ? data : String(data ?? "");
\tfor (let index = 0; index < text.length; index += 1) {
\t\thash ^= text.charCodeAt(index);
\t\thash = Math.imul(hash, 16777619);
\t}
\treturn {
\t\tlength: text.length,
\t\thash: (hash >>> 0).toString(16).padStart(8, "0"),
\t\tcontrol: text === "\\r" ? "enter" : text === "\\n" ? "newline" : text === "\\u0003" ? "ctrl-c" : null,
\t\tpreview: text === "\\r" || text === "\\n" || text === "\\u0003" ? void 0 : text
\t\t\t.replace(/\\x1b\\[[0-?]*[ -/]*[@-~]/g, "")
\t\t\t.replace(/\\x1b\\][^\\u0007]*(?:\\u0007|\\x1b\\\\)/g, "")
\t\t\t.replace(/[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]/g, "")
\t\t\t.replace(/\\s+/g, " ")
\t\t\t.trim()
\t\t\t.slice(0, 220) || void 0
\t};
}
function terminalMessageDebug(msg) {
\treturn {
\t\ttype: msg?.type,
\t\tdata: typeof msg?.data === "string" ? terminalDataDebug(msg.data) : void 0,
\t\ttext: typeof msg?.text === "string" ? terminalDataDebug(msg.text) : void 0,
\t\tcols: typeof msg?.cols === "number" ? msg.cols : void 0,
\t\trows: typeof msg?.rows === "number" ? msg.rows : void 0
\t};
}
function userTextToPtyInput(text) {
\treturn text.endsWith("\\r") || text.endsWith("\\n") ? text : \`\${text}\\r\`;
}`;
  const outputSearch = `function handlePtyOutput(ws, session, raw) {
\tsendJson$1(ws, {`;
  const outputReplace = `function handlePtyOutput(ws, session, raw) {
\tconsole.warn("[openclaw] terminal pty output", {
\t\tdata: terminalDataDebug(raw),
\t\tcurrentTurn: session.currentTurn ? { id: session.currentTurn.id, ended: session.currentTurn.ended } : null,
\t\tconversationId: session.conversationId
\t});
\tsendJson$1(ws, {`;
  const spawnSearch = `\t\tconst pty = spawn(shell, shellArgs, {
\t\t\tname: isWindows ? "xterm" : "xterm-256color",
\t\t\tcols: nativeCli?.config.cols ?? 80,
\t\t\trows: nativeCli?.config.rows ?? 24,
\t\t\tcwd: nativeCli?.cwd ?? process.env.HOME ?? process.cwd(),
\t\t\tenv: shellEnv
\t\t});`;
  const spawnReplace = `\t\tconsole.warn("[openclaw] terminal pty spawn", {
\t\t\tnativeCli: nativeCli ? {
\t\t\t\tagentId: nativeCli.agentId,
\t\t\t\tprovider: nativeCli.provider,
\t\t\t\tsessionKey: nativeCli.sessionKey,
\t\t\t\tresume: nativeCli.resume,
\t\t\t\tcanResume,
\t\t\t\tresumeSessionId: resumeSessionId ? terminalDataDebug(resumeSessionId) : null
\t\t\t} : null,
\t\t\tshell,
\t\t\tshellArgs,
\t\t\tcwd: nativeCli?.cwd ?? process.env.HOME ?? process.cwd(),
\t\t\tcols: nativeCli?.config.cols ?? 80,
\t\t\trows: nativeCli?.config.rows ?? 24
\t\t});
\t\tconst pty = spawn(shell, shellArgs, {
\t\t\tname: isWindows ? "xterm" : "xterm-256color",
\t\t\tcols: nativeCli?.config.cols ?? 80,
\t\t\trows: nativeCli?.config.rows ?? 24,
\t\t\tcwd: nativeCli?.cwd ?? process.env.HOME ?? process.cwd(),
\t\t\tenv: shellEnv
\t\t});
\t\tconsole.warn("[openclaw] terminal pty spawned", {
\t\t\tpid: pty.pid,
\t\t\tprocess: typeof pty.process === "string" ? pty.process : void 0
\t\t});`;
  const exitSearch = `\t\tpty.onExit(({ exitCode }) => {
\t\t\tstopPoller?.();`;
  const exitReplace = `\t\tpty.onExit(({ exitCode }) => {
\t\t\tconsole.warn("[openclaw] terminal pty exit", {
\t\t\t\texitCode,
\t\t\t\tnativeCli: nativeCli ? {
\t\t\t\t\tagentId: nativeCli.agentId,
\t\t\t\t\tprovider: nativeCli.provider,
\t\t\t\t\tsessionKey: nativeCli.sessionKey,
\t\t\t\t\tresume: nativeCli.resume
\t\t\t\t} : null
\t\t\t});
\t\t\tstopPoller?.();`;
  const writeSearch = `\t\tws.on("message", (raw) => {
\t\t\ttry {
\t\t\t\tconst msg = JSON.parse(rawToString(raw));
\t\t\t\tif (msg.type === "data" && typeof msg.data === "string") pty.write(msg.data);
\t\t\t\telse if (msg.type === "user_text" && typeof msg.text === "string") {
\t\t\t\t\tstartTurn(ws, chatSession, msg.text);
\t\t\t\t\tpty.write(userTextToPtyInput(msg.text));
\t\t\t\t} else if (msg.type === "terminal_input" && typeof msg.data === "string") pty.write(msg.data);
\t\t\t\telse if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") ptyControls.resize?.(Math.max(1, msg.cols), Math.max(1, msg.rows));
\t\t\t} catch {}
\t\t});`;
  const writeReplace = `\t\tws.on("message", (raw) => {
\t\t\ttry {
\t\t\t\tconst rawText = rawToString(raw);
\t\t\t\tconst msg = JSON.parse(rawText);
\t\t\t\tconsole.warn("[openclaw] terminal ws message", {
\t\t\t\t\traw: terminalDataDebug(rawText),
\t\t\t\t\tmessage: terminalMessageDebug(msg),
\t\t\t\t\tnativeCli: nativeCli ? {
\t\t\t\t\t\tagentId: nativeCli.agentId,
\t\t\t\t\t\tprovider: nativeCli.provider,
\t\t\t\t\t\tsessionKey: nativeCli.sessionKey,
\t\t\t\t\t\tresume: nativeCli.resume
\t\t\t\t\t} : null
\t\t\t\t});
\t\t\t\tif (msg.type === "data" && typeof msg.data === "string") {
\t\t\t\t\tconsole.warn("[openclaw] terminal pty write", { source: "data", data: terminalDataDebug(msg.data) });
\t\t\t\t\tpty.write(msg.data);
\t\t\t\t} else if (msg.type === "user_text" && typeof msg.text === "string") {
\t\t\t\t\tstartTurn(ws, chatSession, msg.text);
\t\t\t\t\tconst ptyInput = userTextToPtyInput(msg.text);
\t\t\t\t\tconsole.warn("[openclaw] terminal pty write", { source: "user_text", data: terminalDataDebug(ptyInput) });
\t\t\t\t\tpty.write(ptyInput);
\t\t\t\t} else if (msg.type === "terminal_input" && typeof msg.data === "string") {
\t\t\t\t\tconsole.warn("[openclaw] terminal pty write", { source: "terminal_input", data: terminalDataDebug(msg.data) });
\t\t\t\t\tpty.write(msg.data);
\t\t\t\t} else if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
\t\t\t\t\tconsole.warn("[openclaw] terminal pty resize", { cols: msg.cols, rows: msg.rows });
\t\t\t\t\tptyControls.resize?.(Math.max(1, msg.cols), Math.max(1, msg.rows));
\t\t\t\t}
\t\t\t} catch (error) {
\t\t\t\tconsole.warn("[openclaw] terminal ws message parse failed", { error: String(error) });
\t\t\t}
\t\t});`;

  let patched = 0;
  const patches = [
    { search: helperSearch, replace: helperReplace, marker: 'function terminalDataDebug(data)' },
    { search: outputSearch, replace: outputReplace, marker: '[openclaw] terminal pty output' },
    { search: spawnSearch, replace: spawnReplace, marker: '[openclaw] terminal pty spawn' },
    { search: exitSearch, replace: exitReplace, marker: '[openclaw] terminal pty exit' },
    { search: writeSearch, replace: writeReplace, marker: '[openclaw] terminal ws message' },
  ];
  for (const target of gatewayTargets) {
    const diagnosticLogUpgrades: Array<[string, string]> = [
      ['console.log("[openclaw] terminal pty output"', 'console.warn("[openclaw] terminal pty output"'],
      ['console.log("[openclaw] terminal pty spawn"', 'console.warn("[openclaw] terminal pty spawn"'],
      ['console.log("[openclaw] terminal pty spawned"', 'console.warn("[openclaw] terminal pty spawned"'],
      ['console.log("[openclaw] terminal ws message"', 'console.warn("[openclaw] terminal ws message"'],
      ['console.log("[openclaw] terminal pty write"', 'console.warn("[openclaw] terminal pty write"'],
      ['console.log("[openclaw] terminal pty resize"', 'console.warn("[openclaw] terminal pty resize"'],
    ];
    for (const [search, replace] of diagnosticLogUpgrades) {
      if (replaceSnippetInFile(target, search, replace)) patched++;
    }
    if (replaceSnippetInFile(target, existingHelperWithoutPreviewSearch, helperReplace.split('\nfunction terminalMessageDebug(msg) {')[0])) {
      patched++;
    }
    for (const patch of patches) {
      try {
        if (readFileSync(fsPath(target), 'utf-8').includes(patch.marker)) continue;
      } catch {
        continue;
      }
      if (replaceSnippetInFile(target, patch.search, patch.replace)) patched++;
    }
  }
  return patched;
}

function removeOpenClawTerminalDiagnostics(openclawDir: string): number {
  const gatewayTargets = findFilesByName(join(openclawDir, 'dist'), /^gateway-cli-.*\.js$/, 2);
  const replacements: Array<[string, string]> = [
    [
      `function handlePtyOutput(ws, session, raw) {
\tconsole.warn("[openclaw] terminal pty output", {
\t\tdata: terminalDataDebug(raw),
\t\tcurrentTurn: session.currentTurn ? { id: session.currentTurn.id, ended: session.currentTurn.ended } : null,
\t\tconversationId: session.conversationId
\t});
\tsendJson$1(ws, {`,
      `function handlePtyOutput(ws, session, raw) {
\tsendJson$1(ws, {`,
    ],
    [
      `\t\tconsole.warn("[openclaw] terminal pty spawn", {
\t\t\tnativeCli: nativeCli ? {
\t\t\t\tagentId: nativeCli.agentId,
\t\t\t\tprovider: nativeCli.provider,
\t\t\t\tsessionKey: nativeCli.sessionKey,
\t\t\t\tresume: nativeCli.resume,
\t\t\t\tcanResume,
\t\t\t\tresumeSessionId: resumeSessionId ? terminalDataDebug(resumeSessionId) : null
\t\t\t} : null,
\t\t\tshell,
\t\t\tshellArgs,
\t\t\tcwd: nativeCli?.cwd ?? process.env.HOME ?? process.cwd(),
\t\t\tcols: nativeCli?.config.cols ?? 80,
\t\t\trows: nativeCli?.config.rows ?? 24
\t\t});
\t\tconst pty = spawn(shell, shellArgs, {
\t\t\tname: isWindows ? "xterm" : "xterm-256color",
\t\t\tcols: nativeCli?.config.cols ?? 80,
\t\t\trows: nativeCli?.config.rows ?? 24,
\t\t\tcwd: nativeCli?.cwd ?? process.env.HOME ?? process.cwd(),
\t\t\tenv: shellEnv
\t\t});
\t\tconsole.warn("[openclaw] terminal pty spawned", {
\t\t\tpid: pty.pid,
\t\t\tprocess: typeof pty.process === "string" ? pty.process : void 0
\t\t});`,
      `\t\tconst pty = spawn(shell, shellArgs, {
\t\t\tname: isWindows ? "xterm" : "xterm-256color",
\t\t\tcols: nativeCli?.config.cols ?? 80,
\t\t\trows: nativeCli?.config.rows ?? 24,
\t\t\tcwd: nativeCli?.cwd ?? process.env.HOME ?? process.cwd(),
\t\t\tenv: shellEnv
\t\t});`,
    ],
    [
      `\t\tpty.onExit(({ exitCode }) => {
\t\t\tconsole.warn("[openclaw] terminal pty exit", {
\t\t\t\texitCode,
\t\t\t\tnativeCli: nativeCli ? {
\t\t\t\t\tagentId: nativeCli.agentId,
\t\t\t\t\tprovider: nativeCli.provider,
\t\t\t\t\tsessionKey: nativeCli.sessionKey,
\t\t\t\t\tresume: nativeCli.resume
\t\t\t\t} : null
\t\t\t});
\t\t\tstopPoller?.();`,
      `\t\tpty.onExit(({ exitCode }) => {
\t\t\tstopPoller?.();`,
    ],
    [
      `\t\tws.on("message", (raw) => {
\t\t\ttry {
\t\t\t\tconst rawText = rawToString(raw);
\t\t\t\tconst msg = JSON.parse(rawText);
\t\t\t\tconsole.warn("[openclaw] terminal ws message", {
\t\t\t\t\traw: terminalDataDebug(rawText),
\t\t\t\t\tmessage: terminalMessageDebug(msg),
\t\t\t\t\tnativeCli: nativeCli ? {
\t\t\t\t\t\tagentId: nativeCli.agentId,
\t\t\t\t\t\tprovider: nativeCli.provider,
\t\t\t\t\t\tsessionKey: nativeCli.sessionKey,
\t\t\t\t\t\tresume: nativeCli.resume
\t\t\t\t\t} : null
\t\t\t\t});
\t\t\t\tif (msg.type === "data" && typeof msg.data === "string") {
\t\t\t\t\tconsole.warn("[openclaw] terminal pty write", { source: "data", data: terminalDataDebug(msg.data) });
\t\t\t\t\tpty.write(msg.data);
\t\t\t\t} else if (msg.type === "user_text" && typeof msg.text === "string") {
\t\t\t\t\tstartTurn(ws, chatSession, msg.text);
\t\t\t\t\tconst ptyInput = userTextToPtyInput(msg.text);
\t\t\t\t\tconsole.warn("[openclaw] terminal pty write", { source: "user_text", data: terminalDataDebug(ptyInput) });
\t\t\t\t\tpty.write(ptyInput);
\t\t\t\t} else if (msg.type === "terminal_input" && typeof msg.data === "string") {
\t\t\t\t\tconsole.warn("[openclaw] terminal pty write", { source: "terminal_input", data: terminalDataDebug(msg.data) });
\t\t\t\t\tpty.write(msg.data);
\t\t\t\t} else if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
\t\t\t\t\tconsole.warn("[openclaw] terminal pty resize", { cols: msg.cols, rows: msg.rows });
\t\t\t\t\tptyControls.resize?.(Math.max(1, msg.cols), Math.max(1, msg.rows));
\t\t\t\t}
\t\t\t} catch (error) {
\t\t\t\tconsole.warn("[openclaw] terminal ws message parse failed", { error: String(error) });
\t\t\t}
\t\t});`,
      `\t\tws.on("message", (raw) => {
\t\t\ttry {
\t\t\t\tconst msg = JSON.parse(rawToString(raw));
\t\t\t\tif (msg.type === "data" && typeof msg.data === "string") pty.write(msg.data);
\t\t\t\telse if (msg.type === "user_text" && typeof msg.text === "string") {
\t\t\t\t\tstartTurn(ws, chatSession, msg.text);
\t\t\t\t\tpty.write(userTextToPtyInput(msg.text));
\t\t\t\t} else if (msg.type === "terminal_input" && typeof msg.data === "string") pty.write(msg.data);
\t\t\t\telse if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") ptyControls.resize?.(Math.max(1, msg.cols), Math.max(1, msg.rows));
\t\t\t} catch {}
\t\t});`,
    ],
  ];

  let removed = 0;
  for (const target of gatewayTargets) {
    removed += removeInjectedTerminalDiagnosticStatements(target);
    for (const [search, replace] of replacements) {
      if (replaceSnippetInFile(target, search, replace)) removed++;
    }
  }
  return removed;
}

function getNodePtyWindowsPackageRoots(openclawDir: string): string[] {
  try {
    const openclawRequire = createRequire(join(openclawDir, 'package.json'));
    return ['@lydell/node-pty-win32-x64', '@lydell/node-pty-win32-arm64']
      .map((pkgName) => {
        try {
          return path.dirname(path.dirname(openclawRequire.resolve(pkgName)));
        } catch {
          return null;
        }
      })
      .filter((dir): dir is string => Boolean(dir));
  } catch {
    return [];
  }
}

function patchNodePtyWindowsCleanup(openclawDir: string): number {
  const packageRoots = getNodePtyWindowsPackageRoots(openclawDir);
  const cleanupTargets = packageRoots
    .map((packageRoot) => join(packageRoot, 'lib', 'windowsPtyAgent.js'))
    .filter((target) => existsSync(fsPath(target)));
  const terminalTargets = packageRoots
    .map((packageRoot) => join(packageRoot, 'lib', 'windowsTerminal.js'))
    .filter((target) => existsSync(fsPath(target)));

  const search = `            var agent = child_process_1.fork(path.join(__dirname, 'conpty_console_list_agent'), [_this._innerPid.toString()]);
            agent.on('message', function (message) {
                clearTimeout(timeout);
                resolve(message.consoleProcessList);
            });
            var timeout = setTimeout(function () {
                // Something went wrong, just send back the shell PID
                agent.kill();
                resolve([_this._innerPid]);
            }, 5000);`;
  const replace = `            var agent = child_process_1.fork(path.join(__dirname, 'conpty_console_list_agent'), [_this._innerPid.toString()], { silent: true });
            var resolved = false;
            var finish = function (processList) {
                if (resolved) {
                    return;
                }
                resolved = true;
                clearTimeout(timeout);
                resolve(processList);
            };
            agent.on('message', function (message) {
                finish(message && Array.isArray(message.consoleProcessList) ? message.consoleProcessList : [_this._innerPid]);
            });
            agent.on('error', function () {
                finish([_this._innerPid]);
            });
            agent.on('exit', function (code) {
                if (code !== 0) {
                    finish([_this._innerPid]);
                }
            });
            var timeout = setTimeout(function () {
                // Something went wrong, just send back the shell PID
                agent.kill();
                finish([_this._innerPid]);
            }, 5000);`;

  const cleanupCount = cleanupTargets.reduce((count, target) => count + (replaceSnippetInFile(target, search, replace) ? 1 : 0), 0);
  const readySearch = `        _this._socket.on('ready_datapipe', function () {
            // Run deferreds and set ready state once the first data event is received.
            _this._socket.once('data', function () {
                // Wait until the first data event is fired then we can run deferreds.
                if (!_this._isReady) {
                    // Terminal is now ready and we can avoid having to defer method
                    // calls.
                    _this._isReady = true;
                    // Execute all deferred methods
                    _this._deferreds.forEach(function (fn) {
                        // NB! In order to ensure that \`this\` has all its references
                        // updated any variable that need to be available in \`this\` before
                        // the deferred is run has to be declared above this forEach
                        // statement.
                        fn.run();
                    });
                    // Reset
                    _this._deferreds = [];
                }
            });`;
  const readyReplace = `        _this._socket.on('ready_datapipe', function () {
            // The input pipe is ready as soon as the data pipe connects. Waiting for
            // child output deadlocks silent interactive CLIs: their first input stays
            // queued forever because they do not print anything before receiving it.
            if (!_this._isReady) {
                _this._isReady = true;
                _this._deferreds.forEach(function (fn) {
                    fn.run();
                });
                _this._deferreds = [];
            }`;
  const readyCount = terminalTargets.reduce((count, target) => count + (replaceSnippetInFile(target, readySearch, readyReplace) ? 1 : 0), 0);

  return cleanupCount + readyCount;
}

function repairOpenClawRuntimeBeforeLaunch(openclawDir: string): void {
  const boxImPatchCount = patchOpenClawBoxImModelValidation(openclawDir);
  const terminalInitialSizePatchCount = patchOpenClawTerminalInitialSize(openclawDir);
  const terminalDiagnosticsEnabled = process.env.CLAWX_OPENCLAW_TERMINAL_DIAGNOSTICS === '1';
  const terminalDiagnosticPatchCount = terminalDiagnosticsEnabled
    ? patchOpenClawTerminalDiagnostics(openclawDir)
    : 0;
  const terminalDiagnosticCleanupCount = terminalDiagnosticsEnabled
    ? 0
    : removeOpenClawTerminalDiagnostics(openclawDir);
  const nodePtyPatchCount = process.platform === 'win32' ? patchNodePtyWindowsCleanup(openclawDir) : 0;
  if (boxImPatchCount > 0 || terminalInitialSizePatchCount > 0 || terminalDiagnosticPatchCount > 0 || terminalDiagnosticCleanupCount > 0 || nodePtyPatchCount > 0) {
    logger.info(`[gateway-prep] Patched OpenClaw runtime before launch (boxIm=${boxImPatchCount}, terminalInitialSize=${terminalInitialSizePatchCount}, terminalDiagnostics=${terminalDiagnosticPatchCount}, terminalDiagnosticsRemoved=${terminalDiagnosticCleanupCount}, nodePty=${nodePtyPatchCount})`);
  }
}

async function timeGatewayPrepAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    logger.debug(`[gateway-prep] ${label} completed in ${Date.now() - startedAt}ms`);
  }
}

function buildBundledPluginSources(pluginDirName: string): string[] {
  return app.isPackaged
    ? [
      join(process.resourcesPath, 'openclaw-plugins', pluginDirName),
      join(process.resourcesPath, 'app.asar.unpacked', 'build', 'openclaw-plugins', pluginDirName),
      join(process.resourcesPath, 'app.asar.unpacked', 'openclaw-plugins', pluginDirName),
    ]
    : [
      join(app.getAppPath(), 'build', 'openclaw-plugins', pluginDirName),
      join(process.cwd(), 'build', 'openclaw-plugins', pluginDirName),
    ];
}

/**
 * Auto-upgrade all configured channel plugins before Gateway start.
 * - Packaged mode: uses bundled plugins from resources/ (includes deps)
 * - Dev mode: falls back to node_modules/ with pnpm-aware dep collection
 */
function ensureConfiguredPluginsUpgraded(configuredChannels: string[]): void {
  for (const channelType of configuredChannels) {
    const pluginInfo = CHANNEL_PLUGIN_MAP[channelType];
    if (!pluginInfo) continue;
    const { dirName, npmName } = pluginInfo;

    const targetDir = join(homedir(), '.openclaw', 'extensions', dirName);
    const targetManifest = join(targetDir, 'openclaw.plugin.json');
    const isInstalled = existsSync(fsPath(targetManifest));
    const installedVersion = isInstalled ? readPluginVersion(join(targetDir, 'package.json')) : null;

    // Try bundled sources first (packaged mode or if bundle-plugins was run)
    const bundledSources = buildBundledPluginSources(dirName);
    const bundledDir = bundledSources.find((dir) => existsSync(fsPath(join(dir, 'openclaw.plugin.json'))));

    if (bundledDir) {
      const sourceVersion = readPluginVersion(join(bundledDir, 'package.json'));
      // Install or upgrade if version differs or plugin not installed
      if (!isInstalled || (sourceVersion && installedVersion && sourceVersion !== installedVersion)) {
        logger.info(`[plugin] ${isInstalled ? 'Auto-upgrading' : 'Installing'} ${channelType} plugin${isInstalled ? `: ${installedVersion} → ${sourceVersion}` : `: ${sourceVersion}`} (bundled)`);
        try {
          const copyStartedAt = Date.now();
          mkdirSync(fsPath(join(homedir(), '.openclaw', 'extensions')), { recursive: true });
          rmSync(fsPath(targetDir), { recursive: true, force: true });
          cpSyncSafe(bundledDir, targetDir);
          fixupPluginManifest(targetDir);
          logger.info(`[plugin] ${channelType} bundled plugin copy completed in ${Date.now() - copyStartedAt}ms`);
        } catch (err) {
          logger.warn(`[plugin] Failed to ${isInstalled ? 'auto-upgrade' : 'install'} ${channelType} plugin:`, err);
        }
      } else if (isInstalled) {
        // Same version already installed — still patch manifest ID in case it was
        // never corrected (e.g. installed before MANIFEST_ID_FIXES included this plugin).
        fixupPluginManifest(targetDir);
      }
      continue;
    }

    // Dev mode fallback: copy from node_modules/ with pnpm dep resolution
    if (!app.isPackaged) {
      const npmPkgPath = join(process.cwd(), 'node_modules', ...npmName.split('/'));
      if (!existsSync(fsPath(join(npmPkgPath, 'openclaw.plugin.json')))) continue;
      const sourceVersion = readPluginVersion(join(npmPkgPath, 'package.json'));
      if (!sourceVersion) continue;
      // Skip only if installed AND same version — but still patch manifest ID.
      if (isInstalled && installedVersion && sourceVersion === installedVersion) {
        fixupPluginManifest(targetDir);
        continue;
      }

      logger.info(`[plugin] ${isInstalled ? 'Auto-upgrading' : 'Installing'} ${channelType} plugin${isInstalled ? `: ${installedVersion} → ${sourceVersion}` : `: ${sourceVersion}`} (dev/node_modules)`);

      try {
        mkdirSync(fsPath(join(homedir(), '.openclaw', 'extensions')), { recursive: true });
        copyPluginFromNodeModules(npmPkgPath, targetDir, npmName);
        fixupPluginManifest(targetDir);
      } catch (err) {
        logger.warn(`[plugin] Failed to ${isInstalled ? 'auto-upgrade' : 'install'} ${channelType} plugin from node_modules:`, err);
      }
    }
  }
}

/**
 * Ensure extension-specific packages are resolvable from shared dist/ chunks.
 *
 * OpenClaw's Rollup bundler creates shared chunks in dist/ (e.g.
 * sticker-cache-*.js) that eagerly `import "grammy"`.  ESM bare specifier
 * resolution walks from the importing file's directory upward:
 *   dist/node_modules/ → openclaw/node_modules/ → …
 * It does NOT search `dist/extensions/telegram/node_modules/`.
 *
 * NODE_PATH only works for CJS require(), NOT for ESM import statements.
 *
 * Fix: create symlinks in openclaw/node_modules/ pointing to packages in
 * dist/extensions/<ext>/node_modules/.  This makes the standard ESM
 * resolution algorithm find them.  Skip-if-exists avoids overwriting
 * openclaw's own deps (they take priority).
 */
function ensureExtensionDepsResolvable(openclawDir: string): void {
  const packageVersion = readPluginVersion(join(openclawDir, 'package.json')) ?? 'unknown';
  const cacheFile = join(app.getPath('userData'), 'gateway-extension-deps-cache.json');
  // Cache applies to both dev and packaged modes — the extension deps
  // don't change between runs unless the openclaw package is updated.
  try {
    if (existsSync(fsPath(cacheFile))) {
      const cached = JSON.parse(readFileSync(fsPath(cacheFile), 'utf-8')) as {
        openclawDir?: string;
        packageVersion?: string;
      };
      if (cached.openclawDir === openclawDir && cached.packageVersion === packageVersion) {
        logger.debug(`[extension-deps] Skipped dependency scan for OpenClaw ${packageVersion} (cached)`);
        return;
      }
    }
  } catch {
    // Corrupt cache should not block startup; just rebuild it below.
  }

  const extDir = join(openclawDir, 'dist', 'extensions');
  const topNM = join(openclawDir, 'node_modules');
  let linkedCount = 0;

  // Build a set of packages already provided by openclaw's own pnpm virtual
  // store node_modules (the real store, not the top-level symlink dir).
  // We must NOT overwrite these with extension deps — openclaw's own version
  // takes priority (e.g. file-type@21 must not be shadowed by whatsapp's v16).
  const openclawRealDir = (() => {
    try { return realpathSync(openclawDir); } catch { return openclawDir; }
  })();
  const openclawVirtualNM = join(openclawRealDir, 'node_modules');
  const ownedByOpenclaw = new Set<string>();
  try {
    for (const entry of readdirSync(openclawVirtualNM, { withFileTypes: true })) {
      if (entry.name.startsWith('@')) {
        try {
          for (const sub of readdirSync(join(openclawVirtualNM, entry.name), { withFileTypes: true })) {
            ownedByOpenclaw.add(`${entry.name}/${sub.name}`);
          }
        } catch { /* ignore */ }
      } else {
        ownedByOpenclaw.add(entry.name);
      }
    }
  } catch { /* virtual store NM may not exist */ }

  try {
    if (!existsSync(extDir)) return;

    for (const ext of readdirSync(extDir, { withFileTypes: true })) {
      if (!ext.isDirectory()) continue;
      const extNM = join(extDir, ext.name, 'node_modules');
      if (!existsSync(extNM)) continue;

      for (const pkg of readdirSync(extNM, { withFileTypes: true })) {
        if (pkg.name === '.bin') continue;

        if (pkg.name.startsWith('@')) {
          // Scoped package — iterate sub-entries
          const scopeDir = join(extNM, pkg.name);
          let scopeEntries;
          try { scopeEntries = readdirSync(scopeDir, { withFileTypes: true }); } catch { continue; }
          for (const sub of scopeEntries) {
            if (!sub.isDirectory()) continue;
            const scopedName = `${pkg.name}/${sub.name}`;
            if (ownedByOpenclaw.has(scopedName)) continue; // openclaw owns this dep
            const dest = join(topNM, pkg.name, sub.name);
            if (existsSync(dest)) continue;
            try {
              mkdirSync(join(topNM, pkg.name), { recursive: true });
              symlinkSync(join(scopeDir, sub.name), dest);
              linkedCount++;
            } catch { /* skip on error — non-fatal */ }
          }
        } else {
          const dest = join(topNM, pkg.name);
          if (ownedByOpenclaw.has(pkg.name)) continue; // openclaw owns this dep
          if (existsSync(dest)) continue;          try {
            mkdirSync(topNM, { recursive: true });
            symlinkSync(join(extNM, pkg.name), dest);
            linkedCount++;
          } catch { /* skip on error — non-fatal */ }
        }
      }
    }
  } catch {
    // extensions dir may not exist or be unreadable — non-fatal
  }

  if (linkedCount > 0) {
    logger.info(`[extension-deps] Linked ${linkedCount} extension packages into ${topNM}`);
  }

  // Persist cache for both dev and packaged modes.
  try {
    writeFileSync(
      fsPath(cacheFile),
      JSON.stringify({ openclawDir, packageVersion, updatedAt: new Date().toISOString() }, null, 2),
      'utf-8',
    );
  } catch {
    // Cache is an optimization only.
  }
}

// ── Pre-launch sync ──────────────────────────────────────────────

export async function syncGatewayConfigBeforeLaunch(
  appSettings: Awaited<ReturnType<typeof getAllSettings>>,
): Promise<void> {
  await syncProxyConfigToOpenClaw(appSettings, { preserveExistingWhenDisabled: true });

  try {
    await sanitizeOpenClawConfig();
  } catch (err) {
    logger.warn('Failed to sanitize openclaw.json:', err);
  }

  try {
    await cleanupDanglingWeChatPluginState();
  } catch (err) {
    logger.warn('Failed to clean dangling WeChat plugin state before launch:', err);
  }

  // Remove stale copies of built-in extensions (Discord, Telegram) that
  // override OpenClaw's working built-in plugins and break channel loading.
  try {
    cleanupStaleBuiltInExtensions();
  } catch (err) {
    logger.warn('Failed to clean stale built-in extensions:', err);
  }

  // Auto-upgrade installed plugins before Gateway starts so that
  // the plugin manifest ID matches what sanitize wrote to the config.
  try {
    const configuredChannels = await listConfiguredChannels();

    // Also ensure plugins referenced in plugins.allow are installed even if
    // they have no channels.X section yet (e.g. qqbot added via plugins.allow
    // but never fully saved through ClawX UI).
    try {
      const rawCfg = await readOpenClawConfig();
      const allowList = Array.isArray(rawCfg.plugins?.allow) ? (rawCfg.plugins!.allow as string[]) : [];
      // Build reverse maps: dirName → channelType AND known manifest IDs → channelType
      const pluginIdToChannel: Record<string, string> = {};
      for (const [channelType, info] of Object.entries(CHANNEL_PLUGIN_MAP)) {
        pluginIdToChannel[info.dirName] = channelType;
      }
      // Known manifest IDs that differ from their dirName/channelType

      pluginIdToChannel['openclaw-lark'] = 'feishu';
      pluginIdToChannel['feishu-openclaw-plugin'] = 'feishu';

      for (const pluginId of allowList) {
        const channelType = pluginIdToChannel[pluginId] ?? pluginId;
        if (CHANNEL_PLUGIN_MAP[channelType] && !configuredChannels.includes(channelType)) {
          configuredChannels.push(channelType);
        }
      }

    } catch (err) {
      logger.warn('[plugin] Failed to augment channel list from plugins.allow:', err);
    }

    ensureConfiguredPluginsUpgraded(configuredChannels);
  } catch (err) {
    logger.warn('Failed to auto-upgrade plugins:', err);
  }

  // Batch all config writes into a single atomic operation to avoid conflicts with Gateway
  // and improve startup performance
  try {
    await batchSyncGatewayConfig(appSettings);
  } catch (err) {
    logger.warn('Failed to batch sync gateway config:', err);
  }

  try {
    await ensureNativeCliRuntimeResumeArgs();
  } catch (err) {
    logger.warn('Failed to repair native-cli runtime resume args:', err);
  }

  await normalizeOpenClawConfigHealthBaseline();

  // Start watcher to prevent Gateway from overwriting models.providers baseUrl.
  startOpenClawConfigLanReconciliationWatcher();
}

/**
 * Batch all gateway config sync operations into a single atomic write.
 * This prevents file conflicts with Gateway and improves startup performance.
 */
async function batchSyncGatewayConfig(appSettings: Awaited<ReturnType<typeof getAllSettings>>): Promise<void> {
  const { withConfigLock } = await import('../utils/config-mutex');
  const { readOpenClawJson, writeOpenClawJson } = await import('../utils/openclaw-auth');
  const { networkInterfaces } = await import('os');
  const { getTokenKey } = await import('../utils/box-im-sync');

  await withConfigLock(async () => {
    const config = await readOpenClawJson();
    let modified = false;

    // 1. Sync gateway token
    try {
      const gateway = (
        config.gateway && typeof config.gateway === 'object'
          ? { ...(config.gateway as Record<string, unknown>) }
          : {}
      ) as Record<string, unknown>;

      const auth = (
        gateway.auth && typeof gateway.auth === 'object'
          ? { ...(gateway.auth as Record<string, unknown>) }
          : {}
      ) as Record<string, unknown>;

      if (auth.mode !== 'token') {
        auth.mode = 'token';
        modified = true;
      }
      if (auth.token !== appSettings.gatewayToken) {
        auth.token = appSettings.gatewayToken;
        modified = true;
      }
      if (gateway.auth !== auth) {
        gateway.auth = auth;
      }

      const controlUi = (
        gateway.controlUi && typeof gateway.controlUi === 'object'
          ? { ...(gateway.controlUi as Record<string, unknown>) }
          : {}
      ) as Record<string, unknown>;
      const allowedOrigins = Array.isArray(controlUi.allowedOrigins)
        ? (controlUi.allowedOrigins as unknown[]).filter((value): value is string => typeof value === 'string')
        : [];
      const requiredOrigins = [
        'file://',
        'null',
        'http://127.0.0.1:5173',
        'http://localhost:5173',
        'http://127.0.0.1:18789',
        'http://localhost:18789',
        'https://127.0.0.1:18789',
        'https://localhost:18789',
      ];
      const missingOrigins = requiredOrigins.filter((origin) => !allowedOrigins.includes(origin));
      if (missingOrigins.length > 0) {
        controlUi.allowedOrigins = [...allowedOrigins, ...missingOrigins];
        modified = true;
      }
      if (gateway.controlUi !== controlUi) {
        gateway.controlUi = controlUi;
      }

      if (!gateway.mode) {
        gateway.mode = 'local';
        modified = true;
      }
      if (config.gateway !== gateway) {
        config.gateway = gateway;
      }
    } catch (err) {
      logger.warn('Failed to sync gateway token in batch:', err);
    }

    // 2. Windows: ensure gateway.tls is enabled
    if (process.platform === 'win32') {
      try {
        if (!config.gateway || typeof config.gateway !== 'object') {
          config.gateway = {};
        }
        const gw = config.gateway as Record<string, unknown>;
        const certBase = '~/.openclaw/certs';
        const tls = (gw.tls && typeof gw.tls === 'object' ? gw.tls : {}) as Record<string, unknown>;
        let tlsChanged = false;
        if (tls.enabled !== true) { tls.enabled = true; tlsChanged = true; }
        if (!tls.certPath) { tls.certPath = `${certBase}/localhost.pem`; tlsChanged = true; }
        if (!tls.keyPath) { tls.keyPath = `${certBase}/localhost-key.pem`; tlsChanged = true; }
        if (!tls.autoGenerate) { tls.autoGenerate = true; tlsChanged = true; }
        if (tlsChanged) {
          gw.tls = tls;
          modified = true;
        }
        if (!gw.bind) {
          gw.bind = 'lan';
          modified = true;
        }
        if (!gw.controlUi || typeof gw.controlUi !== 'object') {
          gw.controlUi = {};
        }
        const cui = gw.controlUi as Record<string, unknown>;
        if (cui.dangerouslyAllowHostHeaderOriginFallback !== true) {
          cui.dangerouslyAllowHostHeaderOriginFallback = true;
          modified = true;
        }
        if (cui.allowInsecureAuth !== true) {
          cui.allowInsecureAuth = true;
          modified = true;
        }
        if (cui.dangerouslyDisableDeviceAuth !== true) {
          cui.dangerouslyDisableDeviceAuth = true;
          modified = true;
        }
      } catch (err) {
        logger.warn('Failed to ensure gateway TLS in batch:', err);
      }
    }

    // 3. Inject LAN IPs into controlUi.allowedOrigins
    try {
      const nets = networkInterfaces();
      const lanIps: string[] = [];
      const re = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/;
      for (const ifaces of Object.values(nets)) {
        for (const iface of ifaces ?? []) {
          if (iface.family === 'IPv4' && !iface.internal && re.test(iface.address)) {
            lanIps.push(iface.address);
          }
        }
      }
      if (lanIps.length > 0 && config.gateway && typeof config.gateway === 'object') {
        const gw = config.gateway as Record<string, unknown>;
        if (!gw.controlUi || typeof gw.controlUi !== 'object') {
          gw.controlUi = {};
        }
        const cui = gw.controlUi as Record<string, unknown>;
        const existing = Array.isArray(cui.allowedOrigins)
          ? (cui.allowedOrigins as unknown[]).filter((x): x is string => typeof x === 'string')
          : [];
        const toAdd = lanIps.flatMap((ip) => [
          `https://${ip}:18789`,
          `http://${ip}:18789`,
        ]).filter((o) => !existing.includes(o));
        if (toAdd.length > 0) {
          cui.allowedOrigins = [...existing, ...toAdd];
          modified = true;
        }
      }
    } catch (err) {
      logger.warn('Failed to inject LAN origins in batch:', err);
    }

    // 4. Ensure static origins
    try {
      if (config.gateway && typeof config.gateway === 'object') {
        const gw = config.gateway as Record<string, unknown>;
        if (!gw.controlUi || typeof gw.controlUi !== 'object') {
          gw.controlUi = {};
        }
        const cui = gw.controlUi as Record<string, unknown>;
        const existing = Array.isArray(cui.allowedOrigins)
          ? (cui.allowedOrigins as unknown[]).filter((x): x is string => typeof x === 'string')
          : [];
        const staticOrigins = [
          'file://',
          'null',
          'http://127.0.0.1:5173',
          'http://localhost:5173',
          'http://127.0.0.1:18789',
          'http://localhost:18789',
          'https://127.0.0.1:18789',
          'https://localhost:18789',
          'https://im.shadanai.com',
          'https://shadanai.com',
        ];
        const toAdd = staticOrigins.filter((o) => !existing.includes(o));
        if (toAdd.length > 0) {
          cui.allowedOrigins = [...existing, ...toAdd];
          modified = true;
        }
      }
    } catch (err) {
      logger.warn('Failed to inject static origins in batch:', err);
    }

    // 5. Sync browser config
    try {
      const browser = (
        config.browser && typeof config.browser === 'object'
          ? { ...(config.browser as Record<string, unknown>) }
          : {}
      ) as Record<string, unknown>;

      if (browser.enabled === undefined) {
        browser.enabled = true;
        modified = true;
      }

      if (browser.defaultProfile === undefined) {
        browser.defaultProfile = 'openclaw';
        modified = true;
      }

      config.browser = browser;
    } catch (err) {
      logger.warn('Failed to sync browser config in batch:', err);
    }

    // 6. Sync session idle minutes
    try {
      const DEFAULT_IDLE_MINUTES = 10_080; // 7 days
      const session = (
        config.session && typeof config.session === 'object'
          ? { ...(config.session as Record<string, unknown>) }
          : {}
      ) as Record<string, unknown>;

      if (session.idleMinutes === undefined &&
          session.reset === undefined &&
          session.resetByType === undefined &&
          session.resetByChannel === undefined) {
        session.idleMinutes = DEFAULT_IDLE_MINUTES;
        config.session = session;
        modified = true;
      }
    } catch (err) {
      logger.warn('Failed to sync session idle minutes in batch:', err);
    }

    // 7. Re-apply box-im tokenKey
    try {
      const tokenKey = await getTokenKey();
      if (tokenKey) {
        const channels = (config.channels && typeof config.channels === 'object'
          ? config.channels as Record<string, unknown>
          : {});
        const boxIm = (channels['box-im'] && typeof channels['box-im'] === 'object'
          ? channels['box-im'] as Record<string, unknown>
          : {});
        const ownerAuth = (boxIm.ownerAuth && typeof boxIm.ownerAuth === 'object'
          ? boxIm.ownerAuth as Record<string, unknown>
          : {});
        
        if (ownerAuth.tokenKey !== tokenKey) {
          ownerAuth.tokenKey = tokenKey;
          boxIm.ownerAuth = ownerAuth;
          channels['box-im'] = boxIm;
          config.channels = channels;
          modified = true;
        }
      }
    } catch (err) {
      logger.warn('Failed to re-apply tokenKey in batch:', err);
    }

    // Write once if any changes were made
    if (modified) {
      await writeOpenClawJson(config);
      logger.info('[config-sync] Batch synced gateway config in single write');
    } else {
      logger.debug('[config-sync] No config changes needed');
    }
  });
}

async function loadProviderEnv(): Promise<{ providerEnv: Record<string, string>; loadedProviderKeyCount: number }> {
  const providerEnv: Record<string, string> = {};
  const providerTypes = getKeyableProviderTypes();
  let loadedProviderKeyCount = 0;

  try {
    const defaultProviderId = await getDefaultProvider();
    if (defaultProviderId) {
      const defaultProvider = await getProvider(defaultProviderId);
      const defaultProviderType = defaultProvider?.type;
      const defaultProviderKey = await getApiKey(defaultProviderId);
      if (defaultProviderType && defaultProviderKey) {
        const envVar = getProviderEnvVar(defaultProviderType);
        if (envVar) {
          providerEnv[envVar] = defaultProviderKey;
          loadedProviderKeyCount++;
        }
      }
    }
  } catch (err) {
    logger.warn('Failed to load default provider key for environment injection:', err);
  }

  for (const providerType of providerTypes) {
    try {
      const key = await getApiKey(providerType);
      if (key) {
        const envVar = getProviderEnvVar(providerType);
        if (envVar) {
          providerEnv[envVar] = key;
          loadedProviderKeyCount++;
        }
      }
    } catch (err) {
      logger.warn(`Failed to load API key for ${providerType}:`, err);
    }
  }

  return { providerEnv, loadedProviderKeyCount };
}

async function resolveChannelStartupPolicy(): Promise<{
  skipChannels: boolean;
  channelStartupSummary: string;
}> {
  try {
    const configuredChannels = await listConfiguredChannels();
    if (configuredChannels.length === 0) {
      return {
        skipChannels: true,
        channelStartupSummary: 'skipped(no configured channels)',
      };
    }

    return {
      skipChannels: false,
      channelStartupSummary: `enabled(${configuredChannels.join(',')})`,
    };
  } catch (error) {
    logger.warn('Failed to determine configured channels for gateway launch:', error);
    return {
      skipChannels: false,
      channelStartupSummary: 'enabled(unknown)',
    };
  }
}

export async function prepareGatewayLaunchContext(port: number): Promise<GatewayLaunchContext> {
  const openclawDir = getOpenClawDir();
  const entryScript = getOpenClawEntryPath();

  if (!isOpenClawPresent()) {
    throw new Error(`OpenClaw package not found at: ${openclawDir}`);
  }

  const appSettings = await timeGatewayPrepAsync('load settings', () => getAllSettings());
  await timeGatewayPrepAsync('sync config before launch', () => syncGatewayConfigBeforeLaunch(appSettings));
  timeGatewayPrep('repair OpenClaw runtime before launch', () => repairOpenClawRuntimeBeforeLaunch(openclawDir));

  if (!existsSync(entryScript)) {
    throw new Error(`OpenClaw entry script not found at: ${entryScript}`);
  }

  const gatewayArgs = ['gateway', '--port', String(port), '--token', appSettings.gatewayToken, '--allow-unconfigured'];
  const mode = app.isPackaged ? 'packaged' : 'dev';

  const platform = process.platform;
  const arch = process.arch;
  const target = `${platform}-${arch}`;
  const binPath = app.isPackaged
    ? path.join(process.resourcesPath, 'bin')
    : path.join(process.cwd(), 'resources', 'bin', target);
  const binPathExists = existsSync(binPath);

  const { providerEnv, loadedProviderKeyCount } = await timeGatewayPrepAsync('load provider env', () => loadProviderEnv());
  const { skipChannels, channelStartupSummary } = await timeGatewayPrepAsync('resolve channel startup policy', () => resolveChannelStartupPolicy());
  const uvEnv = await timeGatewayPrepAsync('load uv mirror env', () => getUvMirrorEnv());
  const proxyEnv = buildProxyEnv(appSettings);
  const resolvedProxy = resolveProxySettings(appSettings);
  const proxySummary = appSettings.proxyEnabled
    ? `http=${resolvedProxy.httpProxy || '-'}, https=${resolvedProxy.httpsProxy || '-'}, all=${resolvedProxy.allProxy || '-'}`
    : 'disabled';

  const { NODE_OPTIONS: _nodeOptions, ...baseEnv } = process.env;
  const baseEnvRecord = baseEnv as Record<string, string | undefined>;
  const baseEnvPatched = binPathExists
    ? prependPathEntry(baseEnvRecord, binPath).env
    : baseEnvRecord;
  const forkEnv: Record<string, string | undefined> = {
    ...stripSystemdSupervisorEnv(baseEnvPatched),
    ...providerEnv,
    ...uvEnv,
    ...proxyEnv,
    OPENCLAW_GATEWAY_TOKEN: appSettings.gatewayToken,
    OPENCLAW_SKIP_CHANNELS: skipChannels ? '1' : '',
    CLAWDBOT_SKIP_CHANNELS: skipChannels ? '1' : '',
    OPENCLAW_NO_RESPAWN: '1',
    OPENCLAW_DISABLE_AGENT_HEARTBEAT: '1',
    OPENCLAW_SKILL_MARKET_URL: SKILL_MARKET_BASE_URL,
  };

  // Ensure extension-specific packages (e.g. grammy from the telegram
  // extension) are resolvable by shared dist/ chunks via symlinks in
  // openclaw/node_modules/.  NODE_PATH does NOT work for ESM imports.
  timeGatewayPrep('ensure extension deps resolvable', () => ensureExtensionDepsResolvable(openclawDir));

  return {
    appSettings,
    openclawDir,
    entryScript,
    gatewayArgs,
    forkEnv,
    mode,
    binPathExists,
    loadedProviderKeyCount,
    proxySummary,
    channelStartupSummary,
  };
}
