/**
 * Agent Profile utilities
 * Handle reading and writing agent markdown files
 */
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

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
 * Read agent profile file
 */
export async function readAgentProfile(agentId: string, filename: string): Promise<{ success: boolean; content?: string; error?: string }> {
  try {
    const workspaceDir = await ensureAgentWorkspaceDir(agentId);
    const filePath = path.join(workspaceDir, filename);
    
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return { success: true, content };
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // File doesn't exist, return empty content
        return { success: true, content: '' };
      }
      throw error;
    }
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

/**
 * Save agent profile file
 */
export async function saveAgentProfile(agentId: string, filename: string, content: string): Promise<{ success: boolean; error?: string }> {
  try {
    const workspaceDir = await ensureAgentWorkspaceDir(agentId);
    const filePath = path.join(workspaceDir, filename);
    
    await fs.writeFile(filePath, content, 'utf-8');
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}
