export interface SkillTrialPayload {
  name: string;
  slug: string;
  description: string;
}

// Skill trials should always run in the user's built-in OpenClaw assistant.
// That assistant is backed by the main agent session lifecycle.
export const SKILL_TRIAL_AGENT_ID = 'main';

export function buildSkillTrialNavigationState(skill: SkillTrialPayload) {
  return {
    createNewSessionFor: SKILL_TRIAL_AGENT_ID,
    quickUseSkill: skill,
  };
}
