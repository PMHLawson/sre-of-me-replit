import { useState, useMemo } from 'react';
import { useLocation } from 'wouter';
import { format, parseISO, startOfWeek, endOfWeek } from 'date-fns';
import { ArrowLeft, Pencil, Trash2 } from 'lucide-react';
import { useAppStore, Domain, DOMAIN_POLICY, findActiveDeviationAt, type Session } from '@/store';
import { ThemeToggle } from '@/components/theme-toggle';
import { SessionEditDialog } from '@/components/session-actions/session-edit-dialog';
import { SessionDeleteDialog } from '@/components/session-actions/session-delete-dialog';

const DOMAINS: Domain[] = ['martial-arts', 'meditation', 'fitness', 'music'];

export default function History() {
  const [_, setLocation] = useLocation();
  const sessions = useAppStore(state => state.sessions);
  const deviations = useAppStore(state => state.deviations);
  const updateSession = useAppStore(state => state.updateSession);
  const deleteSession = useAppStore(state => state.deleteSession);
  const [visibleWeeks, setVisibleWeeks] = useState(2); // show 2 weeks by default (14 days)
  const [editing, setEditing] = useState<Session | null>(null);
  const [deleting, setDeleting] = useState<Session | null>(null);

  // Build week buckets: each entry is one calendar week (Mon–Sun)
  const weekBuckets = useMemo(() => {
    if (sessions.length === 0) return [];

    const sorted = [...sessions].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    // Find the most recent Monday as week-start
    const weeks: Array<{
      label: string;
      weekStart: Date;
      weekEnd: Date;
      sessionsByDate: Record<string, typeof sessions>;
      totalByDomain: Record<Domain, number>;
      totalMinutes: number;
    }> = [];

    const seen = new Set<string>();
    sorted.forEach(s => {
      const d = parseISO(s.timestamp);
      const ws = startOfWeek(d, { weekStartsOn: 1 }); // Monday
      const key = ws.toISOString();
      if (!seen.has(key)) {
        seen.add(key);
        weeks.push({
          label: `Week of ${format(ws, 'MMM d')} – ${format(endOfWeek(ws, { weekStartsOn: 1 }), 'MMM d, yyyy')}`,
          weekStart: ws,
          weekEnd: endOfWeek(ws, { weekStartsOn: 1 }),
          sessionsByDate: {},
          totalByDomain: { 'martial-arts': 0, meditation: 0, fitness: 0, music: 0 },
          totalMinutes: 0,
        });
      }
    });

    // Populate each week bucket
    sorted.forEach(s => {
      const d = parseISO(s.timestamp);
      const ws = startOfWeek(d, { weekStartsOn: 1 });
      const weekKey = ws.toISOString();
      const week = weeks.find(w => w.weekStart.toISOString() === weekKey);
      if (!week) return;

      const dateLabel = format(d, 'MMM d, yyyy');
      if (!week.sessionsByDate[dateLabel]) week.sessionsByDate[dateLabel] = [];
      week.sessionsByDate[dateLabel].push(s);
      week.totalByDomain[s.domain as Domain] = (week.totalByDomain[s.domain as Domain] || 0) + s.durationMinutes;
      week.totalMinutes += s.durationMinutes;
    });

    return weeks;
  }, [sessions]);

  const visibleWeekBuckets = weekBuckets.slice(0, visibleWeeks);

  return (
    <div className="min-h-screen bg-background text-foreground font-sans transition-colors duration-300">
      <header className="px-4 py-5 flex items-center justify-between sticky top-0 bg-background/90 backdrop-blur-xl border-b border-border/40 z-10">
        <div className="flex items-center gap-4">
          <button
            onClick={() => setLocation('/')}
            className="p-2 -ml-2 rounded-full active:scale-95 hover:bg-accent/50 text-muted-foreground transition-all"
            data-testid="button-history-back"
          >
            <ArrowLeft className="w-6 h-6" />
          </button>
          <div>
            <h1 className="text-xl font-bold tracking-tight">History</h1>
            <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest mt-0.5">
              {weekBuckets.length} weeks · {sessions.length} sessions
            </p>
          </div>
        </div>
        <ThemeToggle />
      </header>

      <main className="px-4 py-6 space-y-6 pb-24">
        {visibleWeekBuckets.map((week, wi) => (
          <section key={week.weekStart.toISOString()} className="space-y-3">
            {/* Week header — shows totals per domain for direct trend verification */}
            <div className="sticky top-[72px] z-10 bg-background/95 backdrop-blur-sm py-2">
              <div className="bg-muted/50 border border-border/50 rounded-2xl p-3">
                <div className="text-xs font-bold text-muted-foreground font-mono mb-2 tracking-wide uppercase">
                  {week.label}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {DOMAINS.map(d => (
                    <span key={d} className="text-[11px] font-bold font-mono">
                      <span className="text-muted-foreground capitalize">{d.replace('-', ' ')}: </span>
                      <span className={week.totalByDomain[d] === 0 ? 'text-muted-foreground/40' : 'text-foreground'}>
                        {week.totalByDomain[d]}m
                      </span>
                    </span>
                  ))}
                  <span className="text-[11px] font-bold font-mono text-primary ml-auto">
                    Total: {week.totalMinutes}m
                  </span>
                </div>
              </div>
            </div>

            {/* Daily sessions within this week */}
            {Object.keys(week.sessionsByDate)
              .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())
              .map(dateLabel => (
                <div key={dateLabel} className="space-y-2">
                  <h2 className="text-xs font-bold text-muted-foreground font-mono pl-1 mt-3">
                    {dateLabel}
                  </h2>
                  {week.sessionsByDate[dateLabel].map(session => {
                    const dom = session.domain as Domain;
                    const floor = DOMAIN_POLICY[dom].sessionFloor;
                    const belowFloor = session.durationMinutes < floor;
                    const deviationAtSession = findActiveDeviationAt(
                      deviations,
                      dom,
                      parseISO(session.timestamp),
                    );
                    const inDeviation = !!deviationAtSession;
                    return (
                      <div
                        key={session.id}
                        className={`bg-card border rounded-2xl p-4 flex items-center justify-between shadow-sm transition-opacity ${
                          belowFloor ? 'border-status-degraded/30 opacity-75' :
                          inDeviation ? 'border-status-advisory/30' :
                          'border-border/50'
                        }`}
                        data-testid={`session-item-${session.id}`}
                      >
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <div className="font-semibold capitalize text-base tracking-tight text-foreground">
                              {session.domain.replace('-', ' ')}
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
                                title={`Deviation active: ${deviationAtSession?.reason}`}
                                data-testid={`badge-deviation-${session.id}`}
                              >
                                Deviation
                              </span>
                            )}
                          </div>
                          {session.notes && (
                            <div className="text-sm text-muted-foreground mt-1 line-clamp-1">
                              {session.notes}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-2 ml-3 shrink-0">
                          <div className="text-right">
                            <div className={`font-mono font-bold ${belowFloor ? 'text-status-degraded' : 'text-primary'}`}>
                              {session.durationMinutes}m
                            </div>
                            <div className="text-xs font-medium text-muted-foreground mt-0.5">
                              {format(parseISO(session.timestamp), 'h:mm a')}
                            </div>
                          </div>
                          <div className="flex flex-col gap-1">
                            <button
                              onClick={() => setEditing(session)}
                              className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/50 active:scale-95 transition-all"
                              aria-label="Edit session"
                              data-testid={`button-edit-session-${session.id}`}
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => setDeleting(session)}
                              className="p-1.5 rounded-lg text-muted-foreground hover:text-status-critical hover:bg-status-critical/10 active:scale-95 transition-all"
                              aria-label="Delete session"
                              data-testid={`button-delete-session-${session.id}`}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))
            }
          </section>
        ))}

        {/* Trend audit note between first and second week */}
        {visibleWeekBuckets.length >= 2 && (
          <div className="bg-primary/5 border border-primary/20 rounded-2xl p-4 text-sm text-muted-foreground">
            <span className="font-bold text-foreground">Trend audit: </span>
            Compare the totals in the week headers above to verify the dashboard trend arrows.
            Current 7-day window = week at top. Previous 7-day window = week below it.
          </div>
        )}

        {visibleWeeks < weekBuckets.length && (
          <button
            onClick={() => setVisibleWeeks(prev => prev + 2)}
            className="w-full py-4 text-sm font-bold text-primary bg-primary/10 rounded-2xl active:scale-[0.98] transition-all border border-primary/20 hover:bg-primary/20"
            data-testid="button-load-older"
          >
            Load Older Weeks ({weekBuckets.length - visibleWeeks} more)
          </button>
        )}

        {sessions.length === 0 && (
          <div className="text-center py-12 text-muted-foreground font-medium">
            No sessions logged yet.
          </div>
        )}
      </main>

      <SessionEditDialog
        open={!!editing}
        onOpenChange={(o) => { if (!o) setEditing(null); }}
        session={editing}
        onSubmit={(patch) => editing ? updateSession(editing.id, patch) : Promise.resolve(null)}
      />
      <SessionDeleteDialog
        open={!!deleting}
        onOpenChange={(o) => { if (!o) setDeleting(null); }}
        session={deleting}
        onConfirm={(id) => deleteSession(id)}
      />
    </div>
  );
}
