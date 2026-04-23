/**
 * Agent Profile utilities
 * Handle reading and writing agent markdown files via BoxIM API with sync support
 */
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { getBoxImConfig, downloadProfileFile, uploadProfileFile_Single, syncProfileFiles } from './box-im-sync';
import { logger } from './logger';

/**
 * Get agent workspace directory path
 */
export function getAgentWorkspaceDir(agentId: string): string {
  const openclawDir = path.join(os.homedir(), '.openclaw');
  return path.join(openclawDir, `workspace-${agentId}`);
}

/**
 * Ensure agent workspace directory exists
 */
async function ensureAgentWorkspaceDir(agentId: string): Promise<string> {
  const workspaceDir = getAgentWorkspaceDir(agentId);
  await fs.mkdir(workspaceDir, { recursive: true });
  return workspaceDir;
}

/**
 * Read agent profile file (with cloud sync)
 */
export async function readAgentProfile(agentId: string, filename: string): Promise<{ success: boolean; content?: string; source?: string; error?: string }> {
  try {
    const { tokenKey } = await getBoxImConfig();
    
    if (!tokenKey) {
      // No token, read from local file only
      logger.info('[agent-profile] No BoxIM token, reading local file');
      return await readAgentProfileLocal(agentId, filename);
    }

    // Try to download from cloud first
    try {
      const success = await downloadProfileFile(agentId, filename);
      if (success) {
        // File downloaded, read from local
        return await readAgentProfileLocal(agentId, filename);
      }
    } catch (err) {
      logger.warn(`[agent-profile] Failed to download ${filename}, using local:`, err);
    }

    // Fallback to local file
    return await readAgentProfileLocal(agentId, filename);
  } catch (error) {
    logger.error('[agent-profile] Read error:', error);
    return { success: false, error: String(error) };
  }
}

/**
 * Read agent profile file from local storage
 */
async function readAgentProfileLocal(agentId: string, filename: string): Promise<{ success: boolean; content?: string; source?: string; error?: string }> {
  try {
    const workspaceDir = await ensureAgentWorkspaceDir(agentId);
    const filePath = path.join(workspaceDir, filename);
    
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return { success: true, content, source: 'LOCAL' };
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // File doesn't exist, return empty content
        return { success: true, content: '', source: 'DEFAULT' };
      }
      throw error;
    }
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

/**
 * Save agent profile file (with cloud sync)
 */
export async function saveAgentProfile(agentId: string, filename: string, content: string): Promise<{ success: boolean; isCustomized?: boolean; error?: string }> {
  try {
    // Save to local first
    const localResult = await saveAgentProfileLocal(agentId, filename, content);
    if (!localResult.success) {
      return localResult;
    }

    const { tokenKey } = await getBoxImConfig();
    
    if (!tokenKey) {
      // No token, local save only
      logger.info('[agent-profile] No BoxIM token, saved to local file only');
      return { success: true };
    }

    // Upload to cloud
    try {
      const success = await uploadProfileFile_Single(agentId, filename);
      if (success) {
        logger.info(`[agent-profile] Uploaded ${filename} to cloud`);
        return { success: true, isCustomized: true };
      } else {
        logger.warn(`[agent-profile] Failed to upload ${filename}, saved locally only`);
        return { success: true }; // Local save succeeded
      }
    } catch (err) {
      logger.warn(`[agent-profile] Upload error for ${filename}, saved locally only:`, err);
      return { success: true }; // Local save succeeded
    }
  } catch (error) {
    logger.error('[agent-profile] Save error:', error);
    return { success: false, error: String(error) };
  }
}

/**
 * Save agent profile file to local storage
 */
async function saveAgentProfileLocal(agentId: string, filename: string, content: string): Promise<{ success: boolean; error?: string }> {
  try {
    const workspaceDir = await ensureAgentWorkspaceDir(agentId);
    const filePath = path.join(workspaceDir, filename);
    
    await fs.writeFile(filePath, content, 'utf-8');
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

/**
 * Sync all profile files for an agent
 */
export async function syncAgentProfile(agentId: string): Promise<{ success: boolean; synced?: number; errors?: number; error?: string }> {
  try {
    const { tokenKey } = await getBoxImConfig();
    
    if (!tokenKey) {
      return { success: false, error: 'Not logged in' };
    }

    const result = await syncProfileFiles(agentId);
    return { success: true, ...result };
  } catch (error) {
    logger.error('[agent-profile] Sync error:', error);
    return { success: false, error: String(error) };
  }
}

