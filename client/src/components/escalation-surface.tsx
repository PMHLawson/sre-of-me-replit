import { AlertTriangle, AlertOctagon, Bell, Eye, ShieldCheck } from 'lucide-react';
import type { DomainEscalation, EscalationTier } from '@shared/schema';
import type { Domain } from '@/store';

const TIER_STYLE: Record<EscalationTier, { text: string; bg: string; border: string; ring: string; Icon: typeof AlertTriangle }> = {
  NOMINAL:  { text: 'text-status-healthy',  bg: 'bg-status-healthy/10',  border: 'border-status-healthy/20',  ring: 'ring-status-healthy/20',  Icon: ShieldCheck   },
  ADVISORY: { text: 'text-status-advisory', bg: 'bg-status-advisory/10', border: 'border-status-advisory/20', ring: 'ring-status-advisory/20', Icon: Eye           },
  WARNING:  { text: 'text-status-degraded', bg: 'bg-status-degraded/10', border: 'border-status-degraded/20', ring: 'ring-status-degraded/20', Icon: AlertTriangle },
  BREACH:   { text: 'text-status-critical', bg: 'bg-status-critical/10', border: 'border-status-critical/20', ring: 'ring-status-critical/30', Icon: AlertOctagon  },
  PAGE:     { text: 'text-status-critical', bg: 'bg-status-critical/15', border: 'border-status-critical/30', ring: 'ring-status-critical/40', Icon: Bell          },
};

interface EscalationCardProps {
  esc: DomainEscalation;
  /** Compact one-line variant for lists; default shows full rationale + recommended action. */
  compact?: boolean;
  domainLabel?: string;
}

export function EscalationCard({ esc, compact = false, domainLabel }: EscalationCardProps) {
  const style = TIER_STYLE[esc.tier];
  const Icon = style.Icon;
  const { errorBudget, burnRate, consecutiveLowDays, tier } = esc;

  if (compact) {
    return (
      <div
        className={`rounded-xl border ${style.bg} ${style.border} px-3 py-2 flex items-center gap-2`}
        data-testid={`escalation-compact-${esc.domain}`}
      >
        <Icon className={`w-4 h-4 ${style.text}`} />
        <span className={`text-[10px] font-bold tracking-widest ${style.text}`}>{tier}</span>
        <span className="text-[11px] text-muted-foreground truncate">
          Budget {errorBudget.percentRemaining}% · Burn {burnRate.toFixed(2)}×
        </span>
      </div>
    );
  }

  return (
    <div
      className={`rounded-3xl border shadow-sm relative overflow-hidden ${style.bg} ${style.border}`}
      data-testid={`escalation-card-${esc.domain}`}
    >
      <div className="p-5 relative z-10 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-xl ${style.bg} ${style.border} border`}>
              <Icon className={`w-5 h-5 ${style.text}`} />
            </div>
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                {domainLabel ? `${domainLabel} Escalation` : 'Escalation'}
              </div>
              <div className={`text-2xl font-extrabold tracking-tight ${style.text}`} data-testid={`escalation-tier-${esc.domain}`}>
                {tier}
              </div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Error Budget</div>
            <div className={`text-2xl font-extrabold tracking-tight ${style.text}`} data-testid={`escalation-budget-${esc.domain}`}>
              {errorBudget.percentRemaining}%
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {Math.max(0, errorBudget.remainingMinutes)}m / {errorBudget.allowedMinutes}m
            </div>
          </div>
        </div>

        <div className="pt-3 border-t border-current/10 space-y-2">
          <p className="text-sm text-foreground leading-relaxed font-medium">{esc.rationale}</p>
          <div className={`text-sm font-semibold ${style.text}`} data-testid={`escalation-action-${esc.domain}`}>
            → {esc.recommendedAction}
          </div>
        </div>

        <div className="flex flex-wrap gap-2 pt-2">
          <span className="text-[10px] font-mono font-semibold text-muted-foreground bg-muted/60 px-2 py-1 rounded-md" data-testid={`escalation-burn-${esc.domain}`}>
            Burn rate {burnRate.toFixed(2)}× target
          </span>
          <span className="text-[10px] font-mono font-semibold text-muted-foreground bg-muted/60 px-2 py-1 rounded-md" data-testid={`escalation-lowdays-${esc.domain}`}>
            {consecutiveLowDays} low day{consecutiveLowDays === 1 ? '' : 's'}
          </span>
        </div>
      </div>
    </div>
  );
}

interface EscalationStripProps {
  perDomain: Partial<Record<Domain, DomainEscalation>>;
  onSelect?: (domain: Domain) => void;
}

const TIER_RANK: Record<EscalationTier, number> = {
  NOMINAL: 0, ADVISORY: 1, WARNING: 2, BREACH: 3, PAGE: 4,
};

const formatName = (d: Domain) => d.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

/** Compact list of escalation pills, ordered most-severe first. */
export function EscalationStrip({ perDomain, onSelect }: EscalationStripProps) {
  const items = (Object.values(perDomain) as DomainEscalation[])
    .filter((esc): esc is DomainEscalation => Boolean(esc))
    .sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier]);

  return (
    <div className="grid gap-2" data-testid="escalation-strip">
      {items.map(esc => {
        const style = TIER_STYLE[esc.tier];
        const Icon = style.Icon;
        return (
          <button
            key={esc.domain}
            type="button"
            onClick={() => onSelect?.(esc.domain)}
            className={`text-left rounded-2xl border ${style.bg} ${style.border} px-4 py-3 flex items-center justify-between gap-3 active:scale-[0.99] transition-transform`}
            data-testid={`escalation-strip-${esc.domain}`}
          >
            <div className="flex items-center gap-3 min-w-0">
              <Icon className={`w-4 h-4 shrink-0 ${style.text}`} />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-foreground truncate">{formatName(esc.domain)}</span>
                  <span className={`text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded ${style.bg} ${style.text} border ${style.border}`}>
                    {esc.tier}
                  </span>
                </div>
                <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                  {esc.recommendedAction}
                </div>
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className={`text-sm font-bold ${style.text}`}>{esc.errorBudget.percentRemaining}%</div>
              <div className="text-[10px] text-muted-foreground">budget</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
