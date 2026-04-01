export interface DigitalEmployee {
  id: number;
  userName: string;
  nickName: string;
  headImage: string;
  openclawAgentId: string;
  model?: string;
  nodeId?: string;
  deviceNodeId?: string;
}

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
  digitalEmployee?: DigitalEmployee;
}

export interface AgentsSnapshot {
  agents: AgentSummary[];
  defaultAgentId: string;
  defaultModelRef?: string | null;
  configuredChannelTypes: string[];
  channelOwners: Record<string, string>;
  channelAccountOwners: Record<string, string>;
}
