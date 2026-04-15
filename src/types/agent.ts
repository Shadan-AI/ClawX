export interface AgentSummary {
  id: string;
  name: string;
  isDefault: boolean;
  modelDisplay: string;
  modelRef?: string | null;
  overrideModelRef?: string | null;
  inheritedModel: boolean;
  workspace: string;
  agentDir: string;
  mainSessionKey: string;
  channelTypes: string[];
  skills?: string[];
}

export interface AgentsSnapshot {
  agents: AgentSummary[];
  defaultAgentId: string;
  defaultModelRef?: string | null;
  configuredChannelTypes: string[];
  channelOwners: Record<string, string>;
  channelAccountOwners: Record<string, string>;
}

/**
 * 数字员工模板
 */
export interface AgentTemplate {
  id: number;
  name: string;
  nameZh: string;
  description: string;
  descriptionZh: string;
  icon: string;
  skills: string[];  // 技能 slug 数组
  recommended: boolean;
  sortOrder: number;
}

/**
 * 数字员工模板 DTO（用于创建和更新）
 */
export interface AgentTemplateDTO {
  name: string;
  nameZh: string;
  description?: string;
  descriptionZh?: string;
  icon?: string;
  skills: string[];
  recommended?: boolean;
  sortOrder?: number;
}
