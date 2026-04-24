/**
 * Agent Profile utilities
 * Handle reading and writing agent markdown files via BoxIM API with sync support
 */
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
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

    // Read local file first
    const local = await readAgentProfileLocal(agentId, filename);
    
    // If local file exists and has content, return it
    if (local.success && local.content && local.source !== 'DEFAULT') {
      logger.info(`[agent-profile] Using local file: ${filename}`);
      return local;
    }

    // Local file doesn't exist or is empty, try to download from cloud
    try {
      logger.info(`[agent-profile] Local file not found, downloading: ${filename}`);
      const success = await downloadProfileFile(agentId, filename);
      if (success) {
        // File downloaded, read from local
        return await readAgentProfileLocal(agentId, filename);
      }
    } catch (err) {
      logger.warn(`[agent-profile] Failed to download ${filename}, using local:`, err);
    }

    // Return local result (might be empty/default)
    return local;
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
        
        // Check if customized by comparing hash with template
        const isCustomized = await checkIfCustomized(agentId, filename, content);
        return { success: true, isCustomized };
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
 * Check if file is customized by comparing hash with template
 */
async function checkIfCustomized(agentId: string, filename: string, content: string): Promise<boolean> {
  try {
    // Calculate file hash
    const fileHash = crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
    
    // Get agent's template info
    const { tokenKey, apiUrl } = await getBoxImConfig();
    if (!tokenKey || !apiUrl) {
      logger.warn('[agent-profile] No token/apiUrl, cannot check template');
      return true; // Assume customized if can't check
    }
    
    // Get agent info to find templateId
    const agentResp = await fetch(`${apiUrl}/employee/${agentId}`, {
      method: 'GET',
      headers: {
        'Token-Key': tokenKey,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    });
    
    if (!agentResp.ok) {
      logger.warn('[agent-profile] Failed to get agent info');
      return true; // Assume customized if can't check
    }
    
    const agentResult = await agentResp.json() as { code?: number; data?: { templateId?: number } };
    const templateId = agentResult.data?.templateId;
    
    if (!templateId) {
      logger.info('[agent-profile] Agent has no template, file is customized');
      return true; // No template = customized
    }
    
    // Get template info
    const templateResp = await fetch(`${apiUrl}/agent/template/${templateId}`, {
      method: 'GET',
      headers: {
        'Token-Key': tokenKey,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    });
    
    if (!templateResp.ok) {
      logger.warn('[agent-profile] Failed to get template info');
      return true; // Assume customized if can't check
    }
    
    const templateResult = await templateResp.json() as { 
      code?: number; 
      data?: { profileFiles?: string } 
    };
    
    const profileFilesStr = templateResult.data?.profileFiles;
    if (!profileFilesStr) {
      logger.info('[agent-profile] Template has no profileFiles, file is customized');
      return true; // No template files = customized
    }
    
    // Parse profileFiles JSON
    const profileFiles = JSON.parse(profileFilesStr) as Record<string, { url: string; hash: string }>;
    const templateFileInfo = profileFiles[filename];
    
    if (!templateFileInfo || !templateFileInfo.hash) {
      logger.info(`[agent-profile] Template has no hash for ${filename}, file is customized`);
      return true; // No template hash = customized
    }
    
    // Compare hashes
    const isCustomized = fileHash !== templateFileInfo.hash;
    logger.info(`[agent-profile] Hash comparison for ${filename}: fileHash=${fileHash.substring(0, 8)}..., templateHash=${templateFileInfo.hash.substring(0, 8)}..., isCustomized=${isCustomized}`);
    
    return isCustomized;
  } catch (error) {
    logger.error('[agent-profile] Error checking if customized:', error);
    return true; // Assume customized on error
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

