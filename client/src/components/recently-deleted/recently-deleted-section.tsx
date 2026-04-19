import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, RotateCcw, Trash2 } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { useAppStore, type Domain } from '@/store';

const DOMAIN_LABEL: Record<Domain, string> = {
  'martial-arts': 'Martial Arts',
  meditation: 'Meditation',
  fitness: 'Fitness',
  music: 'Music',
};

/**
 * Collapsible "Recently Deleted" panel for the History page. The deleted-sessions
 * list is fetched lazily on first expand to avoid an extra round-trip for users
 * who never need recovery.
 */
export function RecentlyDeletedSection() {
  const deletedSessions = useAppStore((s) => s.deletedSessions);
  const deletedSessionsLoaded = useAppStore((s) => s.deletedSessionsLoaded);
  const deletedSessionsError = useAppStore((s) => s.deletedSessionsError);
  const fetchDeletedSessions = useAppStore((s) => s.fetchDeletedSessions);
  const restoreSession = useAppStore((s) => s.restoreSession);

  const [expanded, setExpanded] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  useEffect(() => {
    if (expanded && !deletedSessionsLoaded) {
      void fetchDeletedSessions();
    }
  }, [expanded, deletedSessionsLoaded, fetchDeletedSessions]);

  // Show items in reverse-deletion order (most recently deleted first). Fall back
  // to the original timestamp if deletedAt is somehow missing.
  const sortedDeleted = [...deletedSessions].sort((a, b) => {
    const aT = new Date(a.deletedAt ?? a.timestamp).getTime();
    const bT = new Date(b.deletedAt ?? b.timestamp).getTime();
    return bT - aT;
  });

  const count = deletedSessionsLoaded ? sortedDeleted.length : null;

  const handleRestore = async (id: string) => {
    setRestoringId(id);
    try {
      await restoreSession(id);
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <section
      className="bg-card border border-border/50 rounded-2xl shadow-sm overflow-hidden"
      data-testid="section-recently-deleted"
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-accent/40 transition-colors"
        aria-expanded={expanded}
        data-testid="button-recently-deleted-toggle"
      >
        <div className="flex items-center gap-2">
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          )}
          <Trash2 className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-bold text-foreground">Recently Deleted</span>
          {count !== null && (
            <span
              className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground bg-muted px-2 py-0.5 rounded-full"
              data-testid="text-recently-deleted-count"
            >
              {count}
            </span>
          )}
        </div>
        <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          {expanded ? 'Hide' : 'Show'}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border/50 p-3 space-y-2">
          {!deletedSessionsLoaded && (
            <div
              className="text-center py-6 text-xs text-muted-foreground font-medium"
              data-testid="text-recently-deleted-loading"
            >
              Loading…
            </div>
          )}

          {deletedSessionsLoaded && deletedSessionsError && (
            <div
              className="text-center py-6 space-y-2"
              data-testid="text-recently-deleted-error"
            >
              <p className="text-sm text-status-critical font-medium">
                {deletedSessionsError}
              </p>
              <button
                onClick={() => void fetchDeletedSessions()}
                className="text-xs font-bold text-primary underline underline-offset-2 hover:text-primary/80"
                data-testid="button-recently-deleted-retry"
              >
                Try again
              </button>
            </div>
          )}

          {deletedSessionsLoaded && !deletedSessionsError && sortedDeleted.length === 0 && (
            <div
              className="text-center py-8 text-sm text-muted-foreground font-medium"
              data-testid="text-recently-deleted-empty"
            >
              Nothing here. Deleted sessions appear here within the retention window.
            </div>
          )}

          {deletedSessionsLoaded && !deletedSessionsError &&
            sortedDeleted.map((session) => {
              const dom = session.domain as Domain;
              const isRestoring = restoringId === session.id;
              return (
                <div
                  key={session.id}
                  className="bg-muted/30 border border-border/40 rounded-xl p-3 flex items-start justify-between gap-3"
                  data-testid={`row-deleted-session-${session.id}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-foreground capitalize">
                        {DOMAIN_LABEL[dom] ?? session.domain}
                      </span>
                      <span className="text-xs font-mono font-bold text-muted-foreground">
                        {session.durationMinutes}m
                      </span>
                      <span className="text-[11px] font-medium text-muted-foreground">
                        · {format(parseISO(session.timestamp), 'MMM d, yyyy h:mm a')}
                      </span>
                    </div>
                    {session.notes && (
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-1">
                        {session.notes}
                      </p>
                    )}
                    {session.deletedAt && (
                      <p
                        className="text-[10px] font-mono text-muted-foreground/70 mt-1"
                        data-testid={`text-deleted-at-${session.id}`}
                      >
                        Deleted {format(parseISO(session.deletedAt), 'MMM d, h:mm a')}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={() => handleRestore(session.id)}
                    disabled={isRestoring}
                    className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-primary bg-primary/10 border border-primary/20 hover:bg-primary/20 active:scale-95 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                    data-testid={`button-restore-session-${session.id}`}
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    {isRestoring ? 'Restoring…' : 'Restore'}
                  </button>
                </div>
              );
            })}
        </div>
      )}
    </section>
  );
}
