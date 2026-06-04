import { execSync, spawn } from 'child_process';
import { existsSync } from 'fs';
import { delimiter, extname, join } from 'path';
import { logger } from './logger';

/**
 * Check if a CLI tool is available in PATH and optionally get its version.
 */
export async function checkToolInPath(
  toolName: string,
): Promise<{ found: boolean; path?: string; version?: string }> {
  try {
    const path = findToolPath(toolName);
    if (!path) return { found: false };

    let version: string | undefined;
    try {
      version = execSync(`${quoteForCommand(path)} --version`, {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      }).trim().replace(/^v/, '');
    } catch {
      // version detection is optional
    }

    return { found: true, path, version };
  } catch {
    return { found: false };
  }
}

function quoteForCommand(value: string): string {
  if (process.platform !== 'win32') return `'${value.replace(/'/g, "'\\''")}'`;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function windowsExtraBinDirs(): string[] {
  const dirs = [
    process.env.APPDATA ? join(process.env.APPDATA, 'npm') : '',
    process.env.USERPROFILE ? join(process.env.USERPROFILE, 'AppData', 'Roaming', 'npm') : '',
  ];
  return [...new Set(dirs.filter(Boolean))];
}

function findToolPath(toolName: string): string | null {
  const trimmed = toolName.trim();
  if (!trimmed) return null;

  if (process.platform !== 'win32') {
    const path = execSync(`which ${trimmed}`, { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
    return path.split('\n')[0]?.trim() || null;
  }

  try {
    const path = execSync(`where.exe ${trimmed}`, { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
    const first = path.split('\n')[0]?.trim();
    if (first) return first;
  } catch {
    // Fall back to common npm global bin locations below.
  }

  const extension = extname(trimmed).toLowerCase();
  const suffixes = extension ? [''] : ['.exe', '.cmd', '.bat', ''];
  const dirs = [
    ...(process.env.PATH || process.env.Path || '').split(delimiter),
    ...windowsExtraBinDirs(),
  ].map((entry) => entry.trim()).filter(Boolean);

  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = join(dir, `${trimmed}${suffix}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Install Node.js silently.
 * macOS: homebrew
 * Linux: nodesource
 * Windows: winget
 */
export async function installNode(): Promise<{ success: boolean; error?: string }> {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      return await runSpawn('brew', ['install', 'node'], 120_000);
    } else if (platform === 'linux') {
      return await runSpawn(
        'bash',
        ['-c', 'curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs'],
        180_000,
      );
    } else {
      return await runSpawn('winget', ['install', '--id', 'OpenJS.NodeJS.LTS', '-e', '--source', 'winget'], 180_000);
    }
  } catch (err) {
    const msg = String(err);
    logger.error(`[runtime-env] installNode failed: ${msg}`);
    return { success: false, error: msg };
  }
}

/**
 * Install an npm package globally.
 */
export async function installNpmGlobal(
  packageName: string,
  toolName?: string,
): Promise<{ success: boolean; error?: string; path?: string; version?: string }> {
  try {
    const result = await runSpawn('npm', ['install', '-g', packageName], 120_000);
    if (!result.success || !toolName) return result;

    const tool = await checkToolInPath(toolName);
    if (tool.found) {
      return { success: true, path: tool.path, version: tool.version };
    }
    return {
      success: false,
      error: `Installed ${packageName}, but ${toolName} was not found in PATH or the npm global bin directory. Restart ClawX or add the npm global bin directory to PATH.`,
    };
  } catch (err) {
    const msg = String(err);
    logger.error(`[runtime-env] installNpmGlobal(${packageName}) failed: ${msg}`);
    return { success: false, error: msg };
  }
}

function runSpawn(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      timeout: timeoutMs,
      windowsHide: true,
      shell: process.platform === 'win32',
    });

    const stderrChunks: string[] = [];
    child.stderr?.on('data', (d) => stderrChunks.push(d.toString()));
    child.stdout?.on('data', (d) => {
      const line = d.toString().trim();
      if (line) logger.debug(`[runtime-env] ${command} ${args.join(' ')}: ${line}`);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        const stderr = stderrChunks.join('\n').trim();
        resolve({ success: false, error: stderr || `Exited with code ${code}` });
      }
    });

    child.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}
