import { execSync, spawn } from 'child_process';
import { logger } from './logger';

/**
 * Check if a CLI tool is available in PATH and optionally get its version.
 */
export async function checkToolInPath(
  toolName: string,
): Promise<{ found: boolean; path?: string; version?: string }> {
  try {
    const cmd = process.platform === 'win32' ? `where.exe ${toolName}` : `which ${toolName}`;
    const path = execSync(cmd, { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();

    let version: string | undefined;
    try {
      version = execSync(`${toolName} --version`, {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      }).trim().replace(/^v/, '');
    } catch {
      // version detection is optional
    }

    return { found: true, path: path.split('\n')[0], version };
  } catch {
    return { found: false };
  }
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
): Promise<{ success: boolean; error?: string }> {
  try {
    return await runSpawn('npm', ['install', '-g', packageName], 120_000);
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
