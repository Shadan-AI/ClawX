import { cn } from '@/lib/utils';

type AvatarVariant = {
  shell: string;
  ring: string;
  shellShape: string;
  shellInset: string;
  plateShape: string;
  plateInset: string;
  plateTone: string;
  icon: string;
};

const AVATAR_VARIANTS: AvatarVariant[] = [
  {
    shell: 'from-[#f5f6f8] via-[#eaedf2] to-[#d9dee6] dark:from-[#2d333a] dark:via-[#39414b] dark:to-[#4a5562]',
    ring: 'ring-[#c9d0db]/85 dark:ring-[#748396]/55',
    shellShape: 'rounded-[32%]',
    shellInset: 'inset-[7%] rounded-[28%]',
    plateShape: 'rounded-[26%]',
    plateInset: 'inset-[12%]',
    plateTone: 'bg-[#fbfcfe] border-[#d7dee8] dark:bg-[#f3f6fb] dark:border-[#c7d1de]',
    icon: '#566273',
  },
  {
    shell: 'from-[#f6f5f3] via-[#eeebe6] to-[#dcd5cc] dark:from-[#312d29] dark:via-[#3e3934] dark:to-[#534b44]',
    ring: 'ring-[#d1c8bb]/85 dark:ring-[#8f7d6b]/55',
    shellShape: 'rounded-[42%_24%_42%_24%]',
    shellInset: 'inset-[7%] rounded-[38%_22%_38%_22%]',
    plateShape: 'rounded-[36%_20%_36%_20%]',
    plateInset: 'inset-[12%]',
    plateTone: 'bg-[#fffdfa] border-[#e3dbcf] dark:bg-[#f6f0e8] dark:border-[#d0c3b4]',
    icon: '#6a5f53',
  },
  {
    shell: 'from-[#f5f7fa] via-[#e7edf5] to-[#d0d8e5] dark:from-[#29303d] dark:via-[#354257] dark:to-[#465b77]',
    ring: 'ring-[#c1cbdb]/85 dark:ring-[#7187aa]/55',
    shellShape: 'rounded-[24%_44%_24%_44%]',
    shellInset: 'inset-[7%] rounded-[20%_42%_20%_42%]',
    plateShape: 'rounded-[18%_40%_18%_40%]',
    plateInset: 'inset-[12%]',
    plateTone: 'bg-[#fbfdff] border-[#d5dfeb] dark:bg-[#f0f5fb] dark:border-[#c0cee0]',
    icon: '#546983',
  },
  {
    shell: 'from-[#f7f6f4] via-[#ece8e1] to-[#ddd3c7] dark:from-[#312d28] dark:via-[#403932] dark:to-[#554a40]',
    ring: 'ring-[#d2c7b8]/85 dark:ring-[#917c64]/55',
    shellShape: 'rounded-[36%]',
    shellInset: 'inset-[7%] rounded-[22%]',
    plateShape: 'rounded-[18%]',
    plateInset: 'inset-[12%]',
    plateTone: 'bg-[#fffdf9] border-[#e4dacc] dark:bg-[#f6f1e9] dark:border-[#d3c5b3]',
    icon: '#6e6150',
  },
  {
    shell: 'from-[#f4f5f7] via-[#e7eaef] to-[#d5dce4] dark:from-[#2b323a] dark:via-[#37414c] dark:to-[#485362]',
    ring: 'ring-[#c7cfda]/85 dark:ring-[#78889a]/55',
    shellShape: 'rounded-[50%_22%_38%_22%]',
    shellInset: 'inset-[7%] rounded-[46%_18%_34%_18%]',
    plateShape: 'rounded-[42%_18%_30%_18%]',
    plateInset: 'inset-[12%]',
    plateTone: 'bg-[#fafcff] border-[#d9e0e8] dark:bg-[#f3f7fb] dark:border-[#c9d1db]',
    icon: '#58697b',
  },
  {
    shell: 'from-[#f6f7f8] via-[#eaedf1] to-[#d6dce3] dark:from-[#2e3339] dark:via-[#3a424a] dark:to-[#4d5862]',
    ring: 'ring-[#cdd3dc]/85 dark:ring-[#808b98]/55',
    shellShape: 'rounded-[22%_46%_22%_46%]',
    shellInset: 'inset-[7%] rounded-[18%_42%_18%_42%]',
    plateShape: 'rounded-[16%_38%_16%_38%]',
    plateInset: 'inset-[12%]',
    plateTone: 'bg-[#fcfdfe] border-[#dbe1e8] dark:bg-[#f3f6f9] dark:border-[#cdd4dc]',
    icon: '#5a6570',
  },
  {
    shell: 'from-[#f7f6f5] via-[#eceae7] to-[#dbd7d1] dark:from-[#302e2d] dark:via-[#3d3937] dark:to-[#504c47]',
    ring: 'ring-[#d0cbc5]/85 dark:ring-[#8a837c]/55',
    shellShape: 'rounded-[48%_22%_48%_22%]',
    shellInset: 'inset-[7%] rounded-[44%_18%_44%_18%]',
    plateShape: 'rounded-[40%_18%_40%_18%]',
    plateInset: 'inset-[12%]',
    plateTone: 'bg-[#fdfcfb] border-[#dfdcd6] dark:bg-[#f5f2ef] dark:border-[#cec8c1]',
    icon: '#65605a',
  },
  {
    shell: 'from-[#f5f6f8] via-[#ebedf1] to-[#d7dce3] dark:from-[#2c3138] dark:via-[#383f48] dark:to-[#46505d]',
    ring: 'ring-[#c8d0da]/85 dark:ring-[#748191]/55',
    shellShape: 'rounded-[20%]',
    shellInset: 'inset-[7%] rounded-[18%]',
    plateShape: 'rounded-[14%]',
    plateInset: 'inset-[12%]',
    plateTone: 'bg-[#fbfcfe] border-[#d8dee6] dark:bg-[#f2f5f9] dark:border-[#c6cfdb]',
    icon: '#55606f',
  },
];

function hashSeed(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = ((hash << 5) - hash) + seed.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

function resolveAvatarIndex(seed: string, avatarIndex?: number): number {
  if (typeof avatarIndex === 'number' && Number.isFinite(avatarIndex)) {
    return Math.max(0, avatarIndex);
  }
  return hashSeed(seed);
}

function AgentGlyph({
  variantIndex,
  color,
  className,
}: {
  variantIndex: number;
  color: string;
  className?: string;
}) {
  const strokeProps = {
    stroke: color,
    strokeWidth: 2.9,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none',
  };

  const baseFace = (
    <>
      <circle cx="32" cy="23" r="13" {...strokeProps} />
      <path d="M16 52c2.5-8 9-13 16-13s13.5 5 16 13" {...strokeProps} />
      <path d="M27 23h.01M37 23h.01" {...strokeProps} />
      <path d="M27 31c3 2.4 7 2.4 10 0" {...strokeProps} />
    </>
  );

  const glyphs = [
    <>
      {baseFace}
      <path d="M20 16c2-7 7-10 12-10s10 3 12 10" {...strokeProps} />
      <path d="M18 18l-4 6 4 6M46 18l4 6-4 6" {...strokeProps} />
    </>,
    <>
      {baseFace}
      <rect x="20" y="15" width="24" height="11" rx="5.5" {...strokeProps} />
      <path d="M24 45h16" {...strokeProps} />
      <path d="M32 39v12" {...strokeProps} />
    </>,
    <>
      {baseFace}
      <path d="M23 14h18" {...strokeProps} />
      <path d="M32 14V7" {...strokeProps} />
      <circle cx="32" cy="5" r="2.3" {...strokeProps} />
      <path d="M17 49h30" {...strokeProps} />
    </>,
    <>
      {baseFace}
      <path d="M18 19c0-6 5-10 10-10h8c5 0 10 4 10 10" {...strokeProps} />
      <path d="M20 41l6 6M44 41l-6 6" {...strokeProps} />
    </>,
    <>
      {baseFace}
      <path d="M19 18h26" {...strokeProps} />
      <path d="M23 14l9-6 9 6" {...strokeProps} />
      <path d="M26 41l6 8 6-8" {...strokeProps} />
    </>,
    <>
      {baseFace}
      <path d="M19 21c3-3 7-5 13-5s10 2 13 5" {...strokeProps} />
      <path d="M21 14l6 5M43 14l-6 5" {...strokeProps} />
      <rect x="26" y="41" width="12" height="9" rx="2.5" {...strokeProps} />
    </>,
    <>
      {baseFace}
      <path d="M14 24h6M44 24h6" {...strokeProps} />
      <path d="M20 18c2-4 7-7 12-7s10 3 12 7" {...strokeProps} />
      <path d="M23 47c2.5 2 5.5 3 9 3s6.5-1 9-3" {...strokeProps} />
    </>,
    <>
      {baseFace}
      <rect x="23" y="15" width="18" height="15" rx="4.5" {...strokeProps} />
      <path d="M15 45h9l4 6 4-6h17" {...strokeProps} />
    </>,
  ];

  return (
    <svg
      viewBox="0 0 64 64"
      className={cn('h-full w-full', className)}
      aria-hidden="true"
    >
      {glyphs[variantIndex % glyphs.length]}
    </svg>
  );
}

export function AgentAvatar({
  name,
  imageUrl,
  seed,
  avatarIndex,
  className,
  iconClassName,
  fallbackClassName,
}: {
  name: string;
  imageUrl?: string | null;
  seed?: string;
  avatarIndex?: number;
  className?: string;
  iconClassName?: string;
  fallbackClassName?: string;
}) {
  const baseSeed = seed || name || 'agent';
  const resolvedIndex = resolveAvatarIndex(baseSeed, avatarIndex);
  const variant = AVATAR_VARIANTS[resolvedIndex % AVATAR_VARIANTS.length]!;
  const normalizedImageUrl = imageUrl?.trim();

  if (normalizedImageUrl) {
    return (
      <img
        src={normalizedImageUrl}
        alt={name}
        className={cn(
          'rounded-full object-cover ring-1 ring-black/8 dark:ring-white/10',
          className,
        )}
      />
    );
  }

  return (
    <div
      className={cn(
        'relative flex items-center justify-center overflow-hidden bg-gradient-to-br shadow-sm ring-1',
        variant.shell,
        variant.ring,
        variant.shellShape,
        className,
      )}
      aria-hidden="true"
    >
      <div
        className={cn(
          'absolute border border-white/26 bg-white/18 dark:border-white/10 dark:bg-white/[0.04]',
          variant.shellInset,
        )}
      />
      <div
        className={cn(
          'absolute border shadow-[0_10px_22px_rgba(15,23,42,0.08)] dark:shadow-[0_10px_22px_rgba(0,0,0,0.3)]',
          variant.plateInset,
          variant.plateShape,
          variant.plateTone,
        )}
      />
      <div
        className={cn(
          'relative z-10 flex h-[100%] w-[100%] items-center justify-center p-[8%]',
          fallbackClassName,
        )}
      >
        <AgentGlyph
          variantIndex={resolvedIndex}
          color={variant.icon}
          className={iconClassName}
        />
      </div>
    </div>
  );
}
