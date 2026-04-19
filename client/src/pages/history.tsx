import { useState, useMemo } from 'react';
import { useLocation } from 'wouter';
import { format, parseISO, startOfWeek, endOfWeek } from 'date-fns';
import { ArrowLeft } from 'lucide-react';
import { useAppStore, Domain, type Session } from '@/store';
import { ThemeToggle } from '@/components/theme-toggle';
import { SessionEditDialog } from '@/components/session-actions/session-edit-dialog';
import { SessionDeleteDialog } from '@/components/session-actions/session-delete-dialog';
import { RecentlyDeletedSection } from '@/components/recently-deleted/recently-deleted-section';
import { ActivityLog } from '@/components/activity-log';
import { CalendarHeatMap } from '@/components/metrics/heatmap';
import { buildActivityLog, type ActivityLogEntry } from '@/lib/activity-log';

const DOMAINS: Domain[] = ['martial-arts', 'meditation', 'fitness', 'music'];

// Cadence levels mirror the .010 review rhythm:
//   7d  = daily dashboard glance
//   14d = weekly Monday 7-day review (extra context)
//   30d = monthly trend review
//   90d = quarterly SLO adjustment evaluation
const HEATMAP_RANGES = [
  { label: '7d',  days: 7  },
  { label: '14d', days: 14 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
];

interface WeekBucket {
  label: string;
  weekStart: Date;
  entriesByDate: Record<string, ActivityLogEntry[]>;
  totalByDomain: Record<Domain, number>;
  totalMinutes: number;
}

export default function History() {
  const [_, setLocation] = useLocation();
  const sessions = useAppStore((state) => state.sessions);
  const deviations = useAppStore((state) => state.deviations);
  const updateSession = useAppStore((state) => state.updateSession);
  const deleteSession = useAppStore((state) => state.deleteSession);
  const [visibleWeeks, setVisibleWeeks] = useState(2); // 2 weeks default = 14 days
  const [editing, setEditing] = useState<Session | null>(null);
  const [deleting, setDeleting] = useState<Session | null>(null);
  const [heatmapDays, setHeatmapDays] = useState(30);

  // Bucket the unified activity log into weeks (Mon–Sun), then by date label.
  // Week totals are computed from session entries only — deviation events do
  // not contribute minutes to the totals row above each week.
  const weekBuckets = useMemo<WeekBucket[]>(() => {
    const entries = buildActivityLog(sessions, deviations);
    if (entries.length === 0) return [];

    const weeks: WeekBucket[] = [];
    const weeksByKey = new Map<string, WeekBucket>();

    for (const entry of entries) {
      const ts = parseISO(entry.timestamp);
      const ws = startOfWeek(ts, { weekStartsOn: 1 });
      const weekKey = ws.toISOString();
      let bucket = weeksByKey.get(weekKey);
      if (!bucket) {
        bucket = {
          label: `Week of ${format(ws, 'MMM d')} – ${format(
            endOfWeek(ws, { weekStartsOn: 1 }),
            'MMM d, yyyy',
          )}`,
          weekStart: ws,
          entriesByDate: {},
          totalByDomain: { 'martial-arts': 0, meditation: 0, fitness: 0, music: 0 },
          totalMinutes: 0,
        };
        weeksByKey.set(weekKey, bucket);
        weeks.push(bucket);
      }

      const dateLabel = format(ts, 'MMM d, yyyy');
      if (!bucket.entriesByDate[dateLabel]) bucket.entriesByDate[dateLabel] = [];
      bucket.entriesByDate[dateLabel].push(entry);

      if (entry.kind === 'session') {
        bucket.totalByDomain[entry.domain] += entry.session.durationMinutes;
        bucket.totalMinutes += entry.session.durationMinutes;
      }
    }

    weeks.sort((a, b) => b.weekStart.getTime() - a.weekStart.getTime());
    return weeks;
  }, [sessions, deviations]);

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
        {/* Activity heat map — supports the four .010 review cadence levels */}
        <section className="bg-card border border-border/50 rounded-3xl p-5 shadow-sm space-y-4">
          <div className="flex items-center justify-end">
            <div
              className="flex items-center gap-1 bg-muted/60 rounded-xl p-1"
              data-testid="group-heatmap-range"
            >
              {HEATMAP_RANGES.map((opt) => (
                <button
                  key={opt.days}
                  onClick={() => setHeatmapDays(opt.days)}
                  className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${
                    heatmapDays === opt.days
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  data-testid={`button-heatmap-range-${opt.label}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <CalendarHeatMap sessions={sessions} days={heatmapDays} />
        </section>

        {visibleWeekBuckets.map((week) => (
          <section key={week.weekStart.toISOString()} className="space-y-3">
            {/* Week header — totals computed from session entries only */}
            <div className="sticky top-[72px] z-10 bg-background/95 backdrop-blur-sm py-2">
              <div className="bg-muted/50 border border-border/50 rounded-2xl p-3">
                <div className="text-xs font-bold text-muted-foreground font-mono mb-2 tracking-wide uppercase">
                  {week.label}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {DOMAINS.map((d) => (
                    <span key={d} className="text-[11px] font-bold font-mono">
                      <span className="text-muted-foreground capitalize">
                        {d.replace('-', ' ')}:{' '}
                      </span>
                      <span
                        className={
                          week.totalByDomain[d] === 0
                            ? 'text-muted-foreground/40'
                            : 'text-foreground'
                        }
                      >
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

            {/* Daily groups within this week */}
            {Object.keys(week.entriesByDate)
              .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())
              .map((dateLabel) => (
                <div key={dateLabel} className="space-y-2">
                  <h2 className="text-xs font-bold text-muted-foreground font-mono pl-1 mt-3">
                    {dateLabel}
                  </h2>
                  <ActivityLog
                    entries={week.entriesByDate[dateLabel]}
                    variant="history"
                    onEdit={(s) => setEditing(s)}
                    onDelete={(s) => setDeleting(s)}
                  />
                </div>
              ))}
          </section>
        ))}

        {/* Trend audit note between first and second week */}
        {visibleWeekBuckets.length >= 2 && (
          <div className="bg-primary/5 border border-primary/20 rounded-2xl p-4 text-sm text-muted-foreground">
            <span className="font-bold text-foreground">Trend audit: </span>
            Compare the totals in the week headers above to verify the dashboard trend
            arrows. Current 7-day window = week at top. Previous 7-day window = week
            below it.
          </div>
        )}

        {visibleWeeks < weekBuckets.length && (
          <button
            onClick={() => setVisibleWeeks((prev) => prev + 2)}
            className="w-full py-4 text-sm font-bold text-primary bg-primary/10 rounded-2xl active:scale-[0.98] transition-all border border-primary/20 hover:bg-primary/20"
            data-testid="button-load-older"
          >
            Load Older Weeks ({weekBuckets.length - visibleWeeks} more)
          </button>
        )}

        {weekBuckets.length === 0 && (
          <div className="text-center py-12 text-muted-foreground font-medium">
            No activity logged yet.
          </div>
        )}

        <RecentlyDeletedSection />
      </main>

      <SessionEditDialog
        open={!!editing}
        onOpenChange={(o) => {
          if (!o) setEditing(null);
        }}
        session={editing}
        onSubmit={(patch, reason) =>
          editing ? updateSession(editing.id, patch, reason) : Promise.resolve(null)
        }
      />
      <SessionDeleteDialog
        open={!!deleting}
        onOpenChange={(o) => {
          if (!o) setDeleting(null);
        }}
        session={deleting}
        onConfirm={(id) => deleteSession(id)}
      />
    </div>
  );
}
