import { format, parseISO } from 'date-fns';
import { Pencil, Trash2, Clock, PlayCircle, StopCircle } from 'lucide-react';
import { DOMAIN_POLICY, type Domain, type Session } from '@/store';
import type { ActivityLogEntry } from '@/lib/activity-log';

export type ActivityLogVariant = 'history' | 'domain-detail';

interface ActivityLogProps {
  entries: ActivityLogEntry[];
  /** 'history' shows the domain name as the row title; 'domain-detail' shows
   *  the timestamp instead (caller already filters to a single domain). */
  variant: ActivityLogVariant;
  onEdit?: (session: Session) => void;
  onDelete?: (session: Session) => void;
  /** Copy shown when no entries match. */
  emptyMessage?: string;
}

const formatDomain = (d: Domain) => d.replace('-', ' ');

/**
 * Shared activity-log renderer. Consumes the unified ActivityLogEntry stream
 * from buildActivityLog (B4.1) and renders sessions and deviation lifecycle
 * events with consistent styling across History and Domain Detail.
 *
 * Pagination, week-bucketing, and filtering remain the consumer's concern.
 */
export function ActivityLog({
  entries,
  variant,
  onEdit,
  onDelete,
  emptyMessage = 'No activity to show.',
}: ActivityLogProps) {
  if (entries.length === 0) {
    return (
      <div
        className="text-center py-10 text-muted-foreground bg-card border border-border/50 rounded-3xl shadow-sm"
        data-testid="activity-log-empty"
      >
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="space-y-2.5" data-testid="activity-log">
      {entries.map((entry) => {
        if (entry.kind === 'session') {
          return (
            <SessionRow
              key={`session-${entry.session.id}`}
              entry={entry}
              variant={variant}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          );
        }
        if (entry.kind === 'deviation-start') {
          return (
            <DeviationEventRow
              key={`dev-start-${entry.deviation.id}`}
              kind="start"
              timestamp={entry.timestamp}
              domain={entry.domain}
              reason={entry.deviation.reason}
              excludeFromComposite={entry.deviation.excludeFromComposite}
              variant={variant}
              testId={`activity-deviation-start-${entry.deviation.id}`}
            />
          );
        }
        return (
          <DeviationEventRow
            key={`dev-end-${entry.deviation.id}`}
            kind="end"
            timestamp={entry.timestamp}
            domain={entry.domain}
            reason={entry.deviation.reason}
            excludeFromComposite={entry.deviation.excludeFromComposite}
            endedEarly={entry.endedEarly}
            variant={variant}
            testId={`activity-deviation-end-${entry.deviation.id}`}
          />
        );
      })}
    </div>
  );
}

// ─── Session row ────────────────────────────────────────────────────────────

interface SessionRowProps {
  entry: Extract<ActivityLogEntry, { kind: 'session' }>;
  variant: ActivityLogVariant;
  onEdit?: (session: Session) => void;
  onDelete?: (session: Session) => void;
}

function SessionRow({ entry, variant, onEdit, onDelete }: SessionRowProps) {
  const { session, deviationContext, domain } = entry;
  const floor = DOMAIN_POLICY[domain].sessionFloor;
  const belowFloor = session.durationMinutes < floor;
  const inDeviation = !!deviationContext;
  const ts = parseISO(session.timestamp);

  const borderClass = belowFloor
    ? 'border-status-degraded/30 opacity-75'
    : inDeviation
    ? 'border-status-advisory/30'
    : 'border-border/50';

  const isHistory = variant === 'history';
  const titleText = isHistory
    ? formatDomain(domain)
    : format(ts, 'MMM d, yyyy · h:mm a');

  return (
    <div
      className={`bg-card border rounded-2xl p-4 flex items-center justify-between shadow-sm transition-opacity ${borderClass}`}
      data-testid={isHistory ? `session-item-${session.id}` : `session-row-${session.id}`}
    >
      <div className="flex gap-3 items-start min-w-0">
        {!isHistory && (
          <div className="mt-0.5 text-muted-foreground/50 shrink-0">
            <Clock className="w-4 h-4" />
          </div>
        )}
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div
              className={
                isHistory
                  ? 'font-semibold capitalize text-base tracking-tight text-foreground'
                  : 'font-semibold text-sm text-foreground'
              }
            >
              {titleText}
            </div>
            {belowFloor && (
              <span
                className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-status-degraded/10 text-status-degraded border border-status-degraded/20"
                title={`Below ${floor}m floor — counts toward minutes but not qualifying days`}
                data-testid={`badge-below-floor-${session.id}`}
              >
                Below floor
              </span>
            )}
            {inDeviation && (
              <span
                className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-status-advisory/10 text-status-advisory border border-status-advisory/20"
                title={`Deviation active: ${deviationContext?.reason}`}
                data-testid={`badge-deviation-${session.id}`}
              >
                Deviation
              </span>
            )}
          </div>
          {session.notes && (
            <div
              className={
                isHistory
                  ? 'text-sm text-muted-foreground mt-1 line-clamp-1'
                  : 'text-xs text-muted-foreground mt-1 leading-relaxed line-clamp-2'
              }
            >
              {session.notes}
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 ml-3 shrink-0">
        {isHistory ? (
          <div className="text-right">
            <div
              className={`font-mono font-bold ${
                belowFloor ? 'text-status-degraded' : 'text-primary'
              }`}
            >
              {session.durationMinutes}m
            </div>
            <div className="text-xs font-medium text-muted-foreground mt-0.5">
              {format(ts, 'h:mm a')}
            </div>
          </div>
        ) : (
          <div
            className={`font-mono text-xs font-bold px-2.5 py-1.5 rounded-lg ${
              belowFloor
                ? 'bg-status-degraded/10 text-status-degraded'
                : 'bg-primary/10 text-primary'
            }`}
          >
            {session.durationMinutes}m
          </div>
        )}
        {(onEdit || onDelete) && (
          <div className="flex flex-col gap-1">
            {onEdit && (
              <button
                onClick={() => onEdit(session)}
                className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/50 active:scale-95 transition-all"
                aria-label="Edit session"
                data-testid={`button-edit-session-${session.id}`}
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
            )}
            {onDelete && (
              <button
                onClick={() => onDelete(session)}
                className="p-1.5 rounded-lg text-muted-foreground hover:text-status-critical hover:bg-status-critical/10 active:scale-95 transition-all"
                aria-label="Delete session"
                data-testid={`button-delete-session-${session.id}`}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Deviation event row ────────────────────────────────────────────────────

interface DeviationEventRowProps {
  kind: 'start' | 'end';
  timestamp: string;
  domain: Domain;
  reason: string;
  excludeFromComposite: boolean;
  endedEarly?: boolean;
  variant: ActivityLogVariant;
  testId: string;
}

function DeviationEventRow({
  kind,
  timestamp,
  domain,
  reason,
  excludeFromComposite,
  endedEarly,
  variant,
  testId,
}: DeviationEventRowProps) {
  const Icon = kind === 'start' ? PlayCircle : StopCircle;
  const headline =
    kind === 'start' ? 'Deviation started' : 'Deviation ended';
  const ts = parseISO(timestamp);
  const isHistory = variant === 'history';

  return (
    <div
      className="bg-card border border-status-advisory/30 rounded-2xl p-4 flex items-start gap-3 shadow-sm"
      data-testid={testId}
    >
      <div className="mt-0.5 text-status-advisory shrink-0">
        <Icon className="w-4 h-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-bold uppercase tracking-widest text-status-advisory">
            {headline}
          </span>
          <span
            className="text-[11px] font-semibold capitalize text-foreground"
            data-testid="activity-deviation-domain"
          >
            {formatDomain(domain)}
          </span>
          <span
            className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${
              excludeFromComposite
                ? 'bg-status-deviation/10 text-status-deviation border-status-deviation/20'
                : 'bg-muted text-muted-foreground border-border/50'
            }`}
            title={
              excludeFromComposite
                ? 'This deviation excludes the domain from the composite score'
                : 'This deviation still counts toward the composite score'
            }
            data-testid="activity-deviation-type"
          >
            {excludeFromComposite ? 'Excluded from composite' : 'Counts in composite'}
          </span>
          {endedEarly && (
            <span
              className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border/50"
              title="Ended before the planned end date"
            >
              Ended early
            </span>
          )}
        </div>
        <div className="text-sm text-foreground font-medium mt-1 line-clamp-2">
          {reason}
        </div>
        <div className="text-xs font-medium text-muted-foreground mt-1">
          {format(ts, isHistory ? 'h:mm a' : 'MMM d, yyyy · h:mm a')}
        </div>
      </div>
    </div>
  );
}
