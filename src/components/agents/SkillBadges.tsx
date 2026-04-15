/**
 * Skill Badges Component
 * 显示技能列表的 Badge 组件
 */

import { Badge } from '@/components/ui/badge';
import { useSkillsStore } from '@/stores/skills';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface SkillBadgesProps {
  skills: string[];
  maxDisplay?: number;
  size?: 'sm' | 'md';
}

export function SkillBadges({ skills, maxDisplay = 3, size = 'sm' }: SkillBadgesProps) {
  const allSkills = useSkillsStore((s) => s.skills);

  if (!skills || skills.length === 0) {
    return (
      <span className="text-xs text-muted-foreground italic">未配置技能</span>
    );
  }

  const displaySkills = skills.slice(0, maxDisplay);
  const remainingCount = skills.length - maxDisplay;

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {displaySkills.map((skillId) => {
        const skill = allSkills.find((s) => s.id === skillId);
        const displayName = skill?.name || skillId;
        const icon = skill?.icon || '🔧';

        return (
          <Tooltip key={skillId}>
            <TooltipTrigger asChild>
              <Badge
                variant="secondary"
                className={`
                  ${size === 'sm' ? 'text-[10px] px-1.5 py-0 h-5' : 'text-xs px-2 py-0.5 h-6'}
                  bg-black/5 dark:bg-white/10 border-0 shadow-none
                  hover:bg-black/10 dark:hover:bg-white/15 transition-colors
                `}
              >
                <span className="mr-1">{icon}</span>
                <span className="truncate max-w-[80px]">{displayName}</span>
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              <p>{displayName}</p>
            </TooltipContent>
          </Tooltip>
        );
      })}
      {remainingCount > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="secondary"
              className={`
                ${size === 'sm' ? 'text-[10px] px-1.5 py-0 h-5' : 'text-xs px-2 py-0.5 h-6'}
                bg-black/5 dark:bg-white/10 border-0 shadow-none
              `}
            >
              +{remainingCount}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            <p>还有 {remainingCount} 个技能</p>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
