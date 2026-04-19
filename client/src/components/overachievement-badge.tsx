import { TrendingUp, Sparkles, Trophy } from 'lucide-react';
import type { OverachievementTier } from '@shared/schema';

interface OverachievementBadgeProps {
  tier: OverachievementTier;
  rawScore: number;
  /** `compact` renders a tight inline pill; default renders with icon + label. */
  compact?: boolean;
  /** Test-id suffix — usually the domain key. */
  testIdSuffix?: string;
}

const TIER_STYLE: Record<Exclude<OverachievementTier, 'NONE'>, {
  text: string;
  bg: string;
  border: string;
  Icon: typeof TrendingUp;
  label: string;
}> = {
  COMMITTED: {
    text:   'text-amber-600 dark:text-amber-400',
    bg:     'bg-amber-500/10',
    border: 'border-amber-500/30',
    Icon:   TrendingUp,
    label:  'COMMITTED',
  },
  PEAK: {
    text:   'text-cyan-600 dark:text-cyan-400',
    bg:     'bg-cyan-500/10',
    border: 'border-cyan-500/30',
    Icon:   Sparkles,
    label:  'PEAK',
  },
  ELITE: {
    text:   'text-purple-600 dark:text-purple-400',
    bg:     'bg-purple-500/10',
    border: 'border-purple-500/30',
    Icon:   Trophy,
    label:  'ELITE',
  },
};

/**
 * C2.2 — Overachievement badge. Only renders when tier !== 'NONE'.
 * Returns `null` for the no-overachievement case so callers can drop it
 * inline without conditionals.
 */
export function OverachievementBadge({
  tier,
  rawScore,
  compact = false,
  testIdSuffix,
}: OverachievementBadgeProps) {
  if (tier === 'NONE') return null;
  const style = TIER_STYLE[tier];
  const Icon = style.Icon;
  const testId = testIdSuffix
    ? `badge-overachievement-${testIdSuffix}`
    : 'badge-overachievement';

  if (compact) {
    return (
      <span
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-bold tracking-wide border ${style.bg} ${style.text} ${style.border}`}
        title={`${style.label} overachievement — ${rawScore}% of target`}
        data-testid={testId}
        data-tier={tier}
      >
        <Icon className="w-2.5 h-2.5" />
        {style.label} {rawScore}%
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold uppercase tracking-wide border ${style.bg} ${style.text} ${style.border}`}
      title={`${style.label} overachievement — ${rawScore}% of target`}
      data-testid={testId}
      data-tier={tier}
    >
      <Icon className="w-3.5 h-3.5" />
      {style.label} {rawScore}%
    </span>
  );
}
