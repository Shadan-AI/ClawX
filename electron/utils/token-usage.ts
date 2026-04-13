import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';
import { getOpenClawConfigDir } from './paths';
import { logger } from './logger';
import {
  extractSessionIdFromTranscriptFileName,
  parseUsageEntriesFromJsonl,
  type TokenUsageHistoryEntry,
} from './token-usage-core';
import { listConfiguredAgentIds } from './agent-config';

export {
  extractSessionIdFromTranscriptFileName,
  parseUsageEntriesFromJsonl,
  type TokenUsageHistoryEntry,
} from './token-usage-core';

async function listAgentIdsWithSessionDirs(): Promise<string[]> {
  const openclawDir = getOpenClawConfigDir();
  const agentsDir = join(openclawDir, 'agents');
  const agentIds = new Set<string>();

  try {
    for (const agentId of await listConfiguredAgentIds()) {
      const normalized = agentId.trim();
      if (normalized) {
        agentIds.add(normalized);
      }
    }
  } catch {
    // Ignore config discovery failures and fall back to disk scan.
  }

  try {
    const agentEntries = await readdir(agentsDir, { withFileTypes: true });
    for (const entry of agentEntries) {
      if (entry.isDirectory()) {
        const normalized = entry.name.trim();
        if (normalized) {
          agentIds.add(normalized);
        }
      }
    }
  } catch {
    // Ignore disk discovery failures and return whatever we already found.
  }

  return [...agentIds];
}

async function listRecentSessionFiles(): Promise<Array<{ filePath: string; sessionId: string; agentId: string; mtimeMs: number }>> {
  const openclawDir = getOpenClawConfigDir();
  const agentsDir = join(openclawDir, 'agents');

  try {
    const agentEntries = await listAgentIdsWithSessionDirs();
    const files: Array<{ filePath: string; sessionId: string; agentId: string; mtimeMs: number }> = [];

    for (const agentId of agentEntries) {
      const sessionsDir = join(agentsDir, agentId, 'sessions');
      try {
        const sessionEntries = await readdir(sessionsDir);

        for (const fileName of sessionEntries) {
          const sessionId = extractSessionIdFromTranscriptFileName(fileName);
          if (!sessionId) continue;
          const filePath = join(sessionsDir, fileName);
          try {
            const fileStat = await stat(filePath);
            files.push({
              filePath,
              sessionId,
              agentId,
              mtimeMs: fileStat.mtimeMs,
            });
          } catch {
            continue;
          }
        }
      } catch {
        continue;
      }
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files;
  } catch {
    return [];
  }
}

export async function getRecentTokenUsageHistory(limit?: number): Promise<TokenUsageHistoryEntry[]> {
  const files = await listRecentSessionFiles();
  const maxEntries = typeof limit === 'number' && Number.isFinite(limit)
    ? Math.max(Math.floor(limit), 0)
    : 200; // default cap to avoid reading all files

  // Only read the most recent files needed
  const filesToRead = files.slice(0, Math.min(files.length, maxEntries * 2));

  // Read files concurrently
  const allEntries = await Promise.all(
    filesToRead.map(async (file) => {
      try {
        const content = await readFile(file.filePath, 'utf8');
        return parseUsageEntriesFromJsonl(content, {
          sessionId: file.sessionId,
          agentId: file.agentId,
        });
      } catch (error) {
        logger.debug(`Failed to read token usage transcript ${file.filePath}:`, error);
        return [];
      }
    })
  );

  const results = allEntries.flat();
  results.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return results.slice(0, maxEntries);
}
