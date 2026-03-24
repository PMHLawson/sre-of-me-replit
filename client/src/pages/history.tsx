import { useLocation } from 'wouter';
import { format, parseISO } from 'date-fns';
import { ArrowLeft } from 'lucide-react';
import { useAppStore } from '@/store';

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
    <div className="min-h-screen bg-background text-foreground font-sans">
      <header className="px-4 py-4 flex items-center gap-4 sticky top-0 bg-background/80 backdrop-blur-md z-10 border-b border-white/5">
        <button 
          onClick={() => setLocation('/')}
          className="p-2 -ml-2 rounded-full active:bg-white/5"
        >
          <ArrowLeft className="w-6 h-6" />
        </button>
        <h1 className="text-xl font-medium tracking-tight">Recent History</h1>
      </header>

      <main className="px-4 py-6 space-y-8">
        {Object.entries(groupedSessions).map(([date, daySessions]) => (
          <section key={date} className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground sticky top-[72px] bg-background/95 backdrop-blur-sm py-1 font-mono tracking-wide">
              {date}
            </h2>
            <div className="space-y-2">
              {daySessions.map(session => (
                <div 
                  key={session.id} 
                  className="bg-card border border-white/5 rounded-xl p-4 flex items-center justify-between"
                >
                  <div>
                    <div className="font-medium capitalize text-sm tracking-wide text-foreground/90">
                      {session.domain.replace('-', ' ')}
                    </div>
                    {session.notes && (
                      <div className="text-sm text-muted-foreground mt-1 line-clamp-1">
                        {session.notes}
                      </div>
                    )}
                  </div>
                  <div className="text-right">
                    <div className="font-mono font-medium text-primary">
                      {session.durationMinutes}m
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {format(parseISO(session.timestamp), 'h:mm a')}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
        
        {sessions.length === 0 && (
          <div className="text-center py-12 text-muted-foreground">
            No sessions logged yet.
          </div>
        )}
      </main>
    </div>
  );
}