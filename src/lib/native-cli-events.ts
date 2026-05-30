export const NATIVE_CLI_AGENT_SKILLS_CHANGED_EVENT = 'clawx:native-cli-agent-skills-changed';

export type NativeCliAgentSkillsChangedDetail = {
  agentId: string;
  skillCount: number;
  changedAt: number;
};

export function emitNativeCliAgentSkillsChanged(detail: NativeCliAgentSkillsChangedDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(NATIVE_CLI_AGENT_SKILLS_CHANGED_EVENT, { detail }));
}

export function addNativeCliAgentSkillsChangedListener(
  listener: (detail: NativeCliAgentSkillsChangedDetail) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<NativeCliAgentSkillsChangedDetail>).detail;
    if (!detail || typeof detail.agentId !== 'string') return;
    listener(detail);
  };
  window.addEventListener(NATIVE_CLI_AGENT_SKILLS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(NATIVE_CLI_AGENT_SKILLS_CHANGED_EVENT, handler);
}
