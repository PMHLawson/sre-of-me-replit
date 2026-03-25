import { useLocation } from 'wouter';
import { format, parseISO } from 'date-fns';
import { ArrowLeft } from 'lucide-react';
import { useAppStore } from '@/store';
import { ThemeToggle } from '@/components/theme-toggle';

export default function History() {
  const [_, setLocation] = useLocation();
  const sessions = useAppStore(state => state.sessions);

  // Group sessions by date
  const groupedSessions = sessions.reduce((acc, session) => {
    const date = format(parseISO(session.timestamp), 'MMM d, yyyy');
    if (!acc[date]) {
      acc[date] = [];
    }
    acc[date].push(session);
    return acc;
  }, {} as Record<string, typeof sessions>);

  return (
    <div className="min-h-screen bg-background text-foreground font-sans transition-colors duration-300">
      <header className="px-4 py-5 flex items-center justify-between sticky top-0 bg-background/90 backdrop-blur-xl border-b border-border/40 z-10">
        <div className="flex items-center gap-4">
          <button 
            onClick={() => setLocation('/')}
            className="p-2 -ml-2 rounded-full active:scale-95 hover:bg-accent/50 text-muted-foreground transition-all"
          >
            <ArrowLeft className="w-6 h-6" />
          </button>
          <h1 className="text-xl font-bold tracking-tight">Recent History</h1>
        </div>
        <ThemeToggle />
      </header>

      <main className="px-4 py-6 space-y-8 pb-24">
        {Object.entries(groupedSessions).map(([date, daySessions]) => (
          <section key={date} className="space-y-3">
            <h2 className="text-sm font-bold text-muted-foreground sticky top-[72px] bg-background/95 backdrop-blur-sm py-2 font-mono tracking-wide z-0">
              {date}
            </h2>
            <div className="space-y-2">
              {daySessions.map(session => (
                <div 
                  key={session.id} 
                  className="bg-card border border-border/50 rounded-2xl p-4 flex items-center justify-between shadow-sm"
                >
                  <div>
                    <div className="font-semibold capitalize text-base tracking-tight text-foreground">
                      {session.domain.replace('-', ' ')}
                    </div>
                    {session.notes && (
                      <div className="text-sm text-muted-foreground mt-1 line-clamp-1">
                        {session.notes}
                      </div>
                    )}
                  </div>
                  <div className="text-right">
                    <div className="font-mono font-bold text-primary">
                      {session.durationMinutes}m
                    </div>
                    <div className="text-xs font-medium text-muted-foreground mt-0.5">
                      {format(parseISO(session.timestamp), 'h:mm a')}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
        
        {sessions.length === 0 && (
          <div className="text-center py-12 text-muted-foreground font-medium">
            No sessions logged yet.
          </div>
        )}
      </main>
    </div>
  );
}